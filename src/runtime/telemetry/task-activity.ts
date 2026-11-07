import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
	activityPlainText,
	type TaskActivity,
} from "../../core/task-activity.js";
import type { ExecEvent } from "../../sdk/events.js";
import {
	sanitizedUrlResource,
	SENSITIVE_KEY_PATTERN,
} from "./tool-call-telemetry.js";

const clip = (value: string, max: number): string =>
	value.length <= max ? value : `${value.slice(0, max - 1)}…`;
const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const string = (value: unknown): string =>
	typeof value === "string" ? value : "";

/**
 * One run of token alphabet: a token when it is ≥ 32 characters mixing letters and digits, or a
 * ≥ 40-character blob without identifier separators. A path is judged segment by segment, so
 * `.agent-workflow/workflows/workflow_mvx…57/…` and `mcp__workflow_artifact__workflow_artifact`
 * stay readable.
 */
function redactTokenRun(run: string): string {
	if (run.length < 32) return run;
	const mixed = /\d/.test(run) && /[A-Za-z]/.test(run);
	const blob = run.length >= 40 && /^[A-Za-z0-9+=]+$/.test(run);
	return mixed || blob ? "[redacted]" : run;
}

function safeText(value: string): string {
	// Bound work before regexes. If a value was cut, do not expose a partial secret.
	if (value.length > 8192) return "[long value]";
	const cleaned = activityPlainText(value)
		.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
			const resource = sanitizedUrlResource(url);
			return resource ? resource.value.replace(/^https?:\/\//, "") : "[url]";
		})
		.replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_\w+)\b/gi, "[redacted]")
		// Case-sensitive vendor key shapes: AWS access key ids, Slack and Google API tokens.
		.replace(
			/\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abpors]-[\w-]{10,}|AIza[\w-]{30,})\b/g,
			"[redacted]",
		)
		.replace(/\bBearer\s+[^\s"']+/gi, "[redacted]")
		// A long base64/hex-like run is a token when it mixes letters and digits or is one 40+
		// character blob; a long path ("sample/src/workflow-cancellation") stays readable.
		.replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, (run) =>
			run.includes("/")
				? run.split("/").map(redactTokenRun).join("/")
				: redactTokenRun(run),
		);
	// Free text (queries, paths, URLs) names secrets as words all the time ("auth/session.ts",
	// "tool tokens"); only a sensitive key used as an assignment, header or flag marks a value.
	const words = cleaned.split(" ");
	const sensitive = words.findIndex(sensitiveKeyWord);
	return sensitive < 0
		? cleaned
		: `${words.slice(0, sensitive).join(" ")} [redacted]`.trim();
}

// Words that name a secret value outright: a bare occurrence still redacts what follows.
const SECRET_WORD =
	/^(?:pass(?:word|wd|phrase)?s?|secrets?|credentials?|api[-_]?keys?|private[-_]?keys?|client[-_]?secrets?)$/i;

/**
 * `password=…`, `Authorization:`, `--api-key`, `-token`, or a bare secret word ("password …") —
 * but not everyday words such as "tokens", "auth" or "session" in a query or a path.
 */
function sensitiveKeyWord(word: string): boolean {
	if (SECRET_WORD.test(word.replace(/^["'(]+|["'),.;]+$/g, ""))) return true;
	const key =
		/^-{1,2}([A-Za-z][\w.-]*)(?:[=:].*)?$|^["']?([A-Za-z_][\w.-]*)["']?[=:]/.exec(
			word,
		);
	const name = key?.[1] ?? key?.[2];
	return name !== undefined && SENSITIVE_KEY_PATTERN.test(name);
}

/** The canonical directory, or the input when it cannot be resolved (missing, permissions). */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Inside-cwd relative path, also across a symlinked prefix (macOS /tmp → /private/tmp). */
function localPath(path: string, cwd: string): string | undefined {
	const inside = (from: string, to: string) => {
		const local = relative(from, to);
		return local === ""
			? "."
			: local !== ".." && !local.startsWith("../") && !isAbsolute(local)
				? local
				: undefined;
	};
	const direct = inside(cwd, path);
	if (direct !== undefined) return direct;
	const realCwd = canonical(cwd);
	const realPath = resolve(canonical(dirname(path)), basename(path));
	return (
		inside(realCwd, realPath) ?? inside(realCwd, path) ?? inside(cwd, realPath)
	);
}

function safePath(value: string, cwd: string): string {
	if (!value) return "";
	if (value.length > 8192) return "[long path]";
	const path = resolve(cwd, activityPlainText(value));
	return safeText(localPath(path, cwd) ?? basename(path));
}

function safeWebUrl(value: string): string {
	if (!value) return "web page";
	const resource = sanitizedUrlResource(activityPlainText(value));
	return resource ? safeText(resource.value) : "[url]";
}

/** `zsh -lc 'cmd'`, `/bin/bash -c "cmd"` (how Codex runs commands) → `cmd`. */
function unwrapShell(command: string): string {
	const match =
		/^\s*(?:\/[\w./-]*\/)?(?:ba|z|da|k)?sh\s+-(?:l?c|cl)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*$/.exec(
			command,
		);
	return match
		? (match[1] ?? match[2]!.replace(/\\(["\\$`])/g, "$1"))
		: command;
}

function safeCommand(value: string, cwd: string): string {
	if (value.length > 8192) return "[long command]";
	let command = unwrapShell(activityPlainText(value)).replace(
		/^(?:\s*(?:[A-Za-z_][\w]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)+/,
		"",
	);
	// Sensitive switches/assignments can have arbitrarily quoted values. Fail closed on
	// the rest of the command rather than attempting to parse shell syntax or JSON.
	const words = command.split(" ");
	const sensitive = words.findIndex((word) => SENSITIVE_KEY_PATTERN.test(word));
	if (sensitive >= 0)
		command = `${words.slice(0, sensitive).join(" ")} [redacted]`;
	command = command.replace(
		/https?:\/\/[^\s"'<>]+|"[^"]*\/[^"]*"|'[^']*\/[^']*'|(?<![\w./])(?:\/|\.\.?\/|[\w.-]+\/)[^\s"'<>|;&]+/g,
		(part) => {
			const quote = /^["']/.test(part) ? part[0] : "";
			const path = quote ? part.slice(1, -1) : part;
			const safe = /^https?:/.test(path) ? safeText(path) : safePath(path, cwd);
			return `${quote}${safe}${quote}`;
		},
	);
	return clip(safeText(command), 60);
}

const WEB_SEARCH_NAME = /^(?:websearch|web_search|search_web)$/;

/**
 * Normalized executor inputs only. Completion/output events cannot overwrite newer intent — with
 * one exception: Codex starts `web_search` before its query is known and reports the query (or
 * the page it opened) on completion. When that call is still the latest activity
 * (`refineCallId`), its completion fills in the label; output is never used.
 */
export function activityFromExecEvent(
	event: ExecEvent,
	cwd: string,
	at = new Date().toISOString(),
	options: { refineCallId?: string } = {},
): TaskActivity | undefined {
	if (event.type !== "tool_call") return undefined;
	const refinesSearch =
		event.status === "completed" &&
		event.callId !== undefined &&
		event.callId === options.refineCallId &&
		WEB_SEARCH_NAME.test(event.name.toLowerCase());
	if (
		!refinesSearch &&
		!["pending", "approval_pending", "running"].includes(event.status)
	)
		return undefined;
	const input = record(event.input);
	const action = record(input.action);
	const name = event.name.toLowerCase();
	const path = string(
		input.file_path ?? input.path ?? input.filePath ?? input.filename,
	);
	const query = string(
		input.query ?? input.pattern ?? input.search_query ?? action.query,
	);
	const url = string(input.url ?? action.url);
	let kind: TaskActivity["kind"] = "tool";
	let label: string;
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	if ((mcp?.[2] ?? name) === "workflow_artifact") {
		// The engine's own artifact tool: say which upstream artifact is being read.
		kind = "read";
		const source = safeText(string(input.source)).slice(0, 60);
		const artifact = safeText(string(input.artifact)).slice(0, 30);
		const at = safeText(
			string(input.path)
				.replace(/^\$\.?/, "")
				.split(".")
				.slice(-2)
				.join("."),
		).slice(0, 50);
		label =
			string(input.action) === "list" || !source
				? "Listing workflow artifacts"
				: `Reading ${source}${artifact && artifact !== "control" ? ` ${artifact}` : ""}${at ? ` · ${at}` : ""}`;
	} else if (/^(?:bash|shell|terminal|execute|command_execution)$/.test(name)) {
		const actions = Array.isArray(input.actions) ? input.actions : [];
		const first = record(actions[0]);
		if (event.kind === "read" && string(first.path)) {
			kind = "read";
			label = `Reading ${safePath(string(first.path), cwd)}`;
		} else if (event.kind === "search" && string(first.query)) {
			kind = "search";
			label = `Searching "${clip(safeText(string(first.query)), 106)}"`;
		} else {
			kind = "shell";
			label = `Running ${safeCommand(string(input.command ?? input.cmd), cwd) || "command"}`;
		}
	} else if (/^(?:read|read_file|view_image|ls|list|listfiles)$/.test(name)) {
		kind = "read";
		label = `Reading ${safePath(path, cwd) || "files"}`;
	} else if (
		/^(?:grep|glob|find|search|websearch|web_search|search_web)$/.test(name) ||
		/(?:^|[_-])search$/.test(name)
	) {
		kind = "search";
		const terms = query || string(input.q);
		const opening =
			string(action.type) === "openPage" || /^https?:\/\//i.test(terms);
		if (refinesSearch && !terms && !url) return undefined;
		label =
			(url && !terms) || opening
				? `Opening ${safeWebUrl(url || terms)}`
				: terms
					? `Searching "${clip(safeText(terms), 106)}"`
					: /web/.test(name)
						? "Searching the web" // Codex starts web_search before its query is known
						: "Searching files";
		if ((url && !terms) || opening || (!terms && /web/.test(name)))
			kind = "web";
	} else if (/webfetch|web_fetch|fetch|browse|open_url|navigate/.test(name)) {
		kind = "web";
		label = `Opening ${safeWebUrl(url)}`;
	} else if (/^(?:edit|write|multiedit|apply_patch|file_change)$/.test(name)) {
		kind = "edit";
		const first = Array.isArray(event.input) ? record(event.input[0]) : {};
		label = `${name === "write" ? "Writing" : "Editing"} ${safePath(path || string(first.path), cwd) || "files"}`;
	} else if (
		/^(?:task|agent|worker)$/.test(name) ||
		name.startsWith("collab_")
	) {
		kind = "agent";
		// Prompts/descriptions can contain arbitrary user data: never include them.
		label = "Delegating to agent";
	} else {
		// `mcp__server__tool` → "Using tool (server)"; the prefix is plumbing, not information.
		label = mcp
			? `Using ${safeText(mcp[2]!)} (${safeText(mcp[1]!)})`
			: `Using ${safeText(event.name) || "tool"}`;
	}
	return { kind, label: clip(activityPlainText(label), 120), at };
}

/** One in-memory value, one write at a time; ticks may be shared with a worker heartbeat. */
export class ActivityHeartbeat {
	private latest: TaskActivity | undefined;
	private dirty = false;
	private lastWriteAt = Number.NEGATIVE_INFINITY;
	private inFlight: Promise<void> | undefined;

	constructor(
		private readonly write: (
			activity: TaskActivity | undefined,
		) => Promise<unknown>,
	) {}

	update(activity: TaskActivity): void {
		this.latest = activity;
		this.dirty = true;
	}

	tick(now: number, heartbeatDue = false): Promise<void> | undefined {
		if (
			this.inFlight ||
			now - this.lastWriteAt < 1000 ||
			(!this.dirty && !heartbeatDue)
		)
			return this.inFlight;
		this.lastWriteAt = now;
		this.dirty = false;
		this.inFlight = this.write(this.latest)
			.then(() => undefined)
			.catch(() => {
				this.dirty = true;
			})
			.finally(() => {
				this.inFlight = undefined;
			});
		return this.inFlight;
	}

	async drain(): Promise<void> {
		await this.inFlight;
	}
}
