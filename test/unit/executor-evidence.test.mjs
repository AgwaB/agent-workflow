// WP12d-2 review #3: unreadable launch evidence is never proven absence. For every adapter a
// missing record reconciles `absent`, but a malformed, unreadable or mismatched record reconciles
// `unknown` (owner decision), and submit refuses before consuming the authority.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import {
	attemptDigest as codexDigest,
	createCodexExecutor,
} from "../../dist/executors/codex/index.js";
import { createPiExecutor } from "../../dist/executors/pi/index.js";
import { attemptDigest as piDigest } from "../../dist/executors/pi/state.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";

const ADAPTERS = {
	claude: {
		create: (stateDir) =>
			createClaudeExecutor({
				config: parseClaudeConfig({
					claudePath: "/nonexistent/claude",
					stateDir,
					claudeConfigDir: join(stateDir, "claude-config"),
				}),
			}),
		path: (stateDir, key) =>
			join(
				stateDir,
				"attempts",
				`${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`,
			),
		schema: "agent-workflow-claude-attempt-v1",
		consumed: { phase: "consumed", sessionId: null, keepSession: false },
	},
	codex: {
		create: (stateDir) =>
			createCodexExecutor({ codexPath: "/nonexistent/codex", stateDir }),
		path: (stateDir, key) =>
			join(stateDir, "attempts", `${codexDigest(key)}.json`),
		schema: "agent-workflow-codex-attempt-v1",
		consumed: { phase: "consumed" },
	},
	pi: {
		create: (stateDir) =>
			createPiExecutor({ piCommand: "/nonexistent/pi", stateDir }),
		path: (stateDir, key) =>
			join(stateDir, "attempts", `${piDigest(key)}.json`),
		schema: "agent-workflow-pi-attempt-v1",
		consumed: { phase: "consumed" },
	},
};

function request(cwd, attemptKey, gate) {
	return {
		attemptKey,
		authority: gate.authority,
		cwd,
		prompt: "hi",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
	};
}

for (const [name, adapter] of Object.entries(ADAPTERS)) {
	test(`review #3 (${name}): only a missing record reconciles absent`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), `aw-evidence-${name}-`));
		t.after(() =>
			rm(dir, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			}),
		);
		const stateDir = join(dir, "state");
		const executor = adapter.create(stateDir);
		assert.deepEqual(await executor.reconcile("missing-1"), { absent: true });

		const cases = {
			malformed: async (path) => writeFile(path, "{not json"),
			empty: async (path) => writeFile(path, ""),
			directory: async (path) => mkdir(path, { recursive: true }),
			mismatched: async (path) =>
				writeFile(
					path,
					JSON.stringify({
						schema: adapter.schema,
						attemptKey: "someone-else",
						updatedAt: new Date().toISOString(),
						...adapter.consumed,
					}),
				),
		};
		for (const [label, damage] of Object.entries(cases)) {
			const key = `${label}-1`;
			const path = adapter.path(stateDir, key);
			await mkdir(join(stateDir, "attempts"), { recursive: true });
			await damage(path);
			const result = await executor.reconcile(key);
			assert.equal(
				result.unknown,
				true,
				`${label}: ${JSON.stringify(result)} must be unknown`,
			);
			assert.equal("absent" in result, false, `${label} is not absence`);
			const gate = createAuthorityGate({ attemptKey: key });
			await assert.rejects(
				executor.submit(request(dir, key, gate)),
				(error) => error.code === "AUTHORITY_ALREADY_CONSUMED",
				`${label}: submit refuses`,
			);
			assert.equal(gate.state(), "pending", `${label}: authority not consumed`);
		}
	});
}
