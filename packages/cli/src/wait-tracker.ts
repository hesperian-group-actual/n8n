import { Logger } from '@n8n/backend-common';
import { ExecutionsConfig } from '@n8n/config';
import { ExecutionRepository } from '@n8n/db';
import { OnLeaderStepdown, OnLeaderTakeover } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { UnexpectedError, type IWorkflowExecutionDataProcess } from 'n8n-workflow';

import { ActiveExecutions } from '@/active-executions';
import { ExecutionAlreadyResumingError } from '@/errors/execution-already-resuming.error';
import { OwnershipService } from '@/services/ownership.service';
import { WorkflowRunner } from '@/workflow-runner';
import {
	shouldRestartParentExecution,
	updateParentExecutionWithChildResults,
} from './workflow-helpers';

@Service()
export class WaitTracker {
	private waitingExecutions: {
		[key: string]: {
			executionId: string;
			timer: NodeJS.Timeout;
		};
	} = {};

	mainTimer?: NodeJS.Timeout;

	private readonly pollIntervalMs: number;

	private readonly idlePollingEnabled: boolean;

	constructor(
		private readonly logger: Logger,
		private readonly executionRepository: ExecutionRepository,
		private readonly ownershipService: OwnershipService,
		private readonly activeExecutions: ActiveExecutions,
		private readonly workflowRunner: WorkflowRunner,
		private readonly instanceSettings: InstanceSettings,
		executionsConfig: ExecutionsConfig,
	) {
		this.logger = this.logger.scoped('waiting-executions');
		this.pollIntervalMs = executionsConfig.waitTracker.pollIntervalSeconds * 1000;
		this.idlePollingEnabled =
			executionsConfig.waitTracker.idlePollingEnabled &&
			!instanceSettings.isMultiMain &&
			executionsConfig.mode === 'regular';
	}

	has(executionId: string) {
		return this.waitingExecutions[executionId] !== undefined;
	}

	init() {
		if (this.instanceSettings.isLeader) this.startTracking();
	}

	/** Re-check the database for waiting executions and resume polling if needed. */
	scheduleCheck() {
		if (!this.instanceSettings.isLeader) return;

		void this.getWaitingExecutions();
	}

	@OnLeaderTakeover()
	private startTracking() {
		if (this.idlePollingEnabled) {
			void this.getWaitingExecutions();
			this.logger.debug('Started tracking waiting executions (idle-aware)');
			return;
		}

		this.mainTimer = setInterval(() => {
			void this.getWaitingExecutions();
		}, this.pollIntervalMs);

		void this.getWaitingExecutions();

		this.logger.debug('Started tracking waiting executions');
	}

	private ensurePollingActive() {
		if (this.mainTimer) return;

		this.mainTimer = setInterval(() => {
			void this.getWaitingExecutions();
		}, this.pollIntervalMs);
	}

	private maybeStopPolling() {
		if (!this.idlePollingEnabled || !this.mainTimer) return;
		if (Object.keys(this.waitingExecutions).length > 0) return;

		clearInterval(this.mainTimer);
		this.mainTimer = undefined;
	}

	async getWaitingExecutions() {
		this.logger.debug('Querying database for waiting executions');

		const executions = await this.executionRepository.getWaitingExecutions();

		if (executions.length === 0) {
			this.maybeStopPolling();
			return;
		}

		const executionIds = executions.map((execution) => execution.id).join(', ');
		this.logger.debug(
			`Found ${executions.length} executions. Setting timer for IDs: ${executionIds}`,
		);

		// Add timers for each waiting execution that they get started at the correct time

		for (const execution of executions) {
			const executionId = execution.id;
			if (this.waitingExecutions[executionId] === undefined) {
				const triggerTime = execution.waitTill!.getTime() - new Date().getTime();
				this.waitingExecutions[executionId] = {
					executionId,
					timer: setTimeout(() => {
						void this.startExecution(executionId);
					}, triggerTime),
				};
			}
		}

		this.ensurePollingActive();
	}

	stopExecution(executionId: string) {
		if (!this.waitingExecutions[executionId]) return;

		clearTimeout(this.waitingExecutions[executionId].timer);

		delete this.waitingExecutions[executionId];
		this.maybeStopPolling();
	}

	async startExecution(executionId: string) {
		this.logger.debug(`Resuming execution ${executionId}`, { executionId });
		delete this.waitingExecutions[executionId];
		this.maybeStopPolling();

		// Get the data to execute
		const fullExecutionData = await this.executionRepository.findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
		});

		if (!fullExecutionData) {
			throw new UnexpectedError('Execution does not exist.', { extra: { executionId } });
		}
		if (fullExecutionData.finished) {
			throw new UnexpectedError('The execution did succeed and can so not be started again.');
		}

		if (!fullExecutionData.workflowData.id) {
			throw new UnexpectedError('Only saved workflows can be resumed.');
		}

		const workflowId = fullExecutionData.workflowData.id;
		const project = await this.ownershipService.getWorkflowProjectCached(workflowId);

		const data: IWorkflowExecutionDataProcess = {
			executionMode: fullExecutionData.mode,
			executionData: fullExecutionData.data,
			workflowData: fullExecutionData.workflowData,
			projectId: project.id,
			pushRef: fullExecutionData.data.pushRef,
			startedAt: fullExecutionData.startedAt,
		};

		// Start the execution again
		try {
			await this.workflowRunner.run(data, false, false, executionId);
		} catch (error) {
			if (error instanceof ExecutionAlreadyResumingError) {
				// This execution is already being resumed by another child execution
				// This is expected in "run once for each item" mode when multiple children complete
				this.logger.debug(
					`Execution ${executionId} is already being resumed, skipping duplicate resume`,
					{ executionId },
				);
				return;
			}
			// Rethrow any other errors
			throw error;
		}

		const { parentExecution } = fullExecutionData.data;
		if (shouldRestartParentExecution(parentExecution)) {
			// on child execution completion, resume parent execution
			void this.activeExecutions
				.getPostExecutePromise(executionId)
				.then(async (subworkflowResults) => {
					if (!subworkflowResults) return;
					if (subworkflowResults.status === 'waiting') return; // The child execution is waiting, not completing.
					await updateParentExecutionWithChildResults(
						this.executionRepository,
						parentExecution.executionId,
						subworkflowResults,
					);
					return subworkflowResults;
				})
				.then((subworkflowResults) => {
					if (!subworkflowResults) return;
					if (subworkflowResults.status === 'waiting') return; // The child execution is waiting, not completing.
					void this.startExecution(parentExecution.executionId);
				});
		}
	}

	@OnLeaderStepdown()
	stopTracking() {
		if (this.mainTimer) {
			clearInterval(this.mainTimer);
			this.mainTimer = undefined;
		}

		Object.keys(this.waitingExecutions).forEach((executionId) => {
			clearTimeout(this.waitingExecutions[executionId].timer);
		});

		this.logger.debug('Stopped tracking waiting executions');
	}
}
