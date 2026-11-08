// agent-workflow 2026-11-08 (context-quality backlog X1): which engine and which state of the
// reviewed repository a run used, so results can be compared and reproduced later. Follows Codex's
// session git info (commit, branch; 5 s per git command, fsmonitor off, safe.bareRepository) and adds
// the uncommitted state as hashes. Only hashes are stored, never file content or remote URLs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkflowRunCodeRevisions, WorkflowRunGitState } from "./types.js";

const GIT_TIMEOUT_MS = 5_000;
const TEXT_LIMIT = 4_096;
const GIT_SAFETY = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"safe.bareRepository=explicit",
	"--no-optional-locks",
];
// Output independent of the user's diff configuration (renames, algorithm, prefixes, abbreviation).
const CANONICAL_DIFF = [
	"diff",
	"HEAD",
	"--binary",
	"--full-index",
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--no-renames",
	"--diff-algorithm=myers",
	"--no-indent-heuristic",
	"-U3",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--submodule=short",
	"--ignore-submodules=none",
];
const STATUS = [
	"status",
	"--porcelain=v1",
	"-z",
	"--untracked-files=normal",
	"--ignore-submodules=none",
];
// Variables that would point git at another repository than the directory asked about.
const REPOSITORY_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
];

export interface CodeRevisionOptions {
	/** Package root of the running engine (default: two levels above this module). */
	packageRoot?: string;
	/** Git executable (tests use a stand-in). */
	git?: string;
	timeoutMs?: number;
}

interface GitResult {
	ok: boolean;
	bytes: number;
	sha256: string;
	text: string;
	issue?: string;
}

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	for (const key of REPOSITORY_ENV) delete env[key];
	return env;
}

function runGit(
	git: string,
	cwd: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const hash = createHash("sha256");
		let bytes = 0;
		let text = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const finish = (result: Omit<GitResult, "sha256" | "bytes" | "text">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ ...result, bytes, text, sha256: hash.digest("hex") });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(git, [...GIT_SAFETY, ...args], {
				cwd,
				env: gitEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				// Own process group, so a timeout also ends helpers git started (filters, hooks).
				detached: process.platform !== "win32",
			});
		} catch (error) {
			resolvePromise({
				ok: false,
				bytes: 0,
				text: "",
				sha256: createHash("sha256").digest("hex"),
				issue: `git could not start: ${(error as Error).message}`,
			});
			return;
		}
		// A helper that outlives git keeps the pipes open, so the timeout settles at once instead
		// of waiting for `close`.
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid !== undefined && process.platform !== "win32")
					process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish({
				ok: false,
				issue: `git ${args[0]} timed out after ${timeoutMs} ms`,
			});
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			bytes += chunk.length;
			hash.update(chunk);
			if (text.length < TEXT_LIMIT) text += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < TEXT_LIMIT) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) =>
			finish({ ok: false, issue: `git could not start: ${error.message}` }),
		);
		child.on("close", (code) => {
			if (timedOut)
				return finish({
					ok: false,
					issue: `git ${args[0]} timed out after ${timeoutMs} ms`,
				});
			const firstLine = stderr.trim().split("\n")[0]?.slice(0, 200);
			finish(
				code === 0
					? { ok: true }
					: {
							ok: false,
							issue: `git ${args[0]} exited ${code}${firstLine ? `: ${firstLine}` : ""}`,
						},
			);
		});
	});
}

/** Nearest directory at or above `start` that has a `.git` entry, without starting git. */
function gitMarkerAbove(start: string): boolean {
	let current = resolve(start);
	while (true) {
		try {
			lstatSync(join(current, ".git"));
			return true;
		} catch {
			// keep walking up
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

async function gitState(
	git: string,
	cwd: string,
	timeoutMs: number,
): Promise<WorkflowRunGitState & { toplevel?: string }> {
	const issues: string[] = [];
	const toplevel = await runGit(
		git,
		cwd,
		["rev-parse", "--show-toplevel"],
		timeoutMs,
	);
	if (!toplevel.ok)
		return { issues: [toplevel.issue ?? "git rev-parse failed"] };
	const [head, branch, status] = await Promise.all([
		runGit(git, cwd, ["rev-parse", "--verify", "-q", "HEAD"], timeoutMs),
		runGit(git, cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs),
		runGit(git, cwd, STATUS, timeoutMs),
	]);
	const state: WorkflowRunGitState & { toplevel?: string } = {
		toplevel: toplevel.text.trim(),
	};
	if (head.ok && head.text.trim()) state.head = head.text.trim();
	// `rev-parse --verify -q` exits 1 without a message on an unborn branch.
	else
		issues.push(
			head.issue && !/exited 1$/u.test(head.issue)
				? head.issue
				: "HEAD has no commit",
		);
	// `symbolic-ref -q` exits 1 without a message on a detached HEAD: no branch, not an issue.
	if (branch.ok && branch.text.trim()) state.branch = branch.text.trim();
	else if (branch.issue && !/exited 1$/u.test(branch.issue))
		issues.push(branch.issue);
	if (status.ok) {
		state.dirty = status.bytes > 0;
		state.statusSha256 = status.sha256;
	} else issues.push(status.issue ?? "git status failed");
	if (state.head) {
		const diff = await runGit(git, cwd, CANONICAL_DIFF, timeoutMs);
		if (diff.ok) state.diffSha256 = diff.sha256;
		else issues.push(diff.issue ?? "git diff failed");
	}
	if (issues.length > 0) state.issues = issues;
	return state;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function packageVersion(packageRoot: string): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// The engine code a process runs was loaded when it started, so its checkout is read once.
const engineCheckoutByRoot = new Map<
	string,
	Promise<(WorkflowRunGitState & { toplevel?: string }) | undefined>
>();

function engineCheckoutState(
	git: string,
	packageRoot: string,
	timeoutMs: number,
): Promise<(WorkflowRunGitState & { toplevel?: string }) | undefined> {
	const key = `${git}\0${realpathOrSelf(packageRoot)}`;
	let pending = engineCheckoutByRoot.get(key);
	if (!pending) {
		try {
			lstatSync(join(packageRoot, ".git"));
			pending = gitState(git, packageRoot, timeoutMs);
		} catch {
			pending = Promise.resolve(undefined);
		}
		engineCheckoutByRoot.set(key, pending);
	}
	return pending;
}

export function resetCodeRevisionCacheForTests(): void {
	engineCheckoutByRoot.clear();
}

/** Never throws; failures are recorded as `issues`. */
export async function captureCodeRevisions(
	cwd: string,
	options: CodeRevisionOptions = {},
): Promise<WorkflowRunCodeRevisions> {
	const git = options.git ?? "git";
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
	const packageRoot =
		options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url));
	const capturedAt = new Date().toISOString();

	const engine: WorkflowRunCodeRevisions["engine"] = {
		version: packageVersion(packageRoot),
	};
	const target: WorkflowRunCodeRevisions["target"] = gitMarkerAbove(cwd)
		? { repository: true }
		: { repository: false };

	const [engineState, targetState] = await Promise.all([
		engineCheckoutState(git, packageRoot, timeoutMs),
		target.repository
			? gitState(git, cwd, timeoutMs)
			: Promise.resolve(undefined),
	]);
	// Only a checkout of the engine itself, never a parent repository holding an installed copy.
	if (
		engineState?.toplevel &&
		realpathOrSelf(engineState.toplevel) === realpathOrSelf(packageRoot)
	) {
		const { toplevel: _toplevel, ...checkout } = engineState;
		engine.checkout = checkout;
	}
	if (targetState) {
		const { toplevel: _toplevel, ...state } = targetState;
		Object.assign(target, state);
	}
	return { capturedAt, engine, target };
}
