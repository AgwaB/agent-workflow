// /aw run <name>: workflow names are completed from the discovered catalog, as pi-workflow does.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { awArgumentCompletions } from "../../dist/hosts/pi/command.js";
import { createAgentWorkflowPiExtension } from "../../dist/hosts/pi/extension.js";
import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

test("workflow-name actions complete names; other actions and later words do not", () => {
	const names = ["deep-review", "deep-research", "spec-review"];
	assert.deepEqual(awArgumentCompletions("run ", names), [
		{ value: "run deep-review ", label: "deep-review" },
		{ value: "run deep-research ", label: "deep-research" },
		{ value: "run spec-review ", label: "spec-review" },
	]);
	assert.deepEqual(
		awArgumentCompletions("validate deep-re", names)?.map((item) => item.label),
		["deep-review", "deep-research"],
	);
	for (const action of ["check", "roles", "show"])
		assert.equal(awArgumentCompletions(`${action} spec`, names)?.length, 1);
	assert.equal(awArgumentCompletions("run nothing", names), null);
	assert.equal(awArgumentCompletions("status deep", names), null);
	assert.equal(awArgumentCompletions("run spec-review task", names), null);
	assert.deepEqual(
		awArgumentCompletions("ru", names)?.map((item) => item.value),
		["run"],
	);
});

test("the /aw command completes workflow names discovered at session start", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-complete-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const pi = fakePi();
	createAgentWorkflowPiExtension({
		env: { ...process.env, AGENT_WORKFLOW_ROLE: "worker" },
	})(pi);
	const complete = pi.commands.get("aw").getArgumentCompletions;
	assert.equal(
		complete("run "),
		null,
		"nothing known before the session starts",
	);
	for (const handler of pi.handlers.get("session_start"))
		await handler({ type: "session_start", reason: "startup" }, fakeCtx(cwd));
	await eventually(() => (complete("run ")?.length ?? 0) > 0);
	assert.ok(
		complete("run ").some((item) => item.value === "run deep-review "),
		"bundled workflows are offered",
	);
});
