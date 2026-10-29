// WP43: HTTP contract and security against a fixture-backed, replaceable host source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
import {
	dashboardCsrf,
	DASHBOARD_CSP,
	validTaskId,
	allowedHost,
} from "../../dist/hosts/dashboard/security.js";
const fixture = async (name) =>
	JSON.parse(
		await readFile(
			new URL(`../fixtures/dashboard/${name}.json`, import.meta.url),
			"utf8",
		),
	);
const runs = await fixture("runs");
const run = await fixture("run-workflow_mvt9k2qa_7c41e0");
const logs = await fixture("logs-webhook-retry-path");
const AT = Date.parse(runs.serverTime);
const ID = run.runId;
function fake() {
	return {
		listRuns: async () => structuredClone(runs.runs),
		run: async (id) => (id === ID ? structuredClone(run) : undefined),
		taskLogs: async (_id, task, options) => {
			assert.deepEqual(options, { stream: "all", lines: 400 });
			return task === "task-11" ? logs : undefined;
		},
		report: async () => undefined,
		stop: async () => ({
			outcome: "success",
			status: "interrupted",
			pending: false,
			interruptedTaskIds: ["task-10"],
			text: "Stopped",
		}),
		resume: async () => ({
			outcome: "running",
			status: "running",
			resetTaskIds: ["task-10"],
			text: "Resumed",
		}),
		approve: async (_id, requestId, decision) => ({
			outcome: "success",
			status: "blocked",
			text: `${requestId}: ${decision}`,
		}),
	};
}
async function server(t, options = {}) {
	const instance = await startDashboardServer({
		cwd: process.cwd(),
		env: {},
		source: fake(),
		now: () => AT,
		...options,
	});
	t.after(() => instance.close());
	return instance;
}
function http(
	server,
	path,
	{ method = "GET", headers = {}, body, auth = true } = {},
) {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port: server.port,
				path,
				method,
				headers: {
					...(auth ? { Cookie: `aw_session=${server.token}` } : {}),
					...headers,
				},
			},
			(res) => {
				const chunks = [];
				const address = res.socket.remoteAddress;
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString();
					resolve({
						status: res.statusCode,
						headers: res.headers,
						text,
						address,
						json: () => JSON.parse(text),
					});
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}
const mutation = (s, extra = {}) => ({
	method: "POST",
	headers: {
		Origin: `http://127.0.0.1:${s.port}`,
		"X-AW-CSRF": dashboardCsrf(s.token),
		"Content-Type": "application/json",
		...extra,
	},
	body: "{}",
});

test("bind is IPv4 loopback; token bootstrap redirects and sets strict cookie only on bootstrap", {
	timeout: 5000,
}, async (t) => {
	const s = await server(t);
	assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]{43}$/);
	assert.equal(Buffer.from(s.token, "base64url").length, 32);
	const boot = await http(s, `/?token=${s.token}`, { auth: false });
	assert.equal(boot.address, "127.0.0.1");
	assert.equal(boot.status, 302);
	assert.equal(boot.headers.location, "/");
	assert.deepEqual(boot.headers["set-cookie"], [
		`aw_session=${s.token}; HttpOnly; SameSite=Strict; Path=/`,
	]);
	assert.equal(
		(await http(s, "/api/session")).headers["set-cookie"],
		undefined,
	);
	assert.equal((await http(s, "/?token=wrong", { auth: false })).status, 401);
	assert.equal((await http(s, "/api/session", { auth: false })).status, 401);
	const unauthenticated = await http(s, "/", { auth: false });
	assert.equal(unauthenticated.status, 401);
	assert.match(unauthenticated.text, /printed dashboard URL/);
	assert.equal(
		(await http(s, "/api/session", { headers: { Cookie: "aw_session=wrong" } }))
			.status,
		401,
	);
	assert.equal(
		(
			await http(s, "/api/session", {
				headers: { Cookie: `aw_session=${s.token}; aw_session=bad` },
			})
		).status,
		401,
	);
});

test("all responses have CSP, frame denial, nosniff, no-referrer and no-store", async (t) => {
	const s = await server(t);
	for (const [path, options] of [
		["/api/session", {}],
		["/api/runs", { auth: false }],
		["/bad", {}],
		[`/?token=${s.token}`, { auth: false }],
	]) {
		const { headers } = await http(s, path, options);
		assert.equal(headers["content-security-policy"], DASHBOARD_CSP);
		assert.equal(headers["x-frame-options"], "DENY");
		assert.equal(headers["x-content-type-options"], "nosniff");
		assert.equal(headers["referrer-policy"], "no-referrer");
		assert.equal(headers["cache-control"], "no-store");
	}
});

test("Host and fetch-site reject rebinding and cross-origin requests before authentication", async (t) => {
	const s = await server(t);
	for (const host of [
		"evil.example",
		`evil.example:${s.port}`,
		`127.0.0.1:${s.port + 1}`,
	])
		assert.equal(
			(await http(s, "/api/session", { headers: { Host: host } })).status,
			421,
		);
	for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`])
		assert.equal(
			(await http(s, "/api/session", { headers: { Host: host } })).status,
			200,
		);
	assert.equal(allowedHost("127.0.0.1", s.port), false);
	for (const site of ["cross-site", "same-site", "weird"])
		assert.equal(
			(
				await http(s, `/?token=${s.token}`, {
					auth: false,
					headers: { "Sec-Fetch-Site": site },
				})
			).status,
			403,
		);
	for (const site of ["same-origin", "none"])
		assert.equal(
			(await http(s, "/api/session", { headers: { "Sec-Fetch-Site": site } }))
				.status,
			200,
		);
});

test("fixture JSON routes and session shape", async (t) => {
	const s = await server(t);
	assert.deepEqual((await http(s, "/api/runs")).json(), runs);
	assert.deepEqual((await http(s, `/api/runs/${ID}`)).json(), run);
	assert.deepEqual(
		(await http(s, `/api/runs/${ID}/tasks/task-11/logs`)).json(),
		logs,
	);
	const session = (await http(s, "/api/session")).json();
	assert.deepEqual(Object.keys(session).sort(), [
		"apiVersion",
		"csrf",
		"mode",
		"project",
		"serverTime",
		"version",
	]);
	assert.equal(session.apiVersion, 1);
	assert.equal(session.mode, "read-write");
	assert.equal(session.csrf, dashboardCsrf(s.token));
	assert.equal(session.serverTime, runs.serverTime);
	assert.equal(session.version, "0.1.0");
	assert.equal(JSON.stringify(session).includes(s.token), false);
	assert.equal(
		(await http(s, "/api/session")).headers["content-type"],
		"application/json; charset=utf-8",
	);
});

test("mutations require Origin, CSRF and JSON; valid Stop, Resume, Approve and Reject use source", async (t) => {
	const s = await server(t);
	for (const headers of [
		{},
		{ Origin: `http://127.0.0.1:${s.port}` },
		{ "X-AW-CSRF": dashboardCsrf(s.token) },
		{ Origin: "http://evil.example", "X-AW-CSRF": dashboardCsrf(s.token) },
	]) {
		assert.equal(
			(
				await http(s, `/api/runs/${ID}/stop`, {
					method: "POST",
					headers,
					body: "{}",
				})
			).status,
			403,
		);
	}
	assert.equal(
		(
			await http(
				s,
				`/api/runs/${ID}/stop`,
				mutation(s, { "Content-Type": "text/plain" }),
			)
		).status,
		400,
	);
	assert.deepEqual(
		(await http(s, `/api/runs/${ID}/stop`, mutation(s))).json(),
		await fake().stop(),
	);
	assert.deepEqual(
		(await http(s, `/api/runs/${ID}/resume`, mutation(s))).json(),
		await fake().resume(),
	);
	for (const decision of ["approve", "reject"]) {
		const res = await http(s, `/api/runs/${ID}/approve`, {
			...mutation(s),
			body: JSON.stringify({ requestId: "request-123", decision }),
		});
		assert.equal(res.status, 200);
		assert.equal(res.json().text, `request-123: ${decision}`);
	}
	assert.equal(
		(await http(s, `/api/runs/${ID}/approve`, mutation(s))).status,
		400,
	);
	for (const body of ["not json", "null", "[]"])
		assert.equal(
			(await http(s, `/api/runs/${ID}/stop`, { ...mutation(s), body })).status,
			400,
		);
});

test("read-only refuses every mutation even with valid cookie, Origin and CSRF", async (t) => {
	const s = await server(t, { readonly: true });
	assert.equal((await http(s, "/api/session")).json().mode, "read-only");
	for (const action of ["stop", "resume", "approve"]) {
		const res = await http(s, `/api/runs/${ID}/${action}`, mutation(s));
		assert.equal(res.status, 403);
		assert.deepEqual(res.json(), { error: "read-only" });
	}
});

test("invalid ids and bounds return 400; missing run/task/report and routes return 404", async (t) => {
	const s = await server(t);
	for (const path of [
		"/api/runs/prefix",
		"/api/runs/workflow_a%2Fb",
		"/api/runs/workflow_a%00",
		"/api/events?run=prefix",
		`/api/runs/${ID}/tasks/bad%2Fid/logs`,
		`/api/runs/${ID}/tasks/task-11/logs?lines=401`,
		`/api/runs/${ID}/tasks/task-11/logs?lines=0`,
		`/api/runs/${ID}/tasks/task-11/logs?stream=bad`,
	])
		assert.equal((await http(s, path)).status, 400, path);
	for (const path of [
		"/api/runs/workflow_missing",
		"/api/events?run=workflow_missing",
		`/api/runs/${ID}/tasks/task-99/logs`,
		`/api/runs/${ID}/report`,
		"/elsewhere",
		"/package.json",
	])
		assert.equal((await http(s, path)).status, 404, path);
	assert.equal(validTaskId("reviewers.webhook-retry-path"), true);
	assert.equal(validTaskId(".."), false);
	assert.equal(
		(await http(s, "/api/runs/workflow_missing/stop", mutation(s))).status,
		404,
	);
});

test("JSON bodies are bounded at 16 KiB, including chunked requests", async (t) => {
	const s = await server(t);
	for (const headers of [
		{ "Content-Length": "20002" },
		{ "Transfer-Encoding": "chunked" },
	]) {
		const res = await http(s, `/api/runs/${ID}/stop`, {
			...mutation(s, headers),
			body: `"${"a".repeat(20000)}"`,
		});
		assert.equal(res.status, 413);
	}
});

test("report is text, capped and redacted; failures do not escape request boundary", async (t) => {
	const source = fake();
	source.report = async () => ({
		path: "report.md",
		text: "<script>untrusted()</script>\n" + "x".repeat(270000),
		truncated: false,
	});
	const s = await server(t, {
		source,
		env: { SERVICE_TOKEN: "private-test-secret" },
	});
	const res = await http(s, `/api/runs/${ID}/report`);
	assert.equal(res.status, 200);
	assert.equal(res.json().truncated, true);
	assert.match(res.json().text, /^<script>/);
	assert.match(res.json().text, /Report truncated/);
	assert.ok(Buffer.byteLength(res.json().text) < 256 * 1024 + 100);
	source.run = async () => {
		throw new Error("failed: private-test-secret");
	};
	const failure = await http(s, `/api/runs/${ID}`);
	assert.equal(failure.status, 500);
	assert.equal(failure.text.includes("private-test-secret"), false);
	assert.equal(Object.keys(failure.json()).join(), "error");
	assert.equal((await http(s, "/api/session")).status, 200);
});

async function until(predicate, ms = 3500) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail("timed out awaiting SSE");
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("SSE sends immediate snapshots, only changes, heartbeats, and closes active streams", {
	timeout: 9000,
}, async (t) => {
	let at = AT;
	const source = fake();
	const s = await server(t, { source, now: () => at, pollMs: 500 });
	const abort = new AbortController();
	t.after(() => abort.abort());
	const response = await fetch(
		`http://127.0.0.1:${s.port}/api/events?run=${ID}`,
		{ headers: { Cookie: `aw_session=${s.token}` }, signal: abort.signal },
	);
	assert.match(response.headers.get("content-type"), /text\/event-stream/);
	const received = [];
	const reader = response.body.getReader();
	const reading = (async () => {
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += new TextDecoder().decode(value);
			let end;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const [event, data] = frame.split("\n");
				received.push({
					event: event.slice(7),
					data: JSON.parse(data.slice(6)),
				});
			}
		}
	})().catch((error) => {
		if (error.name !== "AbortError") throw error;
	});
	await until(() => received.length >= 2);
	assert.deepEqual(
		received.map((event) => event.event),
		["runs", "run"],
	);
	assert.deepEqual(received[1].data, run);
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(received.length, 2);
	source.run = async () => ({ ...run, name: "changed" });
	source.listRuns = async () => [{ ...runs.runs[0], name: "changed" }];
	await until(() => received.length === 4);
	assert.deepEqual(
		received.slice(2).map((event) => event.event),
		["runs", "run"],
	);
	at += 15000;
	await until(() => received.some((event) => event.event === "heartbeat"));
	assert.equal(received.filter((event) => event.event === "runs").length, 2);
	await s.close();
	await reading;
	await s.close(); // idempotent
});
