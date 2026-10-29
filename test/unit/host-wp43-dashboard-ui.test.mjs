import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	CSP,
	createFixtureServer,
	injection,
} from "../helpers/dashboard-ui-fixture-server.mjs";

const running = "workflow_mvt9k2qa_7c41e0";
const approval = "workflow_mvt9n8dd_19b2f4";
const failed = "workflow_mvt8x01c_aa3e91";
const complete = "workflow_mvt23704_e8e6d7";
const root = new URL("../../src/hosts/dashboard/ui/", import.meta.url);

test("dashboard static assets have no executable content sinks or inline code", async () => {
	const html = await readFile(new URL("index.html", root), "utf8");
	const js = await readFile(new URL("app.js", root), "utf8");
	const css = await readFile(new URL("app.css", root), "utf8");
	assert.doesNotMatch(
		js,
		/\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval)\b|document\s*\.\s*write\s*\(|new\s+Function\b/,
	);
	assert.doesNotMatch(
		html,
		/<style\b|\sstyle\s*=|\son[a-z]+\s*=|<script(?![^>]*\bsrc=)[^>]*>/i,
	);
	assert.doesNotMatch(js, /setAttribute\(\s*["'](?:style|on\w+)["']|\.style\b/);
	assert.doesNotMatch(css, /@import|url\s*\(|@font-face/);
	assert.doesNotMatch(html, /(?:src|href)=["'](?:https?:|\/\/)/);
	assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])px\b/);
});

const chrome = await findChrome();
test("dashboard Chrome: API, live DAG, dialogs, safe output, readonly and URL state", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 180_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	const approvalSnapshot = structuredClone(fixture.runs.get(approval));
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const text = (selector) =>
		browser.evaluate(
			(selector) => document.querySelector(selector)?.textContent,
			selector,
		);
	const open = (query = `run=${running}`) =>
		browser.open(`${fixture.origin}/?${query}`);
	await open();
	await browser.waitFor(() =>
		document.querySelector("#connection")?.textContent.includes("Live"),
	);
	assert.equal(await text("#task-count"), "3 / 13");
	assert.equal(await text("#project"), "payments-api");
	assert.match(
		await text("#status-sentence"),
		/^Reviewing is under way\. One reviewer is waiting for a rate-limit retry \(2 of 4, \d+:\d{2}\)\. Nothing needs you\.$/,
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[
				...document.querySelectorAll('[data-stage="reviewers"] .agent-name'),
			].map((el) => el.textContent),
		),
		["ledger-double-write", "webhook-retry-path", "refund-idempotency"],
	);
	assert.equal(
		await browser.evaluate(() => document.querySelectorAll(".node").length),
		8,
	);
	assert.equal(
		await browser.evaluate(() => document.querySelector("#inspector").hidden),
		true,
	);
	assert.ok(
		await browser.evaluate(
			() =>
				document.querySelector("#canvas").getBoundingClientRect().height >= 600,
		),
	);
	const typography = await browser.evaluate(() => {
		const walker = document.createTreeWalker(
			document.querySelector("#app"),
			NodeFilter.SHOW_TEXT,
		);
		let node,
			total = 0,
			large = 0,
			smallest = Infinity;
		while ((node = walker.nextNode())) {
			if (
				!node.textContent.trim() ||
				node.parentElement.closest("title,script,style")
			)
				continue;
			const range = document.createRange();
			range.selectNode(node);
			const rect = range.getBoundingClientRect();
			if (
				!rect.width ||
				!rect.height ||
				rect.bottom < 0 ||
				rect.top > innerHeight ||
				rect.right < 0 ||
				rect.left > innerWidth
			)
				continue;
			let size = parseFloat(getComputedStyle(node.parentElement).fontSize);
			if (node.parentElement instanceof SVGElement) {
				const m = node.parentElement.getScreenCTM();
				size *= Math.hypot(m.a, m.b);
			}
			total++;
			if (size >= 13.99) large++;
			smallest = Math.min(smallest, size);
		}
		return { total, large, smallest };
	});
	assert.ok(
		typography.smallest >= 12 && typography.large / typography.total >= 0.6,
		JSON.stringify(typography),
	);
	assert.equal(
		browser.responses.find(
			(response) => response.url === `${fixture.origin}/?run=${running}`,
		).headers["Content-Security-Policy"],
		CSP,
	);

	await browser.click('[data-task="reviewers.webhook-retry-path"]');
	await browser.waitFor(() =>
		document.querySelector("#log-text")?.textContent.includes("<script>"),
	);
	assert.match(
		await text("#task-status"),
		/Waiting to retry · attempt 2 of 4 · next in \d+:\d{2}/,
	);
	const before = await text("#task-status");
	await browser.waitFor(
		`document.querySelector('#task-status')?.textContent !== ${JSON.stringify(before)}`,
	);
	assert.notEqual(
		await text("#task-status"),
		before,
		"countdown advances without rerendering the inspector",
	);
	assert.ok((await text("#log-text")).includes(injection));
	assert.equal(
		await browser.evaluate(() => globalThis.dashboardInjected),
		undefined,
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll("#log-text script").length,
		),
		0,
	);
	assert.equal(
		await browser.evaluate(() => document.querySelector(".task-details").open),
		false,
	);
	await browser.click(".task-details summary");
	assert.match(await text(".task-details"), /Not collected/);
	assert.equal(
		await browser.evaluate(() =>
			new URLSearchParams(location.search).get("task"),
		),
		"reviewers.webhook-retry-path",
	);
	await browser.click('[data-tab="output"]');
	await browser.click('[data-tab="events"]');
	assert.equal(
		await browser.evaluate(() =>
			new URLSearchParams(location.search).get("tab"),
		),
		"events",
	);
	await browser.key("Escape");
	assert.equal(
		await browser.evaluate(() => document.querySelector("#inspector").hidden),
		true,
	);

	await browser.click('[data-action="stop"]');
	assert.match(await text("#dialog"), /1 running and 9 waiting tasks/);
	assert.match(await text("#dialog"), /durable stop intent/);
	assert.match(await text("#dialog"), /supervisor to confirm/);
	await browser.click("#confirm-action");
	await browser.waitFor(() =>
		document
			.querySelector("#status-sentence")
			?.textContent.startsWith("Stopping."),
	);
	assert.match(await text("#notice"), /Stop requested/);
	assert.equal(fixture.mutations.at(-1).action, "stop");
	assert.equal(fixture.mutations.at(-1).csrf, "fixture-csrf");
	assert.equal(fixture.mutations.at(-1).origin, fixture.origin);
	assert.ok(
		fixture.requests.some(
			(request) =>
				request.path.endsWith("/tasks/task-11/logs") &&
				request.query === "?stream=all&lines=400",
		),
	);

	await open(`run=${approval}&dialog=approve`);
	await browser.waitFor(() => document.querySelector("#dialog")?.open);
	assert.match(
		await text("#status-sentence"),
		/Waiting for you\. The controller needs approval before it can add stages\./,
	);
	assert.match(await text("#dialog"), /Run dynamic workflow controller\?/);
	assert.match(await text("#dialog"), /maxAgents=40, maxConcurrency=4/);
	assert.match(await text("#dialog"), /Completed tasks are not relaunched/);
	await browser.evaluate(() =>
		[...document.querySelectorAll("#dialog button")]
			.find((el) => el.textContent === "Reject…")
			.click(),
	);
	assert.match(await text("#dialog"), /STAYS BLOCKED/);
	await browser.click("#confirm-action");
	await browser.waitFor(() =>
		document
			.querySelector("#status-sentence")
			?.textContent.includes("controller was rejected"),
	);
	assert.equal(fixture.mutations.at(-1).body.decision, "reject");
	assert.equal(fixture.runs.get(approval).status, "blocked");

	await open(`run=${failed}&dialog=resume`);
	await browser.waitFor(() => document.querySelector("#dialog")?.open);
	assert.match(
		await text("#status-sentence"),
		/Output didn't match the contract/,
	);
	assert.match(await text("#dialog"), /Completed tasks are not relaunched/);
	await browser.click("#confirm-action");
	await browser.waitFor(() =>
		document.querySelector("#notice")?.textContent.includes("Run resumed"),
	);
	assert.equal(fixture.mutations.at(-1).action, "resume");

	fixture.runs.set(approval, structuredClone(approvalSnapshot));
	await open(`run=${approval}&dialog=approve`);
	await browser.waitFor(
		() => document.querySelector("#confirm-action")?.textContent === "Approve",
	);
	await browser.click("#confirm-action");
	await browser.waitFor(
		() =>
			document.querySelector("#notice")?.textContent === "Approval recorded.",
	);
	assert.equal(fixture.mutations.at(-1).body.decision, "approve");
	assert.equal(
		fixture.mutations.at(-1).body.requestId,
		approvalSnapshot.pendingApprovals[0].requestId,
	);

	await open(`run=${complete}&view=report`);
	await browser.waitFor(() =>
		document
			.querySelector("#report-content")
			?.textContent.includes("Review report"),
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll(
					"#report-content a, #report-content img, #report-content script",
				).length,
		),
		0,
	);
	assert.ok((await text("#report-content")).includes(injection));
	await browser.key("Escape");
	await browser.click('[aria-label="Run details"]');
	assert.match(await text("#inspector"), /Launch command/);
	assert.match(await text("#inspector"), /Permission mode/);
	await browser.key("k", 4);
	await browser.waitFor(
		() => document.querySelector(".palette-input") !== null,
	);
	await browser.evaluate(() => {
		const input = document.querySelector(".palette-input");
		input.value = "triage";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await browser.key("Enter");
	assert.equal(
		await browser.evaluate(() =>
			new URLSearchParams(location.search).get("task"),
		),
		"triage.main",
	);

	// Exercise mappings not present in the exact fixture set without changing those files.
	const mapped = await browser.evaluate(async () => {
		const { statusSentence } = await import("./app.js");
		const task = {
			stageId: "reviewers",
			status: "pending",
			statusDetail: "retry_model_failure",
			retry: {
				attempt: 2,
				maxAttempts: 4,
				reason: "429 rate limit",
				nextRetryAt: "2026-10-29T08:16:40Z",
			},
		};
		const run = {
			status: "running",
			tasks: [task],
			taskSummary: { failed: 0 },
			needsYou: [],
		};
		const retry = statusSentence(run, Date.parse("2026-10-29T08:10:00Z"));
		task.statusDetail = "launchRetry";
		const launch = statusSentence(run, Date.parse("2026-10-29T08:10:00Z"));
		task.statusDetail = "executor_needs_decision";
		task.status = "blocked";
		const decision = statusSentence(run);
		delete task.retry;
		task.statusDetail = "private_unknown_engine_code";
		run.status = "blocked";
		return { retry, launch, decision, unknown: statusSentence(run) };
	});
	assert.match(mapped.retry, /rate-limit retry \(2 of 4, 6:40\)/);
	assert.equal(mapped.retry, mapped.launch);
	assert.match(mapped.decision, /you need to decide/);
	assert.doesNotMatch(mapped.unknown, /private_unknown_engine_code/);

	// A 240-item active foreach stays bounded in the graph; inspection is searchable.
	const scale = structuredClone(fixture.runs.get(running));
	scale.runId = "workflow_scale";
	scale.name = "scale";
	const base = scale.tasks.find(
		(task) => task.specId === "reviewers.ledger-double-write",
	);
	scale.tasks = scale.tasks.filter(
		(task) => task.stageId !== "reviewers" || task.placeholder,
	);
	for (let i = 0; i < 240; i++)
		scale.tasks.push({
			...base,
			taskId: `agent-${i}`,
			specId: `reviewers.agent-${String(i).padStart(3, "0")}`,
			status: i < 170 ? "completed" : i < 176 ? "running" : "pending",
		});
	fixture.runs.set(scale.runId, scale);
	await open(`run=${scale.runId}`);
	assert.match(
		await text('[data-stage="reviewers"]'),
		/240 agents · inspect items/,
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll('[data-stage="reviewers"] .agent-row').length,
		),
		0,
	);
	await browser.click('[data-stage="reviewers"]');
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll(".item-list button").length,
		),
		240,
	);
	assert.ok(
		await browser.evaluate(() =>
			document.querySelector(".item-list").classList.contains("item-grid"),
		),
	);
	await browser.click('[data-mode="table"]');
	assert.equal(
		await browser.evaluate(() =>
			document.querySelector(".item-list").classList.contains("item-grid"),
		),
		false,
	);
	await browser.click('[data-filter="running"]');
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll(".item-list button").length,
		),
		6,
	);
	await browser.click('[data-filter="all"]');
	await browser.evaluate(() => {
		const input = document.querySelector(".items-tools input");
		input.value = "agent-239";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll(".item-list button").length,
		),
		1,
	);

	fixture.setReadonly(true);
	await open(`run=${running}&dialog=stop`);
	await browser.waitFor(() => document.querySelector("#dialog")?.open);
	assert.equal(await text("#readonly-badge"), "Read-only");
	assert.equal(
		await browser.evaluate(
			() => document.querySelector("#confirm-action").disabled,
		),
		true,
	);
	assert.ok(
		await browser.evaluate(() =>
			[...document.querySelectorAll("[data-action]")].every(
				(button) => button.disabled,
			),
		),
	);
	const mutationCount = fixture.mutations.length;
	await browser.evaluate(() =>
		document.querySelector("#confirm-action").click(),
	);
	assert.equal(fixture.mutations.length, mutationCount);
	await browser.key("Escape");
	fixture.disconnectEvents();
	await browser.waitFor(
		() => document.querySelector("#connection")?.textContent === "Reconnecting",
	);
	await browser.waitFor(() =>
		document.querySelector("#connection")?.textContent.includes("Live"),
	);
	fixture.pauseHeartbeats(true);
	await browser.evaluate(() => {
		globalThis.realDashboardClock = Date.now;
		Date.now = () => globalThis.realDashboardClock() + 31000;
	});
	await browser.waitFor(() =>
		document
			.querySelector("#connection")
			?.textContent.startsWith("Stale (updated"),
	);
	await browser.evaluate(() => {
		Date.now = globalThis.realDashboardClock;
		delete globalThis.realDashboardClock;
	});
	fixture.pauseHeartbeats(false);
	await browser.waitFor(() =>
		document.querySelector("#connection")?.textContent.includes("Live"),
	);

	for (const width of [1024, 1280, 1440, 1600]) {
		await browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		assert.ok(
			await browser.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`no page overflow at ${width}`,
		);
	}
	assert.deepEqual(browser.errors, [], "no runtime, console or CSP errors");
	assert.ok(
		browser.requests.every((url) => new URL(url).origin === fixture.origin),
		"all page requests remain same-origin",
	);
});
