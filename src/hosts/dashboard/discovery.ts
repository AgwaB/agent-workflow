// WP43b: local dashboard discovery and opt-in browser launch. Never expose control secrets in text.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { workflowsRoot } from "../../core/store.js";
import { withStoreLock } from "../store-lock.js";

const SCHEMA = "agent-workflow-dashboard-v1";
export interface DashboardDiscovery {
	pid: number;
	port: number;
	launchKey: string;
	startedAt: string;
	/** WP43d: whether the server requires the session cookie (sign-in). Absent in older files = on. */
	auth: boolean;
	detached?: true;
	idleExitAt?: string;
}
export type DashboardLaunchParams = Partial<
	Record<"run" | "task" | "tab" | "view", string>
>;

export function dashboardDiscoveryPath(cwd: string): string {
	return join(workflowsRoot(cwd), "..", "dashboard.json");
}
/** Stable project credential; only explicit reset signs existing browsers out. */
export function dashboardSessionPath(cwd: string): string {
	return join(workflowsRoot(cwd), "..", "dashboard-session");
}
async function publishSession(cwd: string, replace: boolean): Promise<string> {
	const path = dashboardSessionPath(cwd);
	await mkdir(dirname(path), { recursive: true });
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
				const token = (await readFile(path, "utf8")).trim();
				if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
					await chmod(path, 0o600);
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
/** The port this project's dashboard used last (`.agent-workflow/dashboard-port`); reused when free. */
export function dashboardPortPath(cwd: string): string {
	return join(workflowsRoot(cwd), "..", "dashboard-port");
}
export async function readPreferredDashboardPort(
	cwd: string,
): Promise<number | undefined> {
	try {
		const value = Number(
			(await readFile(dashboardPortPath(cwd), "utf8")).trim(),
		);
		return Number.isInteger(value) && value >= 1024 && value <= 65535
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
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${port}\n`, { mode: 0o600 });
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
		Partial<Pick<DashboardDiscovery, "startedAt" | "auth">>,
): Promise<void> {
	const path = dashboardDiscoveryPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({ schema: SCHEMA, startedAt: new Date().toISOString(), ...data })}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
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
		if ((await stat(path)).size > 4096) return undefined;
		const value = JSON.parse(await readFile(path, "utf8"));
		if (
			value.schema !== SCHEMA ||
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
			pid: value.pid,
			port: value.port,
			launchKey: value.launchKey,
			startedAt: value.startedAt,
			auth: value.auth !== false,
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
 * Bounded identity probe without credentials; do not follow redirects or accept an arbitrary
 * listener. An auth server answers 401 `{ error }`; an open one answers 200 `{ apiVersion: 1 }`.
 */
export function probeDashboard(
	discovery: DashboardDiscovery,
): Promise<boolean> {
	return new Promise((done) => {
		let settled = false;
		const finish = (valid: boolean) => {
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
				path: "/api/session",
				method: "GET",
			},
			(res) => {
				if (
					(res.statusCode !== 401 && res.statusCode !== 200) ||
					!res.headers["content-type"]?.startsWith("application/json")
				) {
					finish(false);
					return;
				}
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
					if (body.length > 4096) finish(false);
				});
				res.on("error", () => finish(false));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(body);
						finish(
							res.statusCode === 401
								? typeof parsed.error === "string"
								: parsed.apiVersion === 1 && parsed.auth === false,
						);
					} catch {
						finish(false);
					}
				});
			},
		);
		const timer = setTimeout(() => finish(false), 500);
		req.on("error", () => finish(false));
		req.end();
	});
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const valid = await Promise.race([
			(options.probe ?? probeDashboard)(data),
			new Promise<boolean>((done) => {
				timer = setTimeout(() => done(false), 500);
			}),
		]);
		return valid ? data : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
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
	discovery: Pick<DashboardDiscovery, "port" | "launchKey">,
	params: DashboardLaunchParams = {},
): Promise<string> {
	const origin = `http://127.0.0.1:${discovery.port}`;
	const response = await fetch(`${origin}/api/launch`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-AW-Launch-Key": discovery.launchKey,
		},
		body: JSON.stringify(params),
		signal: AbortSignal.timeout(500),
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
	discovery: Pick<DashboardDiscovery, "port" | "launchKey">,
	launchUrl: string,
): Promise<boolean | undefined> {
	const launchId = lastLaunchIds.get(launchUrl);
	if (!launchId) return undefined;
	try {
		const response = await fetch(
			`http://127.0.0.1:${discovery.port}/api/launch/${launchId}`,
			{
				headers: { "X-AW-Launch-Key": discovery.launchKey },
				signal: AbortSignal.timeout(500),
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
export async function ensureDashboard(
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: { start: boolean },
): Promise<DashboardDiscovery | undefined> {
	const deadline = Date.now() + 3000;
	const existing = await readDashboardDiscovery(cwd);
	if (existing || !options.start) return existing;
	try {
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(
					new URL("../../../src/hosts/cli/cli.mjs", import.meta.url),
				),
				"dashboard",
				"--project",
				resolve(cwd),
				"--detached",
			],
			{ cwd, env, detached: true, stdio: "ignore" },
		);
		let failed = false;
		child.once("error", () => {
			failed = true;
		});
		child.unref();
		while (!failed && Date.now() < deadline - 500) {
			const discovery = await readDashboardDiscovery(cwd);
			if (discovery) return discovery;
			await sleep(50);
		}
	} catch {
		/* Opening is best effort and must never fail a workflow launch. */
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
