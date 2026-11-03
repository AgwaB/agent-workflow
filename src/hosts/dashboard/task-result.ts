// New in agent-workflow (2026-11-03): a finished task's result as the dashboard shows it — the
// digest, the analysis text and the references from tasks/<task>/{control.json,analysis.md,
// refs.json}, plus the control JSON for the curious. The Output tab only had the raw stream's
// bounded tail (cut JSON, section tags, unrendered Markdown). Reads are contained to the project's
// artifact root and size-bounded; nothing is rendered as HTML here (the UI uses text nodes only).
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { resolveContainedRunFile } from "../run-files.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ANALYSIS_CHARS = 60_000;
const MAX_CONTROL_CHARS = 40_000;
const MAX_DIGEST_CHARS = 2_000;
const MAX_REFS = 100;
const MAX_REF_CHARS = 600;

export interface DashboardTaskRef {
	title?: string;
	url?: string;
	note?: string;
}

export interface DashboardTaskResult {
	digest?: string;
	analysis?: string;
	analysisTruncated?: true;
	refs?: DashboardTaskRef[];
	refsTruncated?: true;
	/** Pretty-printed control.json (bounded). */
	control?: string;
	controlTruncated?: true;
}

interface ResultRecord {
	files?: { result?: string };
}

async function readContained(
	cwd: string,
	taskDir: string,
	name: string,
): Promise<string | undefined> {
	const contained = await resolveContainedRunFile(
		cwd,
		posix.join(taskDir, name),
	);
	if (contained.kind !== "ok") return undefined;
	try {
		const info = await stat(contained.path);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
		return await readFile(contained.path, "utf8");
	} catch {
		return undefined;
	}
}

function bounded(
	text: string,
	max: number,
): { text: string; truncated: boolean } {
	return text.length > max
		? { text: `${text.slice(0, max).trimEnd()}…`, truncated: true }
		: { text, truncated: false };
}

function stringField(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim();
	return text ? bounded(text, max).text : undefined;
}

function ref(entry: unknown): DashboardTaskRef | undefined {
	if (typeof entry === "string") {
		const text = stringField(entry, MAX_REF_CHARS);
		if (!text) return undefined;
		return /^https?:\/\/\S+$/u.test(text) ? { url: text } : { note: text };
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry))
		return undefined;
	const record = entry as Record<string, unknown>;
	const title =
		stringField(record.title, MAX_REF_CHARS) ??
		stringField(record.name, MAX_REF_CHARS) ??
		stringField(record.sourceRef, MAX_REF_CHARS);
	const url =
		stringField(record.url, MAX_REF_CHARS) ??
		stringField(record.href, MAX_REF_CHARS) ??
		stringField(record.file, MAX_REF_CHARS);
	const note =
		stringField(record.relevance, MAX_REF_CHARS) ??
		stringField(record.note, MAX_REF_CHARS);
	const out: DashboardTaskRef = {
		...(title ? { title } : {}),
		...(url ? { url } : {}),
		...(note ? { note } : {}),
	};
	return Object.keys(out).length > 0 ? out : undefined;
}

/** The task's result files, or undefined when it has none (not finished, or no result path). */
export async function readTaskResult(
	cwd: string,
	record: ResultRecord,
): Promise<DashboardTaskResult | undefined> {
	const resultPath = record.files?.result;
	if (typeof resultPath !== "string" || !resultPath) return undefined;
	const taskDir = posix.dirname(resultPath.replaceAll("\\", "/"));
	const [controlText, analysisText, refsText] = await Promise.all([
		readContained(cwd, taskDir, "control.json"),
		readContained(cwd, taskDir, "analysis.md"),
		readContained(cwd, taskDir, "refs.json"),
	]);
	const result: DashboardTaskResult = {};
	if (controlText !== undefined) {
		let control: unknown;
		try {
			control = JSON.parse(controlText);
		} catch {
			control = undefined;
		}
		if (control && typeof control === "object" && !Array.isArray(control)) {
			const digest = stringField(
				(control as Record<string, unknown>).digest,
				MAX_DIGEST_CHARS,
			);
			if (digest) result.digest = digest;
		}
		const pretty = bounded(
			control === undefined ? controlText : JSON.stringify(control, null, 2),
			MAX_CONTROL_CHARS,
		);
		result.control = pretty.text;
		if (pretty.truncated) result.controlTruncated = true;
	}
	if (analysisText !== undefined && analysisText.trim()) {
		const analysis = bounded(analysisText.trim(), MAX_ANALYSIS_CHARS);
		result.analysis = analysis.text;
		if (analysis.truncated) result.analysisTruncated = true;
	}
	if (refsText !== undefined) {
		try {
			const parsed = JSON.parse(refsText);
			if (Array.isArray(parsed)) {
				const refs = parsed
					.slice(0, MAX_REFS)
					.map(ref)
					.filter((entry): entry is DashboardTaskRef => entry !== undefined);
				if (refs.length > 0) result.refs = refs;
				if (parsed.length > MAX_REFS) result.refsTruncated = true;
			}
		} catch {
			// Unreadable refs are left out; the control JSON still shows what the worker wrote.
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
