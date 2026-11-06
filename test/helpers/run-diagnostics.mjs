import { stateDir } from "./state-dir.mjs";
// Why did a run not complete? Rare load-dependent failures (a task `blocked` or `launch_failed`
// once in many full-suite runs) cannot be reproduced on demand, so a failing assertion should
// carry the evidence: every task's state and reason, and the tails of the worker logs, task
// stderr and runtime event logs under the project's `.agent-workflow`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LOG_NAMES = new Set(["worker.log", "stderr.log", "events.jsonl"]);

function logFiles(dir, found = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) logFiles(path, found);
		else if (LOG_NAMES.has(entry.name)) found.push(path);
	}
	return found;
}

/** A compact, bounded description of run `runId` in project `cwd` (never throws). */
export async function runDiagnostics(cwd, runId, { tailChars = 1200 } = {}) {
	const lines = [];
	try {
		const store = await import("../../dist/core/store.js");
		const run = await store.readRunRecord(cwd, runId);
		lines.push(`run ${run.runId}: ${run.status}`);
		for (const task of run.tasks)
			lines.push(
				`  ${task.specId}: ${task.status}${task.statusDetail ? ` (${task.statusDetail})` : ""}${task.lastMessage ? ` — ${task.lastMessage}` : ""}`,
			);
	} catch (error) {
		lines.push(`run ${runId}: unreadable (${error?.message ?? error})`);
	}
	const files = logFiles(join(stateDir(cwd), ".agent-workflow"))
		.filter((path) => {
			try {
				return statSync(path).size > 0;
			} catch {
				return false;
			}
		})
		.slice(0, 12);
	for (const path of files) {
		let text = "";
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		lines.push(
			`--- ${relative(cwd, path)} (last ${Math.min(tailChars, text.length)} chars)`,
			text.slice(-tailChars),
		);
	}
	return lines.join("\n");
}
