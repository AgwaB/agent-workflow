// Pi host extension over the host API: commands, tools, notices, status, and completion delivery.
// Restore tracking at session start and stop it at shutdown. Re-drive runs without a
// live driver before showing notices. Runtime Pi presence checks belong to index.ts.
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
import { withProjectContext } from "./project-context.js";

export type { PiHostApi, PiHostOptions } from "./host.js";

/** Build the Pi extension factory (tests inject a recording host API, env and clock). */
export function createAgentWorkflowPiExtension(
	options: PiHostOptions = {},
): (pi: PiExtensionApi) => void {
	return (piApi) => {
		const deps = createPiHostDeps(piApi, options);
		feedbackByPi.set(piApi, deps.feedback);
		// 2026-11-04: handlers see the run project as ctx.cwd (never ~ itself; project-context.ts).
		const pi = withProjectContext(piApi, deps.env);
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
			noticeSettled.set(piApi, () => lastNotice);
		});
		// WP19 round 4 (F1): the shutdown reason tells whether Pi keeps the session's queue
		// (`reload`) or disposes it (`new`/`resume`/`fork`/`quit`).
		pi.on("session_shutdown", async (event, ctx) => {
			session += 1;
			// A pending /aw auto of an ended session starts nothing.
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
