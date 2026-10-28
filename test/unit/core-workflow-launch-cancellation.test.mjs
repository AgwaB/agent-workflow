// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/workflow-launch-cancellation.test.mjs.
// MIT, same author. Changes: imports from dist/core. Only "launch cancellation fences are run-scoped
// and released by their owner" is ported; the 14 `auto …` tests drive pi-workflow's `/workflow auto`
// router launch through the Pi TUI loader, and agent-workflow has no `/aw auto` (docs/pi-host.md
// "Known limits"; docs/core-port.md "WP38").
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	bindWorkflowLaunchSignal,
	throwIfWorkflowStopRequested,
} from "../../dist/core/workflow-stop.js";

test("launch cancellation fences are run-scoped and released by their owner", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-launch-signal-scope-"));
	const controller = new AbortController();
	const dispose = bindWorkflowLaunchSignal(
		cwd,
		"workflow_owned",
		controller.signal,
	);
	try {
		controller.abort();
		await assert.rejects(
			() => throwIfWorkflowStopRequested(cwd, "workflow_owned"),
			{
				name: "WorkflowStopRequested",
			},
		);
		await throwIfWorkflowStopRequested(cwd, "workflow_other");
		dispose();
		await throwIfWorkflowStopRequested(cwd, "workflow_owned");
	} finally {
		dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});
