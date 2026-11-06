// The board reads and acts only through host API handlers: status, show, logs, stop,
// resume, and approve. Logs are bounded and redacted; copying uses Pi copyToClipboard.
import type {
	LogsTask,
	RunSummary,
	StatusData,
	showRunAction,
} from "../api.js";
import type { PiHostDeps } from "./host.js";
import { hostContext, levelForOutcome } from "./host.js";
import type { PiExtensionContext, PiNotifyLevel } from "./pi-types.js";
import { loadPiRuntimeModule } from "./pi-runtime.js";

export type BoardRun = NonNullable<StatusData["run"]>;
export type BoardRunRecord = Awaited<
	ReturnType<typeof showRunAction>
>["data"]["run"];
export type BoardLaunch = Awaited<
	ReturnType<typeof showRunAction>
>["data"]["launch"];

export interface BoardRunDetail {
	/** `statusAction` data: summary, per-task runtime, verdict, reports, pending approvals. */
	run: BoardRun;
	/** `showAction` data: the run record (stages, task names, agents, timestamps). */
	record?: BoardRunRecord;
	/** WP33 launch capture (`showAction`). */
	launch?: BoardLaunch;
}

export interface BoardActionResult {
	text: string;
	level: PiNotifyLevel;
}

/** Everything the board reads or changes. Tests pass fakes. */
export interface AwBoardSource {
	listRuns(): Promise<RunSummary[]>;
	runDetail(runId: string): Promise<BoardRunDetail>;
	taskLogs(runId: string, taskId: string): Promise<LogsTask | undefined>;
	stop(runId: string): Promise<BoardActionResult>;
	resume(runId: string): Promise<BoardActionResult>;
	copy(text: string): Promise<void>;
}

/** Task log lines shown in the detail view (the host API maximum). */
export const BOARD_LOG_LINES = 400;

/** Pi 1.1's `copyToClipboard` (OSC 52, else the platform's copy command). */
export async function piCopyToClipboard(text: string): Promise<void> {
	const pi = (await loadPiRuntimeModule()) as {
		copyToClipboard?: (text: string) => Promise<void>;
	};
	if (typeof pi.copyToClipboard !== "function")
		throw new Error("copyToClipboard is not available in this Pi");
	await pi.copyToClipboard(text);
}

/**
 * The host API source of one board. `onLaunched` tracks a resumed or approved run for the WP16
 * status line and completion delivery, like `/aw resume` and `/aw approve` do.
 */
export function piBoardSource(
	deps: PiHostDeps,
	ctx: PiExtensionContext,
	onLaunched: (
		action: string,
		data: { runId?: unknown; status?: unknown } | undefined,
	) => Promise<void>,
	copy: (text: string) => Promise<void> = piCopyToClipboard,
): AwBoardSource {
	const host = () => hostContext(deps, ctx);
	const outcome = (result: {
		text: string;
		outcome: Parameters<typeof levelForOutcome>[0];
	}): BoardActionResult => ({
		text: result.text,
		level: levelForOutcome(result.outcome),
	});
	return {
		async listRuns() {
			return (await deps.api.statusAction(host(), {})).data.runs ?? [];
		},
		async runDetail(runId) {
			const [status, shown] = await Promise.all([
				deps.api.statusAction(host(), { runId }),
				deps.api.showAction(host(), { ref: runId }).catch(() => undefined),
			]);
			const run = status.data.run;
			if (!run) throw new Error(`run ${runId} not found`);
			const data = shown?.data as
				| { kind?: string; run?: BoardRunRecord; launch?: BoardLaunch }
				| undefined;
			return {
				run,
				...(data?.kind === "run" && data.run ? { record: data.run } : {}),
				...(data?.kind === "run" && data.launch ? { launch: data.launch } : {}),
			};
		},
		async taskLogs(runId, taskId) {
			const logs = await deps.api.logsAction(host(), {
				runId,
				task: taskId,
				lines: BOARD_LOG_LINES,
				stream: "all",
			});
			return logs.data.tasks[0];
		},
		async stop(runId) {
			return outcome(await deps.api.stopAction(host(), { runId }));
		},
		async resume(runId) {
			const resumed = await deps.api.resumeAction(host(), { runId });
			await onLaunched("resume", resumed.data);
			return outcome(resumed);
		},
		copy,
	};
}
