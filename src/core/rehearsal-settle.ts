// A rehearsal runs its workers in durable child processes: a worker, and the detached terminal finalizer it
// spawns, may still be writing under the temporary state root after the engine has seen the run end. The
// rehearsal must not remove that root (or return) before they are done, so it waits for every process whose
// command line names the root — directly (worker payload path) or inside a base64url launch payload
// (the finalizer). Read-only: this never signals a process.
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// A standalone `processesUsingRoot` call has no deadline; the scanner is still bounded.
const PS_UNBOUNDED_MS = 30_000;
const PAYLOAD_TOKEN = /^[A-Za-z0-9_-]{24,}$/u;

type PsRunner = (root: string, timeoutMs: number) => Promise<string>;

let psCommandForTests: { file: string; args: string[] } | undefined;

/** Test seam: run another command in place of `ps` (a finite stand-in the rehearsal starts and must end). */
export function setRehearsalPsCommandForTests(
	file: string | undefined,
	args: string[] = [],
): void {
	psCommandForTests = file === undefined ? undefined : { file, args };
}

// The scanner is this rehearsal's own child, not an enumerated process: when the wait gives up, Node ends it
// (`timeout` + `killSignal`), so it never outlives the wait in an embedding host.
async function runPs(_root: string, timeoutMs: number): Promise<string> {
	const command = psCommandForTests ?? {
		file: "ps",
		args: ["-A", "-o", "pid=", "-o", "args="],
	};
	return (
		await execFileAsync(command.file, command.args, {
			maxBuffer: 64 * 1024 * 1024,
			timeout: Math.max(timeoutMs, 1),
			killSignal: "SIGKILL",
		})
	).stdout;
}

let psForTests: PsRunner | undefined;

/** Test seam: replace the `ps` call (the runner returns its stdout or throws like `execFile`). */
export function setRehearsalPsForTests(hook: PsRunner | undefined): void {
	psForTests = hook;
}

type ProcessScan =
	| { kind: "pids"; pids: number[] }
	// `ps` does not exist here (e.g. Windows): the root cannot be checked, and never will be.
	| { kind: "unavailable" }
	// `ps` exists but this call failed (load, EAGAIN, a signal): says nothing about the root.
	| { kind: "failed" };

async function scanProcesses(
	root: string,
	timeoutMs: number,
): Promise<ProcessScan> {
	let text: string;
	try {
		text = await (psForTests ?? runPs)(root, timeoutMs);
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
			? { kind: "unavailable" }
			: { kind: "failed" };
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
	return { kind: "pids", pids };
}

/** PIDs of processes (other than this one) whose command line refers to `root`; `undefined` if `ps` is unusable. */
export async function processesUsingRoot(
	root: string,
): Promise<number[] | undefined> {
	const scan = await scanProcesses(root, PS_UNBOUNDED_MS);
	return scan.kind === "pids" ? scan.pids : undefined;
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

/** What is known about `root` at the end of a wait: only `quiet` allows removing it. */
export type RootQuiescence = "quiet" | "busy" | "unknown";

/** `scanProcesses` bounded by `budgetMs`: a `ps` that does not answer in time reads as a failed scan (never killed). */
async function scanWithin(
	root: string,
	budgetMs: number,
): Promise<ProcessScan> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<ProcessScan>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "failed" }), budgetMs);
	});
	try {
		return await Promise.race([scanProcesses(root, budgetMs), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Wait until no process refers to `root`; every `ps` call is bounded by the time left. Three outcomes:
 * `quiet` — a scan saw no process; `busy` — a process was still using the root when the deadline came;
 * `unknown` — no scan succeeded (`ps` missing, failing or hanging until the deadline), which is not evidence of
 * quiet. The caller removes the root only on `quiet`. Nothing is ever signalled.
 */
export async function waitForRootProcesses(
	root: string,
	timeoutMs: number,
	pollMs = 50,
): Promise<RootQuiescence> {
	const deadline = Date.now() + timeoutMs;
	let seenBusy = false;
	for (;;) {
		const scan = await scanWithin(root, Math.max(deadline - Date.now(), 1));
		// `ps` does not exist here (e.g. Windows): it never will, and nothing can be said about the root.
		if (scan.kind === "unavailable") return "unknown";
		if (scan.kind === "pids") {
			if (scan.pids.length === 0) return "quiet";
			seenBusy = true;
		}
		if (Date.now() >= deadline) return seenBusy ? "busy" : "unknown";
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
