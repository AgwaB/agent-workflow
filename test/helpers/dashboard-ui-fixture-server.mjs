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
} = {}) {
	const readJson = async (name) =>
		JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
	const session = await readJson("session.json");
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
	const mutations = [],
		requests = [],
		clients = new Set();
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
			const {
				tasks,
				pendingApprovals,
				task,
				usage,
				launch,
				permissionMode,
				...rest
			} = full;
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
				["/", "/index.html", "/app.css", "/app.js"].includes(url.pathname)
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
			if (url.pathname === "/api/runs") return json(summaries());
			if (url.pathname === "/api/events") {
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					Connection: "keep-alive",
				});
				response.flushHeaders();
				const client = { response, runId: url.searchParams.get("run") };
				clients.add(client);
				send(client, "runs", summaries());
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
					text: `# Review report\n\n- A finding\n- ${injection}\n\n[not a link](https://example.invalid)\n![not an image](https://example.invalid/image.png)\n\n## Main findings\n\n### 1. Retries are bounded\n\nEvidence status: **verified**\nSources: [example.invalid](<https://example.invalid/a>)\n- Retry doc: quote "Retries stop after four attempts."\n\n| Area | Status |\n|---|---|\n| Retry | partially\\_supported |\n\n1. **Add a jitter test.**\n   - Evidence status: derived\n2. **Log the final failure.**\n\n- **Gap:** no load test`,
					truncated: false,
				});
			if (
				request.method === "POST" &&
				["/stop", "/resume", "/approve"].includes(suffix)
			) {
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
				if (suffix === "/approve") {
					if (
						data.requestId !== run.pendingApprovals[0]?.requestId ||
						!["approve", "reject"].includes(data.decision)
					)
						return json({ error: "invalid-approval" }, 400);
					run.pendingApprovals = [];
					if (data.decision === "reject") {
						run.statusDetail = "dynamic_approval_rejected";
						run.tasks.at(-1).statusDetail = "dynamic_approval_rejected";
					} else {
						run.status = "running";
						run.tasks.at(-1).status = "running";
						run.tasks.at(-1).statusDetail = "running";
					}
					run.needsYou = [];
				} else {
					run.status = "running";
					run.needsYou = [];
				}
				json({
					outcome: "ok",
					status: run.status,
					text:
						suffix === "/resume"
							? "Run resumed. Completed tasks were kept."
							: data.decision === "reject"
								? "Approval rejected. Run stays blocked."
								: "Approval recorded.",
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
