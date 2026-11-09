// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { startDashboardServer } from "../helpers/dashboard-server.mjs";
import { mintLaunchUrl } from "../../dist/hosts/dashboard/discovery.js";
async function server(t, options = {}) {
	const s = await startDashboardServer({
		cwd: process.cwd(),
		env: {},
		...options,
	});
	t.after(() => s.close());
	return s;
}
function launch(s, headers = {}, body = {}) {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port: s.port,
				path: "/api/launch",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AW-Launch-Key": s.launchKey,
					...headers,
				},
			},
			(res) => {
				let text = "";
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						json: async () => JSON.parse(text),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}
test("launch key authenticates without a cookie/CSRF; Host and fetch-site still enforced", async (t) => {
	const s = await server(t, { readonly: true });
	for (const key of ["", "bad", s.token])
		assert.equal((await launch(s, { "X-AW-Launch-Key": key })).status, 401);
	assert.equal((await launch(s, { Host: "evil.invalid" })).status, 421);
	assert.equal(
		(await launch(s, { "Sec-Fetch-Site": "cross-site" })).status,
		403,
	);
	assert.equal((await launch(s, { "Content-Type": "text/plain" })).status, 400);
	assert.equal((await launch(s)).status, 200, "read-only still allows sign-in");
});
test("WP43d open mode: launch URLs carry a launch id, not a credential; arriving forwards UI params and reclaims the slot", async (t) => {
	let now = 10_000;
	const s = await server(t, { now: () => now });
	assert.equal(s.auth, false);
	const url = await mintLaunchUrl(s, {
		run: "workflow_example",
		tab: "output",
	});
	const minted = new URL(url);
	assert.deepEqual([...minted.searchParams.keys()], ["launch", "run", "tab"]);
	assert.match(minted.searchParams.get("launch"), /^[A-Za-z0-9_-]{24}$/);
	const response = await fetch(url, { redirect: "manual" });
	assert.equal(response.status, 302);
	assert.equal(
		response.headers.get("location"),
		"/?run=workflow_example&tab=output",
	);
	assert.equal(response.headers.get("set-cookie"), null);
	// Re-use is harmless (nothing to steal) and the UI is open anyway.
	assert.equal((await fetch(url, { redirect: "manual" })).status, 302);
	assert.equal((await fetch(s.url)).status, 200);
	// The 16-slot cap still applies and a consumed launch frees its slot.
	const urls = [];
	for (let i = 0; i < 16; i++) urls.push(await mintLaunchUrl(s));
	assert.equal((await launch(s)).status, 429);
	assert.equal((await fetch(urls[0], { redirect: "manual" })).status, 302);
	assert.equal((await launch(s)).status, 200);
	assert.equal((await launch(s)).status, 429);
	now += 60_000;
	assert.equal((await launch(s)).status, 200);
});
test("--auth: one-time bootstrap sets the session cookie, forwards only valid UI params, and rejects reuse", async (t) => {
	const s = await server(t, { auth: true });
	const url = await mintLaunchUrl(s, {
		run: "workflow_example",
		task: "a.1",
		tab: "output",
		view: "details",
	});
	assert.notEqual(new URL(url).searchParams.get("token"), s.token);
	const response = await fetch(url, { redirect: "manual" });
	assert.equal(response.status, 302);
	assert.equal(
		response.headers.get("location"),
		"/?run=workflow_example&task=a.1&tab=output&view=details",
	);
	assert.equal(
		response.headers.get("set-cookie"),
		`aw_session=${s.token}; HttpOnly; SameSite=Strict; Path=/`,
	);
	assert.equal((await fetch(url, { redirect: "manual" })).status, 401);
	for (let i = 0; i < 2; i++)
		assert.equal(
			(
				await fetch(`${s.url}&run=workflow_manual`, { redirect: "manual" })
			).headers.get("location"),
			`/?project=${s.projectId}&run=workflow_manual`,
		);
	const result = await (
		await launch(
			s,
			{},
			{
				run: "bad/value",
				task: 123,
				tab: "events",
				evil: "injected",
				token: s.token,
			},
		)
	).json();
	const forwarded = new URL(result.url);
	assert.deepEqual([...forwarded.searchParams.keys()], ["token", "tab"]);
});
test("--auth: launch tokens expire at 60s, cap outstanding tokens at 16, and reclaim used/expired slots", async (t) => {
	let now = 10_000;
	const s = await server(t, { now: () => now, auth: true });
	const urls = [];
	for (let i = 0; i < 16; i++) urls.push(await mintLaunchUrl(s));
	assert.equal((await launch(s)).status, 429);
	assert.equal((await fetch(urls[0], { redirect: "manual" })).status, 302);
	assert.equal((await launch(s)).status, 200);
	assert.equal((await launch(s)).status, 429);
	now += 60_000;
	assert.equal((await fetch(urls[1], { redirect: "manual" })).status, 401);
	assert.equal((await launch(s)).status, 200);
});
