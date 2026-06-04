#!/usr/bin/env node
// Fetches secrets from Infisical using universal auth, injects them into the
// environment, then spawns the given command. Skips gracefully if any required
// var is missing (falls back to whatever env is already set).

import { spawn } from 'child_process';

const {
	INFISICAL_SITE_URL,
	INFISICAL_CLIENT_ID,
	INFISICAL_CLIENT_SECRET,
	INFISICAL_PROJECT_ID,
	INFISICAL_ENV = 'prod',
	INFISICAL_SECRET_PATH = '/',
} = process.env;

async function fetchSecrets() {
	if (!INFISICAL_SITE_URL || !INFISICAL_CLIENT_ID || !INFISICAL_CLIENT_SECRET || !INFISICAL_PROJECT_ID) {
		console.warn('[infisical-bootstrap] Missing Infisical vars — skipping secret injection');
		return;
	}

	const base = INFISICAL_SITE_URL.replace(/\/$/, '');

	const tokenRes = await fetch(`${base}/api/v1/auth/universal-auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ clientId: INFISICAL_CLIENT_ID, clientSecret: INFISICAL_CLIENT_SECRET }),
	});

	if (!tokenRes.ok) {
		console.error(`[infisical-bootstrap] Auth failed: ${tokenRes.status} ${await tokenRes.text()}`);
		return;
	}

	const { accessToken } = await tokenRes.json();

	const secretsRes = await fetch(
		`${base}/api/v3/secrets/raw?workspaceId=${INFISICAL_PROJECT_ID}&environment=${INFISICAL_ENV}&secretPath=${encodeURIComponent(INFISICAL_SECRET_PATH)}&expandSecretReferences=true`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);

	if (!secretsRes.ok) {
		console.error(`[infisical-bootstrap] Secrets fetch failed: ${secretsRes.status} ${await secretsRes.text()}`);
		return;
	}

	const { secrets } = await secretsRes.json();
	let injected = 0;

	for (const { secretKey, secretValue } of secrets) {
		if (!process.env[secretKey]) {
			process.env[secretKey] = secretValue;
			injected++;
		}
	}

	console.log(`[infisical-bootstrap] Injected ${injected} secrets from Infisical (${INFISICAL_ENV})`);
}

await fetchSecrets();

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { env: process.env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
