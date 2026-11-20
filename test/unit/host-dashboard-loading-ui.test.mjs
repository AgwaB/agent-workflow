// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
const chrome = await findChrome();
async function open(t, view = "workflows") {
	assert.ok(chrome, "Chrome required for native loading checks");
	const p = await managementProject(t);
	const catalog = (await p.http(`${p.base}/workflows`)).data.data.workflows;
	const entry = catalog.find((w) => w.name === "manage");
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
		window.__loads = []; window.__release = {}; window.__hold = new Set(['/api/session', '/api/projects', '/api/executors/models', '/api/profiles/presets']);
		const original = fetch;
		window.fetch = async (...args) => {
			const path = String(args[0]);
			window.__loads.push({path, start: performance.now()});
			const response = await original(...args);
			if (window.__hold.has(path)) await new Promise(resolve => { window.__release[path] = resolve; });
			return response;
		};
	`,
	});
	await browser.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=${view}${view === "workflows" ? `&workflow=${entry.workflowKey}` : ""}`,
	});
	await browser.waitFor(() => !!window.__release["/api/session"]);
	return { ...p, browser };
}

test("session, projects and page data start independently; workflow inputs and preview do not wait for models", async (t) => {
	const p = await open(t);
	await p.browser.waitFor(() =>
		window.__loads.some((r) => r.path === "/api/projects"),
	);
	await p.browser.waitFor(() =>
		window.__loads.some((r) => r.path.includes("/workflows")),
	);
	const times = await p.browser.evaluate(() => window.__loads.slice(0, 5));
	assert.ok(times.some((r) => r.path === "/api/session"));
	assert.ok(times.some((r) => r.path === "/api/projects"));
	await p.browser.waitFor(() => !!window.__release["/api/projects"]);
	await p.browser.waitFor(
		() =>
			!!window.__release["/api/executors/models"] &&
			!!window.__release["/api/profiles/presets"],
	);
	await p.browser.evaluate(() => {
		window.__release["/api/session"]();
		window.__release["/api/projects"]();
	});
	await p.browser.waitFor(
		() => !!document.querySelector(".project-common [data-binding]"),
	);
	await p.browser.waitFor(() =>
		window.__loads.some((r) => r.path.endsWith("/preview")),
	);
	const requests = await p.browser.evaluate(() => window.__loads);
	const detail = requests.find((r) => r.path.includes("?view=editor"));
	const settings = requests.find((r) => r.path.endsWith("/settings"));
	assert.ok(detail && settings, JSON.stringify(requests));
	assert.ok(
		Math.abs(detail.start - settings.start) < 150,
		JSON.stringify(requests),
	);
	await p.browser.evaluate(() => {
		window.__hold.clear();
		for (const release of Object.values(window.__release)) release();
	});
});

test("global progress covers overlapping fetches, errors and reduced motion without blocking input", async (t) => {
	const p = await open(t, "executors");
	await p.browser.waitFor(() => {
		const bar = document.querySelector("#global-progress");
		return bar && !bar.hidden;
	});
	const before = await p.browser.evaluate(() => {
		const b = document.querySelector("#global-progress");
		const s = getComputedStyle(b);
		return {
			position: s.position,
			events: s.pointerEvents,
			height: b.getBoundingClientRect().height,
			value: b.getAttribute("aria-valuenow"),
		};
	});
	assert.equal(before.position, "fixed");
	assert.equal(before.events, "none");
	assert.ok(before.height > 0 && before.height <= 4);
	assert.equal(before.value, null);
	await p.browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	assert.equal(
		await p.browser.evaluate(
			() =>
				getComputedStyle(document.querySelector("#global-progress"))
					.animationName,
		),
		"none",
	);
	await p.browser.evaluate(() => window.__release["/api/session"]());
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector("#global-progress").hidden,
		),
		false,
	);
	// The release exists only once the held response has arrived.
	await p.browser.waitFor(() => !!window.__release["/api/projects"]);
	await p.browser.evaluate(() => {
		window.__hold.clear();
		window.__release["/api/projects"]();
	});
	await p.browser.waitFor(() => document.querySelector(".executors"));
	await p.browser.waitFor(
		() => document.querySelector("#global-progress").hidden,
	);
	await p.browser.evaluate(() => {
		const original = fetch;
		window.fetch = (...args) =>
			String(args[0]) === "/api/doctor?refresh=1"
				? Promise.reject(new Error("fixture failure"))
				: original(...args);
	});
	await p.browser.click('[data-management-action="doctor-refresh"]');
	await p.browser.waitFor(
		() => document.querySelector("#global-progress").hidden,
	);
});
