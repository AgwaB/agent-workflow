/**
 * Readiness probe (D1): no model turn, no credential files. Version from `claude --version`, auth
 * from `claude auth status --json` (only the `loggedIn` boolean is read; account fields are never
 * kept), models from the stream-json `initialize` control request (only the model `value`s are
 * kept). Verified live with claude-code 2.1.310: the `initialize` exchange makes no model call and
 * writes no session.
 */
import { spawn } from "node:child_process";
import type { AuthStatus } from "../../sdk/contract.js";

export interface CommandOutput {
	readonly code: number | null;
	readonly stdout: string;
	readonly error?: string;
}

export function runCommand(
	command: string,
	args: readonly string[],
	options: { readonly timeoutMs: number; readonly cwd?: string },
): Promise<CommandOutput> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const finish = (output: CommandOutput) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(output);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...args], {
				stdio: ["ignore", "pipe", "ignore"],
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			});
		} catch (error) {
			resolve({ code: null, stdout: "", error: String(error) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, error: "timeout" });
		}, options.timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", (error) =>
			finish({ code: null, stdout, error: error.message }),
		);
		child.on("close", (code) => finish({ code, stdout }));
	});
}

export function parseCliVersion(output: string): string | null {
	const match = /(\d+\.\d+\.\d+)/u.exec(output);
	return match === null ? null : (match[1] ?? null);
}

/** Map `claude auth status --json` to a non-secret enum. Never returns account fields. */
export function parseAuthStatus(output: CommandOutput): AuthStatus {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.stdout);
	} catch {
		return "unknown";
	}
	if (parsed === null || typeof parsed !== "object") return "unknown";
	const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn;
	if (loggedIn === true) return "ok";
	if (loggedIn === false) return "missing";
	return "unknown";
}

/** Model values from an `initialize` control response (no account data is returned). */
export function modelsFromInitialize(line: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const response = (
		parsed as { response?: { response?: { models?: unknown } } }
	)?.response?.response;
	if (!Array.isArray(response?.models)) return null;
	return response.models.flatMap((model) =>
		model !== null &&
		typeof model === "object" &&
		typeof (model as { value?: unknown }).value === "string"
			? [(model as { value: string }).value]
			: [],
	);
}

export const PROBE_INIT_ARGV = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--setting-sources",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--permission-mode",
	"default",
	"--tools",
	"",
	"--no-session-persistence",
] as const;

/** Send only `initialize` (no user message ⇒ no model turn) and read the model list. */
export function listModels(
	claudePath: string,
	options: { readonly timeoutMs: number; readonly cwd: string },
): Promise<string[] | null> {
	return new Promise((resolve) => {
		let settled = false;
		let child: ReturnType<typeof spawn>;
		const finish = (models: string[] | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child?.stdin?.end();
			child?.kill("SIGTERM");
			resolve(models);
		};
		try {
			child = spawn(claudePath, [...PROBE_INIT_ARGV], {
				cwd: options.cwd,
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			resolve(null);
			return;
		}
		const timer = setTimeout(() => finish(null), options.timeoutMs);
		let buffer = "";
		child.stdout?.on("data", (chunk) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.includes('"probe-initialize"')) {
					finish(modelsFromInitialize(line));
					return;
				}
				index = buffer.indexOf("\n");
			}
		});
		child.stdin?.on("error", () => {});
		child.on("error", () => finish(null));
		child.on("close", () => finish(null));
		child.stdin?.write(
			`${JSON.stringify({ type: "control_request", request_id: "probe-initialize", request: { subtype: "initialize" } })}\n`,
		);
	});
}
