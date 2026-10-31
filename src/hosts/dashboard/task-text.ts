// WP43 (UI v2): human text for agent rows — a foreach item's title (from its source item) and a
// finished task's outcome (status word + one line from its control.json). Reads are contained to the
// project's artifact root, size-bounded and cached by mtime/size; raw output is never exposed.
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { resolveContainedRunFile } from "../run-files.js";

const MAX_CONTROL_BYTES = 512 * 1024;
const MAX_TEXT = 160;
const CACHE_LIMIT = 2_000;
const TITLE_KEYS = [
	"title",
	"name",
	"claim",
	"question",
	"text",
	"label",
	"topic",
	"summary",
	"digest",
	"description",
	"prompt",
];
const SUMMARY_KEYS = ["summary", "conclusion", "headline", "answer", "digest"];
const STATUS_KEYS = ["status", "verdict", "outcome"];

export type OutcomeTone = "ok" | "warn" | "err";
export interface TaskOutcome {
	status?: string;
	tone: OutcomeTone;
	text?: string;
}
interface TaskTextRecord {
	taskId: string;
	status: string;
	files?: { result?: string };
	dispatchMap?: { entries?: unknown };
}
interface TaskTextTarget {
	taskId: string;
	title?: string;
	outcome?: TaskOutcome;
}

const cache = new Map<string, { stamp: string; value: unknown }>();

/** One line, no control characters, at most MAX_TEXT characters. */
export function oneLine(value: string, max = MAX_TEXT): string {
	const text = value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

async function readControl(cwd: string, resultPath: unknown): Promise<unknown> {
	if (typeof resultPath !== "string" || !resultPath) return undefined;
	const candidate = posix.join(
		posix.dirname(resultPath.replaceAll("\\", "/")),
		"control.json",
	);
	const contained = await resolveContainedRunFile(cwd, candidate);
	if (contained.kind !== "ok") return undefined;
	try {
		const info = await stat(contained.path);
		if (!info.isFile() || info.size > MAX_CONTROL_BYTES) return undefined;
		const stamp = `${info.mtimeMs}:${info.size}`;
		const hit = cache.get(contained.path);
		if (hit?.stamp === stamp) return hit.value;
		const value = JSON.parse(await readFile(contained.path, "utf8"));
		if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
		cache.set(contained.path, { stamp, value });
		return value;
	} catch {
		return undefined;
	}
}

/** `$.a.b[0]` → ["a", "b", 0]; anything else is refused. */
export function parseItemPath(
	path: string,
): Array<string | number> | undefined {
	if (!/^\$(?:\.[A-Za-z_][\w-]*|\[\d+\])*$/u.test(path)) return undefined;
	return [...path.slice(1).matchAll(/\.([A-Za-z_][\w-]*)|\[(\d+)\]/gu)].map(
		(match) => (match[1] !== undefined ? match[1] : Number(match[2])),
	);
}

function at(value: unknown, path: Array<string | number>): unknown {
	let current = value;
	for (const key of path) {
		if (typeof key === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[key];
		} else {
			if (!current || typeof current !== "object" || Array.isArray(current))
				return undefined;
			if (!Object.hasOwn(current, key)) return undefined;
			current = (current as Record<string, unknown>)[key];
		}
	}
	return current;
}

function firstText(
	value: unknown,
	keys: string[],
	skip?: string,
): string | undefined {
	if (typeof value === "string") return oneLine(value) || undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	for (const key of keys) {
		const item = (value as Record<string, unknown>)[key];
		if (typeof item !== "string") continue;
		const text = oneLine(item);
		if (!text) continue;
		if (skip && text.slice(0, 24) === skip.slice(0, 24)) continue;
		return text;
	}
	return undefined;
}

export function itemTitle(item: unknown): string | undefined {
	return firstText(item, TITLE_KEYS);
}

/** `partially_supported` → "Partly supported"; tone from the word, not from a workflow schema. */
export function outcomeOf(
	control: unknown,
	title?: string,
): TaskOutcome | undefined {
	if (!control || typeof control !== "object" || Array.isArray(control))
		return undefined;
	const record = control as Record<string, unknown>;
	const token = STATUS_KEYS.map((key) => record[key]).find(
		(value): value is string =>
			typeof value === "string" && /^[A-Za-z][\w -]{0,39}$/u.test(value),
	);
	const text = firstText(control, SUMMARY_KEYS, title);
	if (!token && !text) return undefined;
	const word = token
		?.replace(/[_-]+/gu, " ")
		.trim()
		.replace(/^partially\b/iu, "partly")
		.toLowerCase();
	const tone: OutcomeTone = !word
		? "ok"
		: /\b(fail|failed|error|blocked|refuted|contradicted|rejected|unsupported|not|invalid|unverified)\b/u.test(
					word,
				)
			? "err"
			: /\b(partly|partial|uncertain|unclear|mixed|warning|degraded|inconclusive|incomplete)\b/u.test(
						word,
					)
				? "warn"
				: "ok";
	return {
		...(word ? { status: word[0]!.toUpperCase() + word.slice(1) } : {}),
		tone,
		...(text ? { text } : {}),
	};
}

/** Fill `title` (foreach items) and `outcome` (completed tasks) on projected tasks in place. */
export async function attachTaskTexts(
	cwd: string,
	records: TaskTextRecord[],
	targets: TaskTextTarget[],
): Promise<void> {
	const byId = new Map(records.map((record) => [record.taskId, record]));
	const items = new Map<string, { source: string; path: string }>();
	for (const record of records) {
		const entries = record.dispatchMap?.entries;
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const { taskId, itemSourceTaskId, itemRef } = entry as Record<
				string,
				unknown
			>;
			if (
				typeof taskId !== "string" ||
				typeof itemSourceTaskId !== "string" ||
				typeof itemRef !== "string"
			)
				continue;
			const marker = itemRef.lastIndexOf(":control:");
			if (marker < 0) continue;
			items.set(taskId, {
				source: itemSourceTaskId,
				path: itemRef.slice(marker + ":control:".length),
			});
		}
	}
	for (const target of targets) {
		const item = items.get(target.taskId);
		if (item) {
			const path = parseItemPath(item.path);
			const source = byId.get(item.source);
			if (path && source) {
				const title = itemTitle(
					at(await readControl(cwd, source.files?.result), path),
				);
				if (title) target.title = title;
			}
		}
		const record = byId.get(target.taskId);
		if (record?.status !== "completed") continue;
		const outcome = outcomeOf(
			await readControl(cwd, record.files?.result),
			target.title,
		);
		if (outcome) target.outcome = outcome;
	}
}
