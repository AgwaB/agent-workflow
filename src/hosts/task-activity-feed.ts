// 2026-11-23 (owner: "open agent should look like watching it work in a terminal"): a compact,
// readable view of one agent's latest attempt, built from its normalized `exec-events.jsonl`
// (executor-neutral: Pi, Codex, Claude Code and ACP write the same events). Streamed message
// tokens join into messages; a tool call's start and end join into one line with its status
// and a short output preview. Like vibe-kanban's normalized conversation entries
// (internal/research/repos/vibe-kanban/packages/web-core/src/features/workspace-chat/ui/
// DisplayConversationEntry.tsx), but read-only and bounded.
import { open } from "node:fs/promises";

import type { ExecEvent, ToolStatus } from "../sdk/events.js";
import { activityFromExecEvent } from "../runtime/telemetry/task-activity.js";

/** Bytes read from the end of the events file: a long attempt shows its latest activity. */
export const ACTIVITY_MAX_BYTES = 2 * 1024 * 1024;
/** Entries returned (the latest ones). */
export const ACTIVITY_MAX_ENTRIES = 300;
/** Characters kept of one message (its end: the latest words). */
export const ACTIVITY_MAX_MESSAGE_CHARS = 4000;
/** Lines and characters kept of one tool output preview (its start). */
export const ACTIVITY_OUTPUT_LINES = 8;
export const ACTIVITY_OUTPUT_CHARS = 1200;

export type ActivityEntry =
	| { kind: "message"; text: string; clipped?: boolean }
	| {
			kind: "tool";
			label: string;
			status: ToolStatus;
			output?: string;
			outputClipped?: boolean;
	  }
	| { kind: "failed"; text: string }
	| { kind: "approval"; text: string };

export interface ActivityFeed {
	entries: ActivityEntry[];
	/** Earlier activity was left out (the file was longer than the bound or entries were cut). */
	truncated: boolean;
}

/** Labels a call gets when its input names nothing (see activityFromExecEvent). */
const GENERIC_LABEL =
	/^(?:Searching the web|Searching files|Reading files|Editing files|Writing files|Running command|Using |Opening $)/;
const hasInput = (input: unknown): boolean =>
	input !== undefined &&
	input !== null &&
	(typeof input !== "object" || Object.keys(input).length > 0);

/** Read the tail of an events file, starting at a whole line. */
async function readTail(path: string): Promise<{ text: string; cut: boolean }> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - ACTIVITY_MAX_BYTES);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
		return { text, cut: start > 0 };
	} finally {
		await handle.close();
	}
}

function outputPreview(
	value: unknown,
): { text: string; clipped: boolean } | undefined {
	if (value === undefined || value === null) return undefined;
	// Executors wrap command output ({ exitCode, output } on Codex; { text } elsewhere): show the text.
	const wrapped =
		typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const inner = [wrapped?.output, wrapped?.text, wrapped?.stdout].find(
		(candidate): candidate is string => typeof candidate === "string",
	);
	let text =
		typeof value === "string"
			? value
			: inner !== undefined
				? inner
				: JSON.stringify(value);
	text = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	if (!text.trim()) return undefined;
	const lines = text.split("\n");
	let clipped = lines.length > ACTIVITY_OUTPUT_LINES;
	text = lines.slice(0, ACTIVITY_OUTPUT_LINES).join("\n");
	if (text.length > ACTIVITY_OUTPUT_CHARS) {
		text = `${text.slice(0, ACTIVITY_OUTPUT_CHARS)}`;
		clipped = true;
	}
	return { text, clipped };
}

/** Compact normalized executor events (one JSON object per line) into readable entries. */
export function compactActivity(
	lines: readonly string[],
	cwd: string,
): ActivityEntry[] {
	const entries: ActivityEntry[] = [];
	const calls = new Map<string, Extract<ActivityEntry, { kind: "tool" }>>();
	for (const line of lines) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event === null || typeof event !== "object") continue;
		const last = entries.at(-1);
		if (event.type === "message_delta" && typeof event.text === "string") {
			if (last?.kind === "message") last.text += event.text;
			else entries.push({ kind: "message", text: event.text });
			continue;
		}
		if (event.type === "tool_call" && typeof event.name === "string") {
			const status = String(event.status) as ToolStatus;
			// Labels come from the same reader as the task's one-line activity (secrets redacted).
			const label = activityFromExecEvent(
				{
					...(event as unknown as ExecEvent & object),
					status: "running",
				} as ExecEvent,
				cwd,
			)?.label;
			const id = typeof event.callId === "string" ? event.callId : undefined;
			const known = id ? calls.get(id) : undefined;
			const preview = outputPreview(event.output);
			if (known) {
				known.status = status;
				// Codex names a web search only when it ends; a later, more specific label wins. An end
				// event without input (Pi) only gives a generic label, which never replaces the start's.
				if (label && hasInput(event.input) && !GENERIC_LABEL.test(label))
					known.label = label;
				if (preview) {
					known.output = preview.text;
					if (preview.clipped) known.outputClipped = true;
				}
				continue;
			}
			const entry: Extract<ActivityEntry, { kind: "tool" }> = {
				kind: "tool",
				label: label ?? `Using ${event.name}`,
				status,
				...(preview
					? {
							output: preview.text,
							...(preview.clipped ? { outputClipped: true } : {}),
						}
					: {}),
			};
			entries.push(entry);
			if (id) calls.set(id, entry);
			continue;
		}
		if (event.type === "failed" && typeof event.message === "string")
			entries.push({ kind: "failed", text: event.message });
		else if (
			event.type === "approval_request" &&
			typeof event.detail === "string"
		)
			entries.push({ kind: "approval", text: event.detail });
	}
	for (const entry of entries)
		if (
			entry.kind === "message" &&
			entry.text.length > ACTIVITY_MAX_MESSAGE_CHARS
		) {
			entry.text = entry.text.slice(-ACTIVITY_MAX_MESSAGE_CHARS);
			entry.clipped = true;
		}
	return entries.filter(
		(entry) => entry.kind !== "message" || entry.text.trim(),
	);
}

/** The latest attempt's activity; `undefined` when the attempt has no events file yet. */
export async function readActivityFeed(
	eventsPath: string,
	cwd: string,
	limit = ACTIVITY_MAX_ENTRIES,
): Promise<ActivityFeed | undefined> {
	const read = await readTail(eventsPath).catch(() => undefined);
	if (!read) return undefined;
	const entries = compactActivity(read.text.split("\n"), cwd);
	const kept = entries.slice(-limit);
	return {
		entries: kept,
		truncated: read.cut || kept.length < entries.length,
	};
}
