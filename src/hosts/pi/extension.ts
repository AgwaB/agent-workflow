// New in agent-workflow (WP11b): the minimal Pi host extension. Registers the `/aw` command, the
// `aw_list`/`aw_run`/`aw_dynamic`/`aw_wait` tools and the session-start unfinished-run notice, all
// over the host API (../api.ts). WP16: the status line and completion delivery of runs this session
// launched (feedback.ts), restored at session start and stopped at shutdown. No board; WP33 adds the
// active-workflows widget and the `/aw wait` loader (active-ui.ts).
// WP28: session start first re-drives the project's running runs that no live process drives
// (host API `redriveRunsAction`, port of pi-workflow `resumeSupervisors`), then shows the notice.
// This module only has type-level Pi dependencies (./pi-types.ts); the package entry `./hosts/pi`
// (index.ts) adds the Pi presence check.
import { isWorkflowSupervisorEnabled } from "../../core/process-role.js";
import { awArgumentCompletions, handleAwCommand } from "./command.js";
import type { PiRunFeedback } from "./feedback.js";
import { createPiHostDeps, hostContext, type PiHostOptions } from "./host.js";
import { AW_COMMAND } from "./names.js";
import { unfinishedRunNotice } from "./notices.js";
import {
	flushRunParentUsage,
	recordRunParentUsage,
	resumeRunParentUsage,
} from "./parent-usage.js";
import type { PiExtensionApi } from "./pi-types.js";
import { registerAwTools } from "./tools.js";

export type { PiHostApi, PiHostOptions } from "./host.js";

/** Build the Pi extension factory (tests inject a recording host API, env and clock). */
export function createAgentWorkflowPiExtension(
	options: PiHostOptions = {},
): (pi: PiExtensionApi) => void {
	return (pi) => {
		const deps = createPiHostDeps(pi, options);
		feedbackByPi.set(pi, deps.feedback);
		// Worker or disabled processes (AGENT_WORKFLOW_ROLE) get no agent tools and no notices, so a
		// Pi worker that loads this package cannot start nested workflows; `/aw help` and
		// `/aw validate` stay available (the host API enforces the role per action).
		const supervisor = isWorkflowSupervisorEnabled(deps.env);
		let session = 0;
		let lastNotice: Promise<void> = Promise.resolve();

		pi.on("session_start", (_event, ctx) => {
			session += 1;
			deps.feedback.stop();
			if (!supervisor) return;
			const current = session;
			// Not awaited: the notice never delays Pi startup.
			lastNotice = (async () => {
				try {
					await deps.ready();
					// WP28: pick up attached runs left running by a gone process (this Pi
					// session's earlier process, another session, a CLI). Delivery stays with
					// each run's audience (feedback.restore below binds nothing).
					await deps.api
						.redriveRunsAction(hostContext(deps, ctx))
						.catch(() => undefined);
				} catch {
					// Re-driving is best effort; a run that is not picked up still has /aw wait.
				}
				try {
					await deps.ready();
					const text = await unfinishedRunNotice(
						deps.api,
						hostContext(deps, ctx),
						deps.now(),
					);
					if (text && current === session && ctx.hasUI)
						ctx.ui.notify(text, "warning");
				} catch {
					// Notices are advisory; unreadable run state never breaks a session.
				}
				// WP16: keep tracking this session's active runs and deliver the ones that
				// settled while it was not running (receipts prevent a second delivery).
				if (current === session)
					await deps.feedback.restore(ctx).catch(() => undefined);
				// WP33: keep counting the parent usage of this session's running runs.
				if (current === session) await resumeRunParentUsage(ctx);
			})();
			noticeSettled.set(pi, () => lastNotice);
		});
		// WP19 round 4 (F1): the shutdown reason tells whether Pi keeps the session's queue
		// (`reload`) or disposes it (`new`/`resume`/`fork`/`quit`).
		pi.on("session_shutdown", async (event, ctx) => {
			session += 1;
			// A pending `/aw auto` of the ended session starts nothing (pi-workflow parity).
			deps.endSession();
			await deps.feedback.shutdown(event, ctx);
			if (supervisor) await flushRunParentUsage(ctx);
		});
		// WP33 (parity row 33): the parent session's assistant usage while its runs are active.
		pi.on("message_end", (event, ctx) => {
			if (!supervisor) return;
			return recordRunParentUsage(ctx, event?.message);
		});

		if (supervisor) registerAwTools(pi, deps);

		pi.registerCommand(AW_COMMAND, {
			description:
				"agent-workflow: list, validate and run workflows on Pi, Codex or Claude workers (/aw help)",
			getArgumentCompletions: awArgumentCompletions,
			handler: (args, ctx) => handleAwCommand(deps, args, ctx),
		});
	};
}

const noticeSettled = new WeakMap<PiExtensionApi, () => Promise<void>>();
const feedbackByPi = new WeakMap<PiExtensionApi, PiRunFeedback>();

/** Tests: the status-line/completion-delivery tracker of this extension instance. */
export function piRunFeedbackForTests(
	pi: PiExtensionApi,
): PiRunFeedback | undefined {
	return feedbackByPi.get(pi);
}

/** Tests: resolves when the session-start notice (and feedback restore) of this instance finished. */
export function unfinishedNoticeSettledForTests(
	pi: PiExtensionApi,
): Promise<void> {
	return noticeSettled.get(pi)?.() ?? Promise.resolve();
}

/** The Pi extension (default export of `@agwab/agent-workflow/hosts/pi`). */
const agentWorkflowPiExtension: (pi: PiExtensionApi) => void =
	createAgentWorkflowPiExtension();

export default agentWorkflowPiExtension;
