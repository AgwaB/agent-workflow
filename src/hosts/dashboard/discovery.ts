// WP43b: local dashboard discovery and opt-in browser launch. Never expose control secrets in text.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { workflowsRoot } from "../../core/store.js";

const SCHEMA = "agent-workflow-dashboard-v1";
export interface DashboardDiscovery {
	pid: number;
	port: number;
	launchKey: string;
	startedAt: string;
}
export type DashboardLaunchParams = Partial<
	Record<"run" | "task" | "tab" | "view", string>
>;

export function dashboardDiscoveryPath(cwd: string): string {
	return join(workflowsRoot(cwd), "..", "dashboard.json");
}
export async function writeDashboardDiscovery(
	cwd: string,
	data: Pick<DashboardDiscovery, "pid" | "port" | "launchKey">,
): Promise<void> {
	const path = dashboardDiscoveryPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({ schema: SCHEMA, ...data, startedAt: new Date().toISOString() })}\n`,
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
			!Number.isFinite(Date.parse(value.startedAt))
		)
			return undefined;
		return {
			pid: value.pid,
			port: value.port,
			launchKey: value.launchKey,
			startedAt: value.startedAt,
		};
	} catch {
		return undefined;
	}
}
/** Bounded, unauthenticated identity probe; do not follow redirects or accept an arbitrary listener. */
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
					res.statusCode !== 401 ||
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
						finish(typeof JSON.parse(body).error === "string");
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
	const data = (await response.json()) as { url?: unknown };
	if (typeof data.url !== "string")
		throw new Error("Invalid dashboard launch URL");
	const url = new URL(data.url);
	if (
		url.origin !== origin ||
		url.pathname !== "/" ||
		!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("token") ?? "")
	)
		throw new Error("Invalid dashboard launch URL");
	return url.href;
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
export async function openInBrowser(
	url: string,
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	try {
		const command =
			process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "rundll32.exe"
					: "xdg-open";
		const args =
			process.platform === "win32"
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
