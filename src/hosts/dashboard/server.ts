// WP43: loopback-only, cookie-authenticated HTTP host. No framework or engine/file-store access.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { basename, resolve } from "node:path";
import {
	writeDashboardDiscovery,
	removeDashboardDiscovery,
} from "./discovery.js";
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
}
export interface DashboardServer {
	url: string;
	port: number;
	token: string;
	launchKey: string;
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
	const source =
		options.source ?? hostApiDashboardSource({ cwd, env, host: "cli" });
	const token = generateDashboardToken();
	const csrf = dashboardCsrf(token);
	const launchKey = options.launchKey ?? generateDashboardToken();
	const launchTokens = new Map<string, number>();
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
	const getRun = async (runId: string) => {
		const run = await source.run(runId);
		if (!run || run.runId !== runId) throw new HttpError(404, "run not found");
		return safe(run);
	};
	const runsPayload = async () => ({
		serverTime: serverTime(),
		runs: safe(await source.listRuns()),
	});

	async function events(
		response: ServerResponse,
		runId: string | null,
	): Promise<void> {
		// Resolve before committing SSE headers so unknown ids still return a JSON 404.
		const firstRuns = await runsPayload();
		const firstRun = runId ? await getRun(runId) : undefined;
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
				const runs = await runsPayload();
				send("runs", runs, runs.runs);
				if (runId) send("run", await getRun(runId));
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
			target.searchParams.set("token", oneTime);
			for (const [key, value] of forwarded.searchParams)
				target.searchParams.set(key, value);
			json(response, 200, { url: target.href, launchId });
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
		if (!hasSessionCookie(request, token)) {
			if (["/", "/app.js", "/app.css"].includes(url.pathname)) {
				response.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
				response.end(
					"<!doctype html><title>Dashboard</title><p>Use the printed dashboard URL to sign in.</p>",
				);
				return;
			}
			throw new HttpError(401, "use the printed dashboard URL");
		}
		if (request.method === "POST") {
			if (options.readonly) throw new HttpError(403, "read-only");
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
		if (request.method === "GET" && url.pathname === "/api/session") {
			json(response, 200, {
				apiVersion: 1,
				project: { path: redact(cwd), name: redact(basename(cwd)) },
				mode: options.readonly ? "read-only" : "read-write",
				csrf,
				serverTime: serverTime(),
				version,
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/runs") {
			json(response, 200, await runsPayload());
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/events") {
			const id = url.searchParams.get("run");
			if (id !== null) requireRunId(id);
			await events(response, id);
			return;
		}
		let parts: string[];
		try {
			parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "invalid path encoding");
		}
		if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2])
			throw new HttpError(404, "not found");
		const runId = requireRunId(parts[2]);
		if (request.method === "GET" && parts.length === 3) {
			json(response, 200, await getRun(runId));
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
			await getRun(runId);
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
			parts.length === 4 &&
			parts[3] === "report"
		) {
			await getRun(runId);
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
			await getRun(runId);
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
	await new Promise<void>((ready, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			ready();
		});
	}).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE" || error.code === "EACCES")
			throw new HostUsageError(
				"dashboard port is unavailable (in use or permission denied)",
			);
		throw error;
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("dashboard did not bind a TCP port");
	port = address.port;
	origin = `http://127.0.0.1:${port}`;
	if (options.discovery) {
		try {
			await writeDashboardDiscovery(cwd, { pid: process.pid, port, launchKey });
		} catch (error) {
			server.close();
			server.closeAllConnections();
			throw error;
		}
	}
	let closing: Promise<void> | undefined;
	return {
		url: `${origin}/?token=${token}`,
		port,
		token,
		launchKey,
		close() {
			closing ??= new Promise<void>((done, reject) => {
				for (const cleanup of clients) cleanup();
				server.close((error) => (error ? reject(error) : done()));
				server.closeAllConnections();
			}).finally(async () => {
				launchTokens.clear();
				launches.clear();
				if (options.discovery) await removeDashboardDiscovery(cwd, launchKey);
			});
			return closing;
		},
	};
}
