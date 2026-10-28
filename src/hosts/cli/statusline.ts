// New in agent-workflow (WP36, owner decision E1): `agent-workflow statusline`, a fast read-only
// one-liner of the project's active runs for Claude Code's `statusLine.command` (or any prompt or
// tmux status bar): `aw: deep-review 5/13 running 12m · +1 more`, empty when idle. Claude Code
// pipes a JSON object on stdin (`workspace.project_dir`, `workspace.current_dir`, `cwd`); the runs
// of those directories (else the working directory) are shown. It never fails loudly: any error
// prints nothing and exits 0. No model call, no lease, no write. The bin (cli.mjs) loads this
// module directly, without the rest of the CLI, to stay fast.
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PROJECT_STATE_DIRECTORY } from "../../core/home-dir.js";
import {
	type ActiveRun,
	formatStatusLine,
	listActiveRuns,
} from "../run-progress.js";

/** How long to wait for Claude Code's stdin JSON before going on without it. */
export const STATUSLINE_STDIN_TIMEOUT_MS = 150;

export interface StatusLineIo {
	cwd: string;
	/** stdin text (the host's JSON), or undefined when stdin is a terminal or empty. */
	readStdin?: () => Promise<string | undefined>;
	stdout: (text: string) => void;
	now?: () => number;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" && current ? current : undefined;
}

/** Project directories to show: the host's project and current directory, else `cwd`. */
export function statusLineDirectories(
	stdinText: string | undefined,
	cwd: string,
): string[] {
	let input: unknown;
	try {
		input = stdinText?.trim() ? JSON.parse(stdinText) : undefined;
	} catch {
		input = undefined;
	}
	const candidates = [
		stringAt(input, "workspace", "project_dir"),
		stringAt(input, "workspace", "current_dir"),
		stringAt(input, "cwd"),
	].filter((dir): dir is string => dir !== undefined);
	const dirs = candidates.length > 0 ? candidates : [cwd];
	return [...new Set(dirs.map((dir) => resolve(cwd, dir)))];
}

async function hasRuns(dir: string): Promise<boolean> {
	try {
		return (
			await stat(join(dir, PROJECT_STATE_DIRECTORY, "workflows"))
		).isDirectory();
	} catch {
		return false;
	}
}

/** The status-line text for `dirs` (empty when idle). Never throws. */
export async function statusLineText(
	dirs: readonly string[],
	now = Date.now(),
): Promise<string> {
	try {
		const active: ActiveRun[] = [];
		const seen = new Set<string>();
		for (const dir of dirs) {
			if (!(await hasRuns(dir))) continue;
			for (const item of await listActiveRuns(dir, { now })) {
				if (seen.has(item.run.runId)) continue;
				seen.add(item.run.runId);
				active.push(item);
			}
		}
		return formatStatusLine(active, now);
	} catch {
		return "";
	}
}

/** Read stdin when it is a pipe, for at most `timeoutMs`. */
export function readProcessStdin(
	timeoutMs = STATUSLINE_STDIN_TIMEOUT_MS,
): Promise<string | undefined> {
	if (process.stdin.isTTY) return Promise.resolve(undefined);
	return new Promise((resolveText) => {
		const chunks: Buffer[] = [];
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			process.stdin.off("data", onData);
			process.stdin.off("end", finish);
			process.stdin.off("error", finish);
			process.stdin.pause();
			resolveText(
				chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
			);
		};
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			if (chunks.reduce((total, part) => total + part.length, 0) > 1 << 20)
				finish();
		};
		const timer = setTimeout(finish, timeoutMs);
		timer.unref?.();
		process.stdin.on("data", onData);
		process.stdin.once("end", finish);
		process.stdin.once("error", finish);
	});
}

/** `agent-workflow statusline`: prints the line (or nothing); always exit code 0. */
export async function runStatusLine(io: StatusLineIo): Promise<number> {
	try {
		const stdinText = await (io.readStdin?.() ?? Promise.resolve(undefined));
		const text = await statusLineText(
			statusLineDirectories(stdinText, io.cwd),
			io.now?.() ?? Date.now(),
		);
		if (text) io.stdout(`${text}\n`);
	} catch {
		// Never fail loudly: a status line that errors would show an error in the host's UI.
	}
	return 0;
}

/** The bin's fast path (src/hosts/cli/cli.mjs). */
export function statusLineMain(): Promise<number> {
	return runStatusLine({
		cwd: process.cwd(),
		readStdin: () => readProcessStdin(),
		stdout: (text) => process.stdout.write(text),
	});
}
