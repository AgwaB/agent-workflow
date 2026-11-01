// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/extension.ts (parseWorkflowRunArgs,
// parseWorkflowDynamicArgs, parseWorkflowPruneArgs, the run-option tokenizer) and src/cli.mjs (the
// supervise option loop). MIT, same author. Changes (WP11a): moved out of the Pi extension into the
// host-neutral host API so every host (CLI, host MCP server, Pi host) parses the same way; no Pi
// imports; errors are HostUsageError; `/workflow dynamic` now accepts `--profile` (saved user
// profiles apply to dynamic runs too); new run options `--executor`, `--permission-mode`,
// `--allow-unverified`, `--effort` (`--thinking`/`--reasoning` stay as aliases). WP12a: repeatable
// `--input key=value`.
import { THINKING_LEVELS, type ThinkingLevel } from "../core/types.js";

/** A caller mistake (bad flag, missing argument). CLI exit code 2; MCP hosts map it to invalid params. */
export class HostUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostUsageError";
	}
}

export interface WorkflowArgToken {
	text: string;
	start: number;
	end: number;
	quoted: boolean;
}

export interface WorkflowRunParsedOptions {
	detach: boolean;
	forceNew?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	profile?: string;
	executor?: string;
	permissionMode?: "free" | "safe";
	allowUnverifiedCapabilities?: string[];
	/** WP12a: `--input key=value` (repeatable), raw strings; typed against the spec at launch. */
	inputs?: Record<string, string>;
}

export interface ParsedWorkflowRunArgs extends WorkflowRunParsedOptions {
	specPath: string;
	task: string;
}

export interface ParsedWorkflowDynamicArgs extends WorkflowRunParsedOptions {
	task: string;
}

export interface ParsedWorkflowPruneArgs {
	keep?: number;
	olderThanDays?: number;
	/** `--run <id>` (repeatable): exactly these terminal runs, instead of the retention filters. */
	runIds?: string[];
	yes?: boolean;
	json?: boolean;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		typeof value === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(value)
	);
}

export function parseThinkingLevel(value: string): ThinkingLevel {
	if (isThinkingLevel(value)) return value;
	throw new HostUsageError(
		`Invalid effort level "${value}". Supported: ${THINKING_LEVELS.join(", ")}`,
	);
}

export function parsePermissionMode(
	value: string,
	where = "--permission-mode",
): "free" | "safe" {
	if (value === "free" || value === "safe") return value;
	throw new HostUsageError(
		`${where} must be "free" or "safe" (got "${value}")`,
	);
}

/** Comma-separated capability keys (`--allow-unverified a,b`). */
export function parseCapabilityList(value: string, option: string): string[] {
	const keys = value
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
	if (keys.length === 0)
		throw new HostUsageError(`${option} requires at least one capability key`);
	for (const key of keys)
		if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(key))
			throw new HostUsageError(`${option}: invalid capability key "${key}"`);
	return [...new Set(keys)];
}

/** Quote-aware tokenizer of the `/workflow` argument string (Pi slash commands, chat hosts). */
export function tokenizeWorkflowArgs(input: string): WorkflowArgToken[] {
	const tokens: WorkflowArgToken[] = [];
	let index = 0;

	while (index < input.length) {
		while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
		if (index >= input.length) break;

		const start = index;
		const quote = input[index];
		if (quote === '"' || quote === "'") {
			index += 1;
			let text = "";
			let escaped = false;
			let closed = false;
			while (index < input.length) {
				const char = input[index] ?? "";
				index += 1;
				if (escaped) {
					text += char;
					escaped = false;
					continue;
				}
				if (char === "\\") {
					escaped = true;
					continue;
				}
				if (char === quote) {
					closed = true;
					break;
				}
				text += char;
			}
			if (!closed)
				throw new HostUsageError("Unterminated quoted workflow argument");
			tokens.push({ text, start, end: index, quoted: true });
			continue;
		}

		while (index < input.length && !/\s/.test(input[index] ?? "")) index += 1;
		tokens.push({
			text: input.slice(start, index),
			start,
			end: index,
			quoted: false,
		});
	}

	return tokens;
}

/**
 * WP12a: one `--input key=value` assignment into `inputs` (raw string; the host API types it
 * against the spec's declared input). The key is everything before the first `=`.
 */
export function addWorkflowInputAssignment(
	inputs: Record<string, string>,
	assignment: string,
	option = "--input",
): void {
	const eq = assignment.indexOf("=");
	const key = eq < 0 ? "" : assignment.slice(0, eq).trim();
	if (eq < 0 || key === "")
		throw new HostUsageError(
			`${option} expects key=value (for example ${option} depth=quick); got ${JSON.stringify(assignment)}`,
		);
	if (Object.hasOwn(inputs, key))
		throw new HostUsageError(`${option} ${key} given more than once`);
	inputs[key] = assignment.slice(eq + 1);
}

/** Options that take a value, and the parsed field each one sets. */
const RUN_SCALAR_OPTIONS: Readonly<
	Record<
		string,
		| "model"
		| "profile"
		| "thinking"
		| "executor"
		| "permissionMode"
		| "allowUnverifiedCapabilities"
	>
> = {
	"--model": "model",
	"--profile": "profile",
	"--thinking": "thinking",
	"--reasoning": "thinking",
	"--effort": "thinking",
	"--executor": "executor",
	"--permission-mode": "permissionMode",
	"--allow-unverified": "allowUnverifiedCapabilities",
};
const RUN_SCALAR_OPTION_NAMES = Object.keys(RUN_SCALAR_OPTIONS);
/** Value-taking options: the scalars plus the repeatable `--input`. */
const RUN_VALUE_OPTION_NAMES = [...RUN_SCALAR_OPTION_NAMES, "--input"];

/** Shared by both ends of run/dynamic input: duplicates never depend on scan order. */
function consumeLeadingRunOptionTokens(
	tokens: readonly WorkflowArgToken[],
	index: number,
	parsed: WorkflowRunParsedOptions,
): number {
	const token = tokens[index];
	if (!token || token.quoted) return 0;
	if (token.text === "--detach") {
		parsed.detach = true;
		return 1;
	}
	if (token.text === "--force-new") {
		parsed.forceNew = true;
		return 1;
	}
	if (token.text === "--route" || token.text === "--no-route") {
		throw new HostUsageError(
			`${token.text} is no longer supported: run and dynamic execute exactly what you selected. Use /workflow auto "<task>" for a recommendation.`,
		);
	}
	{
		const inline = optionValueFromEquals(token.text, "--input");
		if (inline !== undefined || token.text === "--input") {
			const value = inline ?? requiredOptionValue(tokens[index + 1], "--input");
			parsed.inputs ??= {};
			addWorkflowInputAssignment(parsed.inputs, value);
			return inline === undefined ? 2 : 1;
		}
	}
	for (const option of RUN_SCALAR_OPTION_NAMES) {
		const inline = optionValueFromEquals(token.text, option);
		if (inline === undefined && token.text !== option) continue;
		const value = inline ?? requiredOptionValue(tokens[index + 1], option);
		const key = RUN_SCALAR_OPTIONS[option]!;
		if (parsed[key] !== undefined)
			throw new HostUsageError(`Duplicate workflow option ${option}`);
		if (key === "thinking") parsed.thinking = parseThinkingLevel(value);
		else if (key === "permissionMode")
			parsed.permissionMode = parsePermissionMode(value);
		else if (key === "allowUnverifiedCapabilities")
			parsed.allowUnverifiedCapabilities = parseCapabilityList(value, option);
		else parsed[key] = value;
		return inline === undefined ? 2 : 1;
	}
	return 0;
}

function consumeTrailingRunOptionTokens(
	tokens: readonly WorkflowArgToken[],
	end: number,
	parsed: WorkflowRunParsedOptions,
): number {
	const last = tokens[end - 1];
	if (!last) return end;
	if (!last.quoted && RUN_VALUE_OPTION_NAMES.includes(last.text))
		throw new HostUsageError(
			`Workflow run option ${last.text} requires a value`,
		);
	const option = tokens[end - 2];
	if (
		option &&
		!option.quoted &&
		RUN_VALUE_OPTION_NAMES.includes(option.text)
	) {
		consumeLeadingRunOptionTokens(tokens.slice(0, end), end - 2, parsed);
		return end - 2;
	}
	const consumed = consumeLeadingRunOptionTokens(
		tokens.slice(0, end),
		end - 1,
		parsed,
	);
	return end - consumed;
}

function optionValueFromEquals(
	text: string,
	option: string,
): string | undefined {
	if (!text.startsWith(`${option}=`)) return undefined;
	const value = text.slice(option.length + 1);
	if (!value.trim())
		throw new HostUsageError(`Workflow run option ${option} requires a value`);
	return value;
}

function requiredOptionValue(
	token: WorkflowArgToken | undefined,
	option: string,
): string {
	if (
		!token ||
		!token.text.trim() ||
		(!token.quoted && token.text.startsWith("--"))
	)
		throw new HostUsageError(`Workflow run option ${option} requires a value`);
	return token.text;
}

/** Options run/dynamic know (a misplaced one is reported only when no option is unknown). */
const RUN_KNOWN_OPTION_NAMES = new Set([
	...RUN_VALUE_OPTION_NAMES,
	"--detach",
	"--force-new",
	"--route",
	"--no-route",
]);

function assertNoUnconsumedOptions(tokens: readonly WorkflowArgToken[]): void {
	const options = tokens.filter(
		(token) => !token.quoted && token.text.startsWith("--"),
	);
	if (options.length === 0) return;
	// Trailing options are read from the end and stop at an unknown one, which leaves the known
	// options before it unconsumed: name the unknown one, not the first known one.
	const unknown = options.find(
		(token) => !RUN_KNOWN_OPTION_NAMES.has(token.text.split("=")[0]!),
	);
	if (unknown)
		throw new HostUsageError(
			`Unknown workflow option ${unknown.text}; quote literal task text containing options`,
		);
	throw new HostUsageError(
		`Misplaced workflow option ${options[0]!.text}: put options before the workflow or after the task; quote literal task text containing options`,
	);
}

function trimEndBefore(input: string, index: number): number {
	let end = index;
	while (end > 0 && /\s/.test(input[end - 1] ?? "")) end -= 1;
	return end;
}

function unquoteWorkflowTask(input: string): string {
	const trimmed = input.trim();
	const tokens = tokenizeWorkflowArgs(trimmed);
	const only = tokens[0];
	if (
		only?.quoted &&
		tokens.length === 1 &&
		only.start === 0 &&
		only.end === trimmed.length
	)
		return only.text;
	return trimmed;
}

/**
 * `run [options] <workflow-name-or-path> <task> [options]` as one string (Pi `/workflow run`,
 * chat hosts). Options may lead or trail the task; quoted text is always literal task text.
 */
export function parseWorkflowRunArgs(args: string): ParsedWorkflowRunArgs {
	const parsed: WorkflowRunParsedOptions = { detach: false };
	const body = args.trim().replace(/^run(?:\s+|$)/i, "");
	const tokens = tokenizeWorkflowArgs(body);

	let cursor = 0;
	while (cursor < tokens.length) {
		const consumed = consumeLeadingRunOptionTokens(tokens, cursor, parsed);
		if (consumed === 0) break;
		cursor += consumed;
	}

	const specToken = tokens[cursor];
	if (!specToken) return { specPath: "", task: "", ...parsed };

	let taskTokenEnd = tokens.length;
	while (taskTokenEnd > cursor + 1) {
		const nextEnd = consumeTrailingRunOptionTokens(
			tokens,
			taskTokenEnd,
			parsed,
		);
		if (nextEnd === taskTokenEnd) break;
		taskTokenEnd = nextEnd;
	}

	assertNoUnconsumedOptions(tokens.slice(cursor, taskTokenEnd));
	let taskStart = specToken.end;
	while (taskStart < body.length && /\s/.test(body[taskStart] ?? ""))
		taskStart += 1;
	const taskEnd =
		taskTokenEnd < tokens.length
			? trimEndBefore(body, tokens[taskTokenEnd]!.start)
			: body.length;
	const task = unquoteWorkflowTask(body.slice(taskStart, taskEnd));

	return { specPath: specToken.text, task, ...parsed };
}

/** `dynamic [options] <task> [options]` as one string. */
export function parseWorkflowDynamicArgs(
	args: string,
): ParsedWorkflowDynamicArgs {
	return parseTaskWithRunOptions(args.trim().replace(/^dynamic(?:\s+|$)/i, ""));
}

/**
 * `auto <task> [options]` (the Pi `/aw auto` text). Live bundle 5 (WP39): `/aw auto` used the dynamic
 * parser, which strips only a leading `dynamic`, so the task became `auto "<task>"` (the action word
 * and the quotes were sent to the classifier and launched as the run's task).
 */
export function parseWorkflowAutoArgs(args: string): ParsedWorkflowDynamicArgs {
	return parseTaskWithRunOptions(args.trim().replace(/^auto(?:\s+|$)/i, ""));
}

function parseTaskWithRunOptions(body: string): ParsedWorkflowDynamicArgs {
	const parsed: WorkflowRunParsedOptions = { detach: false };
	const tokens = tokenizeWorkflowArgs(body);

	let cursor = 0;
	while (cursor < tokens.length) {
		const consumed = consumeLeadingRunOptionTokens(tokens, cursor, parsed);
		if (consumed === 0) break;
		cursor += consumed;
	}

	let taskTokenEnd = tokens.length;
	while (taskTokenEnd > cursor) {
		const nextEnd = consumeTrailingRunOptionTokens(
			tokens,
			taskTokenEnd,
			parsed,
		);
		if (nextEnd === taskTokenEnd) break;
		taskTokenEnd = nextEnd;
	}

	assertNoUnconsumedOptions(tokens.slice(cursor, taskTokenEnd));
	const taskStartToken = tokens[cursor];
	if (!taskStartToken || taskTokenEnd <= cursor) return { task: "", ...parsed };
	const taskEnd =
		taskTokenEnd < tokens.length
			? trimEndBefore(body, tokens[taskTokenEnd]!.start)
			: body.length;
	const task = unquoteWorkflowTask(body.slice(taskStartToken.start, taskEnd));
	return { task, ...parsed };
}

/** `prune [--keep N] [--older-than DAYS] [--run <id>]… [--yes] [--json]`, before any retention IO. */
export function parseWorkflowPruneArgs(
	args: readonly string[],
): ParsedWorkflowPruneArgs {
	const options: ParsedWorkflowPruneArgs = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--yes") options.yes = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--keep" || arg === "--older-than") {
			const key = arg === "--keep" ? "keep" : "olderThanDays";
			if (options[key] !== undefined)
				throw new HostUsageError(`Duplicate prune option ${arg}`);
			const raw = args[++index];
			if (!raw?.trim() || raw.startsWith("--"))
				throw new HostUsageError(`${arg} requires a numeric value`);
			options[key] = Number(raw);
		} else if (arg === "--run") {
			const id = args[++index];
			if (!id || !/^workflow_[A-Za-z0-9_]+$/.test(id))
				throw new HostUsageError(
					"--run requires an exact run id (workflow_…); prefixes are not accepted",
				);
			options.runIds = [...new Set([...(options.runIds ?? []), id])];
		} else throw new HostUsageError(`Unknown prune argument "${arg}"`);
	}
	if (
		options.runIds &&
		(options.keep !== undefined || options.olderThanDays !== undefined)
	)
		throw new HostUsageError(
			"--run selects runs by id; it cannot be combined with --keep or --older-than",
		);
	if (
		options.keep !== undefined &&
		(!Number.isSafeInteger(options.keep) || options.keep < 0)
	)
		throw new HostUsageError("--keep requires a non-negative integer");
	if (
		options.olderThanDays !== undefined &&
		(!Number.isFinite(options.olderThanDays) || options.olderThanDays < 0)
	)
		throw new HostUsageError(
			"--older-than requires a non-negative number of days",
		);
	return options;
}

export interface ParsedSuperviseArgs {
	runRef?: string;
	all: boolean;
	pollMs: number;
	/** 0 = unlimited. */
	maxRuntimeMs: number;
	/** `--max-runtime-ms` was given (an unlimited loop then keeps the explicit deadline). */
	maxRuntimeExplicit: boolean;
}

export const SUPERVISE_DEFAULT_POLL_MS = 2_000;
export const SUPERVISE_DEFAULT_MAX_RUNTIME_MS = 14_400_000;

/** `supervise <run-id-or-prefix> | --all [--poll-ms N] [--max-runtime-ms N]`. */
export function parseSuperviseArgs(
	argv: readonly string[],
): ParsedSuperviseArgs {
	let runRef: string | undefined;
	let all = false;
	let pollMs = SUPERVISE_DEFAULT_POLL_MS;
	let maxRuntimeMs = SUPERVISE_DEFAULT_MAX_RUNTIME_MS;
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--all") all = true;
		else if (arg === "--poll-ms" || arg === "--max-runtime-ms") {
			if (seen.has(arg))
				throw new HostUsageError(`Duplicate supervise option ${arg}.`);
			seen.add(arg);
			const raw = argv[++index];
			const value = Number(raw);
			const minimum = arg === "--poll-ms" ? 250 : 1_000;
			if (
				!raw ||
				!/^\d+$/.test(raw) ||
				!Number.isSafeInteger(value) ||
				(value < minimum && !(arg === "--max-runtime-ms" && value === 0)) ||
				value > 2_147_483_647
			)
				throw new HostUsageError(
					`${arg} requires an integer from ${minimum} to 2147483647${arg === "--max-runtime-ms" ? ", or 0 for unlimited" : ""}.`,
				);
			if (arg === "--poll-ms") pollMs = value;
			else maxRuntimeMs = value;
		} else if (!arg.startsWith("--") && !runRef) runRef = arg;
		else throw new HostUsageError(`Unknown supervise argument "${arg}".`);
	}
	if (runRef && all)
		throw new HostUsageError("Run id and --all are mutually exclusive.");
	if (!runRef && !all) throw new HostUsageError("Missing run id (or --all).");
	return {
		...(runRef === undefined ? {} : { runRef }),
		all,
		pollMs,
		maxRuntimeMs,
		maxRuntimeExplicit: seen.has("--max-runtime-ms"),
	};
}

/**
 * Durations for `--timeout`: plain milliseconds or a number with `ms`, `s`, `m` or `h`.
 * Returns milliseconds (1 000 to 2 147 483 647).
 */
export function parseDuration(value: string, option = "--timeout"): number {
	const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
	if (!match)
		throw new HostUsageError(
			`${option} requires a duration such as 30000, 30s, 5m or 1h (got "${value}")`,
		);
	const factor =
		match[2] === "s"
			? 1_000
			: match[2] === "m"
				? 60_000
				: match[2] === "h"
					? 3_600_000
					: 1;
	const ms = Number(match[1]) * factor;
	if (!Number.isSafeInteger(ms) || ms < 1_000 || ms > 2_147_483_647)
		throw new HostUsageError(
			`${option} must be between 1s and 2147483647ms (got "${value}")`,
		);
	return ms;
}
