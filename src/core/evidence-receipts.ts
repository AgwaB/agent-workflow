// agent-workflow 2026-11-01: what a worker's own web tools actually returned, as evidence receipts.
// Read from the attempts' normalized `exec-events.jsonl` (executor-neutral `tool_call` events; the
// `running` event carries the input, the terminal one the output). The tool's output form decides
// what a match in it proves:
// - page-text: the page content itself (Pi `fetch_content`, `get_search_content`) — a quote found
//   here for the same URL is verified from the worker's own capture, no re-fetch needed;
// - summary: a model-written summary of the page (Claude `WebFetch`) — a quote found only here is
//   recorded as "in summary" and still needs the page;
// - search-results: titles/snippets (Pi `web_search`, Claude `WebSearch`) — recorded like summary.
// Codex web search events carry metadata only (no text) and yield no receipt. Normalized outputs
// are clipped (Pi 64 KiB), so a quote past the clip falls back to the engine re-fetch.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workflowsRoot } from "./store.js";

export type WebReceiptForm = "page-text" | "summary" | "search-results";

export interface WebReceipt {
	readonly tool: string;
	readonly form: WebReceiptForm;
	/** Normalized keys of the URLs this output is about (see `receiptUrlKey`). */
	readonly targets: readonly string[];
	readonly text: string;
}

const TOOL_FORMS: Readonly<Record<string, WebReceiptForm>> = {
	fetch_content: "page-text",
	get_search_content: "page-text",
	WebFetch: "summary",
	web_search: "search-results",
	WebSearch: "search-results",
};

/** host (no `www.`, lower case) + path (no trailing slash) + query; no scheme or fragment. */
export function receiptUrlKey(url: string): string {
	try {
		const parsed = new URL(url.trim());
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${path}${parsed.search}`;
	} catch {
		return url.trim().toLowerCase();
	}
}

function urlsOf(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	if (typeof record.url === "string") out.push(record.url);
	if (Array.isArray(record.urls))
		for (const url of record.urls) if (typeof url === "string") out.push(url);
	return out;
}

function urlsInText(text: string): string[] {
	return [...text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((match) =>
		match[0].replace(/[.,;]+$/, ""),
	);
}

function outputText(output: unknown): string {
	if (typeof output === "string") return output;
	return "";
}

const MAX_TASK_TEXT = 32 * 1024 * 1024;

/** Receipts from every attempt of one workflow task (empty when nothing was recorded). */
export async function readTaskWebReceipts(
	cwd: string,
	runId: string,
	taskId: string,
): Promise<WebReceipt[]> {
	const taskRoot = join(
		dirname(workflowsRoot(cwd)),
		"workflow-subagents",
		runId,
		taskId,
	);
	const receipts: WebReceipt[] = [];
	let total = 0;
	for (const backendRun of await readdir(taskRoot).catch(() => [])) {
		const attemptsRoot = join(taskRoot, backendRun, "attempts");
		for (const attempt of await readdir(attemptsRoot).catch(() => [])) {
			const raw = await readFile(
				join(attemptsRoot, attempt, "exec-events.jsonl"),
				"utf8",
			).catch(() => "");
			const inputs = new Map<string, unknown>();
			for (const line of raw.split("\n")) {
				if (!line.includes('"tool_call"')) continue;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				const name = typeof event.name === "string" ? event.name : "";
				const form = TOOL_FORMS[name];
				if (event.type !== "tool_call" || form === undefined) continue;
				const callId = typeof event.callId === "string" ? event.callId : "";
				if (event.input !== undefined && callId)
					inputs.set(callId, event.input);
				if (event.status !== "completed") continue;
				const text = outputText(event.output);
				if (text === "" || total + text.length > MAX_TASK_TEXT) continue;
				total += text.length;
				const input = event.input ?? inputs.get(callId);
				const targets =
					form === "search-results" ? urlsInText(text) : urlsOf(input);
				receipts.push({
					tool: name,
					form,
					targets: [...new Set(targets.map(receiptUrlKey))],
					text,
				});
			}
		}
	}
	return receipts;
}
