/**
 * Normalized executor events (stage-1 plan §2.3, design §3).
 * Adapters keep raw CLI output in the run directory; these events are a view over it (D3).
 * Tool kinds follow ACP vocabulary; tool statuses follow vibe-kanban's NormalizedEntry vocabulary.
 */
import { FAILURE_CLASSES, type FailureClass, SdkError } from "./errors.js";
import { isJsonValue, isPlainObject, type JsonValue } from "./json.js";

export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const TOOL_STATUSES = [
	"pending",
	"approval_pending",
	"running",
	"completed",
	"failed",
	"denied",
	"timed_out",
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** Where a usage cost came from. `unknown` always pairs with `cost: null` — never 0 (prior-art §5). */
export const USAGE_SOURCES = ["reported", "estimated", "unknown"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** A worker CLI session the adapter deliberately kept (D3, R#10). Retention deletes only these. */
export interface OwnedSession {
	readonly kind: string;
	readonly locator: string;
}

export interface StartedEvent {
	readonly type: "started";
	readonly sessionId: string | null;
}
export interface MessageDeltaEvent {
	readonly type: "message_delta";
	readonly text: string;
}
export interface ToolCallEvent {
	readonly type: "tool_call";
	readonly name: string;
	readonly kind: ToolKind;
	readonly status: ToolStatus;
	readonly callId?: string;
	readonly input?: JsonValue;
	readonly output?: JsonValue;
}
export interface UsageEvent {
	readonly type: "usage";
	/** Token counts; `null` means unknown, which is different from 0. */
	readonly input: number | null;
	readonly output: number | null;
	readonly cached: number | null;
	readonly cost: number | null;
	readonly source: UsageSource;
}
/** Engine must answer through `WorkflowExecutor.respond` (R#4). Never auto-allowed (D2). */
export interface ApprovalRequestEvent {
	readonly type: "approval_request";
	readonly requestId: string;
	readonly kind: ToolKind;
	readonly detail: string;
}
export interface CompletedEvent {
	readonly type: "completed";
	readonly finalText: string;
	readonly ownedSession?: OwnedSession;
}
export interface FailedEvent {
	readonly type: "failed";
	readonly class: FailureClass;
	readonly message: string;
	readonly raw: JsonValue;
	readonly ownedSession?: OwnedSession;
}

export type ExecEvent =
	| StartedEvent
	| MessageDeltaEvent
	| ToolCallEvent
	| UsageEvent
	| ApprovalRequestEvent
	| CompletedEvent
	| FailedEvent;

export type ExecEventType = ExecEvent["type"];
export const EXEC_EVENT_TYPES: readonly ExecEventType[] = [
	"started",
	"message_delta",
	"tool_call",
	"usage",
	"approval_request",
	"completed",
	"failed",
];

export function isTerminalEvent(event: ExecEvent): event is CompletedEvent | FailedEvent {
	return event.type === "completed" || event.type === "failed";
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isCount(value: unknown): boolean {
	return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function checkOwnedSession(value: unknown, problems: string[]): void {
	if (value === undefined) return;
	if (!isPlainObject(value) || typeof value.kind !== "string" || value.kind === "" || typeof value.locator !== "string" || value.locator === "")
		problems.push("ownedSession must be {kind, locator} with non-empty strings");
}

/** Validate one event. Returns problems (empty = valid). */
export function validateExecEvent(value: unknown): string[] {
	if (!isPlainObject(value)) return ["event must be an object"];
	const problems: string[] = [];
	switch (value.type) {
		case "started":
			if (value.sessionId !== null && typeof value.sessionId !== "string") problems.push("started.sessionId must be string|null");
			break;
		case "message_delta":
			if (typeof value.text !== "string") problems.push("message_delta.text must be a string");
			break;
		case "tool_call":
			if (typeof value.name !== "string" || value.name === "") problems.push("tool_call.name must be a non-empty string");
			if (!includes(TOOL_KINDS, value.kind)) problems.push("tool_call.kind is not an ACP tool kind");
			if (!includes(TOOL_STATUSES, value.status)) problems.push("tool_call.status is invalid");
			if (value.callId !== undefined && typeof value.callId !== "string") problems.push("tool_call.callId must be a string");
			if (value.input !== undefined && !isJsonValue(value.input)) problems.push("tool_call.input must be JSON");
			if (value.output !== undefined && !isJsonValue(value.output)) problems.push("tool_call.output must be JSON");
			break;
		case "usage":
			for (const key of ["input", "output", "cached"] as const)
				if (!isCount(value[key])) problems.push(`usage.${key} must be a non-negative integer or null`);
			if (!includes(USAGE_SOURCES, value.source)) problems.push("usage.source is invalid");
			if (value.cost !== null && !(typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0))
				problems.push("usage.cost must be a non-negative number or null");
			if (value.source === "unknown" && value.cost !== null) problems.push("usage.cost must be null when source is unknown");
			if (value.source !== "unknown" && value.cost === null) problems.push("usage.source must be unknown when cost is null");
			break;
		case "approval_request":
			if (typeof value.requestId !== "string" || value.requestId === "") problems.push("approval_request.requestId must be a non-empty string");
			if (!includes(TOOL_KINDS, value.kind)) problems.push("approval_request.kind is not an ACP tool kind");
			if (typeof value.detail !== "string") problems.push("approval_request.detail must be a string");
			break;
		case "completed":
			if (typeof value.finalText !== "string") problems.push("completed.finalText must be a string");
			checkOwnedSession(value.ownedSession, problems);
			break;
		case "failed":
			if (!includes(FAILURE_CLASSES, value.class)) problems.push("failed.class is invalid");
			if (typeof value.message !== "string") problems.push("failed.message must be a string");
			if (!("raw" in value) || !isJsonValue(value.raw)) problems.push("failed.raw must be JSON (use null when absent)");
			checkOwnedSession(value.ownedSession, problems);
			break;
		default:
			problems.push(`unknown event type: ${String(value.type)}`);
	}
	return problems;
}

export function assertExecEvent(value: unknown): asserts value is ExecEvent {
	const problems = validateExecEvent(value);
	if (problems.length > 0) throw new SdkError("INVALID_EVENT", `invalid executor event: ${problems.join("; ")}`);
}

/**
 * Validate the order of an event stream: `started` first and exactly once, exactly one terminal
 * event (`completed` | `failed`) at the end, approval request ids unique.
 * Pass `{ complete: false }` for a stream that is still running (terminal not yet required).
 */
export function validateEventSequence(events: readonly unknown[], options: { complete?: boolean } = {}): string[] {
	const problems: string[] = [];
	const complete = options.complete ?? true;
	const approvals = new Set<string>();
	let started = 0;
	let terminalAt = -1;
	events.forEach((event, index) => {
		for (const problem of validateExecEvent(event)) problems.push(`#${index}: ${problem}`);
		if (!isPlainObject(event)) return;
		if (terminalAt >= 0) problems.push(`#${index}: event after terminal event #${terminalAt}`);
		if (event.type === "started") {
			started += 1;
			if (index !== 0) problems.push(`#${index}: started must be the first event`);
		} else if (index === 0) problems.push("#0: first event must be started");
		if (event.type === "approval_request" && typeof event.requestId === "string") {
			if (approvals.has(event.requestId)) problems.push(`#${index}: duplicate approval requestId ${event.requestId}`);
			approvals.add(event.requestId);
		}
		if ((event.type === "completed" || event.type === "failed") && terminalAt < 0) terminalAt = index;
	});
	if (started > 1) problems.push("started emitted more than once");
	if (complete && terminalAt < 0) problems.push("stream ended without a terminal event");
	return problems;
}

export function assertEventSequence(events: readonly unknown[], options: { complete?: boolean } = {}): asserts events is readonly ExecEvent[] {
	const problems = validateEventSequence(events, options);
	if (problems.length > 0) throw new SdkError("INVALID_EVENT_SEQUENCE", `invalid event sequence: ${problems.join("; ")}`);
}
