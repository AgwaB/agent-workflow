import type { ExecEvent, ToolCallEvent } from "../sdk/events.js";
import { createSecretRedactor } from "../executors/redact.js";
import { activityPlainText } from "./task-activity.js";
import {
	isSensitiveWorkflowQueryKey,
	redactSensitiveWorkflowText,
} from "./workflow-sensitive-query.js";

export interface BlockedActionSample {
	tool: string;
	command?: string;
	reason: string;
	source?: "provider" | "engine";
}
export interface BlockedActions {
	count: number;
	provider: number;
	engine: number;
	samples: BlockedActionSample[];
}
export interface BlockedActionDecision {
	requestId: string;
	decision: string;
	response: string;
	reason?: string;
}

function command(input: ToolCallEvent["input"]): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return;
	const value = input.command ?? input.CommandLine;
	return typeof value === "string" ? value : undefined;
}

/** Redact before clipping, including host-env secrets; one sample totals at most 300 chars. */
function sampleRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
	const secrets: [string, string][] = Object.entries(env).flatMap(
		([key, value]) =>
			typeof value === "string" && isSensitiveWorkflowQueryKey(key)
				? [[value, key]]
				: [],
	);
	const redact = createSecretRedactor(secrets, {
		minLength: 8,
		replacement: (label) => `[REDACTED:${label}]`,
	});
	return (text) =>
		activityPlainText(redactSensitiveWorkflowText(redact.text(text)));
}

/**
 * Count events, not calls, requests or retries. An accepted deny is engine-attributed only
 * with an exact request/call id or command match. A same-kind but unlinked deny is unknown;
 * without one, the executor's denial is provider-attributed. Never guess from raw transcripts.
 */
export function summarizeBlockedActions(
	events: readonly ExecEvent[],
	decisions: readonly BlockedActionDecision[],
	env: NodeJS.ProcessEnv = process.env,
): BlockedActions | undefined {
	const denied = events.filter(
		(event): event is ToolCallEvent =>
			event.type === "tool_call" && event.status === "denied",
	);
	if (!denied.length) return;
	const redact = sampleRedactor(env);
	const summary: BlockedActions = {
		count: denied.length,
		provider: 0,
		engine: 0,
		samples: [],
	};
	for (const event of denied) {
		const prior = events.slice(0, events.indexOf(event));
		const running =
			event.callId === undefined
				? undefined
				: ([...prior]
						.reverse()
						.find(
							(item) =>
								item.type === "tool_call" &&
								item.callId === event.callId &&
								item.input !== undefined,
						) as ToolCallEvent | undefined);
		const cmd = command(event.input ?? running?.input);
		const candidates = prior.filter(
			(item) =>
				item.type === "approval_request" &&
				item.kind === event.kind &&
				decisions.some(
					(decision) =>
						decision.requestId === item.requestId &&
						decision.decision === "deny" &&
						decision.response === "accepted",
				),
		);
		const matched = candidates.find(
			(item) =>
				item.type === "approval_request" &&
				((event.callId !== undefined && item.requestId === event.callId) ||
					(cmd !== undefined && item.command === cmd)),
		);
		const source = matched
			? "engine"
			: candidates.length
				? undefined
				: "provider";
		if (source) summary[source]++;
		if (summary.samples.length === 3) continue;
		const decision =
			matched?.type === "approval_request"
				? decisions.find((item) => item.requestId === matched.requestId)
				: undefined;
		const tool = redact(event.name).slice(0, 60);
		const safeCommand =
			cmd === undefined ? undefined : redact(cmd).slice(0, 120);
		const reason = redact(
			decision?.reason ??
				(typeof event.output === "string"
					? event.output
					: event.output === undefined
						? "Action denied"
						: JSON.stringify(event.output)),
		).slice(0, 300 - tool.length - (safeCommand?.length ?? 0));
		summary.samples.push({
			tool,
			...(safeCommand === undefined ? {} : { command: safeCommand }),
			reason,
			...(source ? { source } : {}),
		});
	}
	return summary;
}

/** Allowlisted persisted-record/browser boundary. Absent means none; no legacy backfill. */
export function projectBlockedActions(
	value: unknown,
): BlockedActions | undefined {
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const validCount = (n: unknown): n is number =>
		typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	if (
		!validCount(record.count) ||
		!record.count ||
		!validCount(record.provider) ||
		!validCount(record.engine) ||
		record.provider + record.engine > record.count ||
		!Array.isArray(record.samples)
	)
		return;
	const redact = sampleRedactor(process.env);
	return {
		count: record.count,
		provider: record.provider,
		engine: record.engine,
		samples: record.samples.slice(0, 3).flatMap((sample: unknown) => {
			if (!sample || typeof sample !== "object") return [];
			const s = sample as Record<string, unknown>;
			if (typeof s.tool !== "string" || typeof s.reason !== "string") return [];
			const tool = redact(s.tool).slice(0, 60);
			const cmd =
				typeof s.command === "string"
					? redact(s.command).slice(0, 120)
					: undefined;
			return [
				{
					tool,
					...(cmd === undefined ? {} : { command: cmd }),
					reason: redact(s.reason).slice(
						0,
						300 - tool.length - (cmd?.length ?? 0),
					),
					...(s.source === "provider" || s.source === "engine"
						? { source: s.source }
						: {}),
				},
			];
		}),
	};
}

export function runBlockedActions(run: {
	tasks: readonly { blockedActions?: BlockedActions }[];
}): BlockedActions | undefined {
	let total: BlockedActions | undefined;
	for (const task of run.tasks) {
		const blocked = projectBlockedActions(task.blockedActions);
		if (!blocked) continue;
		total ??= { count: 0, provider: 0, engine: 0, samples: [] };
		total.count += blocked.count;
		total.provider += blocked.provider;
		total.engine += blocked.engine;
	}
	return total;
}

export function blockedActionsLabel(
	blocked: BlockedActions | undefined,
	notice = false,
): string {
	if (!blocked?.count) return "";
	const source =
		blocked.provider === blocked.count
			? "provider policy"
			: blocked.engine === blocked.count
				? "engine policy"
				: [
						blocked.provider ? `${blocked.provider} provider policy` : "",
						blocked.engine ? `${blocked.engine} engine policy` : "",
						blocked.count > blocked.provider + blocked.engine
							? `${blocked.count - blocked.provider - blocked.engine} unknown source`
							: "",
					]
						.filter(Boolean)
						.join(", ");
	const actions = `${blocked.count} action${blocked.count === 1 ? "" : "s"}`;
	return notice
		? `; ${actions} ${blocked.count === 1 ? "was" : "were"} blocked (${source})`
		: `${actions} blocked by ${source}`;
}
