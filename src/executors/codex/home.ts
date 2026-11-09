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
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * decision says so or when the links cannot be created (for example no symlink privilege). With `stateDir`,
 * `dir` must be a plain directory chain below it: the old home is removed recursively, and through a symlinked
 * directory that would delete files elsewhere (round-5 review, 2026-11-09).
 */
export function prepareCodexWorkerHome(options: {
	readonly userHome: string;
	readonly dir: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly inherit?: boolean;
	readonly stateDir?: string;
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
	// Checked before anything is removed — including the cleanup below, which would otherwise delete through the
	// symlink it just refused.
	if (options.stateDir !== undefined)
		try {
			assertPlainDirectoryChain(options.stateDir, options.dir);
		} catch (error) {
			return {
				path: options.userHome,
				relocated: false,
				reason: `cannot prepare a private home under ${options.dir}: ${(error as Error).message}`,
				linked: [],
			};
		}
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
		linkAuthLock(path, options.userHome, linked);
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
 * Codex 0.166 serializes every auth.json read/modify/write (token refresh, login) under `auth.lock` in its
 * CODEX_HOME and saves a refresh only if the stored refresh token is still the one it refreshed from. A private
 * home that links auth.json must share that lock, or a worker and the user's own Codex could both refresh and
 * the later save would overwrite the earlier rotation. The link may dangle: Codex creates the target (in the
 * user's home) when it first opens it; agent-workflow writes nothing there (2026-11-09).
 */
function linkAuthLock(path: string, userHome: string, linked: string[]): void {
	if (!linked.includes("auth.json")) return;
	symlinkSync(join(userHome, "auth.lock"), join(path, "auth.lock"), "file");
	linked.push("auth.lock");
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
	paths: CodexHomePaths,
): string | undefined {
	// Round 4 (gpt-6-astra): a home (or a directory above it) replaced by a symlink would lead to the user's own
	// auth.json; only a plain directory chain below the state directory is ever touched.
	assertPlainDirectoryChain(paths.stateDir, homePath);
	const keepDir = paths.keepDir;
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

/** Where a private home may live (below `stateDir`) and where a replaced auth.json is kept. */
export interface CodexHomePaths {
	readonly stateDir: string;
	readonly keepDir: string;
}

/** Every directory from below `anchor` down to `path` must be a plain directory, not a symlink. */
function assertPlainDirectoryChain(anchor: string, path: string): void {
	const base = resolve(anchor);
	const rel = relative(base, resolve(path));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
		throw new Error("private CODEX_HOME is outside the state directory");
	let current = base;
	for (const part of rel.split(sep)) {
		current = join(current, part);
		const info = lstatSync(current);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error(
				`private CODEX_HOME path is not a plain directory: ${current}`,
			);
	}
}

export function removeCodexWorkerHome(
	home: CodexWorkerHome,
	paths: CodexHomePaths,
): string | undefined {
	if (!home.relocated) return undefined;
	let kept: string | undefined;
	try {
		kept = keepReplacedAuth(home.path, paths);
	} catch {
		return undefined;
	}
	rmSync(home.path, { recursive: true, force: true, maxRetries: 3 });
	return kept;
}
