#!/usr/bin/env node

import { execSync } from 'node:child_process';

// Skip lefthook install in CI, container builds, or hosted build environments
if (process.env.CI || process.env.DOCKER_BUILD || process.env.RAILWAY_ENVIRONMENT) {
	process.exit(0);
}

// lefthook git hooks are a local-dev convenience; never let a failure here
// break installs in environments without a git repo (e.g. build images).
try {
	execSync('pnpm lefthook install', { stdio: 'inherit' });
} catch {
	console.warn('Skipping lefthook install (not available in this environment)');
}
