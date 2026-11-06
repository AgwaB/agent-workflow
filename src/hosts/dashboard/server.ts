// WP43: loopback-only HTTP host. No framework or engine/file-store access.
// WP43d: no sign-in by default (loopback + Host/fetch-site/Origin/CSRF); `auth` opts into the
// persistent-session cookie model for shared machines.
import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { basename, resolve } from "node:path";
import {
	DASHBOARD_PROTOCOL,
	writeDashboardDiscovery,
	dashboardDiscoveryPath,
	openInBrowser,
	readOrCreateDashboardSession,
	readPreferredDashboardPort,
	writePreferredDashboardPort,
	removeDashboardDiscovery,
} from "./discovery.js";
import {
	listRegisteredProjects,
	validProjectId,
	projectId,
	type ProjectRegistration,
} from "../../core/state-location.js";
import { dashboardPortCandidates } from "./ports.js";
import { HostUsageError } from "../args.js";
import { hostTextRedactor } from "../redaction.js";
import { boundReportText } from "../run-artifacts.js";
import {
	hostApiDashboardSource,
	redactDashboardData,
	type DashboardSource,
} from "./source.js";
import {
	allowedFetchSite,
	allowedHost,
	bootstrapLocation,
	bootstrapSession,
	dashboardCsrf,
	generateDashboardToken,
	hasSessionCookie,
	secureEqual,
	securityHeaders,
	validRunId,
	validTaskId,
} from "./security.js";

export interface DashboardServerOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	port?: number;
	readonly?: boolean;
	source?: DashboardSource;
	pollMs?: number;
	now?: () => number;
	/** Publish discovery (CLI enables it; embedded/test servers opt in). */
	discovery?: boolean;
	launchKey?: string;
	token?: string;
	/**
	 * Require the session cookie (sign-in page, one-time launch URLs, persistent project session).
	 * Default: `AGENT_WORKFLOW_DASHBOARD_AUTH=1` in `env`, else off.
	 */
	auth?: boolean;
	idleExitMs?: number;
	/** How often the idle rule is evaluated (default 60 s; tests shorten it). */
	idleCheckMs?: number;
	onIdleExit?: () => void;
}
export interface DashboardServer {
	protocol: number;
	url: string;
	port: number;
	/** Session token when `auth` is on; otherwise the server's private CSRF secret (not a URL credential). */
	token: string;
	launchKey: string;
	auth: boolean;
	close(): Promise<void>;
}
class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
const BODY_MAX_BYTES = 16 * 1024;

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(value));
}
function requireRunId(id: string): string {
	if (!validRunId(id)) throw new HttpError(400, "invalid run id");
	return id;
}
function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolveBody, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		let settled = false;
		const timer = setTimeout(
			() => fail(new HttpError(400, "request body timed out")),
			10_000,
		);
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		request.on("error", fail);
		request.on("aborted", () => fail(new HttpError(400, "request aborted")));
		request.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > BODY_MAX_BYTES) {
				chunks.length = 0;
				fail(new HttpError(413, "request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (settled) return;
			try {
				const value: unknown = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				);
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new Error();
				settled = true;
				clearTimeout(timer);
				resolveBody(value as Record<string, unknown>);
			} catch {
				fail(new HttpError(400, "expected a JSON object"));
			}
		});
		if (Number(request.headers["content-length"] ?? 0) > BODY_MAX_BYTES)
			fail(new HttpError(413, "request body too large"));
	});
}
function errorStatus(error: unknown): number {
	if (error instanceof HttpError) return error.status;
	const message = error instanceof Error ? error.message : String(error);
	if (
		(error as NodeJS.ErrnoException)?.code === "ENOENT" ||
		/(?:run|task).*not found|no (?:workflow )?run (?:found|matches)|unknown run/i.test(
			message,
		)
	)
		return 404;
	if (
		error instanceof HostUsageError ||
		/requires a non-terminal run|no pending approval|not resumable|approval.*(?:stale|resolved)/i.test(
			message,
		)
	)
		return 409;
	return 500;
}

/** The sign-in page's script (served at /signin.js; CSP allows same-origin scripts only). */
const SIGNIN_SCRIPT = `(() => {
	const button = document.getElementById("signin");
	const status = document.getElementById("signin-status");
	if (!button || !status) return;
	const say = (text) => { status.textContent = text; };
	const signedIn = async () => {
		try { return (await fetch("/api/session", { credentials: "same-origin" })).status === 200; }
		catch { return false; }
	};
	button.addEventListener("click", async () => {
		button.disabled = true;
		say("Opening a signed-in tab…");
		let opened = false;
		try {
			const response = await fetch("/api/signin-local", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ next: location.search }),
			});
			opened = response.ok && (await response.json()).opened === true;
		} catch {}
		if (!opened) {
			say("Could not open a browser from here. Run agent-workflow dashboard --open in a terminal.");
			button.disabled = false;
			return;
		}
		say("Signed-in tab opened. This tab will refresh as soon as the sign-in lands.");
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			if (await signedIn()) { location.reload(); return; }
		}
		say("Still not signed in here; use the new tab, or run agent-workflow dashboard --open.");
		button.disabled = false;
	});
})();
`;

export async function startDashboardServer(
	options: DashboardServerOptions,
): Promise<DashboardServer> {
	const cwd = resolve(options.cwd);
	if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
		throw new HostUsageError("--project must be an existing directory");
	if (
		options.port !== undefined &&
		(!Number.isInteger(options.port) ||
			options.port < 1 ||
			options.port > 65535)
	)
		throw new HostUsageError("--port must be an integer from 1 to 65535");
	const env = options.env ?? process.env;
	const redact = hostTextRedactor(env);
	const sources = new Map<string, DashboardSource>();
	const sourceFor = (project: ProjectRegistration) => {
		let source = sources.get(project.id);
		if (!source) {
			source =
				options.source && project.id === projectId(cwd)
					? options.source
					: hostApiDashboardSource({ cwd: project.path, env, host: "cli" });
			sources.set(project.id, source);
		}
		return source;
	};
	const requireProject = async (id: string | null) => {
		if (!id || !validProjectId(id))
			throw new HttpError(400, "invalid project id");
		const project = (await listRegisteredProjects()).find(
			(project) => project.id === id,
		);
		if (!project) throw new HttpError(404, "project not found");
		return sourceFor(project);
	};
	const countsFor = async (source: DashboardSource) => {
		if (source.counts) return source.counts();
		const runs = await source.listRuns();
		return {
			running: runs.filter(
				(run) => run.live || ["running", "blocked"].includes(run.status),
			).length,
			needsAttention: runs.filter((run) => run.needsYou.length > 0).length,
			lastActivity:
				runs
					.map((run) => run.updatedAt)
					.sort()
					.at(-1) ?? null,
		};
	};
	const auth = options.auth ?? env.AGENT_WORKFLOW_DASHBOARD_AUTH === "1";
	// Without auth the token is only the CSRF secret: never persisted, never printed or accepted in
	// a URL; foreign pages cannot read `/api/session` (no CORS), so they cannot forge mutations.
	const token =
		options.token ??
		(auth && options.discovery
			? await readOrCreateDashboardSession(cwd)
			: generateDashboardToken());
	const csrf = dashboardCsrf(token);
	const launchKey = options.launchKey ?? generateDashboardToken();
	const launchTokens = new Map<string, number>();
	let lastLocalSignIn = 0;
	/** Launch id → { token, consumedAt }: lets the minter ask whether its one-time URL was used. */
	const launches = new Map<
		string,
		{ token: string; expires: number; consumedAt?: number }
	>();
	const launchKeyOk = (request: IncomingMessage) =>
		secureEqual(
			typeof request.headers["x-aw-launch-key"] === "string"
				? request.headers["x-aw-launch-key"]
				: undefined,
			launchKey,
		);
	const now = options.now ?? Date.now;
	const serverTime = () => new Date(now()).toISOString();
	const configuredPoll =
		options.pollMs ?? Number(env.AGENT_WORKFLOW_DASHBOARD_POLL_MS ?? 1000);
	// The environment accepts 500..10000; the transport always honors the >=1s floor.
	const pollMs = Number.isFinite(configuredPoll)
		? Math.max(1000, Math.min(10_000, configuredPoll))
		: 1000;
	const clients = new Set<() => void>();
	let noClientsSince = now();
	const startedAt = serverTime();
	let idleUpdate: Promise<void> | undefined;
	let port = 0;
	let origin = "";
	let version = "unknown";
	try {
		version = (
			JSON.parse(
				await readFile(
					new URL("../../../package.json", import.meta.url),
					"utf8",
				),
			) as { version: string }
		).version;
	} catch {
		/* Source and dist have the same module depth. */
	}
	const safe = <T>(value: T) => redactDashboardData(value, redact);
	const getRun = async (source: DashboardSource, runId: string) => {
		const run = await source.run(runId);
		if (!run || run.runId !== runId) throw new HttpError(404, "run not found");
		return safe(run);
	};
	const runsPayload = async (source: DashboardSource) => ({
		serverTime: serverTime(),
		runs: safe(await source.listRuns()),
	});

	async function events(
		source: DashboardSource,
		response: ServerResponse,
		runId: string | null,
	): Promise<void> {
		// Resolve before committing SSE headers so unknown ids still return a JSON 404.
		const firstRuns = await runsPayload(source);
		const firstRun = runId ? await getRun(source, runId) : undefined;
		if (response.destroyed) return;
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			Connection: "keep-alive",
		});
		response.flushHeaders();
		let closed = false;
		let busy = false;
		let lastHeartbeat = now();
		const hashes = new Map<string, string>();
		const send = (event: string, data: unknown, content = data) => {
			if (closed || response.writableNeedDrain) return;
			const hash = createHash("sha256")
				.update(JSON.stringify(content))
				.digest("hex");
			if (event !== "heartbeat" && hashes.get(event) === hash) return;
			hashes.set(event, hash);
			// A slow/disconnected tab must not accumulate unbounded event buffers.
			response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		const heartbeat = () => {
			lastHeartbeat = now();
			send("heartbeat", { serverTime: serverTime() });
		};
		const poll = setInterval(() => {
			if (busy || closed || response.writableNeedDrain) return;
			busy = true;
			void (async () => {
				const runs = await runsPayload(source);
				send("runs", runs, runs.runs);
				if (runId) send("run", await getRun(source, runId));
				if (now() - lastHeartbeat >= 15_000) heartbeat();
			})()
				.catch(() => cleanup())
				.finally(() => {
					busy = false;
				});
		}, pollMs);
		const beats = setInterval(heartbeat, 15_000);
		function cleanup() {
			if (closed) return;
			closed = true;
			clearInterval(poll);
			clearInterval(beats);
			clients.delete(cleanup);
			if (clients.size === 0) noClientsSince = now();
			response.end();
		}
		clients.add(cleanup);
		response.once("close", cleanup);
		response.once("error", cleanup);
		send("runs", firstRuns, firstRuns.runs);
		if (firstRun) send("run", firstRun);
	}

	async function route(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		if (
			!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				request.socket.remoteAddress ?? "",
			)
		)
			throw new HttpError(403, "loopback required");
		// Node keeps only the first of repeated Host headers; RFC 9112 requires refusing them.
		if ((request.headersDistinct.host?.length ?? 0) > 1)
			throw new HttpError(400, "more than one Host header");
		if (!allowedHost(request.headers.host, port))
			throw new HttpError(421, "invalid Host");
		if (!allowedFetchSite(request.headers["sec-fetch-site"]))
			throw new HttpError(403, "cross-site request refused");
		let url: URL;
		try {
			url = new URL(request.url ?? "/", origin);
		} catch {
			throw new HttpError(400, "invalid URL");
		}
		if (request.method === "GET" && url.pathname === "/api/identity") {
			const nonce = url.searchParams.get("nonce") ?? "";
			if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
				throw new HttpError(400, "invalid nonce");
			json(response, 200, {
				protocol: DASHBOARD_PROTOCOL,
				version,
				proof: createHmac("sha256", launchKey).update(nonce).digest("hex"),
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/shutdown") {
			if (!launchKeyOk(request)) throw new HttpError(401, "invalid launch key");
			if (
				request.headers.origin !== undefined &&
				request.headers.origin !== origin
			)
				throw new HttpError(403, "invalid Origin");
			json(response, 200, { stopping: true });
			setImmediate(() => {
				void dashboard.close().then(() => options.onIdleExit?.());
			});
			return;
		}
		// WP43b: the minter (CLI --open, Pi, the MCP tool) may ask whether its launch URL was used,
		// so an MCP host can send `notifications/elicitation/complete` once the browser signed in.
		const launchStatus = /^\/api\/launch\/([A-Za-z0-9_-]{16,64})$/.exec(
			url.pathname,
		);
		if (request.method === "GET" && launchStatus) {
			if (!launchKeyOk(request)) throw new HttpError(401, "invalid launch key");
			const launch = launches.get(launchStatus[1]!);
			if (!launch) throw new HttpError(404, "unknown launch");
			json(response, 200, {
				consumed: launch.consumedAt !== undefined,
				expired: launch.consumedAt === undefined && launch.expires <= now(),
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/launch") {
			if (!launchKeyOk(request)) throw new HttpError(401, "invalid launch key");
			if (
				request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
				"application/json"
			)
				throw new HttpError(400, "Content-Type must be application/json");
			const body = await readBody(request);
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(body)) {
				if (typeof value === "string") params.set(key, value);
			}
			const forwarded = new URL(bootstrapLocation(params), origin);
			for (const [value, expires] of launchTokens)
				if (expires <= now()) launchTokens.delete(value);
			if (launchTokens.size >= 16)
				throw new HttpError(429, "too many outstanding launch tokens");
			const oneTime = generateDashboardToken();
			const expires = now() + 60_000;
			launchTokens.set(oneTime, expires);
			const launchId = generateDashboardToken().slice(0, 24);
			for (const [id, launch] of launches)
				if (launch.expires + 600_000 <= now()) launches.delete(id);
			launches.set(launchId, { token: oneTime, expires });
			const target = new URL("/", origin);
			// WP43d: without auth the URL needs no credential; it carries the launch id instead so the
			// minter can still learn that the browser arrived (MCP elicitation completion).
			if (auth) target.searchParams.set("token", oneTime);
			else target.searchParams.set("launch", launchId);
			for (const [key, value] of forwarded.searchParams)
				target.searchParams.set(key, value);
			json(response, 200, { url: target.href, launchId });
			return;
		}
		if (
			!auth &&
			request.method === "GET" &&
			url.pathname === "/" &&
			(url.searchParams.has("launch") || url.searchParams.has("token"))
		) {
			// Mark the launch consumed (unknown/expired ids are simply ignored) and drop the parameter,
			// as well as any `token` from a link printed while auth was on: the UI params survive.
			const launch = launches.get(url.searchParams.get("launch") ?? "");
			if (launch && launch.consumedAt === undefined && launch.expires > now()) {
				launch.consumedAt = now();
				launchTokens.delete(launch.token);
			}
			response.writeHead(302, {
				Location: bootstrapLocation(url.searchParams),
			});
			response.end();
			return;
		}
		if (
			request.method === "GET" &&
			url.pathname === "/" &&
			url.searchParams.has("token")
		) {
			const supplied = url.searchParams.get("token") ?? "";
			if (!secureEqual(supplied, token)) {
				const expires = launchTokens.get(supplied);
				launchTokens.delete(supplied);
				if (expires === undefined || expires <= now())
					throw new HttpError(401, "invalid session token");
				for (const launch of launches.values())
					if (launch.token === supplied) launch.consumedAt = now();
			}
			bootstrapSession(response, token, bootstrapLocation(url.searchParams));
			return;
		}
		// WP43c: one-click local sign-in from the sign-in page. The page's own script (same-origin
		// fetch, so the browser sets Sec-Fetch-Site: same-origin and Origin) asks the server to open a
		// signed-in tab through the OS opener; the one-time URL never travels to the page or the chat.
		// Cross-site pages are refused by the fetch-metadata check; non-browser callers gain nothing
		// (the tab opens in the server owner's browser).
		if (auth && request.method === "GET" && url.pathname === "/signin.js") {
			response.writeHead(200, {
				"Content-Type": "text/javascript; charset=utf-8",
				"Cache-Control": "no-store",
			});
			response.end(SIGNIN_SCRIPT);
			return;
		}
		if (
			auth &&
			request.method === "POST" &&
			url.pathname === "/api/signin-local"
		) {
			if (
				request.headers["sec-fetch-site"] !== "same-origin" ||
				request.headers.origin !== origin
			)
				throw new HttpError(
					403,
					"sign-in must come from the dashboard's own page",
				);
			if (
				request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
				"application/json"
			)
				throw new HttpError(400, "Content-Type must be application/json");
			if (now() - lastLocalSignIn < 3000)
				throw new HttpError(429, "sign-in already in progress");
			lastLocalSignIn = now();
			const body = await readBody(request);
			const next = typeof body.next === "string" ? body.next : "";
			const forwarded = new URL(
				bootstrapLocation(new URLSearchParams(next.replace(/^\?/, ""))),
				origin,
			);
			const oneTime = generateDashboardToken();
			launchTokens.set(oneTime, now() + 60_000);
			const target = new URL("/", origin);
			target.searchParams.set("token", oneTime);
			for (const [key, value] of forwarded.searchParams)
				target.searchParams.set(key, value);
			const opened = await openInBrowser(
				target.href,
				options.env ?? process.env,
			);
			json(response, 200, { opened });
			return;
		}
		if (auth && !hasSessionCookie(request, token)) {
			if (url.pathname === "/app.css") {
				// Stylesheet only (no data); the sign-in page uses it.
				const css = await readFile(
					new URL("./ui/app.css", import.meta.url),
				).catch(() => undefined);
				if (!css) throw new HttpError(404, "dashboard UI is missing");
				response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
				response.end(css);
				return;
			}
			if (["/", "/app.js"].includes(url.pathname)) {
				response.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
				const project = basename(cwd).replace(
					/[&<>"']/g,
					(char) => `&#${char.charCodeAt(0)};`,
				);
				response.end(
					`<!doctype html><html lang="en"><meta charset="utf-8"><title>Dashboard sign-in</title><link rel="stylesheet" href="/app.css"><main class="signin"><h1>Dashboard sign-in</h1><p>This browser isn't signed in to the agent-workflow dashboard for ${project}. Sign in once; after that, links like this one open directly.</p><p><button type="button" id="signin">Sign in on this computer</button></p><p id="signin-status" role="status"></p><p class="muted">Or run <code>agent-workflow dashboard --open</code> in a terminal, or ask your agent to open the dashboard.</p></main><script src="/signin.js"></script></html>`,
				);
				return;
			}
			throw new HttpError(401, "use the printed dashboard URL");
		}
		if (request.method === "POST") {
			if (options.readonly) throw new HttpError(403, "read-only");
			// Without a cookie, same-origin fetch metadata is required (browsers send it; the general
			// fetch-site check above also admits navigations and non-browser callers).
			if (!auth && request.headers["sec-fetch-site"] !== "same-origin")
				throw new HttpError(403, "invalid Origin or CSRF token");
			if (
				request.headers.origin !== origin ||
				!secureEqual(
					typeof request.headers["x-aw-csrf"] === "string"
						? request.headers["x-aw-csrf"]
						: undefined,
					csrf,
				)
			)
				throw new HttpError(403, "invalid Origin or CSRF token");
			if (
				request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
				"application/json"
			)
				throw new HttpError(400, "Content-Type must be application/json");
		}
		if (
			request.method === "GET" &&
			["/", "/app.js", "/app.css"].includes(url.pathname)
		) {
			const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
			const content = await readFile(
				new URL(`./ui/${file}`, import.meta.url),
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (!content && file !== "index.html")
				throw new HttpError(404, "dashboard UI is missing");
			response.writeHead(200, {
				"Content-Type":
					file === "index.html"
						? "text/html; charset=utf-8"
						: file === "app.js"
							? "text/javascript; charset=utf-8"
							: "text/css; charset=utf-8",
			});
			response.end(
				content ??
					"<!doctype html><title>Dashboard</title><p>The dashboard UI is missing.</p>",
			);
			return;
		}
		// Vendored Shiki for code colouring (tools/release/vendor-shiki.mjs): a fixed directory,
		// its entry and hashed chunk names only.
		const vendor =
			request.method === "GET"
				? /^\/vendor\/shiki\/((?:highlight|chunk-[A-Z0-9]+)\.js|colours\.css)$/.exec(
						url.pathname,
					)
				: null;
		if (vendor) {
			const content = await readFile(
				new URL(`./ui/vendor/shiki/${vendor[1]}`, import.meta.url),
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (!content) throw new HttpError(404, "not found");
			response.writeHead(200, {
				"Content-Type": vendor[1].endsWith(".css")
					? "text/css; charset=utf-8"
					: "text/javascript; charset=utf-8",
			});
			response.end(content);
			return;
		}
		// Browsers ask for a favicon on their own; answer "none" instead of a logged 404.
		if (request.method === "GET" && url.pathname === "/favicon.ico") {
			response.writeHead(204, { "Cache-Control": "max-age=86400" });
			response.end();
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/session") {
			json(response, 200, {
				apiVersion: 2,
				mode: options.readonly ? "read-only" : "read-write",
				auth,
				csrf,
				serverTime: serverTime(),
				version,
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/projects") {
			const projects = [];
			for (const project of await listRegisteredProjects()) {
				projects.push({
					id: project.id,
					name: redact(project.name),
					path: redact(project.path),
					pathMissing: !(
						await stat(project.path).catch(() => undefined)
					)?.isDirectory(),
					lastSeenAt: project.lastSeenAt,
					counts: await countsFor(sourceFor(project)),
				});
			}
			json(response, 200, {
				projects: safe(projects),
				serverTime: serverTime(),
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/events") {
			const source = await requireProject(url.searchParams.get("project"));
			const id = url.searchParams.get("run");
			if (id !== null) requireRunId(id);
			await events(source, response, id);
			return;
		}
		let parts: string[];
		try {
			parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "invalid path encoding");
		}
		if (parts[0] !== "api" || parts[1] !== "projects")
			throw new HttpError(404, "not found");
		const source = await requireProject(parts[2] ?? null);
		// Keep the existing run route contract inside an explicitly validated project.
		parts = ["api", ...parts.slice(3)];
		if (parts[1] !== "runs") throw new HttpError(404, "not found");
		if (request.method === "GET" && parts.length === 2) {
			json(response, 200, await runsPayload(source));
			return;
		}
		if (!parts[2]) throw new HttpError(404, "not found");
		const runId = requireRunId(parts[2]);
		if (request.method === "GET" && parts.length === 3) {
			json(response, 200, await getRun(source, runId));
			return;
		}
		if (
			request.method === "GET" &&
			parts.length === 6 &&
			parts[3] === "tasks" &&
			parts[5] === "logs"
		) {
			const taskId = parts[4]!;
			if (!validTaskId(taskId)) throw new HttpError(400, "invalid task id");
			const stream = url.searchParams.get("stream") ?? "all";
			const rawLines = url.searchParams.get("lines") ?? "400";
			const lines = Number(rawLines);
			if (
				!["output", "stderr", "events", "all"].includes(stream) ||
				!/^\d+$/.test(rawLines) ||
				lines < 1 ||
				lines > 400
			)
				throw new HttpError(400, "invalid log stream or lines (1..400)");
			await getRun(source, runId);
			const logs = await source.taskLogs(runId, taskId, {
				stream: stream as "all" | "output" | "stderr" | "events",
				lines,
			});
			if (!logs) throw new HttpError(404, "task not found");
			json(response, 200, safe(logs));
			return;
		}
		if (
			request.method === "GET" &&
			parts.length === 6 &&
			parts[3] === "tasks" &&
			parts[5] === "result"
		) {
			const taskId = parts[4]!;
			if (!validTaskId(taskId)) throw new HttpError(400, "invalid task id");
			const shownRun = await getRun(source, runId);
			if (!shownRun.tasks?.some((task) => task.taskId === taskId))
				throw new HttpError(404, "task not found");
			// A known task without result files (not finished, or none written) is an empty result,
			// not an error: the UI says so without a failed request.
			const result = (await source.taskResult?.(runId, taskId)) ?? {};
			json(response, 200, safe(result));
			return;
		}
		if (
			request.method === "GET" &&
			parts.length === 4 &&
			parts[3] === "report"
		) {
			await getRun(source, runId);
			const report = await source.report(runId);
			if (!report) throw new HttpError(404, "report not found");
			const redacted = safe(report);
			const bounded = boundReportText(redacted.text);
			json(response, 200, {
				path: redacted.path,
				text: bounded.text,
				truncated: report.truncated || bounded.truncated,
			});
			return;
		}
		if (
			request.method === "POST" &&
			parts.length === 4 &&
			["stop", "resume", "approve"].includes(parts[3]!)
		) {
			const body = await readBody(request);
			await getRun(source, runId);
			let result;
			if (parts[3] === "approve") {
				if (
					typeof body.requestId !== "string" ||
					!/^[A-Za-z0-9_-]{1,256}$/.test(body.requestId) ||
					(body.decision !== "approve" && body.decision !== "reject")
				)
					throw new HttpError(
						400,
						"approve needs requestId and decision approve|reject",
					);
				result = await source.approve(runId, body.requestId, body.decision);
			} else
				result =
					parts[3] === "stop"
						? await source.stop(runId)
						: await source.resume(runId);
			json(response, 200, safe(result));
			return;
		}
		throw new HttpError(404, "not found");
	}
	const server = createServer((request, response) => {
		securityHeaders(response);
		void route(request, response).catch((error: unknown) => {
			if (response.headersSent || response.destroyed) {
				response.end();
				return;
			}
			json(response, errorStatus(error), {
				error: redact(error instanceof Error ? error.message : String(error)),
			});
		});
	});
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	// WP43c: links in old chat messages must survive restarts, so a project's dashboard reuses its
	// last port when nothing else holds it; an explicit --port is strict, an ephemeral one is the
	// fallback.
	const preferred =
		options.port === undefined && options.discovery
			? await readPreferredDashboardPort(cwd)
			: undefined;
	const listenOn = (candidate: number) =>
		new Promise<void>((ready, reject) => {
			server.once("error", reject);
			server.listen(candidate, "127.0.0.1", () => {
				server.removeListener("error", reject);
				ready();
			});
		});
	const explicit =
		options.port ??
		(env.AGENT_WORKFLOW_DASHBOARD_PORT === undefined
			? undefined
			: Number(env.AGENT_WORKFLOW_DASHBOARD_PORT));
	if (
		explicit !== undefined &&
		(!Number.isInteger(explicit) || explicit < 1 || explicit > 65535)
	)
		throw new HostUsageError(
			"dashboard port must be an integer from 1 to 65535",
		);
	for (const candidate of dashboardPortCandidates({
		explicit,
		customHome: Boolean(process.env.AGENT_WORKFLOW_HOME?.trim()),
		lastPort: preferred,
	})) {
		try {
			await listenOn(candidate);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES")
				throw new HostUsageError(
					"Dashboard cannot listen from a sandboxed shell; start it from a terminal, hook or MCP server.",
				);
			if (code !== "EADDRINUSE") throw error;
			if (explicit !== undefined || candidate === 0)
				throw new HostUsageError("dashboard port is unavailable (in use)");
		}
	}
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("dashboard did not bind a TCP port");
	port = address.port;
	origin = `http://127.0.0.1:${port}`;
	if (options.discovery) {
		await writePreferredDashboardPort(cwd, port).catch(() => undefined);
		try {
			await writeDashboardDiscovery(cwd, {
				pid: process.pid,
				port,
				launchKey,
				startedAt,
				auth,
				version,
				...(options.idleExitMs !== undefined
					? {
							detached: true,
							idleExitAt: new Date(
								noClientsSince + options.idleExitMs,
							).toISOString(),
						}
					: {}),
			});
		} catch (error) {
			server.close();
			server.closeAllConnections();
			throw error;
		}
	}
	let closing: Promise<void> | undefined;
	let idleTimer: ReturnType<typeof setInterval> | undefined;
	const dashboard: DashboardServer = {
		protocol: DASHBOARD_PROTOCOL,
		url: auth
			? `${origin}/?token=${token}&project=${projectId(cwd)}`
			: `${origin}/?project=${projectId(cwd)}`,
		port,
		token,
		launchKey,
		auth,
		close() {
			clearInterval(idleTimer);
			closing ??= new Promise<void>((done, reject) => {
				for (const cleanup of clients) cleanup();
				server.close((error) => (error ? reject(error) : done()));
				server.closeAllConnections();
			}).finally(async () => {
				launchTokens.clear();
				launches.clear();
				await idleUpdate;
				if (options.discovery) await removeDashboardDiscovery(cwd, launchKey);
			});
			return closing;
		},
	};
	if (options.idleExitMs !== undefined) {
		const idleExitMs = options.idleExitMs;
		let checking = false;
		idleTimer = setInterval(
			() => {
				if (checking || closing) return;
				checking = true;
				void (async () => {
					// Detached servers no longer belong to a project after its state/discovery is
					// removed. Check before listRuns or publishing: either can recreate directories.
					if (options.discovery) {
						try {
							await stat(dashboardDiscoveryPath(cwd));
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT")
								throw error;
							await dashboard.close();
							options.onIdleExit?.();
							return;
						}
					}
					let live = false;
					for (const project of await listRegisteredProjects()) {
						if ((await countsFor(sourceFor(project))).running > 0) {
							live = true;
							break;
						}
					}
					if (closing) return;
					if (!clients.size && !live && now() - noClientsSince >= idleExitMs) {
						await dashboard.close();
						options.onIdleExit?.();
					} else if (options.discovery) {
						idleUpdate = writeDashboardDiscovery(cwd, {
							pid: process.pid,
							port,
							launchKey,
							startedAt,
							auth,
							version,
							detached: true,
							idleExitAt: new Date(
								(clients.size || live ? now() : noClientsSince) + idleExitMs,
							).toISOString(),
						}).catch(() => undefined);
						await idleUpdate;
					}
				})()
					.catch(() => {
						/* Unknown run liveness: stay up rather than interrupt a user. */
					})
					.finally(() => {
						checking = false;
					});
			},
			Math.max(100, options.idleCheckMs ?? 60_000),
		);
		idleTimer.unref();
	}
	return dashboard;
}
