// New in agent-workflow (WP42 review round 1, finding 1): a session that ends after the auto
// final choice — while the launch path still asks (the declared-profile chooser, the capability
// degradation confirm) — must publish nothing and submit nothing. The stale dialog answers as if
// the user agreed; the ended session's launch is fenced by the original abort signal.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import {
	autoProject,
	core,
	piAutoSession,
	READY,
	runCount,
	shadowExecutors,
	submits,
} from "../helpers/pi-auto-harness.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const sessions = [];

before(async () => {
	root = await realpath(
		await mkdtemp(join(tmpdir(), "aw-wp42-auto-late-cancel-")),
	);
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.shutdown();
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const env = await autoProject(cwd, join(root, `home${counter}`), [
		["review-cancel", "Review source code."],
	]);
	return { cwd, env, log: join(root, `effects-${counter}.jsonl`) };
}

test("session shutdown inside the post-auto profile chooser publishes nothing and submits nothing", async () => {
	const { cwd, env, log } = await project();
	const file = join(cwd, "workflows", "review-cancel", "spec.json");
	const spec = JSON.parse(await readFile(file, "utf8"));
	spec.executionProfiles = { quick: {} };
	await writeFile(file, JSON.stringify(spec));
	unregister.push(...shadowExecutors(log, { recommend: "review-cancel" }));
	let ended = false;
	const pi = piAutoSession(cwd, env, {
		select: async (options, title) => {
			if (title.startsWith("Choose execution profile")) {
				ended = true;
				await pi.shutdown();
			}
			return options[0];
		},
	});
	sessions.push(pi);
	await pi.command('auto "Review source code."');
	assert.equal(ended, true, "the profile chooser was shown");
	assert.equal(await runCount(cwd), 0, "no run was published");
	assert.equal(submits(log).classifier.length, 1);
	assert.equal(submits(log).workflow.length, 0, "no worker submit");
	const notes = pi.ctx.notes.map(({ message }) => message).join("\n");
	assert.match(notes, /cancelled/i);
	assert.doesNotMatch(notes, /Workflow started|Run: workflow_/);
});

test("session shutdown inside the capability degradation confirm publishes nothing and submits nothing", async () => {
	const { cwd, env, log } = await project();
	// pi has an emulated capability: a safe-mode interactive launch asks to confirm degradations.
	for (const id of ["pi", "claude", "codex"])
		unregister.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					effectLog: log,
					autoRecommend: "review-cancel",
					probe: READY,
					capabilities: {
						contextIsolation: {
							level: "emulated",
							source: "probed",
							warning: "global AGENTS.md loaded",
						},
					},
				}),
			),
		);
	let ended = false;
	const pi = piAutoSession(cwd, env, {
		async confirm(title, _message, current) {
			if (title.startsWith("Proceed with these executor capability")) {
				ended = true;
				await current.shutdown();
			}
			return true;
		},
	});
	sessions.push(pi);
	await pi.command('auto "Review source code." --permission-mode safe');
	assert.equal(ended, true, "the degradation confirm was shown");
	assert.equal(await runCount(cwd), 0, "no run was published");
	assert.equal(submits(log).classifier.length, 1);
	assert.equal(submits(log).workflow.length, 0, "no worker submit");
	const notes = pi.ctx.notes.map(({ message }) => message).join("\n");
	assert.match(notes, /cancelled/i);
	assert.doesNotMatch(notes, /Workflow started|Run: workflow_/);
});
