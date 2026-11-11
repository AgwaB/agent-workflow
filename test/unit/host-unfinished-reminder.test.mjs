// 2026-11-12 (owner: the unfinished-run notice was Pi-only — solve it generally): a whole-project
// notify-check (the Claude Code and Codex prompt hook) carries the same reminder as Pi's session
// start, with the host's own commands; quiet for six hours, not added to one run's check, and
// silenced by the shared acknowledgement.
import {
	assert,
	makeProject,
	rmSync,
	test,
	writeUnfinishedNoticeIndex,
	writeUnfinishedNoticeIndexRun,
} from "../helpers/unit-test-support.mjs";
import { notifyCheck } from "../../dist/hosts/notify-check.js";
import { executeWorkflowNoticesCommand } from "../../dist/core/workflow-notices.js";

const HOUR = 60 * 60 * 1000;

test("notify-check reminds about unfinished runs on every host, every six hours, until dismissed", async () => {
	const cwd = makeProject();
	try {
		writeUnfinishedNoticeIndex(cwd, [
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_recent",
				name: "deep-research",
			}),
		]);
		const start = Date.parse("2026-06-12T12:00:00.000Z");
		const first = await notifyCheck(cwd, { host: "claude-code", now: start });
		assert.match(
			first.text,
			/^Unfinished agent-workflow run in this project:/m,
		);
		assert.match(
			first.text,
			/- deep-research workflow_recent: failed \(updated 2026-06-11T00:00:00\.000Z\) \[state [a-f0-9]{64}\] — workflow_resume \{"runId":"workflow_recent"\}/,
		);
		assert.match(first.text, /dismiss it in the dashboard \(Maintenance\)/);
		assert.equal(first.data.reminder, first.text);

		assert.equal(
			(await notifyCheck(cwd, { host: "claude-code", now: start + HOUR })).text,
			"",
			"quiet within six hours",
		);
		assert.equal(
			(
				await notifyCheck(cwd, {
					host: "codex",
					now: start + 7 * HOUR,
					runId: "workflow_recent",
				})
			).text,
			"",
			"one run's check (a wake) adds no reminder",
		);
		const again = await notifyCheck(cwd, {
			host: "codex",
			now: start + 7 * HOUR,
		});
		assert.match(again.text, /workflow_resume \{"runId":"workflow_recent"\}/);
		assert.match(again.text, /workflow_notices \{"action":"acknowledge"/);

		const listed = JSON.parse(
			await executeWorkflowNoticesCommand(cwd, ["list", "--json"]),
		);
		await executeWorkflowNoticesCommand(cwd, [
			"acknowledge",
			"workflow_recent",
			"--state",
			listed.notices[0].sha256,
			"--reason",
			"handled",
		]);
		assert.equal(
			(await notifyCheck(cwd, { host: "codex", now: start + 14 * HOUR })).text,
			"",
			"dismissed everywhere",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
