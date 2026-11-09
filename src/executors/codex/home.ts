/**
 * 2026-11-08 (context-quality backlog C1): a private `CODEX_HOME` for isolated Codex workers.
 *
 * Codex loads global instructions from `$CODEX_HOME/AGENTS.override.md` or `AGENTS.md` (first
 * non-empty file wins, no switch to disable it — codex `360319d8`,
 * `codex-rs/codex-home/src/instructions/mod.rs:41-80`), so the only way to keep the user's global
 * instructions out of a worker is a home without them. The worker home links, never copies:
 *
 * - `auth.json` → the user's file. Codex's file store writes refreshed tokens **in place**
 *   (`codex-rs/login/src/auth/storage.rs:227-243`, truncate + write, no rename), so the link keeps
 *   the one shared credential file every Codex process uses today; a copy would diverge at the next
 *   refresh (refresh tokens rotate; a reused one is rejected, `manager.rs:1757`).
 * - `config.toml` → the user's file (model providers, profiles, project trust; MCP servers the thread
 *   config disables as before). Nothing under it is copied into state.
 * - `rules/` → the user's exec-policy directory: policy survives isolation by design and is probed.
 *
 * Not linked: `AGENTS.md`, `AGENTS.override.md`, `skills/`, `plugins/`, `memories*`, sessions and
 * history. The home is created under the attempt's log directory and removed when the app-server
 * exits.
 *
 * Relocation is skipped (the user's home is used, as before) when the stage inherits user context,
 * when `cli_auth_credentials_store` is not `file` — the keyring store keys credentials by a hash of
 * the home path (`storage.rs:259-270`), so a private home would find nothing and `auto` would save a
 * refresh under the private key — or when there is neither an `auth.json` nor an API-key variable.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { processAlive } from "./state.js";

export type CodexCredentialsStore =
	| "file"
	| "keyring"
	| "auto"
	| "ephemeral"
	| "unknown";

export const CODEX_WORKER_HOME_DIRNAME = "home";
export const CODEX_API_KEY_ENV_VARS = [
	"OPENAI_API_KEY",
	"CODEX_API_KEY",
] as const;

/** `cli_auth_credentials_store` from the top level of `config.toml`; Codex's default is `file`. */
export function codexCredentialsStore(userHome: string): CodexCredentialsStore {
	let text: string;
	try {
		text = readFileSync(join(userHome, "config.toml"), "utf8");
	} catch {
		return "file";
	}
	for (const raw of text.split(/\r?\n/u)) {
		const line = raw.trim();
		if (/^\[/u.test(line)) break; // top level ends at the first table header
		const match =
			/^cli_auth_credentials_store\s*=\s*"([^"]*)"\s*(?:#.*)?$/u.exec(line);
		if (!match) continue;
		const value = match[1]!.trim().toLowerCase();
		return value === "file" ||
			value === "keyring" ||
			value === "auto" ||
			value === "ephemeral"
			? value
			: "unknown";
	}
	return "file";
}

export interface CodexWorkerHomeDecision {
	readonly relocate: boolean;
	/** Why the user's home is kept (absent when relocating). */
	readonly reason?: string;
	readonly credentialsStore: CodexCredentialsStore;
	readonly authFile: "present" | "absent";
}

export function decideCodexWorkerHome(options: {
	readonly userHome: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly inherit?: boolean;
}): CodexWorkerHomeDecision {
	const env = options.env ?? process.env;
	const credentialsStore = codexCredentialsStore(options.userHome);
	const authFile = existsSync(join(options.userHome, "auth.json"))
		? "present"
		: "absent";
	const base = { credentialsStore, authFile } as const;
	if (options.inherit === true)
		return { ...base, relocate: false, reason: "stage inherits user context" };
	if (credentialsStore !== "file")
		return {
			...base,
			relocate: false,
			reason: `cli_auth_credentials_store="${credentialsStore}" keys credentials by the home path`,
		};
	const apiKey = CODEX_API_KEY_ENV_VARS.some(
		(name) => (env[name] ?? "").trim() !== "",
	);
	if (authFile === "absent" && !apiKey)
		return {
			...base,
			relocate: false,
			reason: `no auth.json in ${options.userHome} and no API-key variable`,
		};
	return { ...base, relocate: true };
}

export interface CodexWorkerHome {
	/** The `CODEX_HOME` the worker gets (the user's when not relocated). */
	readonly path: string;
	readonly relocated: boolean;
	readonly reason?: string;
	/** Entries linked into the private home (names only). */
	readonly linked: readonly string[];
}

/**
 * Prepare the worker's home under `dir`. Falls back to the user's home (with the reason) when the
 * decision says so or when the links cannot be created (for example no symlink privilege).
 */
export function prepareCodexWorkerHome(options: {
	readonly userHome: string;
	readonly dir: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly inherit?: boolean;
}): CodexWorkerHome {
	const decision = decideCodexWorkerHome(options);
	if (!decision.relocate)
		return {
			path: options.userHome,
			relocated: false,
			reason: decision.reason,
			linked: [],
		};
	const path = join(options.dir, CODEX_WORKER_HOME_DIRNAME);
	const linked: string[] = [];
	try {
		rmSync(path, { recursive: true, force: true });
		mkdirSync(path, { recursive: true, mode: 0o700 });
		for (const name of ["auth.json", "config.toml", "rules"]) {
			const target = join(options.userHome, name);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(target);
			} catch {
				continue;
			}
			if (name === "rules" ? !stat.isDirectory() : !stat.isFile()) continue;
			symlinkSync(target, join(path, name), name === "rules" ? "dir" : "file");
			linked.push(name);
		}
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		return {
			path: options.userHome,
			relocated: false,
			reason: `cannot prepare a private home under ${options.dir}: ${
				(error as NodeJS.ErrnoException).code ?? String(error)
			}`,
			linked: [],
		};
	}
	return { path, relocated: true, linked };
}

/** Remove a private worker home; links are removed, their targets untouched. */
/**
 * Re-review 2026-11-09 (gpt-6-astra, claude-fable-5-1): a kept thread's rollout lives in its CODEX_HOME,
 * so a kept session gets a private home outside the attempt's log directory that outlives the attempt:
 * resume reuses it (the path is kept with the thread's ownership record) and deleting the owned session
 * removes it. The first fix used the user's home instead, which silently dropped the isolation the
 * probe had advertised.
 */
export function codexSessionHomeDir(stateDir: string, key: string): string {
	return join(
		stateDir,
		"session-homes",
		createHash("sha256").update(key).digest("hex").slice(0, 40),
	);
}

/** A kept session's private home, its links restored if any went missing. */
export function reuseCodexWorkerHome(
	path: string,
	userHome: string,
): CodexWorkerHome {
	const linked: string[] = [];
	for (const name of ["auth.json", "config.toml", "rules"]) {
		const link = join(path, name);
		try {
			lstatSync(link);
			linked.push(name);
			continue;
		} catch {}
		try {
			const target = join(userHome, name);
			const stat = statSync(target);
			if (name === "rules" ? !stat.isDirectory() : !stat.isFile()) continue;
			symlinkSync(target, link, name === "rules" ? "dir" : "file");
			linked.push(name);
		} catch {}
	}
	return { path, relocated: true, linked };
}

/**
 * Review F (2026-11-09) and round 3 (gpt-6-astra): linking is safe while Codex writes auth.json in place (0.165
 * source). Should a Codex version replace the link with a file of its own, that file is kept, never copied over
 * the user's auth.json: an automatic restore can overwrite a newer or another account's login. It moves to
 * `keepDir` (mode 0600; the probe reports it) and the user's file is not touched. agent-workflow does not parse it.
 * Throws when the file cannot be kept, so the caller leaves the home in place instead of deleting it.
 */
export function keepReplacedAuth(
	homePath: string,
	keepDir: string,
): string | undefined {
	const privateAuth = join(homePath, "auth.json");
	try {
		const stat = lstatSync(privateAuth);
		if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
	} catch {
		return undefined;
	}
	mkdirSync(keepDir, { recursive: true, mode: 0o700 });
	const target = join(
		keepDir,
		`${Date.now()}-${randomBytes(6).toString("hex")}.auth.json`,
	);
	try {
		renameSync(privateAuth, target);
		chmodSync(target, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		writeFileSync(target, readFileSync(privateAuth), {
			mode: 0o600,
			flag: "wx",
		});
	}
	return target;
}

/** Removes a kept session's private home (the per-session directory around it), keeping a replaced auth.json. */
export function removeCodexSessionHome(
	path: string,
	keepDir: string,
): string | undefined {
	let kept: string | undefined;
	try {
		kept = keepReplacedAuth(path, keepDir);
	} catch {
		return undefined;
	}
	rmSync(dirname(path), { recursive: true, force: true, maxRetries: 3 });
	return kept;
}

/**
 * Round 3 (gpt-6-astra): an app-server running in a kept session's home holds a lease on it (its pid), so
 * deleting the session never removes a home in use. A lease of a process that is gone does not count.
 */
export function leaseCodexSessionHome(
	path: string,
	attemptKey: string,
	pid: number,
): () => void {
	const dir = join(dirname(path), "leases");
	const file = join(
		dir,
		`${createHash("sha256").update(attemptKey).digest("hex").slice(0, 32)}.json`,
	);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(file, JSON.stringify({ pid, attemptKey }), { mode: 0o600 });
	} catch {}
	return () => rmSync(file, { force: true });
}

export function codexSessionHomeInUse(path: string): boolean {
	const dir = join(dirname(path), "leases");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	return names.some((name) => {
		try {
			const lease = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
				pid?: unknown;
			};
			return typeof lease.pid === "number" && processAlive(lease.pid);
		} catch {
			return false;
		}
	});
}

export function removeCodexWorkerHome(
	home: CodexWorkerHome,
	keepDir: string,
): string | undefined {
	if (!home.relocated) return undefined;
	let kept: string | undefined;
	try {
		kept = keepReplacedAuth(home.path, keepDir);
	} catch {
		return undefined;
	}
	rmSync(home.path, { recursive: true, force: true, maxRetries: 3 });
	return kept;
}
