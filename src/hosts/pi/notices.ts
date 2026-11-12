// Pi's session-start notice: the host-neutral unfinished-run reminder (../unfinished-notice.ts,
// 2026-11-12) with Pi's /aw commands. Claude Code and Codex get the same reminder through
// `notify-check` in their prompt hook.
import type { HostApiContext } from "../api.js";
import { unfinishedRunReminder } from "../unfinished-notice.js";
import type { PiHostApi } from "./host.js";

/**
 * The notice text for this session start, or undefined when nothing needs a notice. Records the
 * notified runs so the next session within 6 hours stays quiet about unchanged runs.
 */
export function unfinishedRunNotice(
	api: Pick<PiHostApi, "noticesAction">,
	ctx: HostApiContext,
	nowMs: number,
): Promise<string | undefined> {
	return unfinishedRunReminder(api, ctx, nowMs, { host: "pi" });
}
