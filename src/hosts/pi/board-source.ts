// New in agent-workflow (WP34, parity row 22): what the `/aw` board reads and does, through the host
// API only. pi-workflow 0.16.4 (b83cc4f) src/workflow-view.ts read its run store directly
// (`readIndex`, `readRunRecord`, `readWorkflowLaunchCommandArtifact`, the task output/prompt files);
// the board here calls host API handlers: `statusAction` (runs; one run with its per-task
// executor/model/effort, verdict, report paths, pending approvals and parent usage), `showAction`
// (the run record and its WP33 launch capture, redacted), `logsAction` (the task's bounded,
// redacted output/stderr/events tails), and `stopAction`, `resumeAction`, `approveAction` for the
// board's keys. Copying uses Pi 1.1's exported `copyToClipboard`.
import type {
	LogsTask,
	RunSummary,
	StatusData,
	showRunAction,
} from "../api.js";
import type { PiHostDeps } from "./host.js";
import { hostContext, levelForOutcome } from "./host.js";
import type { PiExtensionContext, PiNotifyLevel } from "./pi-types.js";

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
	approve(
		runId: string,
		requestId: string,
		decision: "approve" | "reject",
	): Promise<BoardActionResult>;
	copy(text: string): Promise<void>;
}

/** Task log lines shown in the detail view (the host API maximum). */
export const BOARD_LOG_LINES = 400;

// Not a string literal on purpose: the package builds without the optional Pi peer.
const PI_PACKAGE: string = ["@earendil-works", "pi-coding-agent"].join("/");

/** Pi 1.1's `copyToClipboard` (OSC 52, else the platform's copy command). */
export async function piCopyToClipboard(text: string): Promise<void> {
	const pi = (await import(PI_PACKAGE)) as {
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
		async approve(runId, requestId, decision) {
			const approved = await deps.api.approveAction(host(), {
				runId,
				requestId,
				decision,
			});
			await onLaunched("approve", approved.data);
			return outcome(approved);
		},
		copy,
	};
}
