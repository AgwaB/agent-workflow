// 2026-11-05 (live: the ChatGPT app's Codex starts MCP servers with PATH=/usr/bin:/bin:/usr/sbin:/sbin
// plus its own directories, so `claude` in ~/.local/bin was not found: "spawn claude ENOENT", the run
// never started). As kimi-code (packages/kaos/src/login-shell-path.ts), trilium
// (apps/server/src/services/llm/providers/binary_lookup.ts findOnPath) and cline
// (sdk/packages/core/src/remote/shell-path.ts): ask the user's login shell for its PATH and append the
// absolute entries the current PATH lacks; the current entries keep their order and priority. Both
// `-l` (profile files; fast) and `-i -l` (rc files, where nvm and homebrew usually are; 3-5 s on the
// test machine) run, at most 10 s; any failure leaves PATH as it is. `/usr/bin/env` by absolute path
// (a bare `env` would resolve through the inherited PATH). AGENT_WORKFLOW_LOGIN_SHELL_PATH=0 turns
// it off.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { basename } from "node:path";

export const LOGIN_SHELL_PATH_ENV = "AGENT_WORKFLOW_LOGIN_SHELL_PATH";
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 10_000;
const MARK = "__AGENT_WORKFLOW_LOGIN_SHELL_ENV__";
const COMMAND = `printf '%s\\n' '${MARK}'; /usr/bin/env`;

/** Runs `shell args…`; resolves with stdout (also of a failed or timed-out shell), never rejects. */
export type LoginShellRunner = (
	shell: string,
	args: readonly string[],
	timeoutMs: number,
) => Promise<string>;

const runShell: LoginShellRunner = (shell, args, timeoutMs) =>
	new Promise((resolve) => {
		try {
			const child = execFile(
				shell,
				[...args],
				{
					timeout: timeoutMs,
					killSignal: "SIGKILL",
					encoding: "utf8",
					maxBuffer: 4 * 1024 * 1024,
				},
				(_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
			);
			// An interactive shell that reads stdin gets EOF at once.
			child.stdin?.end();
		} catch {
			resolve("");
		}
	});

/** PATH from the env dump after the last marker (profile output before it is ignored). */
export function pathFromShellOutput(output: string): string | undefined {
	const at = output.lastIndexOf(MARK);
	if (at < 0) return undefined;
	let path: string | undefined;
	for (const line of output.slice(at + MARK.length).split("\n"))
		if (line.startsWith("PATH=")) path = line.slice("PATH=".length).trim();
	return path ? path : undefined;
}

/**
 * The current PATH verbatim, then the login shell's absolute entries it lacks, in their order
 * (empty, `.` and relative entries are cwd-dependent and never added).
 */
export function mergeLoginShellPath(
	currentPath: string | undefined,
	loginPath: string,
): string {
	const current = currentPath ?? "";
	const seen = new Set(current.split(":").filter(Boolean));
	const added: string[] = [];
	for (const entry of loginPath.split(":")) {
		if (!entry.startsWith("/") || seen.has(entry)) continue;
		seen.add(entry);
		added.push(entry);
	}
	if (added.length === 0) return current;
	return currentPath === undefined || currentPath === ""
		? added.join(":")
		: `${current}:${added.join(":")}`;
}

function loginShell(env: NodeJS.ProcessEnv): string | undefined {
	let shell = env.SHELL?.trim();
	if (!shell)
		try {
			shell = userInfo().shell ?? undefined;
		} catch {
			shell = undefined;
		}
	// csh/tcsh take -l only as the sole flag; such a shell is left alone.
	if (!shell?.startsWith("/") || /^t?csh$/u.test(basename(shell)))
		return undefined;
	return shell;
}

/**
 * Adds the login shell's PATH entries to `env.PATH` (in place; the server passes process.env, so
 * workers and detached supervisors inherit it). Returns the added entries. Never throws.
 */
export async function adoptLoginShellPath(
	env: NodeJS.ProcessEnv = process.env,
	options: {
		platform?: NodeJS.Platform;
		run?: LoginShellRunner;
		timeoutMs?: number;
	} = {},
): Promise<string[]> {
	if ((options.platform ?? process.platform) === "win32") return [];
	if (env[LOGIN_SHELL_PATH_ENV]?.trim() === "0") return [];
	const shell = loginShell(env);
	if (!shell) return [];
	const run = options.run ?? runShell;
	const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS;
	const outputs = await Promise.all([
		run(shell, ["-l", "-c", COMMAND], timeoutMs).catch(() => ""),
		run(shell, ["-i", "-l", "-c", COMMAND], timeoutMs).catch(() => ""),
	]);
	const before = new Set((env.PATH ?? "").split(":").filter(Boolean));
	for (const output of outputs) {
		const path = pathFromShellOutput(output);
		if (path) env.PATH = mergeLoginShellPath(env.PATH, path);
	}
	return (env.PATH ?? "")
		.split(":")
		.filter((entry) => entry && !before.has(entry));
}
