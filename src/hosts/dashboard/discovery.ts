// WP43b: local dashboard discovery and opt-in browser launch. Never expose control secrets in text.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import {
	link,
	lstat,
	open,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentWorkflowHome } from "../../core/home-dir.js";
import {
	ensurePrivateDirectory,
	readPrivateFileText,
	writePrivateFileAtomic,
} from "../../core/secure-atomic-write.js";
import { secureEqual } from "./security.js";
import { withStoreLock } from "../store-lock.js";

export const DASHBOARD_PROTOCOL = 2;
const SCHEMA = "agent-workflow-dashboard-v1";
export interface DashboardDiscovery {
	pid: number;
	protocol: number;
	version: string;
	home: string;
	url: string;
	portReason?: string;
	port: number;
	launchKey: string;
	startedAt: string;
	/** WP43d: whether the server requires the session cookie (sign-in). Absent in older files = on. */
	auth: boolean;
	detached?: true;
	idleExitAt?: string;
}
export type DashboardLaunchParams = Partial<
	Record<"project" | "run" | "task" | "tab" | "view", string>
>;

export function dashboardDiscoveryPath(_cwd?: string): string {
	return join(agentWorkflowHome(), "dashboard.json");
}
/** Stable user credential; only explicit reset signs existing browsers out. */
export function dashboardSessionPath(_cwd?: string): string {
	return join(agentWorkflowHome(), "dashboard-session");
}
async function publishSession(cwd: string, replace: boolean): Promise<string> {
	const path = dashboardSessionPath(cwd);
	await ensurePrivateDirectory(dirname(path));
	const token = randomBytes(32).toString("base64url");
	const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
		// Link publishes a complete file without overwriting a concurrent creator's token.
		if (replace) await rename(temporary, path);
		else await link(temporary, path);
		return token;
	} finally {
		await rm(temporary, { force: true });
	}
}
export async function readOrCreateDashboardSession(
	cwd: string,
): Promise<string> {
	const path = dashboardSessionPath(cwd);
	// Serialize repair as well as creation: two readers of a malformed file must not
	// remove a token that another reader has just repaired.
	return withStoreLock(path, async () => {
		for (;;) {
			try {
				const token = (await readPrivateFileText(path, 4096)).trim();
				if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
					const handle = await open(
						path,
						constants.O_RDONLY | constants.O_NOFOLLOW,
					);
					try {
						const info = await handle.stat();
						if (
							!info.isFile() ||
							info.nlink !== 1 ||
							(typeof process.getuid === "function" &&
								info.uid !== process.getuid())
						)
							throw new Error("Unsafe dashboard session file");
						await handle.chmod(0o600);
					} finally {
						await handle.close();
					}
					return token;
				}
				await rm(path, { force: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				return await publishSession(cwd, false);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	});
}
/** Last user-server port; custom homes reuse it when free. */
export function dashboardPortPath(_cwd?: string): string {
	return join(agentWorkflowHome(), "dashboard-port");
}
export async function readPreferredDashboardPort(
	cwd: string,
): Promise<number | undefined> {
	try {
		const value = Number(
			(await readPrivateFileText(dashboardPortPath(cwd), 64)).trim(),
		);
		return Number.isInteger(value) && value >= 1 && value <= 65535
			? value
			: undefined;
	} catch {
		return undefined;
	}
}
export async function writePreferredDashboardPort(
	cwd: string,
	port: number,
): Promise<void> {
	const path = dashboardPortPath(cwd);
	await ensurePrivateDirectory(dirname(path));
	await writePrivateFileAtomic(path, `${port}\n`);
}
/** Caller stops any running dashboard before rotating its session. */
export function resetDashboardSession(cwd: string): Promise<string> {
	return withStoreLock(dashboardSessionPath(cwd), () =>
		publishSession(cwd, true),
	);
}
export async function writeDashboardDiscovery(
	cwd: string,
	data: Pick<
		DashboardDiscovery,
		"pid" | "port" | "launchKey" | "detached" | "idleExitAt"
	> &
		Partial<
			Pick<
				DashboardDiscovery,
				"startedAt" | "auth" | "protocol" | "version" | "portReason"
			>
		>,
): Promise<void> {
	const path = dashboardDiscoveryPath(cwd);
	await ensurePrivateDirectory(dirname(path));
	await writePrivateFileAtomic(
		path,
		`${JSON.stringify({ schema: SCHEMA, protocol: DASHBOARD_PROTOCOL, version: "unknown", home: agentWorkflowHome(), url: `http://127.0.0.1:${data.port}/`, startedAt: new Date().toISOString(), ...data })}\n`,
	);
}
/** An owner key prevents an older server's close from removing a newer server's discovery. */
export async function removeDashboardDiscovery(
	cwd: string,
	ownerKey?: string,
): Promise<void> {
	if (ownerKey !== undefined) {
		const current = await loadDiscovery(cwd);
		if (current?.launchKey !== ownerKey) return;
	}
	await rm(dashboardDiscoveryPath(cwd), { force: true });
}
async function loadDiscovery(
	cwd: string,
): Promise<DashboardDiscovery | undefined> {
	try {
		const path = dashboardDiscoveryPath(cwd);
		const info = await lstat(path);
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			(info.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === "function" && info.uid !== process.getuid())
		)
			return undefined;
		// Round 4: the 0600/uid check above saw a path snapshot; check the file actually read too.
		const value = JSON.parse(
			await readPrivateFileText(path, 4096, { ownerOnly: true }),
		);
		if (
			value.schema !== SCHEMA ||
			!Number.isSafeInteger(value.protocol) ||
			value.protocol < 1 ||
			value.home !== agentWorkflowHome() ||
			typeof value.version !== "string" ||
			!Number.isSafeInteger(value.pid) ||
			value.pid <= 0 ||
			!Number.isInteger(value.port) ||
			value.port < 1 ||
			value.port > 65535 ||
			typeof value.launchKey !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(value.launchKey) ||
			typeof value.startedAt !== "string" ||
			!Number.isFinite(Date.parse(value.startedAt)) ||
			(value.auth !== undefined && typeof value.auth !== "boolean")
		)
			return undefined;
		return {
			protocol: value.protocol,
			version: value.version,
			home: value.home,
			url: `http://127.0.0.1:${value.port}/`,
			pid: value.pid,
			port: value.port,
			launchKey: value.launchKey,
			startedAt: value.startedAt,
			auth: value.auth !== false,
			...(typeof value.portReason === "string" && value.portReason.length <= 300
				? { portReason: value.portReason }
				: {}),
			...(value.detached === true ? { detached: true as const } : {}),
			...(typeof value.idleExitAt === "string" &&
			Number.isFinite(Date.parse(value.idleExitAt))
				? { idleExitAt: value.idleExitAt }
				: {}),
		};
	} catch {
		return undefined;
	}
}
/**
 * Bound for one request to the local dashboard (is it a live dashboard, mint a launch URL, was a
 * launch URL used). 3 s (was 0.5 s, 2026-11-01): on a loaded machine a healthy loopback dashboard
 * answered later, so a launch said "not running" and minting failed. Only a hung dashboard waits
 * this long.
 */
const DASHBOARD_LOCAL_REQUEST_MS = 3000;

/**
 * Bounded identity probe without credentials; do not follow redirects or accept an arbitrary
 * listener. Only a fresh nonce HMAC made with our private launch key proves ownership.
 */
/**
 * Identity of the listener at the discovery's port: `valid` (it proved the launch key), `foreign` (a JSON
 * answer with a wrong proof or protocol: another server holds the port), `unknown` (error, timeout or
 * another status: a busy or restarting server cannot be told apart from a dead one), `timeout` (no
 * answer within the local request bound).
 */
export function probeDashboardIdentity(
	discovery: Pick<DashboardDiscovery, "port" | "launchKey" | "protocol">,
): Promise<"valid" | "foreign" | "unknown" | "timeout"> {
	const nonce = randomBytes(32).toString("base64url");
	const expected = createHmac("sha256", discovery.launchKey)
		.update(nonce)
		.digest("hex");
	return new Promise((done) => {
		let settled = false;
		const finish = (valid: "valid" | "foreign" | "unknown" | "timeout") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			req.destroy();
			done(valid);
		};
		const req = request(
			{
				hostname: "127.0.0.1",
				port: discovery.port,
				path: `/api/identity?nonce=${nonce}`,
				method: "GET",
			},
			(res) => {
				if (
					res.statusCode !== 200 ||
					!res.headers["content-type"]?.startsWith("application/json")
				) {
					finish("unknown");
					return;
				}
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
					if (body.length > 4096) finish("foreign");
				});
				res.on("error", () => finish("unknown"));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(body);
						finish(
							parsed.protocol === discovery.protocol &&
								secureEqual(parsed.proof, expected)
								? "valid"
								: "foreign",
						);
					} catch {
						finish("foreign");
					}
				});
			},
		);
		const timer = setTimeout(
			() => finish("timeout"),
			DASHBOARD_LOCAL_REQUEST_MS,
		);
		req.on("error", () => finish("unknown"));
		req.end();
	});
}
export async function probeDashboard(
	discovery: Pick<DashboardDiscovery, "port" | "launchKey" | "protocol">,
): Promise<boolean> {
	return (await probeDashboardIdentity(discovery)) === "valid";
}
export async function readDashboardDiscovery(
	cwd: string,
	options: { probe?: (discovery: DashboardDiscovery) => Promise<boolean> } = {},
): Promise<DashboardDiscovery | undefined> {
	const data = await loadDiscovery(cwd);
	if (!data) return undefined;
	try {
		process.kill(data.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH")
			await removeDashboardDiscovery(cwd, data.launchKey).catch(
				() => undefined,
			);
		return undefined;
	}
	// 2026-11-06 (CI ubuntu/Node 24): a live server whose identity answer failed once (busy, reset
	// connection) lost its discovery and a second server could take the next port. Remove the
	// discovery only for a dead pid or a proven foreign listener; an unknown answer is retried once
	// and then reported as unavailable, keeping the file for the server that may still own it.
	const identity = async (): Promise<
		"valid" | "foreign" | "unknown" | "timeout"
	> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				options.probe
					? options
							.probe(data)
							.then((valid): "valid" | "foreign" =>
								valid ? "valid" : "foreign",
							)
					: probeDashboardIdentity(data),
				new Promise<"timeout">((done) => {
					timer = setTimeout(() => done("timeout"), DASHBOARD_LOCAL_REQUEST_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		let result = await identity();
		// A fast failure (reset connection, busy status) is retried once; a timeout already waited.
		if (result === "unknown") {
			await sleep(100);
			result = await identity();
		}
		if (result === "foreign")
			await removeDashboardDiscovery(cwd, data.launchKey);
		return result === "valid" ? data : undefined;
	} catch {
		return undefined;
	}
}
export function detectAgentEnvironment(
	env: NodeJS.ProcessEnv,
	host?: string,
): { detected: boolean; reason?: string } {
	for (const key of [
		"CLAUDECODE",
		"CODEX_SANDBOX",
		"CODEX_THREAD_ID",
		"CURSOR_AGENT",
		"AI_AGENT",
	]) {
		if (env[key] !== undefined) return { detected: true, reason: key };
	}
	if (host && ["pi", "codex", "claude-code"].includes(host))
		return { detected: true, reason: `host: ${host}` };
	return { detected: false };
}
export async function mintLaunchUrl(
	discovery: Pick<DashboardDiscovery, "port" | "launchKey" | "protocol">,
	params: DashboardLaunchParams = {},
): Promise<string> {
	if (!(await probeDashboard(discovery)))
		throw new Error("Dashboard identity verification failed");
	const origin = `http://127.0.0.1:${discovery.port}`;
	const response = await fetch(`${origin}/api/launch`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-AW-Launch-Key": discovery.launchKey,
		},
		body: JSON.stringify(params),
		signal: AbortSignal.timeout(DASHBOARD_LOCAL_REQUEST_MS),
		redirect: "error",
	});
	if (!response.ok) throw new Error("Could not mint dashboard launch URL");
	const data = (await response.json()) as { url?: unknown; launchId?: unknown };
	if (typeof data.url !== "string")
		throw new Error("Invalid dashboard launch URL");
	const url = new URL(data.url);
	if (
		url.origin !== origin ||
		url.pathname !== "/" ||
		// Auth servers mint `?token=<one-time>`; open servers mint `?launch=<id>` (no credential).
		!(
			/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("token") ?? "") ||
			(/^[A-Za-z0-9_-]{24}$/.test(url.searchParams.get("launch") ?? "") &&
				!url.searchParams.has("token"))
		)
	)
		throw new Error("Invalid dashboard launch URL");
	lastLaunchIds.set(
		url.href,
		typeof data.launchId === "string" ? data.launchId : "",
	);
	return url.href;
}
/** Launch ids of URLs minted in this process (an MCP host asks whether the browser used one). */
const lastLaunchIds = new Map<string, string>();

/**
 * Whether the browser signed in with a launch URL minted by `mintLaunchUrl` (the one-time token
 * was consumed). `undefined` when the dashboard cannot say (unknown launch, not reachable).
 */
export async function launchConsumed(
	discovery: Pick<DashboardDiscovery, "port" | "launchKey" | "protocol">,
	launchUrl: string,
): Promise<boolean | undefined> {
	const launchId = lastLaunchIds.get(launchUrl);
	if (!launchId) return undefined;
	try {
		if (!(await probeDashboard(discovery))) return undefined;
		const response = await fetch(
			`http://127.0.0.1:${discovery.port}/api/launch/${launchId}`,
			{
				headers: { "X-AW-Launch-Key": discovery.launchKey },
				signal: AbortSignal.timeout(DASHBOARD_LOCAL_REQUEST_MS),
				redirect: "error",
			},
		);
		if (!response.ok) return undefined;
		const data = (await response.json()) as { consumed?: unknown };
		return data.consumed === true;
	} catch {
		return undefined;
	}
}
/**
 * How long a launch waits for the dashboard it starts (best effort; the launch prints the start
 * command instead when it is not up in time). 186 ms idle; a heavily loaded machine (the whole
 * test suite twice in parallel) took over 3 s.
 */
const DASHBOARD_START_BUDGET_MS = 3000;
let dashboardStartBudget = DASHBOARD_START_BUDGET_MS;

export function dashboardStartBudgetMs(): number {
	return dashboardStartBudget;
}

/** Tests on a loaded machine wait longer for the started dashboard; `undefined` restores 3 s. */
export function setDashboardStartBudgetForTests(ms: number | undefined): void {
	dashboardStartBudget = ms ?? DASHBOARD_START_BUDGET_MS;
}

/** Serialize discovery, spawn and adoption across processes. Never hold this in the spawned server. */
export async function ensureDashboard(
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: { start: boolean },
): Promise<DashboardDiscovery | undefined> {
	if (!options.start) return readDashboardDiscovery(cwd);
	return withDashboardStartLock((owner) =>
		startEnsuredDashboard(
			cwd,
			{ ...env, AGENT_WORKFLOW_DASHBOARD_START_LOCK: owner },
			options,
		),
	);
}
export async function withDashboardStartLock<T>(
	body: (owner: string) => Promise<T>,
): Promise<T> {
	const lock = await acquireDashboardStartLock();
	try {
		return await body(lock.owner);
	} finally {
		await lock.release();
	}
}
/** A spawned CLI may inherit its launcher's lock, but only an exact live-owner record authorizes it. */
export async function acquireDashboardStartLock(
	inheritedOwner?: string,
): Promise<{ owner: string; release(): Promise<void> }> {
	const path = join(agentWorkflowHome(), "dashboard.lock");
	await ensurePrivateDirectory(dirname(path));
	if (inheritedOwner) {
		const lock = JSON.parse(
			await readPrivateFileText(path, 4096).catch(() => "null"),
		);
		if (lock?.owner === inheritedOwner) {
			try {
				process.kill(lock.pid, 0);
				return { owner: inheritedOwner, release: async () => {} };
			} catch {
				/* Reacquire a dead parent's lock. */
			}
		}
	}
	const owner = randomBytes(16).toString("hex");
	const deadline = Date.now() + dashboardStartBudget * 2;
	for (;;) {
		try {
			await writeFile(
				path,
				JSON.stringify({ pid: process.pid, startedAt: Date.now(), owner }),
				{ mode: 0o600, flag: "wx" },
			);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Serialize stale cleanup as well as checking the generation: two waiters must not
			// unlink a fresh lock that replaced the stale one between their reads.
			await withStoreLock(path, async () => {
				try {
					const info = await stat(path);
					let stale = Date.now() - info.mtimeMs > dashboardStartBudget;
					try {
						const lock = JSON.parse(await readPrivateFileText(path, 4096));
						try {
							process.kill(lock.pid, 0);
						} catch (error) {
							stale ||= (error as NodeJS.ErrnoException).code === "ESRCH";
						}
						stale ||= Date.now() - lock.startedAt > dashboardStartBudget;
					} catch {
						/* An incomplete lock ages out, never immediately. */
					}
					if (stale) await rm(path, { force: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			});
			if (Date.now() >= deadline)
				throw new Error("Dashboard start lock timed out");
			await sleep(50);
		}
	}
	return {
		owner,
		async release() {
			const current = JSON.parse(
				await readPrivateFileText(path, 4096).catch(() => "null"),
			);
			if (current?.owner === owner) await rm(path, { force: true });
		},
	};
}
export async function shutdownDashboard(
	discovery: DashboardDiscovery,
): Promise<void> {
	if (!(await probeDashboard(discovery)))
		throw new Error("Dashboard identity verification failed");
	const response = await fetch(
		`http://127.0.0.1:${discovery.port}/api/shutdown`,
		{
			method: "POST",
			headers: { "X-AW-Launch-Key": discovery.launchKey },
			redirect: "error",
			signal: AbortSignal.timeout(DASHBOARD_LOCAL_REQUEST_MS),
		},
	);
	if (!response.ok) throw new Error("Could not stop dashboard");
}

async function startEnsuredDashboard(
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: { start: boolean },
): Promise<DashboardDiscovery | undefined> {
	const deadline = Date.now() + dashboardStartBudget;
	let existing = await readDashboardDiscovery(cwd);
	let takeoverPort: number | undefined;
	if (existing && existing.protocol < DASHBOARD_PROTOCOL && options.start) {
		takeoverPort = existing.port;
		await shutdownDashboard(existing);
		while (Date.now() < deadline && (await readDashboardDiscovery(cwd)))
			await sleep(50);
		existing = await readDashboardDiscovery(cwd);
	}
	if (existing || !options.start) return existing;
	let child: ReturnType<typeof spawn> | undefined;
	let adopted = false;
	try {
		child = spawn(
			process.execPath,
			[
				fileURLToPath(
					new URL("../../../src/hosts/cli/cli.mjs", import.meta.url),
				),
				"dashboard",
				"--project",
				resolve(cwd),
				"--detached",
				...(takeoverPort === undefined ? [] : ["--port", String(takeoverPort)]),
			],
			{ cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" },
		);
		let failed = false;
		child.once("error", () => {
			failed = true;
		});
		child.unref();
		while (!failed && Date.now() < deadline - 500) {
			const discovery = await readDashboardDiscovery(cwd);
			if (discovery) {
				adopted = discovery.pid === child.pid;
				return discovery;
			}
			await sleep(50);
		}
	} catch {
		/* Opening is best effort and must never fail a workflow launch. */
	} finally {
		// A timed-out start must not publish discovery later, after the caller has given up
		// (or removed its project). Signal only our still-live ChildProcess, never a stored pid.
		if (
			!adopted &&
			child?.pid &&
			child.exitCode === null &&
			child.signalCode === null
		) {
			const failedChild = child;
			const exited = new Promise<void>((done) =>
				failedChild.once("close", () => done()),
			);
			// The child was unref'd for the detached dashboard; waiting for its exit must keep the loop
			// alive (2026-11-05, first CI run on Node 22: the loop ended with this wait pending).
			failedChild.ref();
			failedChild.kill("SIGKILL");
			await exited;
		}
	}
	return undefined;
}
/**
 * Opens `url` in the user's browser. `BROWSER` (Vite/Jupyter convention) names the program to use
 * instead of the platform opener (`BROWSER=none` opens nothing and reports false); `BROWSER_ARGS`
 * adds arguments. Never throws.
 */
export async function openInBrowser(
	url: string,
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	try {
		const custom = env.BROWSER?.trim();
		if (custom === "none") return false;
		const command =
			custom ||
			(process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "rundll32.exe"
					: "xdg-open");
		const args = custom
			? [
					...(env.BROWSER_ARGS?.trim()
						? env.BROWSER_ARGS.trim().split(/\s+/)
						: []),
					url,
				]
			: process.platform === "win32"
				? ["url.dll,FileProtocolHandler", url]
				: [url];
		return await new Promise<boolean>((done) => {
			const child = spawn(command, args, {
				env,
				detached: true,
				stdio: "ignore",
			});
			child.once("error", () => done(false));
			child.once("spawn", () => {
				child.unref();
				done(true);
			});
		});
	} catch {
		return false;
	}
}
