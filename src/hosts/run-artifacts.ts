// WP43: optional bounded artifact reads for showAction, shared by web/other hosts.
import { open, stat } from "node:fs/promises";
import type { WorkflowRunRecord } from "../core/types.js";
import { hostTextRedactor } from "./redaction.js";
import { resolveContainedRunFile } from "./run-files.js";
import type { HostApiContext } from "./types.js";

export const REPORT_MAX_BYTES = 256 * 1024;
export interface RunReport {
	path: string;
	text: string;
	truncated: boolean;
}

/** Includes the truncation notice inside the byte cap; never leaves a partial UTF-8 codepoint. */
export function boundReportText(
	text: string,
	truncated = false,
): Pick<RunReport, "text" | "truncated"> {
	const bytes = Buffer.from(text);
	if (!truncated && bytes.length <= REPORT_MAX_BYTES)
		return { text, truncated: false };
	const notice = "\n\n[Report truncated at 256 kB]";
	const prefix = bytes.subarray(
		0,
		REPORT_MAX_BYTES - Buffer.byteLength(notice),
	);
	return {
		text: new TextDecoder().decode(prefix, { stream: true }) + notice,
		truncated: true,
	};
}

export async function readHostRunReport(
	ctx: HostApiContext,
	path: string,
): Promise<RunReport | undefined> {
	const resolved = await resolveContainedRunFile(ctx.cwd, path);
	if (resolved.kind !== "ok") return undefined;
	const file = await open(resolved.path, "r");
	try {
		if (!(await file.stat()).isFile()) return undefined;
		const buffer = Buffer.alloc(REPORT_MAX_BYTES + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		// Reports are UTF-8 text, never rendered as HTML or returned as arbitrary binary.
		const bytes = buffer.subarray(0, Math.min(bytesRead, REPORT_MAX_BYTES));
		if (bytes.includes(0)) return undefined;
		const truncated = bytesRead > REPORT_MAX_BYTES;
		const redact = hostTextRedactor(ctx.env ?? process.env);
		return {
			path: redact(path),
			...boundReportText(redact(bytes.toString("utf8")), truncated),
		};
	} finally {
		await file.close();
	}
}

export async function hostTaskLogIds(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<string[]> {
	const ids: string[] = [];
	for (const task of run.tasks) {
		if (!task.startedAt) continue;
		for (const candidate of [task.files?.output, task.files?.stderr]) {
			if (!candidate) continue;
			const resolved = await resolveContainedRunFile(cwd, candidate);
			if (
				resolved.kind === "ok" &&
				(await stat(resolved.path).catch(() => undefined))?.isFile()
			) {
				ids.push(task.taskId);
				break;
			}
		}
	}
	return ids;
}
