import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const fixtures = new URL("../fixtures/dashboard/", import.meta.url);
const ui = new URL("../../src/hosts/dashboard/ui/", import.meta.url);
export const injection = "<script>globalThis.dashboardInjected = true</script>";

// Local-only browser harness. Real API fixtures are unchanged; optional mutations and
// adversarial log/report text are synthesized here, not in the production UI.
export async function createFixtureServer({
	readonly = false,
	snapshots,
	extraProjects = [],
	// 2026-11-12: list failed top-level runs as unfinished notices (the shared dismissal); off, the
	// notices list is empty and "Needs you" dismissals stay in the browser.
	notices = false,
} = {}) {
	const readJson = async (name) =>
		JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
	const session = await readJson("session.json");
	const project = {
		id: "payments-api-123456789abc",
		name: "payments-api",
		path: "~/work/payments-api",
		pathMissing: false,
		lastSeenAt: session.serverTime,
	};
	const listing = snapshots
		? { ...(await readJson("runs.json")), runs: snapshots }
		: await readJson("runs.json");
	const logs = await readJson("logs-webhook-retry-path.json");
	const runs = new Map();
	if (snapshots) {
		for (const run of snapshots) runs.set(run.runId, structuredClone(run));
	} else {
		for (const file of await readdir(fixtures))
			if (file.startsWith("run-")) {
				const run = await readJson(file);
				runs.set(run.runId, run);
			}
	}
	// A test may give a run its own report text (runId → Markdown).
	const reports = new Map();
	const mutations = [],
		requests = [],
		clients = new Set();
	// Notice acknowledgements by run id; a run's state digest follows its status and update time.
	const acknowledgements = new Map();
	const noticeDigest = (run) =>
		createHash("sha256").update(`${run.status}|${run.updatedAt}`).digest("hex");
	const start = Date.now(),
		base = Date.parse(session.serverTime);
	let origin,
		heartbeatPaused = false;
	const serverTime = () => new Date(base + Date.now() - start).toISOString();
	const summaries = () => ({
		...listing,
		serverTime: serverTime(),
		runs: listing.runs.map((summary) => {
			const full = runs.get(summary.runId);
			const { tasks, task, usage, launch, permissionMode, ...rest } = full;
			return rest;
		}),
	});
	const send = (client, event, data) =>
		client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	const publish = () => {
		for (const client of clients) {
			send(client, "runs", summaries());
			if (runs.has(client.runId)) send(client, "run", runs.get(client.runId));
		}
	};
	const server = createServer(async (request, response) => {
		response.setHeader("Content-Security-Policy", CSP);
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Cache-Control", "no-store");
		const url = new URL(request.url, origin);
		requests.push({
			method: request.method,
			path: url.pathname,
			query: url.search,
		});
		const json = (data, status = 200) => {
			response.writeHead(status, {
				"Content-Type": "application/json; charset=utf-8",
			});
			response.end(JSON.stringify(data));
		};
		try {
			if (
				request.method === "GET" &&
				(["/", "/index.html", "/app.css", "/app.js"].includes(url.pathname) ||
					/^\/vendor\/shiki\/[\w-]+\.(?:js|css)$/.test(url.pathname))
			) {
				const name =
					url.pathname === "/" ? "index.html" : url.pathname.slice(1);
				response.writeHead(200, {
					"Content-Type": name.endsWith(".js")
						? "text/javascript; charset=utf-8"
						: name.endsWith(".css")
							? "text/css; charset=utf-8"
							: "text/html; charset=utf-8",
				});
				response.end(await readFile(new URL(name, ui)));
				return;
			}
			if (url.pathname === "/favicon.ico") {
				response.writeHead(204);
				response.end();
				return;
			}
			if (url.pathname === "/api/session")
				return json({
					...session,
					mode: readonly ? "read-only" : "read-write",
					serverTime: serverTime(),
				});
			if (url.pathname === "/api/projects")
				return json({
					projects: [
						{
							...project,
							counts: {
								running: listing.runs.filter((run) =>
									["running", "blocked"].includes(run.status),
								).length,
								needsAttention: listing.runs.filter(
									(run) => run.needsYou.length,
								).length,
								lastActivity: session.serverTime,
							},
						},
						...extraProjects,
					],
				});
			if (url.pathname.startsWith(`/api/projects/${project.id}/`))
				url.pathname = `/api/${url.pathname.split("/").slice(4).join("/")}`;
			const emptyProject = extraProjects.find(
				(project) =>
					url.pathname.startsWith(`/api/projects/${project.id}/`) ||
					(url.pathname === "/api/events" &&
						url.searchParams.get("project") === project.id),
			);
			if (emptyProject && url.pathname.endsWith("/runs"))
				return json({ serverTime: serverTime(), runs: [] });
			if (url.pathname === "/api/runs") return json(summaries());
			// The notices endpoint (2026-11-12): acknowledgements by run, keyed to a fixed state digest.
			const noticeMatch =
				/^\/api\/notices(?:\/(workflow_[A-Za-z0-9_-]+)\/(acknowledge|clear))?$/.exec(
					url.pathname,
				);
			if (noticeMatch) {
				const listed = notices
					? [...runs.values()]
							.filter((run) => run.status === "failed" && !run.parentRunId)
							.map((run) => ({
								runId: run.runId,
								status: run.status,
								updatedAt: run.updatedAt,
								sha256: noticeDigest(run),
							}))
					: [];
				if (!noticeMatch[1] && request.method === "GET")
					return json({
						action: "notices",
						ok: true,
						data: {
							notices: listed,
							acknowledgements: [...acknowledgements.values()].map((entry) => ({
								...entry,
								active: listed.some(
									(run) =>
										run.runId === entry.runId && run.sha256 === entry.sha256,
								),
							})),
							warnings: [],
						},
					});
				if (request.method === "POST" && noticeMatch[1]) {
					if (readonly) return json({ error: "read-only" }, 403);
					if (request.headers["x-aw-csrf"] !== session.csrf)
						return json({ error: "mutation-security-check-failed" }, 403);
					let body = "";
					for await (const chunk of request) body += chunk;
					const data = body ? JSON.parse(body) : {};
					mutations.push({
						runId: noticeMatch[1],
						action: `notices-${noticeMatch[2]}`,
						body: data,
					});
					if (noticeMatch[2] === "clear")
						acknowledgements.delete(noticeMatch[1]);
					else {
						const run = listed.find((entry) => entry.runId === noticeMatch[1]);
						if (!run || run.sha256 !== data.state)
							return json({ error: "Run state changed" }, 409);
						acknowledgements.set(noticeMatch[1], {
							runId: noticeMatch[1],
							status: run.status,
							updatedAt: run.updatedAt,
							sha256: run.sha256,
							reason: data.reason,
							acknowledgedAt: serverTime(),
						});
					}
					return json({ action: "notices", ok: true, data: {} });
				}
			}
			if (url.pathname === "/api/events") {
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					Connection: "keep-alive",
				});
				response.flushHeaders();
				const client = { response, runId: url.searchParams.get("run") };
				clients.add(client);
				send(
					client,
					"runs",
					emptyProject ? { serverTime: serverTime(), runs: [] } : summaries(),
				);
				if (runs.has(client.runId)) send(client, "run", runs.get(client.runId));
				const timer = setInterval(() => {
					if (!heartbeatPaused)
						send(client, "heartbeat", { serverTime: serverTime() });
				}, 1000);
				response.on("close", () => {
					clearInterval(timer);
					clients.delete(client);
				});
				return;
			}
			const match = /^\/api\/runs\/(workflow_[A-Za-z0-9_-]+)(.*)$/.exec(
				url.pathname,
			);
			if (!match || !runs.has(match[1]))
				return json({ error: "not-found" }, 404);
			const run = runs.get(match[1]),
				suffix = match[2];
			if (!suffix && request.method === "GET") return json(run);
			if (/^\/tasks\/[^/]+\/logs$/.test(suffix)) {
				const data = structuredClone(logs);
				data.taskId = decodeURIComponent(suffix.split("/")[2]);
				data.streams
					.find((stream) => stream.kind === "stderr")
					.lines.push(injection);
				return json(data);
			}
			// 2026-11-03: a finished task's result (digest, analysis Markdown, refs, control JSON).
			if (/^\/tasks\/[^/]+\/result$/.test(suffix))
				return json({
					digest: `Result digest ${injection}`,
					analysis: `## Findings\n\n- **Bold** item with \`code\`\n- ${injection}\n\n[not a link](https://example.invalid)`,
					refs: [
						{
							title: "Source title",
							url: "https://example.invalid/source",
							note: injection,
						},
					],
					control: JSON.stringify({ digest: "x", note: injection }, null, 2),
				});
			if (suffix === "/report")
				return json({
					path: "reports/review.md",
					text:
						reports.get(match[1]) ??
						`# Review report\n\n- A finding\n- ${injection}\n\n[not a link](https://example.invalid)\n![not an image](https://example.invalid/image.png)\n\n## Main findings\n\n### 1. Retries are bounded\n\nEvidence status: **verified**\nSources: [example.invalid](<https://example.invalid/a>)\n- Retry doc: quote "Retries stop after four attempts."\n\n| Area | Status |\n|---|---|\n| Retry | partially\\_supported |\n\n1. **Add a jitter test.**\n   - Evidence status: derived\n2. **Log the final failure.**\n\n- **Gap:** no load test\n\nRun cd sample &amp;&amp; npm test &lt;ok&gt;\nVerdict: **NEEDS_WORK**; **API** stays.\n\n\`\`\`ts\n\tif (a **b**) return \"ok\"; // 2\n  <x>\n\`\`\`\n\n- \\{\"item\":\"Ship it\",\"owner\":\"release\",\"blocking\":true\\}`,
					truncated: false,
				});
			if (request.method === "POST" && ["/stop", "/resume"].includes(suffix)) {
				if (readonly) return json({ error: "read-only" }, 403);
				if (
					request.headers["x-aw-csrf"] !== session.csrf ||
					request.headers["content-type"] !== "application/json" ||
					request.headers.origin !== origin
				)
					return json({ error: "mutation-security-check-failed" }, 403);
				let body = "";
				for await (const chunk of request) body += chunk;
				const data = JSON.parse(body);
				mutations.push({
					runId: run.runId,
					action: suffix.slice(1),
					body: data,
					csrf: request.headers["x-aw-csrf"],
					origin: request.headers.origin,
				});
				if (suffix === "/stop") {
					json({
						outcome: "requested",
						status: run.status,
						pending: true,
						interruptedTaskIds: [],
						text: "Stop requested — waiting for supervisor confirmation.",
					});
					return;
				}
				run.status = "running";
				run.needsYou = [];
				json({
					outcome: "ok",
					status: run.status,
					text: "Run resumed. Completed tasks were kept.",
				});
				publish();
				return;
			}
			json({ error: "not-found" }, 404);
		} catch (error) {
			json({ error: error.message }, 500);
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	return {
		origin,
		runs,
		reports,
		mutations,
		requests,
		publish,
		setReadonly(value) {
			readonly = value;
		},
		pauseHeartbeats(value) {
			heartbeatPaused = value;
		},
		disconnectEvents() {
			for (const client of clients) client.response.end();
		},
		async close() {
			for (const client of clients) client.response.end();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const fixture = await createFixtureServer();
	console.log(fixture.origin);
	for (const signal of ["SIGINT", "SIGTERM"])
		process.once(signal, async () => {
			await fixture.close();
			process.exit(0);
		});
}
