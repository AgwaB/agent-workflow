import { basename, isAbsolute, relative, resolve } from "node:path";
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
		.replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, "[redacted]");
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

function safePath(value: string, cwd: string): string {
	if (!value) return "";
	if (value.length > 8192) return "[long path]";
	const path = resolve(cwd, activityPlainText(value));
	const local = relative(cwd, path);
	return safeText(
		local === ""
			? "."
			: local !== ".." && !local.startsWith("../") && !isAbsolute(local)
				? local
				: basename(path),
	);
}

function safeWebUrl(value: string): string {
	if (!value) return "web page";
	const resource = sanitizedUrlResource(activityPlainText(value));
	return resource ? safeText(resource.value) : "[url]";
}

function safeCommand(value: string, cwd: string): string {
	if (value.length > 8192) return "[long command]";
	let command = activityPlainText(value).replace(
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

/** Normalized executor inputs only. Completion/output events cannot overwrite newer intent. */
export function activityFromExecEvent(
	event: ExecEvent,
	cwd: string,
	at = new Date().toISOString(),
): TaskActivity | undefined {
	if (
		event.type !== "tool_call" ||
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
	if (/^(?:bash|shell|terminal|execute|command_execution)$/.test(name)) {
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
		label =
			url && !query
				? `Opening ${safeWebUrl(url)}`
				: `Searching "${clip(safeText(query || string(input.q) || "files"), 106)}"`;
		if (url && !query) kind = "web";
	} else if (/webfetch|web_fetch|fetch|browse|open_url|navigate/.test(name)) {
		kind = "web";
		label = `Opening ${safeWebUrl(url)}`;
	} else if (/^(?:edit|write|multiedit|apply_patch|file_change)$/.test(name)) {
		kind = "edit";
		const first = Array.isArray(event.input) ? record(event.input[0]) : {};
		label = `${name === "write" ? "Writing" : "Editing"} ${safePath(path || string(first.path), cwd) || "files"}`;
	} else if (
		/^(?:task|agent|subagent)$/.test(name) ||
		name.startsWith("collab_")
	) {
		kind = "agent";
		// Prompts/descriptions can contain arbitrary user data: never include them.
		label = "Delegating to agent";
	} else {
		label = `Using ${safeText(event.name) || "tool"}`;
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
