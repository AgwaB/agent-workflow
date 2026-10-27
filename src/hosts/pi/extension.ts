// New in agent-workflow (WP11b): the minimal Pi host extension. Registers the `/aw` command, the
// `aw_list`/`aw_run`/`aw_dynamic`/`aw_wait` tools and the session-start unfinished-run notice, all
// over the host API (../api.ts). Stage 1 has no board, widgets, completion-feedback delivery or
// TUI profile picker. This module only has type-level Pi dependencies (./pi-types.ts); the package
// entry `./hosts/pi` (index.ts) adds the Pi presence check.
import { isWorkflowSupervisorEnabled } from "../../core/process-role.js";
import { awArgumentCompletions, handleAwCommand } from "./command.js";
import { createPiHostDeps, hostContext, type PiHostOptions } from "./host.js";
import { AW_COMMAND } from "./names.js";
import { unfinishedRunNotice } from "./notices.js";
import type { PiExtensionApi } from "./pi-types.js";
import { registerAwTools } from "./tools.js";

export type { PiHostApi, PiHostOptions } from "./host.js";

/** Build the Pi extension factory (tests inject a recording host API, env and clock). */
export function createAgentWorkflowPiExtension(
	options: PiHostOptions = {},
): (pi: PiExtensionApi) => void {
	return (pi) => {
		const deps = createPiHostDeps(pi, options);
		// Worker or disabled processes (AGENT_WORKFLOW_ROLE) get no agent tools and no notices, so a
		// Pi worker that loads this package cannot start nested workflows; `/aw help` and
		// `/aw validate` stay available (the host API enforces the role per action).
		const supervisor = isWorkflowSupervisorEnabled(deps.env);
		let session = 0;
		let lastNotice: Promise<void> = Promise.resolve();

		pi.on("session_start", (_event, ctx) => {
			session += 1;
			if (!supervisor) return;
			const current = session;
			// Not awaited: the notice never delays Pi startup.
			lastNotice = (async () => {
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
			})();
			noticeSettled.set(pi, () => lastNotice);
		});
		pi.on("session_shutdown", () => {
			session += 1;
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

/** Tests: resolves when the session-start notice of this extension instance has finished. */
export function unfinishedNoticeSettledForTests(
	pi: PiExtensionApi,
): Promise<void> {
	return noticeSettled.get(pi)?.() ?? Promise.resolve();
}

/** The Pi extension (default export of `@agwab/agent-workflow/hosts/pi`). */
const agentWorkflowPiExtension: (pi: PiExtensionApi) => void =
	createAgentWorkflowPiExtension();

export default agentWorkflowPiExtension;
