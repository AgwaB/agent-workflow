// New in agent-workflow (WP33): per-run sidecars the host API shows in `status`/`show`/`inspect`.
// Item 3 (parity row 33): parent-session usage (`parent-usage.json`, written by the Pi host while
// its session drives a run; pi-workflow showed it in the board's run detail). Only totals are
// returned: never the session's message hashes.
import {
	isWorkflowRunLaunchMetadata,
	readWorkflowLaunchCommandArtifact,
} from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";
import {
	readParentUsage,
	type WorkflowParentUsageRecord,
} from "../core/workflow-parent-usage.js";

export interface ParentUsageSummary {
	source: "parent-session";
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	reasoningTokens?: number;
	costUsd?: number;
	assistantMessages: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	lastWriteFailure?: WorkflowParentUsageRecord["lastWriteFailure"];
}

const USAGE_KEYS = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
	"reasoningTokens",
	"costUsd",
] as const;

/** The parent-usage totals of a run, or undefined when no host session recorded any. */
export async function parentUsageSummary(
	cwd: string,
	runId: string,
): Promise<ParentUsageSummary | undefined> {
	const record = await readParentUsage(cwd, runId).catch(() => undefined);
	if (!record) return undefined;
	const summary: ParentUsageSummary = {
		source: "parent-session",
		assistantMessages: record.assistantMessages,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		...(record.completedAt ? { completedAt: record.completedAt } : {}),
		...(record.lastWriteFailure
			? { lastWriteFailure: record.lastWriteFailure }
			: {}),
	};
	for (const key of USAGE_KEYS) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value))
			summary[key] = value;
	}
	return summary;
}

const count = (value: number | undefined) =>
	value === undefined ? "n/a" : Math.round(value).toLocaleString("en-US");

/** One line: `Parent session usage: 1,234 tokens (in 1,000, out 234, cache r/w 0/0), $0.0123, 2 messages`. */
export function formatParentUsage(summary: ParentUsageSummary): string {
	const total =
		summary.totalTokens ??
		(summary.inputTokens ?? 0) + (summary.outputTokens ?? 0);
	const cost =
		summary.costUsd === undefined ? "" : `, $${summary.costUsd.toFixed(4)}`;
	const messages = `${summary.assistantMessages} assistant message${summary.assistantMessages === 1 ? "" : "s"}`;
	const state = summary.completedAt ? "" : " (counting)";
	return `Parent session usage: ${count(total)} tokens (in ${count(summary.inputTokens)}, out ${count(summary.outputTokens)}, cache read/write ${count(summary.cacheReadInputTokens)}/${count(summary.cacheCreationInputTokens)})${cost}, ${messages}${state}`;
}

// Item 4 (parity row 35): launch capture (`run.launch` + `launch-command.txt`), shown by
// `show <run>` and `inspect <run>` (the WP34 board will use it too). The command text was redacted
// when it was captured; it is read through the core's verified reader (digest, size, no symlinks).

export interface LaunchSummary {
	schema: string;
	/** `cli`, `pi`, `mcp:<host>`; pi-workflow records: `pi-workflow`. */
	source: string;
	/** `command run`, `tool aw_run`, … */
	entry: string;
	requestKind: string;
	profile: string;
	task: { characters: number; lines: number };
	command:
		| {
				state: "captured";
				fidelity: string;
				bytes: number;
				text?: string;
				error?: string;
		  }
		| { state: "unavailable"; reason: string };
	/**
	 * WP32: a confirmed `auto` launch: the chosen workflow, how many candidates were offered, the
	 * classifier executor/model and how consent was given.
	 */
	auto?: {
		selected: string;
		candidates: number;
		recommended: string | null;
		choseRecommendation: boolean;
		classifier: { executor: string; model: string | null };
		consent: string;
	};
}

const MAX_SHOWN_COMMAND_CHARS = 4000;

/** The launch provenance of a run, or undefined for runs created without one. */
export async function launchSummary(
	cwd: string,
	run: Pick<WorkflowRunRecord, "runId" | "launch">,
): Promise<LaunchSummary | undefined> {
	const launch = run.launch;
	if (!isWorkflowRunLaunchMetadata(launch)) return undefined;
	const profile =
		launch.profile.kind === "named"
			? `profile ${launch.profile.name}`
			: launch.profile.kind === "base"
				? "base profile"
				: "no profile";
	const source: string = launch.source;
	const entry =
		launch.entry.kind === "tool"
			? `tool ${launch.entry.name}`
			: `command ${launch.entry.action}`;
	let command: LaunchSummary["command"];
	if (launch.command.state === "captured") {
		command = {
			state: "captured",
			fidelity: launch.command.fidelity,
			bytes: launch.command.bytes,
		};
		try {
			command.text = await readWorkflowLaunchCommandArtifact(cwd, run);
		} catch (error) {
			command.error = error instanceof Error ? error.message : String(error);
		}
	} else command = { state: "unavailable", reason: launch.command.reason };
	let auto: LaunchSummary["auto"];
	if (launch.schema === "agent-workflow-run-launch-v2") {
		const selection = launch.selection;
		const recommended = selection.recommendation
			? (selection.candidates.find(
					(candidate) =>
						candidate.candidateId === selection.recommendation?.candidateId,
				)?.label ?? null)
			: null;
		auto = {
			selected: selection.selected.label,
			candidates: selection.candidates.length,
			recommended,
			choseRecommendation: selection.choseRecommendation,
			classifier: selection.classifier,
			consent: selection.consent,
		};
	}
	return {
		schema: launch.schema,
		source,
		entry,
		requestKind: launch.requestKind,
		profile,
		task: launch.task,
		command,
		...(auto ? { auto } : {}),
	};
}

/** `Launch: pi · command run · named-workflow, base profile, task 12 chars/1 line` + the command. */
export function formatLaunch(summary: LaunchSummary): string[] {
	const lines = [
		`Launch: ${summary.source} · ${summary.entry} · ${summary.requestKind}, ${summary.profile}, task ${summary.task.characters} chars/${summary.task.lines} line${summary.task.lines === 1 ? "" : "s"}`,
	];
	if (summary.auto) {
		const auto = summary.auto;
		lines.push(
			`Auto selection: ${auto.selected} (${auto.choseRecommendation ? "recommended" : auto.recommended ? `recommended was ${auto.recommended}` : "no recommendation"}; ${auto.candidates} candidate${auto.candidates === 1 ? "" : "s"}; classifier ${auto.classifier.executor}${auto.classifier.model ? ` ${auto.classifier.model}` : ""}; consent ${auto.consent})`,
		);
	}
	const command = summary.command;
	if (command.state === "unavailable")
		lines.push(`Launch command: unavailable (${command.reason})`);
	else if (command.text !== undefined) {
		const points = Array.from(command.text);
		const shown =
			points.length > MAX_SHOWN_COMMAND_CHARS
				? `${points.slice(0, MAX_SHOWN_COMMAND_CHARS).join("")}… (${points.length} chars)`
				: command.text;
		lines.push(`Launch command: ${shown}`);
	} else lines.push(`Launch command: ${command.error ?? "unavailable"}`);
	return lines;
}
