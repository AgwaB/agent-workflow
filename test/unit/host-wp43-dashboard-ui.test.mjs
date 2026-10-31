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
	// Edges read as a path: into the running stage (active, animated), to the stage that comes
	// next (dashed accent, and that node is outlined as next), then later; every edge has an
	// arrowhead marker of its own state.
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".edge")].map(
				(edge) =>
					`${edge.dataset.edge}:${edge.classList[1]}:${edge.getAttribute("marker-end")}`,
			),
		),
		[
			"triage>reviewers:active:url(#arrow-active)",
			"reviewers>dedup-findings:next:url(#arrow-next)",
			"dedup-findings>devil-advocate:later:url(#arrow-later)",
			"devil-advocate>partition-verdicts:later:url(#arrow-later)",
			"partition-verdicts>report-packet:later:url(#arrow-later)",
			"report-packet>report:later:url(#arrow-later)",
			"report>final:later:url(#arrow-later)",
		],
	);
	assert.deepEqual(
		await browser.evaluate(() => ({
			next: [...document.querySelectorAll(".node.next")].map(
				(node) => node.dataset.stage,
			),
			markers: document.querySelectorAll(".graph defs marker").length,
			flowing: getComputedStyle(document.querySelector(".edge.active"))
				.animationName,
			still: getComputedStyle(document.querySelector(".edge.later"))
				.animationName,
			ports: document.querySelectorAll(".port").length,
		})),
		{
			next: ["dedup-findings"],
			markers: 6,
			flowing: "none",
			still: "none",
			ports: 7,
		},
	);
	// Panning is clamped: however far the wheel scrolls, the graph stays inside the canvas and
	// the markers keep their on-screen size.
	const panned = await browser.evaluate(() => {
		const canvas = document.getElementById("canvas");
		const wheel = (deltaX, deltaY) =>
			canvas.dispatchEvent(
				new WheelEvent("wheel", {
					deltaX,
					deltaY,
					bubbles: true,
					cancelable: true,
				}),
			);
		const place = () => {
			const c = canvas.getBoundingClientRect();
			const g = document
				.querySelector(".graph > g:last-of-type")
				.getBoundingClientRect();
			return {
				inside:
					g.top >= c.top &&
					g.bottom <= c.bottom &&
					g.left >= c.left &&
					g.right <= c.right,
				visibleNodes: [...document.querySelectorAll(".node")].filter((n) => {
					const r = n.getBoundingClientRect();
					return r.bottom > c.top && r.top < c.bottom;
				}).length,
			};
		};
		const before = place();
		for (let i = 0; i < 60; i++) wheel(0, 500);
		const down = place();
		for (let i = 0; i < 120; i++) wheel(0, -500);
		const up = place();
		for (let i = 0; i < 60; i++) wheel(500, 0);
		const right = place();
		const marker = document.querySelector(".graph defs marker");
		const k = document
			.querySelector(".graph > g:last-of-type")
			.getScreenCTM().a;
		return {
			before,
			down,
			up,
			right,
			markerPx: Number(marker.getAttribute("markerWidth")) * k,
			fitZoom: k,
		};
	});
	for (const [label, place] of Object.entries(panned))
		if (typeof place === "object")
			assert.ok(
				place.inside && place.visibleNodes === 8,
				`${label}: ${JSON.stringify(place)}`,
			);
	assert.ok(Math.abs(panned.markerPx - 13) < 0.01, JSON.stringify(panned));
	assert.ok(panned.fitZoom >= 0.699, JSON.stringify(panned));
	await browser.evaluate(() =>
		document.querySelector(".toolbar button").click(),
	);
	// Edges are orthogonal rails (no bezier), every one starts with a port dot; hovering a card
	// lights its own edges and neighbours and dims the rest.
	assert.deepEqual(
		await browser.evaluate(() => {
			const bezier = [...document.querySelectorAll(".edge")].some((edge) =>
				/C/.test(edge.getAttribute("d")),
			);
			const node = document.querySelector('[data-stage="reviewers"]');
			node.dispatchEvent(new MouseEvent("mouseenter"));
			const lit = {
				tracing: document.querySelector(".graph").classList.contains("tracing"),
				links: [...document.querySelectorAll(".link.lit")].map(
					(link) => link.dataset.link,
				),
				nodes: [...document.querySelectorAll(".node.lit")].map(
					(n) => n.dataset.stage,
				),
				finalLit: document
					.querySelector('[data-stage="final"]')
					.classList.contains("lit"),
			};
			node.dispatchEvent(new MouseEvent("mouseleave"));
			return {
				bezier,
				...lit,
				after: document.querySelector(".graph").classList.contains("tracing"),
			};
		}),
		{
			bezier: false,
			tracing: true,
			links: ["triage>reviewers", "reviewers>dedup-findings"],
			nodes: ["triage", "reviewers", "dedup-findings"],
			finalLit: false,
			after: false,
		},
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
	// Stages that share inputs and outputs (here: four stages with none) stack into one card with
	// a row per stage; the card takes the worst status, the rows keep their own.
	assert.deepEqual(
		await browser.evaluate(() => {
			const card = document.querySelector(".node.group");
			return {
				cards: document.querySelectorAll(".node").length,
				status: card?.classList[1],
				title: card?.querySelector(".node-name")?.textContent,
				rows: [...card.querySelectorAll(".stage-row")].map(
					(row) =>
						`${row.dataset.stage}:${row.querySelector(".status-icon").classList[1]}`,
				),
				edges: document.querySelectorAll(".edge").length,
			};
		}),
		{
			cards: 1,
			status: "failed",
			title: "4 in parallel",
			rows: [
				"extract-requirements:completed",
				"map-implementation:failed",
				"verify-gaps:skipped",
				"report:skipped",
			],
			edges: 0,
		},
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
	// Finished paths stay visible and static: no perpetual decorative glints or packets.
	assert.deepEqual(
		await browser.evaluate(() => ({
			done: document.querySelectorAll(".edge.done").length > 0,
			packets: document.querySelectorAll(".handoff-packet,.pulse").length,
		})),
		{ done: true, packets: 0 },
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

	// A run update that changes nothing structural keeps the drawn graph (so the flow animation
	// keeps its phase and hover survives); a status change redraws it.
	await open(`run=${running}`);
	await browser.waitFor(() => document.querySelector(".edge.active"));
	// First drawing of a run replays the journey: every card and link gets a scripted fade
	// (layer by layer) on top of the stylesheet's flow animations.
	assert.ok(
		(await browser.evaluate(
			() =>
				document
					.getAnimations()
					.filter(
						(a) =>
							!(a instanceof CSSAnimation) && a.effect.target.closest(".graph"),
					).length,
		)) >= 15,
	);
	await browser.evaluate(() => {
		document.getElementById("canvas").dataset.mark = "kept";
		document.getElementById("run-header").dataset.mark = "old";
	});
	const live = fixture.runs.get(running);
	live.updatedAt = new Date(Date.parse(live.updatedAt) + 1000).toISOString();
	fixture.publish();
	await browser.waitFor(
		() => document.getElementById("run-header").dataset.mark !== "old",
	);
	assert.equal(
		await browser.evaluate(
			() => document.getElementById("canvas").dataset.mark,
		),
		"kept",
	);
	live.tasks.find((task) => task.specId === "triage.main").status = "failed";
	live.updatedAt = new Date(Date.parse(live.updatedAt) + 1000).toISOString();
	fixture.publish();
	await browser.waitFor(() =>
		document
			.querySelector('[data-stage="triage"]')
			?.classList.contains("failed"),
	);
	assert.equal(
		await browser.evaluate(
			() => document.getElementById("canvas").dataset.mark,
		),
		undefined,
	);
	live.tasks.find((task) => task.specId === "triage.main").status = "completed";

	// A fan-out/join (scope → {api, data} → synthesis, all under one dotted prefix): the two
	// siblings stack into one card, neighbours' edges point at the card, the shared prefix leaves
	// the card text, and a stage inside the card can be selected and traced.
	const fan = structuredClone(fixture.runs.get(running));
	fan.runId = "workflow_fan";
	fan.name = "fan";
	const template = fan.tasks.find((task) => task.specId === "triage.main");
	const single = (name, dependsOn, status = "completed") => ({
		...template,
		taskId: `task-${name}`,
		specId: `impact.${name}.main`,
		stageId: `impact.${name}`,
		status,
		statusDetail: status,
		dependsOn: dependsOn.map((dep) => `impact.${dep}.main`),
	});
	fan.tasks = [
		single("scope", []),
		single("api", ["scope"]),
		single("data", ["scope"], "running"),
		single("synthesis", ["api", "data"], "pending"),
	];
	fixture.runs.set(fan.runId, fan);
	await open(`run=${fan.runId}`);
	await browser.waitFor(() => document.querySelector(".node.group"));
	assert.deepEqual(
		await browser.evaluate(() => ({
			cards: [...document.querySelectorAll(".node")].map(
				(node) =>
					`${node.dataset.stage}:${node.classList[1]}:${node.querySelector(".node-name").textContent}`,
			),
			rows: [...document.querySelectorAll(".stage-row .agent-name")].map(
				(row) => row.textContent,
			),
			edges: [...document.querySelectorAll(".edge")].map(
				(edge) => `${edge.dataset.edge}:${edge.classList[1]}`,
			),
			next: [...document.querySelectorAll(".node.next")].map(
				(node) => node.dataset.stage,
			),
		})),
		{
			cards: [
				"impact.scope:completed:Scope",
				"__group_0:running:2 in parallel",
				"impact.synthesis:pending:Synthesis",
			],
			rows: ["Api", "Data"],
			edges: [
				"impact.scope>__group_0:active",
				"__group_0>impact.synthesis:next",
			],
			next: ["impact.synthesis"],
		},
	);
	await browser.click('.stage-row[data-stage="impact.data"]');
	await browser.waitFor(() => !document.querySelector("#inspector").hidden);
	assert.deepEqual(
		await browser.evaluate(() => ({
			card: document
				.querySelector('[data-stage="__group_0"]')
				.classList.contains("selected"),
			row: document
				.querySelector('.stage-row[data-stage="impact.data"]')
				.classList.contains("selected"),
			other: document
				.querySelector('.stage-row[data-stage="impact.api"]')
				.classList.contains("selected"),
			inspector: document.querySelector("#inspector h2")?.textContent,
		})),
		{ card: true, row: true, other: false, inspector: "impact.data.main" },
	);

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
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll("[data-mode]").length,
		),
		0,
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll("[data-group]")].map(
				(el) => el.dataset.group,
			),
		),
		["running", "waiting", "done"],
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
