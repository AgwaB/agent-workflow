// test-tier: integration
// Live bundle 5 (WP39), D6: `agent-workflow doctor` on a loaded machine said Pi's auth was
// "unknown" and "could not check for pi-web-access (`pi list` failed)" although pi-web-access is
// installed: `pi --list-models` took 4.2–5.4 s and a cold `pi list` 4.1 s, over the probe's 4 s
// bound. A failed `pi list` was also cached for the executor's life, so one slow call refused every
// later web stage in that process. Stub Pi CLIs only; no model or agent-CLI calls.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createExecutor } from "../../dist/executors/pi/index.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
	isSdkError,
} from "../../dist/sdk/index.js";
import { PROBE_SCRIPTS } from "../fixtures/executors/pi/harness.mjs";

const roots = [];
after(async () => {
	for (const dir of roots)
		await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});
async function scratch() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "aw-wp39-pi-")));
	roots.push(dir);
	return dir;
}

const SLOW_MS = 5_000;

test("probe: `pi --list-models` and `pi list` slower than 4 s still count (auth ok, pi-web-access found)", async () => {
	const dir = await scratch();
	const scripts = PROBE_SCRIPTS.map((script) =>
		script.name === "list-models"
			? { ...script, steps: [{ sleepMs: SLOW_MS }, ...script.steps] }
			: script.name === "package-list"
				? {
						...script,
						steps: [
							{ sleepMs: SLOW_MS },
							{ stdout: "User packages:" },
							{ stdout: "  npm:pi-web-access@0.44.0" },
							{ stdout: "    /x/node_modules/pi-web-access" },
						],
					}
				: script,
	);
	const cli = await createStubCli({ dir, name: "pi", scripts });
	const probe = await createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	}).probe();
	assert.equal(probe.installed, true);
	assert.equal(probe.auth, "ok", probe.notes.join("\n"));
	assert.equal(probe.webAccessExtension, "/x/node_modules/pi-web-access");
	assert.equal(probe.capabilities.webTools.level, "native");
});

test("submit: a failed `pi list` is not cached; the next web stage asks again", async () => {
	const dir = await scratch();
	const scripts = [
		...PROBE_SCRIPTS.filter((script) => script.name !== "package-list"),
		{
			name: "package-list",
			when: { argvIncludes: ["list"] },
			// Counted by effectCount(): one per `pi list` invocation.
			effect: true,
			steps: [{ stderr: "timed out" }, { exit: 2 }],
		},
	];
	const cli = await createStubCli({ dir, name: "pi", scripts });
	const executor = createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	});
	for (let index = 0; index < 2; index += 1) {
		const attemptKey = `wp39-web-${process.pid}-${index}`;
		const gate = createAuthorityGate({ attemptKey });
		await assert.rejects(
			executor.submit({
				attemptKey,
				authority: gate.authority,
				cwd: dir,
				prompt: "hello",
				tools: ["read", "web_search"],
				readOnly: true,
				mcpServers: [],
				deadlineMs: Date.now() + 60_000,
				env: {},
				isolation: { inherit: false },
				approvalPolicy: defaultApprovalPolicy(),
			}),
			(error) => isSdkError(error, "CAPABILITY_MISSING"),
		);
		assert.equal(gate.state(), "pending");
	}
	assert.equal(await cli.effectCount(), 2, "`pi list` ran for each submit");
});
