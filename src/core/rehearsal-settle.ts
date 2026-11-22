// A rehearsal runs its workers in durable child processes: a worker, and the detached terminal finalizer it
// spawns, may still be writing under the temporary state root after the engine has seen the run end. The
// rehearsal must not remove that root (or return) before they are done, so it waits for every process whose
// command line names the root — directly (worker payload path) or inside a base64url launch payload
// (the finalizer). Read-only: this never signals a process.
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAYLOAD_TOKEN = /^[A-Za-z0-9_-]{24,}$/u;

/** PIDs of processes (other than this one) whose command line refers to `root`; `undefined` if `ps` is unusable. */
export async function processesUsingRoot(
	root: string,
): Promise<number[] | undefined> {
	let text: string;
	try {
		text = (
			await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "args="], {
				maxBuffer: 64 * 1024 * 1024,
			})
		).stdout;
	} catch {
		return undefined;
	}
	const pids: number[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
		if (match === null) continue;
		const pid = Number(match[1]);
		const args = match[2] ?? "";
		if (pid === process.pid) continue;
		if (args.includes(root) || payloadNamesRoot(args, root)) pids.push(pid);
	}
	return pids;
}

function payloadNamesRoot(args: string, root: string): boolean {
	for (const token of args.split(/\s+/u)) {
		if (!PAYLOAD_TOKEN.test(token)) continue;
		try {
			if (Buffer.from(token, "base64url").toString("utf8").includes(root))
				return true;
		} catch {
			// not a payload
		}
	}
	return false;
}

/** Wait until no process refers to `root`. Returns false when some still do at the deadline. */
export async function waitForRootProcesses(
	root: string,
	timeoutMs: number,
	pollMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const pids = await processesUsingRoot(root);
		if (pids === undefined || pids.length === 0) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

type RemoveTree = (path: string) => void;

function removeTree(path: string): void {
	rmSync(path, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 50,
	});
}

let removeForTests: RemoveTree | undefined;

/** Test seam: make the removal of a temporary root fail (or observe it). */
export function setRehearsalRemoveForTests(hook: RemoveTree | undefined): void {
	removeForTests = hook;
}

/**
 * Remove a finished rehearsal's temporary root. A removal that still fails must not turn a finished
 * rehearsal into an error: the path is returned so the result can name what was left behind.
 */
export function removeRehearsalRoot(root: string): string | undefined {
	try {
		(removeForTests ?? removeTree)(root);
		return undefined;
	} catch {
		return root;
	}
}
