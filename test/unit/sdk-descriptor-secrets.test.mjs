// WP2b: ExecutorDescriptor.config is persisted (worker.json, executor.json), so secret-looking
// values are refused with DESCRIPTOR_INVALID; secrets go through SubmitRequest.env (kept off disk).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertExecutorDescriptor,
	findSecretLikeConfigValues,
	validateExecutorDescriptor,
} from "../../dist/sdk/index.js";
import { runSubagent } from "../../dist/runtime/index.js";

const descriptor = (config) => ({
	id: "external",
	version: "1.0.0",
	contractVersion: "0.1.0",
	module: "/opt/adapters/external.mjs",
	config,
});

// Built at runtime so this file holds no token-shaped literal.
const fake = {
	openai: `sk-${"A1b2C3d4".repeat(3)}`,
	anthropic: `sk-ant-${"api03_x9Y8z7W6".repeat(2)}`,
	github: `ghp_${"aB3dE5gH7jK9".repeat(3)}`,
	slack: `xoxb-${"1234567890"}-${"abcdefABCDEF12"}`,
	aws: `AKIA${"ABCDEFGHIJKLMNOP"}`,
	hex: "0123456789abcdef".repeat(3),
	base64: `${"QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(2)}9Z`,
	pem: `-----BEGIN ${"RSA PRIVATE"} KEY-----\nMIIB...`,
};

test("secret-looking config values are refused, with the path and never the value", () => {
	for (const [label, config, path] of [
		["openai key", { apiKey: fake.openai }, "config.apiKey"],
		[
			"anthropic key anywhere",
			{ nested: { x: [fake.anthropic] } },
			"config.nested.x[0]",
		],
		["github token", { gh: fake.github }, "config.gh"],
		["slack token", { slack: fake.slack }, "config.slack"],
		["aws key id", { aws: fake.aws }, "config.aws"],
		["private key", { key: fake.pem }, "config.key"],
		["hex under token", { authToken: fake.hex }, "config.authToken"],
		[
			"base64 under secret",
			{ client_secret: fake.base64 },
			"config.client_secret",
		],
		[
			"hex under password in an array",
			{ passwords: [fake.hex] },
			"config.passwords[0]",
		],
		["top-level string", fake.github, "config"],
	]) {
		const findings = findSecretLikeConfigValues(config);
		assert.equal(findings.length, 1, `${label}: ${JSON.stringify(findings)}`);
		assert.ok(
			findings[0].startsWith(`${path} looks like a secret`),
			findings[0],
		);
		const problems = validateExecutorDescriptor(descriptor(config));
		assert.equal(problems.length, 1, label);
		assert.match(problems[0], /pass secrets through SubmitRequest\.env/u);
		for (const value of Object.values(fake))
			assert.equal(problems[0].includes(value), false, "value never echoed");
		assert.throws(
			() => assertExecutorDescriptor(descriptor(config)),
			(error) => error.code === "DESCRIPTOR_INVALID",
		);
	}
});

test("ordinary config is accepted (paths, ids, short or low-entropy values, hex under neutral keys)", () => {
	for (const config of [
		null,
		{},
		{
			effectLog:
				"/var/folders/ab/cd/T/aw-run-1234567890abcdefXYZ/effects.jsonl",
		},
		{ tokenFile: "/home/user/.config/agent/credentialsFileWithLongName" },
		{ model: "claude-sonnet-4", effort: "high", maxTokens: 4096 },
		{ token: "short" },
		{ commitSha: fake.hex },
		{ authMode: "oauth", apiKeyEnv: "OPENAI_API_KEY" },
		{ task: "the sk- prefix alone is not a key" },
	])
		assert.deepEqual(
			validateExecutorDescriptor(descriptor(config)),
			[],
			JSON.stringify(config),
		);
});

test("runSubagent refuses a run whose executor config carries a token, before anything is written", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-descriptor-secret-"));
	try {
		await assert.rejects(
			runSubagent({
				cwd,
				executor: descriptor({ apiKey: fake.openai }),
				task: "never",
				async: true,
			}),
			(error) =>
				error.name === "SubagentValidationError" &&
				/config\.apiKey looks like a secret/u.test(error.message) &&
				!error.message.includes(fake.openai),
		);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
