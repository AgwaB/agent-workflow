// test-tier: integration
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
	createBrowser,
	findChrome,
	MOTION_SKIP,
	motionChecks,
} from "../helpers/dashboard-browser.mjs";
import { scanMarks } from "../helpers/dashboard-marks.mjs";
import {
	CSP,
	createFixtureServer,
	injection,
} from "../helpers/dashboard-ui-fixture-server.mjs";

const running = "workflow_mvt9k2qa_7c41e0";
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
	// 2026-11-03 (owner's pick of the mock-ups): code steps are hidden by default; agent stages
	// connect straight across them, and the switch says how many are hidden.
	assert.deepEqual(
		await browser.evaluate(() => ({
			cards: [...document.querySelectorAll(".node")].map(
				(node) => node.dataset.stage,
			),
			edges: [...document.querySelectorAll(".edge")].map(
				(edge) => `${edge.dataset.edge}:${edge.classList[1]}`,
			),
			next: [...document.querySelectorAll(".node.next")].map(
				(node) => node.dataset.stage,
			),
			switch: [
				document.querySelector(".code-switch").textContent,
				document.querySelector(".code-switch").getAttribute("aria-checked"),
			],
		})),
		{
			cards: ["triage", "reviewers", "devil-advocate", "report"],
			edges: [
				"triage>reviewers:active",
				"reviewers>devil-advocate:next",
				"devil-advocate>report:later",
			],
			next: ["devil-advocate"],
			switch: ["4 code steps hiddenShow", "false"],
		},
	);
	await browser.evaluate(() => document.querySelector(".code-switch").click());
	await browser.waitFor(() => document.querySelectorAll(".node").length === 8);
	// The cards slide apart and the view glides to the new fit (Web Animations, not CSS transitions):
	// wait until every finite animation has run out — a fixed sleep raced it under a loaded suite.
	await browser.waitFor(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						resolve(
							document
								.getAnimations()
								.every(
									(animation) =>
										animation.playState !== "running" ||
										animation.effect?.getTiming().iterations === Infinity,
								),
						),
					),
				),
			),
	);
	assert.deepEqual(
		await browser.evaluate(() => [
			document.querySelector(".code-switch").textContent,
			document.querySelector(".code-switch").getAttribute("aria-checked"),
			document.activeElement?.className,
			localStorage.getItem("agent-workflow:code-steps"),
		]),
		["4 code steps shownHide", "true", "code-switch", "shown"],
	);
	// The rest of this test reads the full graph; the switch stays on across reloads.
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
			smallest = Math.min(smallest, size);
			// The 60% share counts the main view; the runs rail is a compact list by choice
			// (owner, 2026-11-11). The 12 px floor still holds everywhere.
			if (node.parentElement.closest(".rail")) continue;
			total++;
			if (size >= 13.99) large++;
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
		/Waiting to retry, attempt 2 of 4, next in \d+:\d{2}/,
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

	await open(`run=${complete}`);
	// Finished paths stay visible and static: no perpetual decorative glints or packets.
	assert.deepEqual(
		await browser.evaluate(() => ({
			done: document.querySelectorAll(".edge.done").length > 0,
			packets: document.querySelectorAll(".handoff-packet,.pulse").length,
		})),
		{ done: true, packets: 0 },
	);
	// 2026-11-12 (owner): "Open report" leads to the report page (its own URL), not a modal.
	await browser.evaluate(() =>
		[...document.querySelectorAll("#run-header button")]
			.find((button) => button.textContent === "Open report")
			.click(),
	);
	await browser.waitFor(() => document.querySelector("#report-content"));
	assert.deepEqual(
		[...(await route(browser)), await text("dialog[open]")],
		[complete, "report", undefined],
	);
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
	// 2026-11-03: heading levels follow Markdown; a link shows its text and its address as plain
	// text, an image only its alt text.
	assert.equal(
		await browser.evaluate(
			() => document.querySelector("#report-content .md-h1")?.textContent,
		),
		"Review report",
	);
	assert.match(
		await text("#report-content"),
		/not a link \(https:\/\/example\.invalid\)/,
	);
	assert.match(await text("#report-content"), /\[image: not an image\]/);
	// Entities written by report renderers read as characters (still text, not markup).
	assert.match(await text("#report-content"), /Run cd sample && npm test <ok>/);
	// A bold verdict code reads in sentence case (the code is the title); other capitals stay.
	assert.match(
		await text("#report-content"),
		/Verdict: Needs work; API stays\./,
	);
	// 2026-11-03: fenced code shows verbatim (no Markdown inside, whitespace kept) and is coloured
	// by the vendored Shiki (text spans carrying --shiki-light/--shiki-dark, never markup); a row
	// written as one flat JSON object reads as its main text and fields.
	await browser.waitFor(() =>
		document.querySelector("#report-content pre.md-code[data-coloured]"),
	);
	assert.deepEqual(
		await browser.evaluate(() => {
			const pre = document.querySelector("#report-content pre.md-code");
			const keyword = [...pre.querySelectorAll("span")].find(
				(span) => span.textContent === "if",
			);
			return {
				code: [pre.dataset.lang, pre.textContent],
				markup: pre.querySelectorAll("code *:not(span)").length,
				keyword: [
					/\bshl-[0-9a-f]{6}\b/.test(keyword?.className),
					/\bshd-[0-9a-f]{6}\b/.test(keyword?.className),
					getComputedStyle(keyword).color !== getComputedStyle(pre).color,
				],
				json: [...document.querySelectorAll("#report-content li")].find(
					(node) => node.textContent.startsWith("Ship it"),
				)?.textContent,
			};
		}),
		{
			code: ["ts", '\tif (a **b**) return "ok"; // 2\n  <x>'],
			markup: 0,
			keyword: [true, true, true],
			json: "Ship it, owner: release; blocking: true",
		},
	);
	// The outline lists the report's own sections (##), the first one current; a sub-section
	// (###) that is not a finding is left out (2026-11-12, review P2-6).
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".report-outline .outline-link")].map(
				(link) => [link.textContent, link.className],
			),
		),
		[["Main findings", "outline-link level-0 current"]],
	);
	// 2026-11-03 reading aids (owner's design rules: no filled cards, no tinted chips, status as
	// glyph + word): a finding is a section with a hanging number, field labels are quiet, evidence
	// words read as glyph + plain word (escaped or in a table too; the raw word is the title),
	// same-label lines are grouped under that label with a count, quotes read as quotes, a link
	// named by its host shows host + path, and a numbered list keeps counting across nested bullets.
	assert.deepEqual(
		await browser.evaluate(() => {
			const all = (selector) =>
				[...document.querySelectorAll(`#report-content ${selector}`)].map(
					(node) => node.textContent,
				);
			return {
				card: all(".md-block > .md-h3"),
				index: all(".md-block .md-index"),
				labels: all(".md-label").slice(0, 2),
				badges: all(".md-status"),
				raw: [...document.querySelectorAll("#report-content .md-status")].map(
					(node) => `${node.title}:${node.dataset.tone}`,
				),
				groups: all(".md-group"),
				grouped: all(".md-grouped > li"),
				address: all(".md-url").slice(-1),
				quotes: all(".md-quote"),
				numbered: all(".md-block > ol > li").length,
				nested: all("ol > li > ul .md-status"),
			};
		}),
		{
			card: ["1Retries are bounded"],
			index: ["1"],
			labels: ["Evidence status:", "Sources:"],
			badges: ["Verified", "Partly supported", "Proposal"],
			raw: ["verified:done", "partially_supported:warn", "derived:neutral"],
			groups: ["Gap 1"],
			grouped: ["no load test"],
			address: ["/a"],
			quotes: ['"Retries stop after four attempts."'],
			numbered: 2,
			nested: ["Proposal"],
		},
	);
	// The page colour is chosen in the report and kept in this browser.
	const page = () =>
		browser.evaluate(() => [
			document.querySelector("#report-view").dataset.page ?? null,
			document.querySelector(".report-page")?.textContent,
		]);
	const [initialPage] = await page();
	await browser.evaluate(() => document.querySelector(".report-page").click());
	const chosen = (await page())[0];
	assert.notEqual(chosen, initialPage);
	assert.deepEqual(await page(), [
		chosen,
		chosen === "light" ? "Dark page" : "Light page",
	]);
	await open(`run=${complete}&view=report`);
	await browser.waitFor(() =>
		document
			.querySelector("#report-content")
			?.textContent.includes("Review report"),
	);
	assert.equal((await page())[0], chosen);
	await browser.evaluate(() =>
		localStorage.removeItem("agent-workflow:report-page"),
	);

	// 2026-11-03: a finished task opens on its Result: digest, analysis as text-only Markdown,
	// references as text (no links), the control JSON folded away.
	await open(`run=${complete}&task=triage.main`);
	await browser.waitFor(
		() =>
			document.querySelector("#result-view .result-digest")?.textContent
				.length > 0,
	);
	assert.equal(
		await browser.evaluate(() =>
			document
				.querySelector('[data-tab="result"]')
				.getAttribute("aria-selected"),
		),
		"true",
	);
	assert.equal(
		await browser.evaluate(() => document.querySelector("#log-text").hidden),
		true,
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector("#result-view .result-analysis strong")
					?.textContent,
		),
		"Bold",
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll(
					"#result-view a, #result-view img, #result-view script",
				).length,
		),
		0,
	);
	assert.ok((await text("#result-view")).includes(injection));
	assert.match(
		await text("#result-view .result-refs"),
		/https:\/\/example\.invalid\/source/,
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".result-control").open,
		),
		false,
	);
	assert.equal(
		await browser.evaluate(() => globalThis.dashboardInjected),
		undefined,
	);
	await browser.click('[aria-label="Run details"]');
	assert.match(await text("#inspector"), /Launch command/);
	assert.match(await text("#inspector"), /Permission mode/);
	fixture.runs.get(running).taskPreview = "Check the payout ledger";
	fixture.publish();
	await browser.waitFor(() =>
		[...document.querySelectorAll(".run-task")].some((node) =>
			node.textContent.includes("payout ledger"),
		),
	);
	await browser.key("k", 4);
	await browser.waitFor(
		() => document.querySelector(".palette-input") !== null,
	);
	// 2026-11-12: a run row names its workflow and task, with its state and age; tasks are searchable.
	const firstRun = await browser.evaluate(() => {
		const row = document.querySelector(".palette-list [role=option]");
		return {
			label: row.querySelector(".palette-label")?.textContent,
			detail: row.querySelector(".palette-detail")?.textContent,
			meta: row.querySelector(".palette-meta")?.textContent,
			heading: document.querySelector(".palette-group")?.textContent,
		};
	});
	assert.equal(firstRun.heading, "Runs");
	assert.ok(
		firstRun.label && firstRun.detail && firstRun.detail !== firstRun.label,
	);
	assert.match(firstRun.meta, /, (?:just now|\d+[mhd] ago)$/);
	await browser.evaluate(() => {
		const input = document.querySelector(".palette-input");
		input.value = "payout";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	assert.match(
		await browser.evaluate(
			() =>
				document.querySelector(".palette-list [role=option] .palette-detail")
					?.textContent ?? "",
		),
		/payout ledger/,
		"a run is found by its task",
	);
	await browser.evaluate(() => {
		const input = document.querySelector(".palette-input");
		input.value = "triage";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await browser.key("Enter");
	// 2026-11-03: a one-agent stage opens its readable stage view (the raw agent is one click on).
	assert.deepEqual(
		await browser.evaluate(() => {
			const params = new URLSearchParams(location.search);
			return [params.get("stage"), params.get("task")];
		}),
		["triage", null],
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
		// A run that says running but has no live driver is not "under way" (30 s launch grace).
		// (The page clock follows the fixture server's time, so pass the time explicitly.)
		const at = Date.now();
		const old = new Date(at - 600_000).toISOString();
		const stalledRun = (extra) => ({
			status: "running",
			tasks: [{ stageId: "reviewers", status: "pending" }],
			taskSummary: { failed: 0 },
			needsYou: [],
			createdAt: old,
			...extra,
		});
		const stalled = {
			dead: statusSentence(stalledRun({ live: false }), at),
			driven: statusSentence(stalledRun({ live: true }), at),
			unknown: statusSentence(stalledRun({}), at),
			fresh: statusSentence(
				stalledRun({ live: false, createdAt: new Date(at).toISOString() }),
				at,
			),
			stopped: statusSentence(
				stalledRun({ live: false, status: "interrupted" }),
				at,
			),
			// The engine interrupted it itself (its driver ended): not "Stopped by you".
			lost: statusSentence(
				stalledRun({
					live: false,
					status: "interrupted",
					statusDetail: "driver_lost",
				}),
				at,
			),
			lostByTask: statusSentence(
				stalledRun({
					status: "interrupted",
					tasks: [
						{
							stageId: "a",
							status: "interrupted",
							statusDetail: "driver_lost",
						},
					],
				}),
				at,
			),
		};
		return { retry, launch, decision, unknown: statusSentence(run), stalled };
	});
	assert.match(
		mapped.stalled.dead,
		/^Stalled\. No process is driving this run/,
	);
	assert.doesNotMatch(mapped.stalled.dead, /under way/);
	for (const key of ["driven", "unknown", "fresh"])
		assert.match(mapped.stalled[key], /^Work is under way\./, key);
	assert.match(mapped.stalled.stopped, /^Stopped by you/);
	for (const key of ["lost", "lostByTask"])
		assert.equal(
			mapped.stalled[key],
			"Stopped: the process running it ended (its host was closed). Completed work is kept. Resume to continue.",
			key,
		);
	assert.match(mapped.retry, /rate-limit retry \(2 of 4, 6:40\)/);
	assert.equal(mapped.retry, mapped.launch);
	assert.match(mapped.decision, /you need to decide/);
	assert.doesNotMatch(mapped.unknown, /private_unknown_engine_code/);

	// A run update that changes nothing structural keeps the drawn graph (so the flow animation
	// keeps its phase and hover survives); a status change redraws it.
	// First drawing of a run replays the journey: every card and link gets a scripted fade
	// (layer by layer) on top of the stylesheet's flow animations. 2026-11-05 (CI: on a slower
	// machine the replay, about 1 s, had finished and left getAnimations() before the check ran):
	// count the scripted animations as they start instead; an animation timing check, so only
	// with AGENT_WORKFLOW_UI_MOTION=1.
	const replayHook = motionChecks
		? (
				await browser.send("Page.addScriptToEvaluateOnNewDocument", {
					source: `(() => {
				const animate = Element.prototype.animate;
				window.__awAnimated = [];
				Element.prototype.animate = function (...args) {
					window.__awAnimated.push(this);
					return animate.apply(this, args);
				};
			})();`,
				})
			).identifier
		: undefined;
	await open(`run=${running}`);
	await browser.waitFor(() => document.querySelector(".edge.active"));
	if (replayHook !== undefined) {
		assert.ok(
			(await browser.evaluate(
				() =>
					window.__awAnimated.filter((target) => target.closest(".graph"))
						.length,
			)) >= 15,
		);
		await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
			identifier: replayHook,
		});
	}
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
		{ card: true, row: true, other: false, inspector: "Data" },
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
		/240 agents, inspect items/,
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

test("dashboard Chrome: a stage selected while the run works is cleared when it finishes; a task stays", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner report): a finished run kept "Verify claims" selected, hiding the result.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const param = (key) =>
		browser.evaluate(
			(key) => new URLSearchParams(location.search).get(key),
			key,
		);
	const finish = (run, status) => {
		run.status = status;
		run.updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
		fixture.publish();
	};
	await browser.open(`${fixture.origin}/?run=${running}&stage=reviewers`);
	await browser.waitFor(() =>
		document.querySelector("#connection")?.textContent.includes("Live"),
	);
	assert.equal(await param("stage"), "reviewers");
	const live = fixture.runs.get(running);
	finish(live, "completed");
	await browser.waitFor(
		() => new URLSearchParams(location.search).get("stage") === null,
	);
	assert.equal(
		await browser.evaluate(() => document.querySelector("#inspector").hidden),
		true,
	);
	// A task the user opened is their reading, not a stale focus: it stays.
	finish(live, "running");
	await browser.open(
		`${fixture.origin}/?run=${running}&task=reviewers.webhook-retry-path`,
	);
	await browser.waitFor(() =>
		document.querySelector("#connection")?.textContent.includes("Live"),
	);
	finish(live, "completed");
	await browser.waitFor(
		() => document.getElementById("run-header")?.textContent.length > 0,
	);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(await param("task"), "reviewers.webhook-retry-path");
});

test("dashboard Chrome: an agent of a many-agent stage steps to its neighbours and back to the list", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner): open an agent, Back, open the next, Back… was tedious.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/?run=${running}&stage=reviewers`);
	await browser.waitFor(
		() => document.querySelectorAll(".agent-item").length === 3,
	);
	const listed = await browser.evaluate(() =>
		[...document.querySelectorAll(".agent-item")].map(
			(row) => row.dataset.item,
		),
	);
	// A row opens in place; "Open agent ›" leads to the full view.
	await browser.evaluate(() => document.querySelector(".agent-item").click());
	await browser.waitFor(() =>
		document.querySelector(".item-expand .item-open"),
	);
	await browser.evaluate(() =>
		document.querySelector(".item-expand .item-open").click(),
	);
	await browser.waitFor(
		() => document.querySelector(".item-pos")?.textContent === "1 / 3",
	);
	const where = () =>
		browser.evaluate(() => ({
			task: new URLSearchParams(location.search).get("task"),
			stage: new URLSearchParams(location.search).get("stage"),
			pos: document.querySelector(".item-pos")?.textContent ?? null,
			history: history.length,
		}));
	const start = await where();
	assert.deepEqual(
		{ task: start.task, pos: start.pos },
		{ task: listed[0], pos: "1 / 3" },
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector('[data-nav="previous"]').disabled,
		),
		true,
	);
	// j / › move on in the list's order and replace the history entry.
	await browser.key("j");
	await browser.waitFor(
		() => document.querySelector(".item-pos")?.textContent === "2 / 3",
	);
	await browser.evaluate(() =>
		document.querySelector('[data-nav="next"]').click(),
	);
	await browser.waitFor(
		() => document.querySelector(".item-pos")?.textContent === "3 / 3",
	);
	const last = await where();
	assert.deepEqual(
		{ task: last.task, history: last.history },
		{ task: listed[2], history: start.history },
	);
	await browser.key("k");
	await browser.waitFor(
		() => document.querySelector(".item-pos")?.textContent === "2 / 3",
	);
	assert.equal((await where()).task, listed[1]);
	// The stage link goes back to the list.
	await browser.evaluate(() =>
		document.querySelector('[data-nav="list"]').click(),
	);
	await browser.waitFor(
		() => document.querySelectorAll(".agent-item").length === 3,
	);
	assert.deepEqual(
		{ ...(await where()), history: undefined },
		{ task: null, stage: "reviewers", pos: null, history: undefined },
	);
});

test("dashboard Chrome: a stage's agent opens in place, stays open through live updates, and closes again", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner's pick of three, compared on real runs): expand in place instead of
	// open → Back → open.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/?run=${running}&stage=reviewers`);
	await browser.waitFor(
		() => document.querySelectorAll(".agent-item").length === 3,
	);
	const row = (id) => `.agent-item[data-item="reviewers.${id}"]`;
	await browser.evaluate(
		(selector) => document.querySelector(selector).click(),
		row("refund-idempotency"),
	);
	await browser.waitFor(() =>
		document.querySelector(".item-expand .result-digest"),
	);
	const opened = await browser.evaluate((selector) => {
		const button = document.querySelector(selector);
		const region = document.getElementById(
			button.getAttribute("aria-controls"),
		);
		return {
			expanded: button.getAttribute("aria-expanded"),
			follows: button.nextElementSibling === region,
			digest: region.querySelector(".result-digest")?.textContent,
			analysis: region.querySelector(".result-analysis .md-h2")?.textContent,
			links: region.querySelectorAll("a, script").length,
			focus: document.activeElement === button,
			url: new URLSearchParams(location.search).get("task"),
		};
	}, row("refund-idempotency"));
	assert.deepEqual(opened, {
		expanded: "true",
		follows: true,
		digest: `Result digest ${injection}`,
		analysis: "Findings",
		links: 0,
		focus: true,
		url: null,
	});
	// A running agent opens to its state, without a result request.
	const before = fixture.requests.filter((r) =>
		r.path.endsWith("/result"),
	).length;
	await browser.evaluate(
		(selector) => document.querySelector(selector).click(),
		row("ledger-double-write"),
	);
	await browser.waitFor(
		() => document.querySelectorAll(".item-expand").length === 2,
	);
	assert.match(
		await browser.evaluate(
			(selector) =>
				document.querySelector(selector).nextElementSibling.textContent,
			row("ledger-double-write"),
		),
		/no result yet\.Open agent ›$/,
	);
	assert.equal(
		fixture.requests.filter((r) => r.path.endsWith("/result")).length,
		before,
	);
	// A live update repaints the list; open rows stay open.
	const live = fixture.runs.get(running);
	live.updatedAt = new Date(Date.parse(live.updatedAt) + 1000).toISOString();
	fixture.publish();
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll(".item-expand").length,
		),
		2,
	);
	// A second click closes it (the result folds away first, 160 ms).
	await browser.evaluate(
		(selector) => document.querySelector(selector).click(),
		row("refund-idempotency"),
	);
	await browser.waitForMotionEnd();
	assert.deepEqual(
		await browser.evaluate(
			(selector) => [
				document.querySelector(selector).getAttribute("aria-expanded"),
				document.querySelectorAll(".item-expand").length,
			],
			row("refund-idempotency"),
		),
		["false", 1],
	);
});

test("dashboard Chrome: code steps hide by default; one that failed or is selected stays; cards say who did the work", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner's pick of the graph mock-ups): code steps leave the graph unless the switch
	// shows them, but a failed one stays in place; a card says who did the work at its right —
	// "✦ agent" / "✦ N agents" / "</> code" — and a lone "agent" goes when no code card is in view.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const dedup = fixture.runs
		.get(running)
		.tasks.find((task) => task.stageId === "dedup-findings");
	Object.assign(dedup, {
		status: "failed",
		lastMessage: "verifier ids did not match",
	});
	const cards = () =>
		browser.evaluate(() =>
			Object.fromEntries(
				[...document.querySelectorAll(".node[data-stage]")].map((node) => [
					node.dataset.stage,
					[
						node.querySelector(".node-kind text")?.textContent ?? null,
						node.querySelector(".node-kind .kind-icon")?.classList[1] ?? null,
						node.querySelector(":scope > .sub")?.textContent ?? null,
					],
				]),
			),
		);
	await browser.open(`${fixture.origin}/?run=${running}`);
	await browser.waitFor(() => document.querySelector(".code-switch"));
	const failed = await cards();
	assert.deepEqual(Object.keys(failed), [
		"triage",
		"reviewers",
		"dedup-findings",
		"devil-advocate",
		"report",
	]);
	assert.deepEqual(failed["dedup-findings"], [
		"code",
		"code",
		"Failed: verifier ids did not match",
	]);
	assert.deepEqual(failed.triage.slice(0, 2), ["agent", "agent"]);
	assert.match(failed.reviewers[0], /^\d+ agents$/);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".code-switch").textContent,
		),
		"3 code steps hiddenShow",
	);
	// The mark sits at the card's right, clear of the name and inside the card.
	assert.deepEqual(
		await browser.evaluate(() => {
			const node = document.querySelector('.node[data-stage="triage"]');
			const box = (selector) =>
				node.querySelector(selector).getBoundingClientRect();
			const card = box(".outline"),
				name = box(".node-name"),
				icon = box(".node-kind .kind-icon"),
				label = box(".node-kind text");
			return [icon.left > name.right, label.right <= card.right - 8];
		}),
		[true, true],
	);
	// With no code card in view every card is an agent's: a lone "agent" goes, counts stay.
	dedup.status = "pending";
	await browser.open(`${fixture.origin}/?run=${running}`);
	await browser.waitFor(() => document.querySelectorAll(".node").length === 4);
	const quiet = await cards();
	assert.deepEqual(quiet.triage.slice(0, 2), [null, null]);
	assert.match(quiet.reviewers[0], /^\d+ agents$/);
	// A hidden stage opened from Jump or a link appears in place while it is selected.
	await browser.open(`${fixture.origin}/?run=${running}&stage=final`);
	await browser.waitFor(() =>
		document.querySelector('.node[data-stage="final"]'),
	);
	assert.deepEqual((await cards()).final, ["code", "code", "Waiting"]);
});

test("dashboard Chrome: the runs rail folds and stays folded; graph controls line up with the header", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner: "the left margin doesn't line up", "a wider rail, and a way to fold it").
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/?run=${running}`, 1440, 900);
	await browser.waitFor(() => document.querySelector(".code-switch"));
	const layout = () =>
		browser.evaluate(() => {
			const left = (selector) =>
				Math.round(
					document.querySelector(selector).getBoundingClientRect().left,
				);
			const sentence = getComputedStyle(
				document.querySelector("#status-sentence"),
			);
			return {
				rail: Math.round(
					document.getElementById("rail").getBoundingClientRect().width,
				),
				hidden: document.getElementById("rail").inert,
				lefts: [left(".result"), left(".code-switch"), left(".toolbar")],
				button: document
					.querySelector(".rail-button")
					.getAttribute("aria-expanded"),
				// Regression (2026-11-03): a misplaced selector laid the sentence out as a 17 px flex row.
				sentence: [sentence.display, sentence.fontSize],
			};
		});
	const open = await layout();
	assert.equal(open.rail, 260);
	assert.equal(open.hidden, false);
	assert.equal(new Set(open.lefts).size, 1, JSON.stringify(open.lefts));
	assert.equal(open.button, "true");
	assert.deepEqual(open.sentence, ["block", "14px"]);
	await browser.evaluate(() => document.querySelector(".rail-button").click());
	await browser.waitFor(() => document.getElementById("rail").inert);
	await browser.waitForMotionEnd(); // the column narrows (0.28 s)
	const folded = await layout();
	assert.equal(folded.button, "false");
	assert.equal(new Set(folded.lefts).size, 1, JSON.stringify(folded.lefts));
	assert.equal(folded.lefts[0], 28);
	assert.equal(
		await browser.evaluate(() => localStorage.getItem("agent-workflow:rail")),
		"folded",
	);
	// It stays folded across a reload; "Needs you" opens it again.
	await browser.open(`${fixture.origin}/?run=${running}`, 1440, 900);
	assert.equal(
		await browser.evaluate(() => document.getElementById("rail").inert),
		true,
	);
	await browser.evaluate(() => document.querySelector(".needs-button").click());
	await browser.waitFor(() => !document.getElementById("rail").inert);
	assert.equal(
		await browser.evaluate(() => localStorage.getItem("agent-workflow:rail")),
		null,
	);
});

test("dashboard Chrome: the rail steps aside for the inspector on narrower screens and is a drawer on phones", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner review: "include mobile"): below 1440 px the rail folds while the inspector
	// is open (the sidebar button brings it back for that inspection); on a phone the rail is a
	// drawer, closed until asked for, closed again by a pick, the scrim or Escape. Rows say when a
	// run started and what it was asked.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	fixture.runs.get(running).taskPreview = "Review the ledger's retry path";
	const state = () =>
		browser.evaluate(() => ({
			rail: !document.getElementById("rail").inert,
			scrim: document.getElementById("body").classList.contains("rail-open"),
			expanded: document
				.querySelector(".rail-button")
				.getAttribute("aria-expanded"),
			width: document.documentElement.scrollWidth,
			center: Math.round(
				document.getElementById("center").getBoundingClientRect().width,
			),
		}));
	await browser.open(
		`${fixture.origin}/?run=${running}&stage=triage`,
		1280,
		800,
	);
	await browser.waitFor(() => !document.getElementById("inspector").hidden);
	// The inspector's sections keep its width while it folds; with side margins they used to
	// spill past its right edge (2026-11-11). Nothing may overflow it, in the stage or run details.
	const spill = () =>
		browser.evaluate(() => {
			const inspector = document.getElementById("inspector");
			const right = inspector.getBoundingClientRect().right;
			return [...inspector.querySelectorAll("*")]
				.filter(
					(node) =>
						node.getClientRects().length &&
						node.getBoundingClientRect().right - right > 1,
				)
				.map((node) => node.className || node.tagName);
		});
	assert.deepEqual(await spill(), [], "stage inspector");
	await browser.evaluate(() =>
		[...document.querySelectorAll(".actions button")]
			.find((button) => /Run details/.test(button.textContent))
			?.click(),
	);
	await browser.waitFor(() => document.querySelector(".details-section"));
	assert.deepEqual(await spill(), [], "run details");
	await browser.open(
		`${fixture.origin}/?run=${running}&stage=triage`,
		1280,
		800,
	);
	await browser.waitFor(() => !document.getElementById("inspector").hidden);
	assert.deepEqual((await state()).rail, false);
	await browser.evaluate(() => document.querySelector(".rail-button").click());
	assert.deepEqual((await state()).rail, true);
	assert.equal(
		await browser.evaluate(() => localStorage.getItem("agent-workflow:rail")),
		null,
		"bringing it back beside the inspector is not a kept choice",
	);
	const [task, started] = await browser.evaluate(() => {
		const row = document.querySelector(".run-row[aria-current='true']");
		return [
			row.querySelector(".run-task")?.textContent,
			row.querySelector(".run-started")?.textContent,
		];
	});
	assert.equal(task, "Review the ledger's retry path");
	assert.match(started, /^\d+m ago$/);
	// The compact rail (owner, 2026-11-11): a bar only on live runs, one meta line, no text dots.
	const rail = await browser.evaluate(() =>
		[...document.querySelectorAll(".run-row")].map((row) => ({
			current: row.getAttribute("aria-current") === "true",
			bar: Boolean(row.querySelector("progress")),
			meta: row.querySelector(".run-meta")?.textContent ?? null,
			count: row.querySelector(".run-count")?.textContent ?? "",
		})),
	);
	assert.ok(
		rail.find((row) => row.current).bar,
		"the running run keeps its bar",
	);
	assert.ok(
		rail.some((row) => !row.bar),
		"a run that is not live has no bar",
	);
	for (const row of rail) {
		assert.ok(row.meta !== null && !row.meta.includes("·"), row.meta);
		assert.match(row.count, /^(?:\d+ of )?\d+ (?:agents|tasks)$/);
	}
	// A phone: one column, the rail closed until asked for.
	await browser.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await browser.open(`${fixture.origin}/?run=${running}`, 390, 844);
	const closed = await state();
	assert.deepEqual(
		{ ...closed, center: undefined },
		{
			rail: false,
			scrim: false,
			expanded: "false",
			width: 390,
			center: undefined,
		},
	);
	assert.equal(closed.center, 390);
	await browser.evaluate(() => document.querySelector(".rail-button").click());
	assert.deepEqual(
		await state().then(({ rail, scrim, expanded }) => [rail, scrim, expanded]),
		[true, true, "true"],
	);
	await browser.evaluate(() => document.getElementById("rail-scrim").click());
	assert.equal((await state()).rail, false);
	await browser.evaluate(() => document.querySelector(".rail-button").click());
	await browser.key("Escape");
	assert.equal((await state()).rail, false);
	await browser.evaluate(() => document.querySelector(".rail-button").click());
	await browser.evaluate(() =>
		document.querySelector(".run-row:not([aria-current='true'])").click(),
	);
	assert.equal((await state()).rail, false);
	// A long report's contents fold behind "Contents" on a phone; a pick folds them again.
	fixture.reports.set(
		complete,
		"# Report\n\n## One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.",
	);
	await browser.open(
		`${fixture.origin}/?run=${complete}&view=report`,
		390,
		844,
	);
	await browser.waitFor(() => document.querySelector(".report-outline"));
	const contents = () =>
		browser.evaluate(() => ({
			expanded: document
				.querySelector(".outline-toggle")
				.getAttribute("aria-expanded"),
			entries: [...document.querySelectorAll(".outline-link")].filter(
				(entry) => entry.getClientRects().length,
			).length,
		}));
	assert.deepEqual(await contents(), { expanded: "false", entries: 0 });
	await browser.evaluate(() =>
		document.querySelector(".outline-toggle").click(),
	);
	assert.deepEqual(await contents(), { expanded: "true", entries: 3 });
	await browser.evaluate(() =>
		document.querySelectorAll(".outline-link")[1].click(),
	);
	assert.deepEqual(await contents(), { expanded: "false", entries: 0 });
});

test("dashboard Chrome: panels and dialogs share one motion family, both ways", {
	skip: !chrome
		? "Chrome is not installed (set CHROME to a local executable)"
		: motionChecks
			? false
			: MOTION_SKIP,
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner: "run details should be smooth too; check consistency"): the inspector's
	// column grows and narrows like the rail's (it stays drawn, inert, while it closes), dialogs
	// rise in and sink out, all on the same tokens; reduced motion turns them off.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/?run=${running}`, 1500, 900);
	// The first drawing places the panels without motion; later changes move.
	await browser.waitFor(() => document.body.dataset.ready === "1");
	const motion = () =>
		browser.evaluate(() => {
			const style = (el) => getComputedStyle(el);
			const body = style(document.getElementById("body"));
			const pick = (s, property) => {
				const names = s.transitionProperty.split(", ");
				const durations = s.transitionDuration.split(", ");
				return durations[names.indexOf(property)] ?? null;
			};
			return {
				layout: pick(body, "grid-template-columns"),
				dialog: pick(style(document.getElementById("dialog")), "opacity"),
				tokens: ["--t-fast", "--t-base", "--t-layout", "--t-leave"].map((n) =>
					style(document.documentElement).getPropertyValue(n).trim(),
				),
			};
		});
	assert.deepEqual(await motion(), {
		layout: "0.28s",
		dialog: "0.16s",
		tokens: ["0.15s", "0.22s", "0.28s", "0.16s"],
	});
	await browser.click('#run-header [aria-label="Run details"]');
	await browser.waitFor(() => !document.getElementById("inspector").hidden);
	await browser.key("Escape");
	// Closing: hidden and inert at once, still drawn while its column narrows.
	assert.deepEqual(
		await browser.evaluate(() => {
			const inspector = document.getElementById("inspector");
			return [
				inspector.hidden,
				inspector.inert,
				getComputedStyle(inspector).display,
			];
		}),
		[true, true, "block"],
	);
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	assert.equal((await motion()).layout, null, "no layout transition");
});

test("dashboard Chrome: a one-agent stage opens its readable result; a stage with no agents yet has no empty bar", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner): a many-agent stage opened as a readable list while a one-agent stage
	// opened the raw agent (tabs, "untrusted output", and a stray "null"); a foreach stage whose
	// agents were not generated yet drew an empty bar and "0/0" over its "Waiting" line.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const run = fixture.runs.get(running);
	run.tasks = run.tasks.filter(
		(task) => task.stageId !== "devil-advocate" || task.placeholder,
	);
	await browser.open(`${fixture.origin}/?run=${running}`, 1440, 900);
	assert.deepEqual(
		await browser.evaluate(() => {
			const node = document.querySelector('.node[data-stage="devil-advocate"]');
			return [
				node.querySelector(".sub")?.textContent,
				node.querySelectorAll(".fraction, .bar, .track").length,
			];
		}),
		["Waiting", 0],
	);
	await browser.click('.node[data-stage="triage"]');
	await browser.waitFor(() => document.querySelector(".item-expand.single"));
	const single = await browser.evaluate(() => {
		const inspector = document.getElementById("inspector");
		return {
			title: inspector.querySelector("h2")?.textContent,
			tabs: inspector.querySelectorAll('[role="tablist"]').length,
			open: inspector.querySelector(".item-open")?.textContent,
			stray: [...inspector.childNodes].some(
				(node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
			),
			url: new URLSearchParams(location.search).get("stage"),
		};
	});
	assert.deepEqual(single, {
		title: "Triage",
		tabs: 0,
		open: "Open agent ›",
		stray: false,
		url: "triage",
	});
	// The raw agent is one click on, and its inspector has no stray text either.
	await browser.click(".item-open");
	await browser.waitFor(() => document.querySelector('[role="tablist"]'));
	assert.equal(
		await browser.evaluate(() =>
			[...document.getElementById("inspector").childNodes].some(
				(node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
			),
		),
		false,
	);
});

test("dashboard Chrome: a report table of four or more columns reads as one entry per row", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-03 (owner: the evidence table was hard to read — long links, wrapped Korean in narrow
	// columns, the last column cut off).
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	fixture.reports.set(
		complete,
		[
			"# Report",
			"",
			"| Area | Status | Evidence | Why it matters |",
			"|---|---|---|---|",
			"| 메모리와 상태 관리 | partial | [docs.langchain.com](<https://docs.langchain.com/oss/python/concepts/memory>), [arxiv.org](<https://arxiv.org/abs/2005.11401>) | 구현 사례를 일반화하지 않는다. |",
			"",
			"| A | B | C |",
			"|---|---|---|",
			"| 1 | 2 | 3 |",
		].join("\n"),
	);
	await browser.open(
		`${fixture.origin}/?run=${complete}&view=report`,
		1440,
		900,
	);
	await browser.waitFor(() => document.querySelector(".report-rows"));
	assert.deepEqual(
		await browser.evaluate(() => {
			const row = document.querySelector(".report-row");
			return {
				title: row.querySelector(".report-row-title").textContent,
				status: row.querySelector(".report-row-title .md-status")?.textContent,
				labels: [...row.querySelectorAll("dt")].map((dt) => dt.textContent),
				sources: [...row.querySelectorAll(".md-source")].map(
					(source) => source.textContent,
				),
				tables: document.querySelectorAll("#report-content table").length,
			};
		}),
		{
			title: "메모리와 상태 관리Partly covered",
			status: "Partly covered",
			labels: ["Why it matters", "Evidence"],
			sources: [
				"docs.langchain.com/oss/python/concepts/memory",
				"arxiv.org/abs/2005.11401",
			],
			tables: 1,
		},
	);
});

test("dashboard Chrome: a click on the empty canvas closes the inspector; a drag only pans", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-04 (owner): open a stage by clicking its card, close it by clicking empty space.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(
		`${fixture.origin}/?run=${running}&stage=triage`,
		1500,
		900,
	);
	await browser.waitFor(() => !document.getElementById("inspector").hidden);
	// A point on the canvas away from the cards, the switch and the toolbar.
	const spot = await browser.evaluate(() => {
		const canvas = document.getElementById("canvas").getBoundingClientRect();
		return { x: canvas.right - 30, y: canvas.top + canvas.height / 2 };
	});
	const mouse = async (type, x, y) =>
		browser.send("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: "left",
			buttons: type === "mouseReleased" ? 0 : 1,
			clickCount: 1,
		});
	const state = () =>
		browser.evaluate(() => [
			document.getElementById("inspector").hidden,
			new URLSearchParams(location.search).get("stage"),
		]);
	// A drag that starts on empty canvas pans and keeps the inspector.
	await mouse("mousePressed", spot.x, spot.y);
	await mouse("mouseMoved", spot.x - 60, spot.y - 20);
	await mouse("mouseReleased", spot.x - 60, spot.y - 20);
	assert.deepEqual(await state(), [false, "triage"]);
	// A click closes it.
	await mouse("mousePressed", spot.x, spot.y);
	await mouse("mouseReleased", spot.x, spot.y);
	await browser.waitFor(() => document.getElementById("inspector").hidden);
	assert.deepEqual(await state(), [true, null]);
	// Clicking a card opens it again (the card is not "empty space").
	await browser.click('.node[data-stage="triage"]');
	await browser.waitFor(() => !document.getElementById("inspector").hidden);
	assert.deepEqual(await state(), [false, "triage"]);
});

test("dashboard Chrome: the timeline lays stages and their agents on one time axis", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	// 2026-11-12 (owner: the run's timeline): when each stage and agent ran, how long it took and
	// what it cost; a cost nobody reported is "—", never $0. A row opens what a card opens.
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(
		`${fixture.origin}/?run=${complete}&layout=timeline`,
		1440,
		900,
	);
	await browser.waitFor(() => document.querySelectorAll(".tl-row").length > 0);
	const rows = await browser.evaluate(() =>
		[...document.querySelectorAll(".tl-row")].map((row) => [
			row.getAttribute("aria-label"),
			row.classList.contains("tl-child"),
		]),
	);
	assert.equal(rows.length, 16);
	assert.deepEqual(rows.slice(0, 3), [
		["Triage, Completed, 16s, $0.0030", false],
		["Reviewers, Completed, 13s", false],
		["stop-signal-race, Completed, 13s", true],
	]);
	assert.deepEqual(
		rows.find(([label]) => label.startsWith("Devil advocate")),
		["Devil advocate, Completed, 18s, $0.0162", false],
	);
	assert.equal(
		rows.filter(([, child]) => child).length,
		8,
		"three reviewers and five devil's advocates",
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('.tl-row[data-row="stage:reviewers"] .tl-cost')
					.textContent,
		),
		"n/a",
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll('#timeline [role="toolbar"] button')].map(
				(node) => [
					node.getAttribute("aria-label"),
					node.getAttribute("aria-pressed"),
				],
			),
		),
		[
			["Top-down", "false"],
			["Left-right", "false"],
			["Timeline", "true"],
		],
	);
	await browser.click('.tl-row[data-row="stage:devil-advocate"]');
	await browser.waitFor(() => !document.getElementById("inspector").hidden);
	assert.deepEqual(
		await browser.evaluate(() => [
			new URLSearchParams(location.search).get("stage"),
			new URLSearchParams(location.search).get("layout"),
			document
				.querySelector('.tl-row[data-row="stage:devil-advocate"]')
				.getAttribute("aria-current"),
		]),
		["devil-advocate", "timeline", "true"],
	);
	// Back to the graph.
	await browser.click('#timeline [aria-label="Top-down"]');
	await browser.waitFor(() => document.querySelector(".node[data-stage]"));
	assert.deepEqual(
		await browser.evaluate(() => [
			document.getElementById("timeline"),
			new URLSearchParams(location.search).get("layout"),
		]),
		[null, null],
	);
	// A task at work ends now; one still waiting (even with a launch stamp) has no bar yet.
	const live = await browser.evaluate(async (run) => {
		const { timelineRows, deriveGraph } = await import("./app.js");
		const until = Date.parse("2026-10-29T08:10:00Z");
		const rows = timelineRows(
			run,
			[...deriveGraph(run).stages.values()],
			until,
		);
		const of = (id) => rows.find((row) => row.task?.specId === id);
		return [
			of("reviewers.ledger-double-write").span,
			of("reviewers.webhook-retry-path").span,
			of("reviewers.ledger-double-write").cost,
			rows.find((row) => row.stage.id === "triage").cost,
		];
	}, fixture.runs.get(running));
	assert.deepEqual(live, [
		[102_000, 540_000],
		null,
		null,
		{ usd: 0.0124, of: 1, tasks: 1 },
	]);
});

test("dashboard Chrome: project overview, explicit selection, keyboard-labelled switcher and remembered choice", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 30_000,
}, async (t) => {
	const second = {
		id: "other-abcdef012345",
		name: "Other project",
		path: "~/work/other",
		pathMissing: true,
		lastSeenAt: "2026-11-06T00:00:00.000Z",
		counts: { running: 0, needsAttention: 0, lastActivity: null },
	};
	const fixture = await createFixtureServer({ extraProjects: [second] });
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const open = async (url) => {
		await browser.send("Page.navigate", { url });
		await browser.waitFor(
			() =>
				document.readyState === "complete" &&
				document.querySelector("#project-switcher"),
		);
	};
	await open(`${fixture.origin}/`);
	await browser.waitFor(() => document.querySelector(".projects-overview"));
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".projects-overview h1").textContent,
		),
		"All projects",
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll(".project-card").length,
		),
		2,
	);
	assert.ok(
		await browser.evaluate(() =>
			document
				.querySelector(".projects-overview")
				.textContent.includes("path missing"),
		),
	);
	assert.equal(
		fixture.requests.some(
			(request) =>
				request.path.includes("/runs") || request.path === "/api/events",
		),
		false,
		"overview never polls per-run details",
	);
	await browser.evaluate(() => {
		const select = document.querySelector("#project-switcher");
		select.value = "payments-api-123456789abc";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await browser.waitFor(
		() =>
			document.querySelector("#project")?.textContent === "payments-api" &&
			// 2026-11-12: a project opens to its overview, not to a run.
			document.querySelector("#home-view"),
	);
	assert.equal(
		await browser.evaluate(() =>
			new URLSearchParams(location.search).get("project"),
		),
		"payments-api-123456789abc",
	);
	await open(`${fixture.origin}/`);
	await browser.waitFor(() => document.querySelector("#home-view"));
	assert.equal(
		await browser.evaluate(() =>
			document.querySelector("#project-switcher").getAttribute("aria-label"),
		),
		"Project",
	);
	await open(`${fixture.origin}/?project=${second.id}`);
	await browser.waitFor(
		() => document.querySelector("#project")?.textContent === "Other project",
	);
	assert.ok(
		await browser.evaluate(() =>
			document
				.querySelector("#center")
				.textContent.includes("No runs in this project"),
		),
	);
	await open(`${fixture.origin}/?project=unregistered-0123456789ab`);
	await browser.waitFor(() => document.querySelector(".projects-overview"));
	assert.ok(
		await browser.evaluate(() =>
			document.querySelector("#notice").textContent.includes("not registered"),
		),
	);
	await open(`${fixture.origin}/?project=all`);
	await browser.waitFor(() => document.querySelector(".projects-overview"));
	await open(`${fixture.origin}/`);
	await browser.waitFor(() => document.querySelector(".projects-overview"));
});

test("the dashboard's effort choices are the engine's effort vocabulary", async () => {
	const js = await readFile(new URL("app.js", root), "utf8");
	const { EFFORT_LEVELS } = await import("../../dist/core/types.js");
	const listed = /const EFFORT_LEVELS = \[([^\]]*)\]/.exec(js)?.[1];
	assert.ok(listed, "app.js declares EFFORT_LEVELS");
	assert.deepEqual(
		[...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
		[...EFFORT_LEVELS],
	);
});

// 2026-11-12 (owner): the report is a page with its own URL, an outline, and — for a deep-review
// style report — finding cards with filter chips. Everything shown comes from the report text.
/** The run and view in the address bar (other query parts, like the project, are not under test). */
const route = (browser) =>
	browser.evaluate(() => {
		const params = new URL(location.href).searchParams;
		return [params.get("run"), params.get("view")];
	});
const text2 = (browser, selector) =>
	browser.evaluate(
		(selector) => document.querySelector(selector)?.textContent,
		selector,
	);
// The renderer ends these field lines with a Markdown hard break ("  "); the fixture file is kept
// free of trailing whitespace (the diff check), so the breaks are put back here.
const deepReport = (
	await readFile(
		new URL("../fixtures/dashboard/report-deep-review.md", import.meta.url),
		"utf8",
	)
).replace(/^((?:Severity|Root cause|Verifier verdict): .*)$/gm, "$1  ");
/** Share of text at 14px or more outside the rail, and the smallest size (the guard of the first test). */
const measureTypography = (browser) =>
	browser.evaluate(() => {
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
			// What is drawn in the window now (a folded <details> and the page below are not).
			if (
				!rect.width ||
				!rect.height ||
				rect.bottom < 0 ||
				rect.top > innerHeight ||
				rect.right < 0 ||
				rect.left > innerWidth ||
				!node.parentElement.checkVisibility()
			)
				continue;
			const size = parseFloat(getComputedStyle(node.parentElement).fontSize);
			smallest = Math.min(smallest, size);
			if (node.parentElement.closest(".rail")) continue;
			total++;
			if (size >= 13.99) large++;
		}
		return { total, large, smallest };
	});
test("dashboard Chrome: a deep-review report is a page with a verdict header, an outline, finding cards and filters", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	fixture.reports.set(complete, deepReport);
	Object.assign(fixture.runs.get(complete), {
		summary:
			"The working-tree changes should not go into a PR yet. Three high findings were kept.",
		agentSummary: { completed: 8, total: 8 },
		cost: { costUsd: 0.282, agentsReporting: 8, agentTotal: 8 },
		activeMs: 97_000,
	});
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const text = (selector) =>
		browser.evaluate(
			(selector) => document.querySelector(selector)?.textContent,
			selector,
		);
	const copied = () => browser.evaluate(() => globalThis.copiedText);
	await browser.open(`${fixture.origin}/?run=${complete}&view=report`);
	await browser.waitFor(
		() => document.querySelectorAll(".finding-card").length,
	);
	await browser.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (value) => {
					globalThis.copiedText = value;
				},
			},
		});
	});
	// Header: verdict badge (icon + word), the result card's sentence, the meta line, the actions.
	const header = await browser.evaluate(() => ({
		badge: document.querySelector(".result-badge").textContent,
		icon: !!document.querySelector(".result-badge .glyph svg"),
		summary: document.querySelector(".report-summary").textContent,
		meta: [...document.querySelectorAll(".report-meta > span")].map(
			(span) => span.textContent,
		),
		costTitle: document.querySelector(".report-cost").title,
		actions: [...document.querySelectorAll(".report-title-row button")].map(
			(button) => button.textContent,
		),
		dialog: document.querySelector("dialog").open,
	}));
	assert.match(header.meta[1], /^Finished \d+[mhd] ago$|^Finished just now$/);
	header.meta[1] = "Finished";
	assert.deepEqual(header, {
		badge: "Needs work",
		icon: true,
		summary:
			"The working-tree changes should not go into a PR yet. Three high findings were kept.",
		meta: [
			"deep-review",
			"Finished",
			"1m 37s active",
			"8 of 8 agents",
			"$0.28, 8 of 8 agents reported",
		],
		costTitle: "8 of 8 agents reported cost",
		actions: ["Copy as Markdown", "Light page", "Open run"],
		dialog: false,
	});
	// Finding cards: a severity chip and a separate verifier pill, location chips from the Locations
	// table. The report states "WEAKEN" for one finding and says nothing about a changed severity,
	// so the card shows "High" and "Weakened" only.
	const cards = await browser.evaluate(() =>
		[...document.querySelectorAll(".finding-card")].map((card) => ({
			id: card.querySelector(".finding-id").textContent,
			title: card.querySelector(".finding-title").textContent,
			severity: card.querySelector(".severity-chip").textContent,
			verifier: card.querySelector(".verifier-pill")?.textContent,
			// The file and line, then the symbol in its own span, spaced by a margin.
			locations: [...card.querySelectorAll(".location-chip")].map((chip) =>
				[...chip.children].map((part) => part.textContent).join(" "),
			),
			folds: [...card.querySelectorAll("details > summary")].map(
				(summary) => summary.textContent,
			),
			parts: [...card.querySelectorAll(".part-label")].map(
				(label) => label.textContent,
			),
			open: card.querySelectorAll("details[open]").length,
		})),
	);
	assert.deepEqual(
		cards.map(({ id, severity, verifier }) => [id, severity, verifier]),
		[
			["finding-001", "High", "Kept"],
			["finding-002", "High", "Kept"],
			["finding-003", "High", "Weakened"],
			["finding-004", "High", "Kept"],
		],
	);
	assert.equal(
		cards[0].title,
		"graceMs makes expired entries live ttlMs+graceMs; the existing TTL test fails and nothing refreshes stale entries",
	);
	assert.deepEqual(cards[0].locations, [
		"src/cache.js:14 Cache.get",
		"src/cache.js:3 Cache constructor graceMs default",
		"src/server.js:10-13 /users handler",
		"test/cache.test.js:10-11 entries expire after their TTL",
	]);
	// A location with no symbol shows just file and line.
	assert.deepEqual(cards[1].locations, [
		"src/server.js:9 createServer handler",
		"docs/API_SPEC.md:6",
	]);
	assert.deepEqual(cards[0].parts, ["Rationale", "Recommended action"]);
	assert.deepEqual(cards[0].folds, [
		"Reviewer/source evidence (5)",
		"Verifier evidence (6)",
		"Caveat / counter-evidence (4)",
	]);
	assert.equal(cards[0].open, 0, "evidence is folded until asked for");
	assert.doesNotMatch(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".finding-head")]
				.map((head) => head.textContent)
				.join(" "),
		),
		/→|downgraded|medium/i,
	);
	// Count chips are filters: severity, then verifier verdicts; kept + weakened add up.
	const chips = () =>
		browser.evaluate(() =>
			[...document.querySelectorAll(".filter-chip")].map(
				(chip) => `${chip.textContent}:${chip.getAttribute("aria-pressed")}`,
			),
		);
	const visible = () =>
		browser.evaluate(() =>
			[...document.querySelectorAll(".finding-card")]
				.filter((card) => !card.hidden)
				.map((card) => card.getAttribute("aria-label")),
		);
	assert.deepEqual(await chips(), [
		"4 high:false",
		"3 kept:false",
		"1 weakened:false",
	]);
	await browser.click('[data-filter-value="weakened"]');
	assert.deepEqual(await visible(), ["finding-003"]);
	// A filtered-out card leaves the outline too (a finding is listed by its title, its id in the tooltip).
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".outline-link")]
				.filter((link) => !link.hidden && link.title.startsWith("finding-"))
				.map((link) => link.title),
		),
		["finding-003: Unknown user never yields 404"],
	);
	// The filter says what it did, and the first match is brought into view (review, P2-5).
	assert.equal(await text(".filter-count"), "Showing 1 of 4");
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".filter-clear").hidden,
		),
		false,
	);
	await browser.waitFor(() => {
		const top = document
			.querySelector('.finding-card[aria-label="finding-003"]')
			.getBoundingClientRect().top;
		return top >= 0 && top < innerHeight / 2;
	});
	assert.equal(
		await browser.evaluate(() =>
			document
				.querySelector(".filter-chip[data-filter-value=weakened]")
				.getAttribute("aria-pressed"),
		),
		"true",
	);
	await browser.click('[data-filter-value="kept"]');
	assert.deepEqual(await visible(), [
		"finding-001",
		"finding-002",
		"finding-004",
	]);
	await browser.click('[data-filter-value="kept"]');
	assert.equal((await visible()).length, 4);
	// The sticky outline "On this page" (2026-11-12, review P2-6): the report's own ## sections and
	// its findings by title, one line each; the short ### sub-sections are left out.
	const outline = await browser.evaluate(() =>
		[...document.querySelectorAll(".outline-link")].map(
			(link) =>
				`${link.classList.contains("level-1") ? "  " : ""}${link.textContent}`,
		),
	);
	assert.deepEqual(outline.slice(0, 5), [
		"Executive summary",
		"Finding summary",
		"Synthesis narrative",
		"Risks and partial-review limitations",
		"High findings",
	]);
	assert.deepEqual(outline.slice(5, 9), [
		"  graceMs makes expired entries live ttlMs+graceMs; the existing TTL test fails and nothing refreshes stale entries",
		"  Missing id returns 200 instead of 400",
		"  Unknown user never yields 404",
		"  Grace period lets responses be served up to 35s old, exceeding the 30s limit",
	]);
	assert.ok(
		!outline.includes("  Core conclusion"),
		"sub-sections are not listed",
	);
	assert.equal(await text(".outline-title"), "On this page");
	assert.deepEqual(
		await browser
			.evaluate(() =>
				[...document.querySelectorAll(".outline-link")].map((link) => {
					const label = link.querySelector(".outline-text");
					const style = getComputedStyle(label);
					return [style.whiteSpace, style.textOverflow];
				}),
			)
			.then((rows) => [...new Set(rows.map((row) => row.join(" ")))]),
		["nowrap ellipsis"],
		"one line each",
	);
	assert.equal(
		await browser.evaluate(
			() =>
				getComputedStyle(document.querySelector(".report-outline")).position,
		),
		"sticky",
	);
	assert.equal(
		await text(".outline-link.current"),
		"Executive summary",
		"the first section is current at the top",
	);
	await browser.evaluate(() =>
		[...document.querySelectorAll(".outline-link")]
			.find((link) => link.title.startsWith("finding-003"))
			.click(),
	);
	await browser.waitFor(
		() =>
			document.querySelector(".outline-link.current")?.title.split(":")[0] ===
			"finding-003",
	);
	// The page scrolls to it (smoothly), and the highlight stays on it when the scroll settles.
	await browser.waitFor(
		() => document.querySelector("#report-view").scrollTop > 400,
	);
	await browser.waitFor(
		() =>
			new Promise((resolve) => {
				const view = document.querySelector("#report-view");
				const before = view.scrollTop;
				setTimeout(() => resolve(view.scrollTop === before), 250);
			}),
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".outline-link.current").title,
		),
		"finding-003: Unknown user never yields 404",
	);
	// Copy fix prompt: that finding's own Markdown, nothing from its neighbours.
	await browser.click('[data-copy-finding="finding-003"]');
	const fix = await copied();
	assert.match(fix, /^### finding-003 — Unknown user never yields 404\n/);
	assert.match(fix, /Verifier verdict: \*\*WEAKEN\*\*/);
	assert.match(fix, /Recommended action:/);
	assert.doesNotMatch(fix, /finding-00[124]/);
	assert.equal(await text("#notice"), "Copied", "the copy says so");
	// Copy as Markdown: the whole report, as written.
	await browser.evaluate(() => {
		globalThis.copiedText = "";
	});
	await browser.click(".copy-report");
	assert.equal(await copied(), deepReport);
	// No inline styles (the CSP forbids them), no links or images from the report.
	assert.deepEqual(
		await browser.evaluate(() => ({
			styled: document.querySelectorAll("#report-view [style]").length,
			links: document.querySelectorAll("#report-content a, #report-content img")
				.length,
		})),
		{ styled: 0, links: 0 },
	);
	const typography = await measureTypography(browser);
	assert.ok(
		typography.smallest >= 12 && typography.large / typography.total >= 0.6,
		JSON.stringify(typography),
	);
	// Open run leads back to the run; the back button returns to the report, forward to the run.
	await browser.click('[data-action="open-run"]');
	await browser.waitFor(() => document.querySelector("#task-count"));
	assert.deepEqual(await route(browser), [complete, null]);
	await browser.evaluate(() => history.back());
	await browser.waitFor(() => document.querySelector(".finding-card"));
	assert.deepEqual(await route(browser), [complete, "report"]);
	await browser.evaluate(() => history.forward());
	await browser.waitFor(() => document.querySelector("#task-count"));
	assert.deepEqual(await route(browser), [complete, null]);
	// "Open report" pushes the page again; back leaves it.
	await browser.evaluate(() =>
		[...document.querySelectorAll("#run-header button")]
			.find((button) => button.textContent === "Open report")
			.click(),
	);
	await browser.waitFor(() => document.querySelector(".finding-card"));
	await browser.evaluate(() => history.back());
	await browser.waitFor(() => document.querySelector("#task-count"));
	assert.deepEqual(await route(browser), [complete, null]);
});

test("dashboard Chrome: a report without the deep-review structure stays plain Markdown", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	// A medium finding after a high one: filtering by severity hides the heading of an empty section.
	const card = (id, severity, verdict) =>
		`### ${id} — Title of ${id}\n\nSeverity: **${severity}**  \n${verdict ? `Verifier verdict: **${verdict}**  \n` : ""}\nLocations:\n\n| File | Line | Symbol |\n|---|---:|---|\n| \`a.js\` | 1 | — |\n\nRationale:\n\nBecause.\n`;
	await browser.open(`${fixture.origin}/?run=${complete}&view=report`);
	await browser.waitFor(() => document.querySelector("#report-content .md-h1"));
	// The default fixture report has no finding sections: no cards, no chips, the outline still works.
	assert.deepEqual(
		await browser.evaluate(() => ({
			cards: document.querySelectorAll(".finding-card").length,
			chips: document.querySelectorAll(".filter-chip").length,
			outline: [...document.querySelectorAll(".outline-link")].map(
				(link) => link.textContent,
			),
			blocks: document.querySelectorAll(".md-block").length,
			title: document.querySelector(".report-summary").textContent,
			badge: document.querySelector(".result-badge").textContent,
		})),
		{
			cards: 0,
			chips: 0,
			outline: ["Main findings"],
			blocks: 1,
			// The fixture run has no summary sentence: the title says what this is, nothing more.
			title: "deep-review report",
			badge: "Needs work",
		},
	);
	// A "finding" without Severity / Verifier lines in a report that never says "kept or weakened"
	// gets a card without a verifier pill: nothing is assumed.
	fixture.reports.set(
		complete,
		`# Findings\n\n## High findings\n\n${card("finding-001", "high")}\n## Medium findings\n\n${card("finding-002", "medium", "NEEDS\\_HUMAN")}\n## Gaps\n\n### finding-003 — Written as bullets\n\n- Disposition: **Keep**\n- Severity: **High**\n`,
	);
	await browser.open(`${fixture.origin}/?run=${complete}&view=report`);
	await browser.waitFor(
		() => document.querySelectorAll(".finding-card").length === 2,
	);
	// Another workflow's "### finding-003 — …" with bullet fields has no Severity line: no card.
	assert.deepEqual(
		await browser.evaluate(() => ({
			cards: document.querySelectorAll(".finding-card").length,
			plain: [...document.querySelectorAll("#report-content .md-h3")]
				.filter((heading) => !heading.closest(".finding-card"))
				.map((heading) => heading.textContent),
			chips: [...document.querySelectorAll(".filter-chip")].map(
				(chip) => chip.textContent,
			),
		})),
		{
			cards: 2,
			plain: ["finding-003 — Written as bullets"],
			chips: ["1 high", "1 medium", "1 needs human"],
		},
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".finding-card")].map((item) => [
				item.querySelector(".severity-chip").textContent,
				item.querySelector(".verifier-pill")?.textContent ?? null,
			]),
		),
		[
			["High", null],
			["Medium", "Needs human"],
		],
	);
	await browser.click('[data-filter-value="medium"]');
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll("#report-content .md-h2")].map(
				(heading) => [heading.textContent, heading.hidden],
			),
		),
		[
			["High findings", true],
			["Medium findings", false],
			// A section with plain content next to cards is never hidden.
			["Gaps", false],
		],
	);
	await browser.click('[data-filter-value="needs-human"]');
	await browser.click('[data-filter-value="high"]');
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".filter-empty").hidden,
		),
		false,
		"filters that match nothing say so",
	);
	// A run without a report says so and still has its way back.
	await browser.open(`${fixture.origin}/?run=${running}&view=report`);
	await browser.waitFor(() => document.querySelector("#report-content"));
	assert.equal(
		await browser.evaluate(
			() => document.querySelector("#report-content").textContent,
		),
		"This run has no report.",
	);
	await browser.click('[data-action="open-run"]');
	await browser.waitFor(() => document.querySelector("#task-count"));
	assert.deepEqual(await route(browser), [running, null]);
});

test("dashboard Chrome: the report page on a phone has no horizontal overflow and a folded outline", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	fixture.reports.set(complete, deepReport);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	for (const [width, height] of [
		[390, 844],
		[1440, 900],
	]) {
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			width,
			height,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		await browser.evaluate(() =>
			document.querySelector(".finding-fold").setAttribute("open", ""),
		);
		assert.deepEqual(
			await browser.evaluate(() => ({
				page: document.documentElement.scrollWidth <= innerWidth,
				view:
					document.querySelector("#report-view").scrollWidth <=
					document.querySelector("#report-view").clientWidth,
				cards: [...document.querySelectorAll(".finding-card")].every(
					(card) => card.getBoundingClientRect().right <= innerWidth,
				),
			})),
			{ page: true, view: true, cards: true },
			`${width}px`,
		);
	}
});

// 2026-11-12 (owner): with no run chosen the dashboard opens to the project overview. Aggregates
// (cost, agent reporting counts, active time) come with the run list; the fixture states them
// here, with numbers that tell wall clock from active time and tasks from agents apart.
const docsWriter = "workflow_mvt1t1i7_7b71df";
const quickRead = "workflow_mvt1jojn_3dd217";
const research = "workflow_mvt63y66_4c2a15";
const blocked = "workflow_mvt9n8dd_19b2f4";
function overviewFixture(fixture) {
	const set = (id, values) => Object.assign(fixture.runs.get(id), values);
	set(complete, {
		taskPreview: "Review the checkout flow",
		agentSummary: { completed: 8, total: 8 },
		// The run's own usage says 10 of 16 tasks reported; its eight agents all did.
		cost: { costUsd: 0.282, agentsReporting: 8, agentTotal: 8 },
		activeMs: 97_000,
	});
	set(research, {
		cost: { costUsd: 3.4, agentsReporting: 5, agentTotal: 6 },
		activeMs: 1_500_000,
	});
	set(docsWriter, {
		cost: { costUsd: 0.0007, agentsReporting: 1, agentTotal: 1 },
		activeMs: 5_000,
	});
	// Stopped by the user: hidden from Recent results until asked for.
	set(quickRead, {
		status: "interrupted",
		cost: { costUsd: null, agentsReporting: 0, agentTotal: 1 },
		activeMs: 4_000,
	});
	// Created 07:00, updated 07:06: it sat waiting. Its work took 2m 15s.
	set(failed, {
		cost: { costUsd: 0.0061, agentsReporting: 2, agentTotal: 2 },
		activeMs: 135_000,
	});
}
test("dashboard Chrome: the overview is the landing view with needs, running, results, workflows and totals", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	overviewFixture(fixture);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const all = (selector, pick = (node) => node.textContent) =>
		browser.evaluate(
			(selector, pick) =>
				[...document.querySelectorAll(selector)].map(
					new Function("node", `return (${pick})(node)`),
				),
			selector,
			String(pick),
		);
	await browser.open(`${fixture.origin}/`);
	await browser.waitFor(() => document.querySelector(".home-row.recent"));
	// No run is chosen: no run in the address bar, nothing of a run on the page, Overview current.
	assert.deepEqual(await route(browser), [null, null]);
	assert.deepEqual(
		await browser.evaluate(() => ({
			// The page says what it is; the project is in the top bar and the rail.
			title: document.querySelector(".home-grid h1").firstChild.textContent,
			// The date depends on the time zone; the space before the count is for screen readers.
			heading: document
				.querySelector(".home-grid h1")
				.textContent.replace(/since .*/, "since"),
			crumb: document.querySelector("#project").textContent,
			run: !!document.querySelector("#task-count, #run-header"),
			nav: [...document.querySelectorAll(".management-nav a")].map((link) => [
				link.textContent,
				link.getAttribute("aria-current"),
			]),
		})),
		{
			title: "Overview",
			heading: "Overview 7 runs since",
			crumb: "payments-api",
			run: false,
			nav: [
				["Overview", "page"],
				["Runs", null],
				["Workflows", null],
				["Profiles", null],
				["Maintenance", null],
				["Executors", null],
			],
		},
	);
	// Needs you: the run's own identity (workflow), then the reason in the rail's wording; Inspect
	// is the lead action, a failure can be dismissed, and there is no "Open run" beside Inspect.
	assert.deepEqual(
		await all(".home-need", (node) => [
			node.querySelector("strong").textContent,
			node.querySelector(".home-need-reason b").textContent,
			[...node.querySelectorAll("button")].map((button) => button.textContent),
		]),
		[
			["migration-planner", "Controller needs a decision", ["Inspect"]],
			["spec-review", "Failed at map-implementation", ["Inspect", "Dismiss"]],
		],
	);
	// Running now: the run that works.
	assert.deepEqual(
		await all(
			"#home-running .home-row",
			(node) => node.querySelector("strong").textContent,
		),
		["deep-review"],
	);
	// Recent results: newest first; the stopped run is hidden. A run that is in "Needs you" is not
	// listed twice (owner, pass 2): migration-planner and spec-review are above, not here.
	const recent = () =>
		all("#home-recent .home-row.recent", (node) => [
			node.querySelector(".result-badge").textContent,
			node.querySelector(".home-row-wf").textContent,
			node.querySelector(".home-row-agents")?.textContent ?? null,
			node.querySelector(".home-row-task")?.textContent ?? null,
			node.querySelector(".home-row-dur").textContent,
			node.querySelector(".home-cost").textContent,
		]);
	// 2026-11-12 (review, P2-8): the workflow leads, the task the run was given is the quiet line.
	assert.deepEqual(await recent(), [
		["Complete", "deep-research", null, null, "25m 00s", "$3.40+"],
		[
			"Needs work",
			"deep-review",
			"8 of 8 agents",
			"Review the checkout flow",
			"1m 37s",
			"$0.28",
		],
		["Finished", "docs-writer", null, null, "5s", "$0.0007"],
	]);
	assert.equal(
		await text2(browser, '[data-home-key="stopped"]'),
		"Show 1 stopped run",
	);
	await browser.click('[data-home-key="stopped"]');
	assert.deepEqual((await recent()).at(-1), [
		"Stopped",
		"live6-quick-read",
		null,
		null,
		"4s",
		// Unknown cost is "n/a" in muted text, never $0.
		"n/a",
	]);
	assert.equal(
		await browser.evaluate(() =>
			document
				.querySelector("#home-recent .home-row.recent:last-child .home-cost")
				.classList.contains("muted"),
		),
		true,
	);
	assert.equal(
		await text2(browser, '[data-home-key="stopped"]'),
		"Hide stopped runs",
	);
	await browser.click('[data-home-key="stopped"]');
	assert.equal((await recent()).length, 3);
	// A partial cost has a "+" and its ratio in a title; agents are the denominator.
	assert.deepEqual(
		await all("#home-recent .home-cost", (node) => [
			node.textContent,
			node.title,
		]),
		[
			["$3.40+", "5 of 6 agents reported cost. The true total may be higher."],
			["$0.28", "8 of 8 agents reported cost"],
			["$0.0007", "1 of 1 agent reported cost"],
		],
	);
	// This project: totals use active time and the agent-only ratio.
	assert.deepEqual(
		await all(".home-stat", (node) => [
			node.querySelector(".home-stat-value").textContent,
			node.querySelector(".home-stat-name").textContent,
			node.querySelector(".home-stat-note").textContent,
		]),
		[
			["7", "runs", "3 done, 1 stopped, 1 failed, 1 running, 1 needs you"],
			["$3.69+", "spend", "16 of 18 agents reported"],
			["29m 01s", "active time", "all runs, not waiting"],
		],
	);
	// Workflows: runs, last result, median active time, cost with its ratio, an outcome strip.
	const workflow = (name) =>
		browser.evaluate((name) => {
			const row = document.querySelector(`[data-workflow="${name}"]`);
			return [...row.cells].map((cell) =>
				cell.querySelector(".strip")
					? [...cell.querySelectorAll(".sq")].map((sq) =>
							sq.className.replace("sq ", ""),
						)
					: cell.textContent.trim(),
			);
		}, name);
	// "Last result" is the last run that finished, not the one still going (owner, 2026-11-12), and
	// the cost has no runs ratio beside it: "$0.28+ 1/2" read as incomplete and complete at once.
	assert.deepEqual(await workflow("deep-review"), [
		"deep-review",
		"2",
		"Needs work",
		"1m 37s",
		"$0.28",
		["warn", "run"],
	]);
	assert.deepEqual(await workflow("spec-review"), [
		"spec-review",
		"1",
		"Failed",
		"n/a",
		"$0.0061",
		["err"],
	]);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector(
					'[data-workflow="deep-review"] td.n:nth-child(5)',
				).title,
		),
		"8 of 8 agents reported cost, 1 of 2 runs reported",
		"the runs ratio is in the tooltip",
	);
	// The workflow's name leads to the Workflows page, and the section links there too.
	assert.deepEqual(
		await browser.evaluate(() => [
			document
				.querySelector('[data-workflow="deep-review"] td.c-wf a')
				.getAttribute("href"),
			document.querySelector(".home-manage").textContent,
		]),
		["/?project=payments-api-123456789abc&view=workflows", "Manage →"],
	);
	// Selecting a run opens it as before; back returns to the overview.
	await browser.click('#home-recent .home-row[data-run="' + complete + '"]');
	await browser.waitFor(() => document.querySelector("#task-count"));
	assert.deepEqual(await route(browser), [complete, null]);
	await browser.evaluate(() => history.back());
	await browser.waitFor(() => document.querySelector("#home-view"));
	assert.deepEqual(await route(browser), [null, null]);
	assert.equal(
		await browser.evaluate(
			() => !!document.querySelector("#canvas, #run-header"),
		),
		false,
	);
	// Inspect opens the run with the task that needs a decision selected, and no dialog: the person
	// looks first and presses Resume on the run (owner, pass 2).
	await browser.click('.home-need [class~="primary"]');
	await browser.waitFor(() =>
		document.querySelector("#inspector:not([hidden])"),
	);
	assert.deepEqual(
		await browser.evaluate(() => {
			const url = new URL(location.href);
			return [
				url.searchParams.get("run"),
				url.searchParams.get("task"),
				url.searchParams.get("dialog"),
				document.querySelector("dialog[open]") === null,
			];
		}),
		[blocked, "adaptive.controller", null, true],
	);
	// The run list changes: a finished run leaves "Running now" for the results, live.
	await browser.click('.management-nav a:not([href*="view="])');
	await browser.waitFor(() => document.querySelector("#home-view"));
	const done = fixture.runs.get(running);
	done.status = "completed";
	done.verdict = "NEEDS_WORK";
	done.live = false;
	fixture.publish();
	await browser.waitFor(
		() =>
			document.querySelector("#home-running .home-calm")?.textContent ===
			"Nothing running right now.",
	);
	assert.equal((await recent())[0][0], "Needs work");
	const typography = await measureTypography(browser);
	assert.ok(
		typography.smallest >= 12 && typography.large / typography.total >= 0.6,
		JSON.stringify(typography),
	);
});

test("dashboard Chrome: existing run links and the Runs item still open a run; the overview fits a phone", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	overviewFixture(fixture);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/?run=${complete}&task=triage.main`);
	assert.deepEqual(await route(browser), [complete, null]);
	assert.equal(
		await browser.evaluate(() =>
			new URL(location.href).searchParams.get("task"),
		),
		"triage.main",
	);
	assert.equal(
		await browser.evaluate(() => !!document.querySelector("#home-view")),
		false,
	);
	// The run details count agents for the cost ratio too: 8 of 8, not the 10 of 16 tasks the engine counts.
	await browser.open(`${fixture.origin}/?run=${complete}&view=details`);
	await browser.waitFor(() => document.querySelector("#inspector dl"));
	assert.match(
		await text2(browser, "#inspector"),
		/Coverage8 \/ 8 agents reporting/,
	);
	assert.doesNotMatch(await text2(browser, "#inspector"), /tasks reporting/);
	// The nav's Runs item opens the latest run (a running one first), as the landing used to.
	await browser.open(`${fixture.origin}/?view=runs`);
	assert.deepEqual(await route(browser), [running, null]);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('.management-nav a[aria-current="page"]')
					.textContent,
		),
		"Runs",
	);
	await browser.click('.management-nav a:not([href*="view="])');
	await browser.waitFor(() => document.querySelector("#home-view"));
	assert.deepEqual(await route(browser), [null, null]);
	// A phone: one column, the workflows table stacks, nothing runs past the width.
	await browser.open(`${fixture.origin}/`, 390, 844);
	await browser.waitFor(() => document.querySelector(".home-table"));
	assert.deepEqual(
		await browser.evaluate(() => ({
			page: document.documentElement.scrollWidth <= innerWidth,
			view:
				document.querySelector("#home-view").scrollWidth <=
				document.querySelector("#home-view").clientWidth,
			head: getComputedStyle(document.querySelector(".home-table thead"))
				.display,
			rows: [
				...document.querySelectorAll(".home-row.recent, .home-table tr"),
			].every((row) => row.getBoundingClientRect().right <= innerWidth),
		})),
		{ page: true, view: true, head: "none", rows: true },
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector(".home-stats").getBoundingClientRect().right <=
				innerWidth,
		),
		true,
	);
	// 2026-11-12 (review, P3-2): the three stats stand in a column, each value on one line.
	assert.deepEqual(
		await browser.evaluate(() => {
			const stats = [...document.querySelectorAll(".home-stat")].map((stat) =>
				stat.getBoundingClientRect(),
			);
			const values = [...document.querySelectorAll(".home-stat-value")].map(
				(value) => value.getBoundingClientRect().height,
			);
			return {
				column: stats.every(
					(box, index) => index === 0 || box.top >= stats[index - 1].bottom - 1,
				),
				oneLine: values.every((height) => height <= 30),
			};
		}),
		{ column: true, oneLine: true },
	);
});

// 2026-11-12 (review fixes): the UI/UX review of the report page and the overview, and the owner's
// decisions on it. Each test names the review item it holds.
const fixtureSnapshots = async () => {
	const dir = new URL("../fixtures/dashboard/", import.meta.url);
	return Promise.all(
		(await readdir(dir))
			.filter((name) => name.startsWith("run-"))
			.map(async (name) =>
				JSON.parse(await readFile(new URL(name, dir), "utf8")),
			),
	);
};
const reviewFixture = async (t, options = {}) => {
	const fixture = await createFixtureServer(options);
	t.after(() => fixture.close());
	fixture.reports.set(complete, deepReport);
	overviewFixture(fixture);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	return { fixture, browser };
};
const chromeOptions = {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 120_000,
};
/**
 * Where the icon of every badge-like element sits against its box and its text (P1-1). The icon is
 * centred when its centre is the box's centre; the padding is balanced when the gap before the icon
 * and the gap after the text are alike (the border and padding of the box included).
 */
const measureBadges = (browser, selector) =>
	browser.evaluate((selector) => {
		const textRight = (node) => {
			const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			let last = null,
				text;
			while ((text = walker.nextNode()))
				if (text.textContent.trim()) last = text;
			const range = document.createRange();
			range.selectNodeContents(last);
			return range.getBoundingClientRect().right;
		};
		return [...document.querySelectorAll(selector)].map((node) => {
			const box = node.getBoundingClientRect();
			const mark = node.querySelector(
				":scope > .glyph .status-icon, :scope > .outline-dot",
			);
			const icon = mark.getBoundingClientRect();
			const style = getComputedStyle(node);
			return {
				text: node.textContent.trim(),
				centre: icon.top + icon.height / 2 - (box.top + box.height / 2),
				before: icon.left - box.left,
				after: box.right - textRight(node),
				background: style.backgroundColor,
				radius: style.borderTopLeftRadius,
				border: style.borderTopWidth,
				height: box.height,
			};
		});
	}, selector);
/** `framed`: a label (severity, verifier) keeps its hairline frame; a run's status is unframed. */
const checkBadges = (rows, where, height, framed = true) => {
	assert.ok(rows.length > 0, `${where}: there are badges`);
	for (const row of rows) {
		assert.ok(
			Math.abs(row.centre) <= 0.5,
			`${where}: "${row.text}" icon is ${row.centre}px off the centre of its box`,
		);
		assert.ok(
			Math.abs(row.before - row.after) <= 3,
			`${where}: "${row.text}" has ${row.before}px before the icon and ${row.after}px after the text`,
		);
		// The owner's 2026-11-03 rule stands: glyph + word, colour on the glyph only, no tinted chips.
		assert.equal(
			row.background,
			"rgba(0, 0, 0, 0)",
			`${where}: "${row.text}" has a fill`,
		);
		// 2026-11-13 (owner, "follow the references"): a run's status is a glyph and a word with no
		// frame, starting on its column's edge (Inngest, Vercel, Linear); labels keep the frame.
		if (framed)
			assert.equal(
				row.radius,
				"6px",
				`${where}: "${row.text}" has the label shape`,
			);
		else
			assert.deepEqual(
				[row.border, row.before],
				["0px", 0],
				`${where}: "${row.text}" is unframed and starts on its edge`,
			);
		if (height)
			assert.equal(row.height, height, `${where}: "${row.text}" height`);
	}
};

test(
	"dashboard Chrome: badges, chips and pills centre their icon, balance their padding and carry no fill (P1-1, P2-10, P3-9)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		// The report page: the header badge (28px); severity chips and verifier pills (24px).
		await browser.open(`${fixture.origin}/?run=${complete}&view=report`);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		checkBadges(
			await measureBadges(browser, ".report-head .result-badge"),
			"report header",
			28,
			false,
		);
		checkBadges(
			await measureBadges(browser, ".severity-chip"),
			"severity chips",
			24,
		);
		checkBadges(
			await measureBadges(browser, ".verifier-pill"),
			"verifier pills",
			24,
		);
		// Controls keep the control shape: the filter chips are 8px-radius, 28px buttons (P2-10).
		assert.deepEqual(
			await browser.evaluate(() => {
				const chip = document.querySelector(".filter-chip");
				const style = getComputedStyle(chip);
				return [style.borderTopLeftRadius, chip.getBoundingClientRect().height];
			}),
			["8px", 28],
		);
		// The overview: Stopped (the owner's), Failed and the others, in Recent results and the table.
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		await browser.click('[data-home-key="stopped"]');
		const recent = await measureBadges(
			browser,
			".home-row.recent .result-badge",
		);
		assert.ok(recent.some((row) => row.text === "Stopped"));
		checkBadges(recent, "recent results", 24, false);
		checkBadges(
			await measureBadges(browser, ".home-table .result-badge"),
			"workflows table",
			24,
			false,
		);
		// The run view: the rail's rows, the result line, the top bar's button. Each icon is centred
		// on its row; these are not boxes, so only the centre is held.
		await browser.open(`${fixture.origin}/?run=${failed}`);
		await browser.waitFor(() => document.querySelector(".run-row"));
		const centred = await browser.evaluate(() =>
			[".run-row > .row", ".needs-button", ".result-verdict", ".home-need"]
				.flatMap((selector) => [...document.querySelectorAll(selector)])
				.filter((row) => row.querySelector(":scope > .glyph .status-icon"))
				.map((row) => {
					const icon = row
						.querySelector(":scope > .glyph .status-icon")
						.getBoundingClientRect();
					const box = row.getBoundingClientRect();
					return [
						row.className,
						Math.abs(icon.top + icon.height / 2 - (box.top + box.height / 2)),
					];
				}),
		);
		assert.ok(centred.length >= 3, JSON.stringify(centred));
		for (const [name, off] of centred)
			assert.ok(off <= 0.5, `${name}: icon ${off}px off the centre of its row`);
	},
);

test(
	"dashboard Chrome: the report at 2304px has its outline right of the body, under the header, with one reading measure (P1-2)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			2304,
			1190,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		const rect = (selector) =>
			browser.evaluate((selector) => {
				const r = document.querySelector(selector).getBoundingClientRect();
				return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
			}, selector);
		const [rail, head, body, outline, card, paragraph, view] =
			await Promise.all(
				[
					"#rail",
					".report-head",
					".report-body",
					".report-outline",
					".finding-card",
					".report-content p",
					"#report-view",
				].map(rect),
			);
		assert.ok(outline.left >= body.right, "the outline is right of the body");
		assert.ok(
			outline.top >= head.bottom,
			"the outline starts under the header, not beside it",
		);
		assert.ok(
			Math.abs(head.left - body.left) <= 1,
			"the header and the body share a left edge",
		);
		assert.ok(
			outline.right <= head.right + 1,
			"the outline ends where the header ends",
		);
		// One measure: paragraphs and cards fill the same column.
		assert.ok(paragraph.right <= body.right + 1);
		assert.ok(Math.abs(card.right - body.right) <= 1, "cards fill the column");
		assert.ok(Math.abs(card.left - body.left) <= 1);
		// No big empty gap: the block is centred in the page with the same margin on each side, and the
		// first content starts well inside the old 700px.
		const left = head.left - rail.right,
			right = view.right - head.right;
		assert.ok(
			Math.abs(left - right) <= 18,
			`centred: ${left} against ${right}`,
		);
		assert.ok(
			left <= 560,
			`the gap between the rail and the content is ${left}px`,
		);
		assert.equal(await text2(browser, ".outline-title"), "On this page");
		// 1100px: the page beside the rail is narrower than 900px, so the outline folds above the body.
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			1100,
			900,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		assert.deepEqual(
			await browser.evaluate(() => {
				const view = document.querySelector("#report-view");
				const outline = document.querySelector(".report-outline");
				const body = document.querySelector(".report-body");
				return {
					folded:
						getComputedStyle(document.querySelector(".outline-toggle"))
							.display !== "none",
					above:
						outline.getBoundingClientRect().bottom <=
						body.getBoundingClientRect().top + 1,
					bodyWidth: body.getBoundingClientRect().width >= 600,
					overflow: view.scrollWidth <= view.clientWidth,
				};
			}),
			{ folded: true, above: true, bodyWidth: true, overflow: true },
		);
	},
);

test(
	"dashboard Chrome: the outline highlight agrees with a click, reaches the last sections, and keeps its ring (P2-1, P1-4)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			1440,
			900,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		const settle = () =>
			browser.waitFor(
				() =>
					new Promise((resolve) => {
						const view = document.querySelector("#report-view");
						const before = view.scrollTop;
						setTimeout(() => resolve(view.scrollTop === before), 300);
					}),
			);
		const current = () => text2(browser, ".outline-link.current");
		for (const label of [
			"finding-002: Missing id returns 200 instead of 400",
			"Related artifacts",
			"Limitations",
			"Evidence and review coverage",
		]) {
			await browser.evaluate(
				(label) =>
					[...document.querySelectorAll(".outline-link")]
						.find((link) => link.title === label || link.textContent === label)
						.click(),
				label,
			);
			await settle();
			// What was clicked stays current, also when the page cannot scroll that section to the top.
			assert.equal(
				await browser.evaluate((label) => {
					const link = document.querySelector(".outline-link.current");
					return link.title === label || link.textContent === label;
				}, label),
				true,
				`clicking "${label}" ends with "${await current()}"`,
			);
		}
		// A section reached by a click is not under the top bar: its top has a margin from the page's top.
		await browser.evaluate(() =>
			[...document.querySelectorAll(".outline-link")]
				.find((link) => link.title.startsWith("finding-002"))
				.click(),
		);
		await settle();
		const gap = await browser.evaluate(
			() =>
				document
					.querySelector('.finding-card[aria-label="finding-002"]')
					.getBoundingClientRect().top -
				document.querySelector("#report-view").getBoundingClientRect().top,
		);
		assert.ok(
			gap >= 8 && gap <= 24,
			`the card starts ${gap}px under the top of the page`,
		);
		// Reading by hand takes over: the end of the page is the last section, and the middle follows.
		await browser.evaluate(() => {
			const view = document.querySelector("#report-view");
			view.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
			view.scrollTop = view.scrollHeight;
		});
		await browser.waitFor(
			() =>
				document.querySelector(".outline-link.current")?.textContent ===
				"Related artifacts",
		);
		await browser.evaluate(() => {
			const view = document.querySelector("#report-view");
			view.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
			const card = document.querySelector(
				'.finding-card[aria-label="finding-003"]',
			);
			view.scrollTop +=
				card.getBoundingClientRect().top -
				view.getBoundingClientRect().top -
				40;
		});
		await browser.waitFor(() =>
			document
				.querySelector(".outline-link.current")
				?.title.startsWith("finding-003"),
		);
		// The ring of a focused outline link is drawn inside the link: the outline scrolls, which would
		// cut one drawn outside (P1-4).
		const ring = await browser.evaluate(() => {
			const link = document.querySelector(".outline-link");
			link.focus();
			const style = getComputedStyle(link);
			const box = link.getBoundingClientRect();
			const clip = link.closest(".report-outline").getBoundingClientRect();
			const grow =
				parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
			return {
				visible: link.matches(":focus-visible"),
				inside:
					box.left - grow >= clip.left &&
					box.right + grow <= clip.right &&
					box.top - grow >= clip.top,
			};
		});
		assert.deepEqual(ring, { visible: true, inside: true });
	},
);

test(
	"dashboard Chrome: a long outline scrolls to its current entry and stays under the top bar (P2-1)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		const many = Array.from(
			{ length: 40 },
			(_, index) =>
				`## Section number ${index + 1}\n\nText of section ${index + 1}.\n\n`,
		).join("");
		fixture.reports.set(complete, `# Long report\n\n${many}`);
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			1280,
			700,
		);
		await browser.waitFor(() => document.querySelector(".outline-link"));
		assert.deepEqual(
			await browser.evaluate(() => {
				const nav = document.querySelector(".report-outline");
				const view = document.querySelector("#report-view");
				return {
					scrolls: nav.scrollHeight > nav.clientHeight,
					// The outline never runs under the top bar: its box fits the page's own height.
					fits: nav.getBoundingClientRect().height <= view.clientHeight - 48,
				};
			}),
			{ scrolls: true, fits: true },
		);
		await browser.evaluate(() => {
			const view = document.querySelector("#report-view");
			view.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
			view.scrollTop = view.scrollHeight;
		});
		await browser.waitFor(
			() =>
				document.querySelector(".outline-link.current")?.textContent ===
				"Section number 40",
		);
		assert.deepEqual(
			await browser.evaluate(() => {
				const nav = document
					.querySelector(".report-outline")
					.getBoundingClientRect();
				const link = document
					.querySelector(".outline-link.current")
					.getBoundingClientRect();
				const view = document
					.querySelector("#report-view")
					.getBoundingClientRect();
				return {
					inView: link.top >= nav.top - 1 && link.bottom <= nav.bottom + 1,
					belowTopBar: nav.top >= view.top,
				};
			}),
			{ inView: true, belowTopBar: true },
		);
		// A section near the end cannot be scrolled to the top of the page; what was clicked is still
		// the current one, not the last section the page ends on (the click starts a long scroll).
		await browser.evaluate(() => {
			const view = document.querySelector("#report-view");
			view.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
			view.scrollTop = 0;
		});
		await browser.waitFor(
			() =>
				document.querySelector(".outline-link.current")?.textContent ===
				"Section number 1",
		);
		await browser.evaluate(() =>
			[...document.querySelectorAll(".outline-link")]
				.find((link) => link.textContent === "Section number 38")
				.click(),
		);
		await browser.waitFor(
			() =>
				new Promise((resolve) => {
					const view = document.querySelector("#report-view");
					const before = view.scrollTop;
					setTimeout(() => resolve(view.scrollTop === before), 300);
				}),
		);
		assert.equal(
			await text2(browser, ".outline-link.current"),
			"Section number 38",
		);
		assert.deepEqual(
			await browser.evaluate(() => {
				const view = document.querySelector("#report-view");
				return view.scrollTop + view.clientHeight >= view.scrollHeight - 2;
			}),
			true,
			"the page is at its end, so section 38 could not reach the top",
		);
	},
);

test(
	"dashboard Chrome: a finding card puts its rationale and action first, then the folds (P3-1); filters say what they did (P2-5)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			1440,
			900,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		assert.deepEqual(
			await browser.evaluate(() =>
				[...document.querySelector(".finding-card").children]
					.map((part) =>
						part.matches("details")
							? "fold"
							: part.querySelector(".part-label")?.textContent,
					)
					.filter(Boolean),
			),
			["Rationale", "Recommended action", "fold", "fold", "fold"],
		);
		// A closed fold is one 28px row, not a 40px one.
		assert.deepEqual(
			await browser.evaluate(() =>
				[
					...document.querySelectorAll(
						".finding-card:first-of-type .finding-fold > summary",
					),
				].map((summary) => summary.getBoundingClientRect().height),
			),
			[28, 28, 28],
		);
		// A pressed chip is the page's text colour on its background: seen from far up the page.
		await browser.click('[data-filter-value="weakened"]');
		// (the pointer is still over it: a pressed chip keeps its look under the pointer)
		await browser.waitFor(
			() =>
				getComputedStyle(
					document.querySelector('.filter-chip[data-filter-value="weakened"]'),
				).backgroundColor ===
				getComputedStyle(document.querySelector("#report-view")).color,
		);
		assert.deepEqual(
			await browser.evaluate(() => {
				const chip = document.querySelector(
					'.filter-chip[data-filter-value="weakened"]',
				);
				const style = getComputedStyle(chip);
				const page = getComputedStyle(document.querySelector("#report-view"));
				return [
					style.backgroundColor === page.color,
					style.color === page.backgroundColor,
				];
			}),
			[true, true],
		);
		await browser.click(".filter-clear");
		assert.equal(await text2(browser, ".filter-count"), "");
		assert.equal(
			await browser.evaluate(
				() => document.querySelectorAll(".finding-card:not([hidden])").length,
			),
			4,
		);
	},
);

test(
	"dashboard Chrome: the report's title is a label, its header is one block, and the page theme can follow the dashboard again (P2-4, P3-5, P3-6, P3-7, P3-8)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			1440,
			900,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		// The document's own title is quiet (13px label); the page's sentence is the largest text.
		assert.deepEqual(
			await browser.evaluate(() => {
				const label = getComputedStyle(
					document.querySelector(".report-content > .md-h1"),
				);
				const sentence = getComputedStyle(
					document.querySelector(".report-summary"),
				);
				return [parseFloat(label.fontSize), parseFloat(sentence.fontSize)];
			}),
			[13, 22],
		);
		// Meta items are spaced by the layout (a gap), with no mark between them.
		assert.deepEqual(
			await browser.evaluate(() => {
				const meta = document.querySelector(".report-meta");
				return [
					meta.children.length,
					getComputedStyle(meta).columnGap,
					/[·—]/.test(meta.textContent),
				];
			}),
			[5, "16px", false],
		);
		// The tab says where it is.
		assert.equal(
			await browser.evaluate(() => document.title),
			"Report | deep-review | payments-api",
		);
		// Focus starts on the page, so the first Tab reaches Copy as Markdown, not the filters.
		assert.equal(
			await browser.evaluate(() => document.activeElement.id),
			"report-view",
		);
		await browser.key("Tab");
		assert.equal(
			await browser.evaluate(() => document.activeElement.className),
			"copy-report",
		);
		// "Light page"/"Dark page" is a pin only while it differs from the dashboard: pressing it again
		// returns to following it.
		const pinned = () =>
			browser.evaluate(() => [
				document.querySelector("#report-view").dataset.page ?? null,
				localStorage.getItem("agent-workflow:report-page"),
			]);
		assert.deepEqual(await pinned(), [null, null]);
		await browser.click(".report-page");
		const [page, stored] = await pinned();
		assert.ok(page === "light" || page === "dark");
		assert.equal(stored, page);
		await browser.click(".report-page");
		assert.deepEqual(await pinned(), [null, null]);
		// The overview's tab, and the heading's accessible name.
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		assert.equal(
			await browser.evaluate(() => document.title),
			"Overview | payments-api",
		);
	},
);

test(
	"dashboard Chrome: the rail has no run groups on the overview, and has them again with a run (P2-2)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		const rail = () =>
			browser.evaluate(() => ({
				headings: [...document.querySelectorAll("#rail .rail-heading")].map(
					(node) => node.querySelector("span")?.textContent ?? node.textContent,
				),
				runs: document.querySelectorAll("#rail .run-row").length,
				needs: document.querySelectorAll("#rail .need").length,
				switcher: !!document.querySelector("#rail #project-switcher"),
				nav: document.querySelectorAll("#rail .management-nav a").length,
			}));
		assert.deepEqual(await rail(), {
			headings: [],
			runs: 0,
			needs: 0,
			switcher: true,
			nav: 6,
		});
		// The top bar's "Needs you" leads to the needs the page itself lists.
		await browser.click(".needs-button");
		assert.equal(
			await browser.evaluate(
				() => !!document.activeElement.closest("#home-needs"),
			),
			true,
		);
		// A run brings the groups back (the rail is how to switch runs)...
		await browser.click('#home-recent .home-row[data-run="' + complete + '"]');
		await browser.waitFor(() => document.querySelector("#task-count"));
		const open = await rail();
		// No "Needs you" group: each need is on its run's own row (owner, pass 2).
		assert.deepEqual(open.headings, ["Runs"]);
		assert.ok(
			open.runs >= 6 && open.needs >= 1 && open.switcher && open.nav === 6,
		);
		// ...and the report page too; going back to the overview takes them away again.
		await browser.click(
			'[data-action="open-report"], #run-header button:not([data-action])',
		);
		await browser.evaluate(() => history.back());
		await browser.evaluate(() => history.back());
		await browser.waitFor(() => document.querySelector("#home-view"));
		assert.deepEqual(await rail(), {
			headings: [],
			runs: 0,
			needs: 0,
			switcher: true,
			nav: 6,
		});
	},
);

test(
	"dashboard Chrome: an ended run shows its active time in the rail and the run header; a live run keeps its clock (P1-5)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		// Created 07:00 and last updated 07:06: six minutes of wall clock, 2m 15s of work.
		await browser.open(`${fixture.origin}/?run=${failed}`);
		await browser.waitFor(() => document.querySelector(".run-row"));
		const elapsed = (id) =>
			browser.evaluate(
				(id) =>
					document.querySelector(`[data-run-elapsed="${id}"]`).textContent,
				id,
			);
		assert.equal(await elapsed(failed), "2m 15s");
		assert.match(await text2(browser, "#hero-sub"), /^spec-review, 2m 15s, /);
		// The overview says the same about the same run (and the report calls it "active").
		assert.equal(await elapsed(complete), "1m 37s");
		// A running run shows the clock: its wall time is not its (smaller) active time.
		assert.notEqual(await elapsed(running), "5s");
		fixture.runs.get(running).activeMs = 5_000;
		fixture.publish();
		await browser.waitFor(() =>
			document.querySelector('[data-run-elapsed="workflow_mvt9k2qa_7c41e0"]'),
		);
		assert.notEqual(await elapsed(running), "5s");
	},
);

test(
	"dashboard Chrome: the overview's calm state is one line; one empty section keeps its heading without a box (P2-9)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		for (const run of fixture.runs.values()) {
			if (["running", "blocked", "failed"].includes(run.status))
				run.status = "completed";
			run.needsYou = [];
			run.live = false;
		}
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		assert.deepEqual(
			await browser.evaluate(() => ({
				line: document.querySelector("#home-status")?.textContent,
				sections: [...document.querySelectorAll(".home-section > h2")].map(
					(node) => node.querySelector("span").textContent,
				),
				box: (() => {
					const style = getComputedStyle(
						document.querySelector("#home-status"),
					);
					return [style.borderTopWidth, style.backgroundColor];
				})(),
			})),
			{
				line: "Nothing needs you and nothing is running.",
				sections: ["Recent results", "This project", "Workflows"],
				box: ["0px", "rgba(0, 0, 0, 0)"],
			},
		);
		// With something running, "Needs you" is the quiet line and "Running now" has its row.
		const live = fixture.runs.get(running);
		live.status = "running";
		live.live = true;
		fixture.publish();
		await browser.waitFor(() =>
			document.querySelector("#home-running .home-row"),
		);
		assert.deepEqual(
			await browser.evaluate(() => ({
				status: !!document.querySelector("#home-status"),
				needs: document.querySelector("#home-needs .home-calm")?.textContent,
				box: getComputedStyle(document.querySelector("#home-needs .home-calm"))
					.borderTopWidth,
			})),
			{ status: false, needs: "Nothing needs you.", box: "0px" },
		);
	},
);

test(
	"dashboard Chrome: Show all expands the results in place, the Runs item prefers a run that is not stopped, Last result is the last one that finished (P2-3)",
	chromeOptions,
	async (t) => {
		const snapshots = await fixtureSnapshots();
		const docs = snapshots.find((run) => run.runId === docsWriter);
		// Six more finished runs, older than everything else, and a newer docs-writer that was stopped.
		const more = Array.from({ length: 6 }, (_, index) => ({
			...structuredClone(docs),
			runId: `workflow_mvt1t1i7_old${index}`,
			createdAt: `2026-10-2${index}T04:33:36.224Z`,
			updatedAt: `2026-10-2${index}T04:33:42.001Z`,
		}));
		const stoppedDocs = {
			...structuredClone(docs),
			runId: "workflow_mvt1t1i7_stop00",
			status: "interrupted",
			createdAt: "2026-10-29T09:00:00.000Z",
			updatedAt: "2026-10-29T09:00:20.000Z",
		};
		const { browser, fixture } = await reviewFixture(t, {
			snapshots: [...snapshots, ...more, stoppedDocs],
		});
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		const rows = () =>
			browser.evaluate(() => ({
				rows: document.querySelectorAll("#home-recent .home-row.recent").length,
				stopped: document.querySelectorAll(
					"#home-recent .result-badge.interrupted",
				).length,
				button:
					document.querySelector('[data-home-key="all"]')?.textContent ?? null,
				toggle:
					document.querySelector('[data-home-key="stopped"]')?.textContent ??
					null,
				link: !!document.querySelector("a.home-all"),
				focus: document.activeElement?.dataset?.homeKey ?? null,
			}));
		// Eight results, the stopped ones hidden; the button names how many there are in all.
		const before = await rows();
		assert.deepEqual(
			[before.rows, before.stopped, before.button, before.toggle, before.link],
			// 14 runs: one is running and two need you, so they are not results.
			[8, 0, "Show all 11", "Show 2 stopped runs", false],
		);
		await browser.click('[data-home-key="all"]');
		// In place: the address is the overview's, every result is listed, stopped ones with them.
		assert.deepEqual(await route(browser), [null, null]);
		const all = await rows();
		assert.deepEqual(
			[all.rows, all.stopped, all.button, all.toggle, all.focus],
			[11, 2, "Show fewer", null, "all"],
		);
		await browser.click('[data-home-key="all"]');
		assert.equal((await rows()).rows, 8);
		// Last result: the workflow's last run that finished. docs-writer's newest run was stopped.
		assert.equal(
			await browser.evaluate(() =>
				document
					.querySelector('[data-workflow="docs-writer"] td:nth-child(3)')
					.textContent.trim(),
			),
			"Finished",
		);
		// The nav's Runs item: the running run first; without one, the newest that is not stopped.
		const order = await browser.evaluate(async (project) => {
			const data = await (await fetch(`/api/projects/${project}/runs`)).json();
			return data.runs.map((summary) => [summary.runId, summary.status]);
		}, "payments-api-123456789abc");
		await browser.open(`${fixture.origin}/?view=runs`);
		assert.deepEqual((await route(browser))[0], running);
		for (const run of fixture.runs.values())
			if (run.status === "running") run.status = "completed";
		fixture.runs.get(order[0][0]).status = "interrupted";
		await browser.open(`${fixture.origin}/?view=runs`);
		const expected = order.find(
			([, status]) => !["running", "interrupted"].includes(status),
		);
		assert.ok(expected && expected[0] !== order[0][0]);
		assert.deepEqual((await route(browser))[0], expected[0]);
	},
);

test(
	"dashboard Chrome: the overview's parts follow their own width: no clipped table, a readable results list (P1-3, P2-8)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		for (const [width, height] of [
			[1280, 800],
			[1180, 800],
			[1440, 900],
			[2304, 1190],
			[1101, 800],
		]) {
			await browser.open(`${fixture.origin}/`, width, height);
			await browser.waitFor(() => document.querySelector(".home-table"));
			const fit = await browser.evaluate(() => {
				const wrap = document.querySelector(".home-table-wrap");
				const box = wrap.getBoundingClientRect();
				const table = document.querySelector(".home-table");
				const strips = [...document.querySelectorAll(".home-table .strip")].map(
					(strip) => strip.getBoundingClientRect(),
				);
				const task = document.querySelector(".home-row-task");
				return {
					// Nothing of the table is cut off: its box is inside the wrapper, and every outcome strip
					// is drawn inside it too.
					table: table.getBoundingClientRect().right <= box.right + 0.5,
					strips: strips.every(
						(strip) => strip.right <= box.right && strip.width > 0,
					),
					page: document.documentElement.scrollWidth <= innerWidth,
					task: task.getBoundingClientRect().width,
				};
			});
			assert.equal(fit.table, true, `${width}px: the table fits its box`);
			assert.equal(
				fit.strips,
				true,
				`${width}px: the "Last runs" strips are visible`,
			);
			assert.equal(fit.page, true, `${width}px: no sideways scroll`);
			assert.ok(
				fit.task >= 180,
				`${width}px: the task text is ${fit.task}px wide`,
			);
		}
	},
);

// 2026-11-12 (owner, pass 2): look first. Every way into a need opens the run with the failing
// task selected and the inspector showing what failed; "Resume…" is a button on the run.
test(
	"dashboard Chrome: Inspect opens the failing task with no dialog, from the overview and from the rail; Resume stays an explicit button",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		const where = () =>
			browser.evaluate(() => {
				const url = new URL(location.href);
				return {
					run: url.searchParams.get("run"),
					task: url.searchParams.get("task"),
					dialog: url.searchParams.get("dialog"),
					open: document.querySelector("dialog[open]") !== null,
					inspector: !document.querySelector("#inspector").hidden,
					text: document.querySelector("#inspector").textContent,
				};
			});
		// From the overview card.
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-need"));
		await browser.evaluate(() =>
			document
				.querySelector(
					`.home-need[data-run="${"workflow_mvt8x01c_aa3e91"}"] .primary`,
				)
				.click(),
		);
		await browser.waitFor(() => document.querySelector("#task-status"));
		let now = await where();
		assert.equal(now.run, failed);
		assert.equal(now.task, "map-implementation.main");
		assert.equal(now.dialog, null);
		assert.equal(now.open, false, "no dialog opens by itself");
		assert.equal(now.inspector, true);
		assert.match(now.text, /map-implementation/);
		// Resume is the person's own press on the run, and it opens the existing confirm dialog.
		await browser.click('[data-action="resume"]');
		await browser.waitFor(() => document.querySelector("dialog[open]"));
		assert.match(await text2(browser, "#dialog-title"), /^Resume spec-review/);
		await browser.key("Escape");
		// From the rail, with another run open.
		await browser.open(`${fixture.origin}/?run=${complete}`);
		await browser.waitFor(() =>
			document.querySelector(
				`.run-row[data-run="workflow_mvt8x01c_aa3e91"] .need`,
			),
		);
		await browser.click(`.run-row[data-run="${failed}"] .need`);
		await browser.waitFor(
			() =>
				new URL(location.href).searchParams.get("run") !==
				"workflow_mvt23704_e8e6d7",
		);
		await browser.waitFor(() => document.querySelector("#task-status"));
		now = await where();
		assert.equal(now.run, failed);
		assert.equal(now.task, "map-implementation.main");
		assert.equal(now.open, false);
		assert.match(now.text, /map-implementation/);
		// A link that asks for the dialog still gets it.
		await browser.open(`${fixture.origin}/?run=${failed}&dialog=resume`);
		await browser.waitFor(() => document.querySelector("dialog[open]"));
		assert.match(await text2(browser, "#dialog-title"), /^Resume spec-review/);
	},
);

test(
	"dashboard Chrome: a need is on its run's own row in the rail; dismissing it works there",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(`${fixture.origin}/?run=${complete}`);
		await browser.waitFor(() =>
			document.querySelector(
				`.run-row[data-run="workflow_mvt8x01c_aa3e91"] .need`,
			),
		);
		const rail = () =>
			browser.evaluate((failed) => {
				const row = document.querySelector(`.run-row[data-run="${failed}"]`);
				const text = (node) => node?.textContent.replace(/\s+/g, " ").trim();
				return {
					headings: [...document.querySelectorAll("#rail .rail-heading")].map(
						(node) =>
							node.querySelector("span")?.textContent ?? node.textContent,
					),
					// The same run appears once.
					rows: document.querySelectorAll(`.run-row[data-run="${failed}"]`)
						.length,
					name: text(row.querySelector(".row .grow")),
					task: text(row.querySelector(".run-task")),
					need: text(row.querySelector(".need")),
					reason: text(row.querySelector(".need-title")),
					dismiss: row
						.querySelector(".need-dismiss")
						?.getAttribute("aria-label"),
					meta: text(row.querySelector(".run-meta")),
					needs: document.querySelectorAll("#rail .need").length,
					restore: text(document.querySelector("#rail .need-restore")),
				};
			}, failed);
		let now = await rail();
		// No "Needs you" group; the run's own identity lines stay; the need sits in the row.
		assert.deepEqual(now.headings, ["Runs"]);
		assert.equal(now.rows, 1);
		assert.equal(now.name, "spec-review");
		assert.equal(now.need, "Needs youInspectFailed at map-implementation");
		assert.equal(now.reason, "Failed at map-implementation");
		assert.equal(now.dismiss, "Dismiss: Failed at map-implementation");
		assert.doesNotMatch(
			now.meta,
			/Failed/,
			"the meta line does not say it twice",
		);
		assert.equal(now.needs, 2, "the decision is on its own row too");
		// Dismiss: the need leaves the row, the word returns to the meta line, and it can be restored.
		await browser.click(`.run-row[data-run="${failed}"] .need-dismiss`);
		await browser.waitFor(
			() =>
				!document.querySelector(
					`.run-row[data-run="workflow_mvt8x01c_aa3e91"] .need`,
				),
		);
		now = await rail();
		assert.equal(now.need, undefined);
		assert.match(now.meta, /^Failed/);
		assert.equal(now.needs, 1);
		assert.equal(now.restore, "Show 1 dismissed");
		await browser.click("#rail .need-restore");
		await browser.waitFor(() =>
			document.querySelector(
				`.run-row[data-run="workflow_mvt8x01c_aa3e91"] .need`,
			),
		);
		assert.equal((await rail()).needs, 2);
	},
);

test(
	"dashboard Chrome: the overview's need leads with the run's identity and a dismissed run is a result again",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-need"));
		const card = () =>
			browser.evaluate((failed) => {
				const node = document.querySelector(`.home-need[data-run="${failed}"]`);
				if (!node) return null;
				return {
					lines: [...node.querySelector(".home-need-body").children].map(
						(child) => child.textContent.replace(/\s+/g, " ").trim(),
					),
					recent: [...document.querySelectorAll("#home-recent .home-row")].map(
						(row) => row.dataset.run,
					),
				};
			}, failed);
		const before = await card();
		// The workflow, then the reason in the rail's wording, how far it got and when, then the buttons.
		assert.equal(before.lines[0], "spec-review");
		assert.match(before.lines[1], /^Failed at map-implementation/);
		assert.equal(before.lines.at(-1), "InspectDismiss");
		assert.ok(!before.recent.includes(failed), "not listed twice");
		await browser.click(
			`.home-need[data-run="${failed}"] button:not(.primary)`,
		);
		await browser.waitFor(
			() =>
				!document.querySelector(
					`.home-need[data-run="workflow_mvt8x01c_aa3e91"]`,
				),
		);
		assert.ok(
			(
				await browser.evaluate(() =>
					[...document.querySelectorAll("#home-recent .home-row")].map(
						(row) => row.dataset.run,
					),
				)
			).includes(failed),
			"dismissed, the run is one of the results",
		);
	},
);

// Column x positions: every row has them at the same x (owner, pass 2).
const columnLefts = (browser, rowSelector, cellSelector) =>
	browser.evaluate(
		(rowSelector, cellSelector) =>
			[...document.querySelectorAll(rowSelector)].map((row) =>
				[...row.querySelectorAll(cellSelector)].map((cell) => {
					const box = cell.getBoundingClientRect();
					return [
						Math.round(box.left * 10) / 10,
						Math.round(box.right * 10) / 10,
					];
				}),
			),
		rowSelector,
		cellSelector,
	);
const sameColumns = (rows, where, edge = 0) => {
	assert.ok(rows.length >= 3, `${where}: rows ${rows.length}`);
	for (const row of rows) {
		assert.equal(row.length, rows[0].length, `${where}: same column count`);
		row.forEach((cell, index) =>
			assert.ok(
				Math.abs(cell[edge] - rows[0][index][edge]) <= 1,
				`${where}: column ${index} is at ${cell[edge]}, not ${rows[0][index][edge]}`,
			),
		);
	}
};
test(
	"dashboard Chrome: the Workflows table is a real table whose columns line up on every row (1280, 1440, 1101, 2304)",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		for (const [width, height] of [
			[1280, 800],
			[1440, 900],
			[2304, 1190],
		]) {
			await browser.open(`${fixture.origin}/`, width, height);
			await browser.waitFor(() => document.querySelector(".home-table"));
			const where = `${width}px`;
			const shape = await browser.evaluate(() => {
				const rows = [...document.querySelectorAll(".home-table tr")];
				return {
					table: getComputedStyle(document.querySelector(".home-table"))
						.display,
					layout: getComputedStyle(document.querySelector(".home-table"))
						.tableLayout,
					row: [...new Set(rows.map((row) => getComputedStyle(row).display))],
					head: document.querySelectorAll(".home-table th").length,
					shown: [...document.querySelectorAll(".home-table thead th")].map(
						(th) => getComputedStyle(th).display !== "none",
					),
					names: [...document.querySelectorAll(".home-table thead th")].map(
						(th) => th.textContent,
					),
				};
			});
			// Never stacked label-over-value cards at this width: all six columns, as table rows.
			assert.equal(shape.table, "table", where);
			assert.equal(shape.layout, "fixed", where);
			assert.deepEqual(shape.row, ["table-row"], where);
			assert.deepEqual(
				shape.names,
				["Workflow", "Runs", "Last result", "Median", "Cost", "Last runs"],
				where,
			);
			assert.ok(shape.shown.every(Boolean), `${where}: no column is dropped`);
			const rows = await columnLefts(browser, ".home-table tr", "th, td");
			sameColumns(rows, `${where} left`);
			// Numbers are right-aligned: their right edges agree too.
			const numbers = await browser.evaluate(() => {
				const cells = (selector) =>
					[...document.querySelectorAll(selector)].map((cell) => {
						const range = document.createRange();
						range.selectNodeContents(cell);
						return [
							Math.round(range.getBoundingClientRect().right),
							getComputedStyle(cell).textAlign,
							getComputedStyle(cell).fontVariantNumeric,
						];
					});
				return {
					runs: cells(".home-table td.c-runs"),
					median: cells(".home-table td.c-median"),
					cost: cells(".home-table td.c-cost"),
				};
			});
			for (const [name, cells] of Object.entries(numbers)) {
				assert.ok(cells.length >= 3, name);
				assert.ok(
					cells.every(([right]) => Math.abs(right - cells[0][0]) <= 1),
					`${where}: ${name} is right-aligned ${JSON.stringify(cells)}`,
				);
				assert.ok(
					cells.every(
						([, align, figures]) =>
							align === "right" && figures.includes("tabular-nums"),
					),
					`${where}: ${name} has tabular figures`,
				);
			}
			// The badge column: left-aligned at one x, centred in its row.
			const badges = await browser.evaluate(() =>
				[...document.querySelectorAll(".home-table td.c-last")].map((cell) => {
					const row = cell.parentElement.getBoundingClientRect();
					const badge = cell
						.querySelector(".result-badge")
						.getBoundingClientRect();
					return {
						left: badge.left - cell.getBoundingClientRect().left,
						centre: badge.top + badge.height / 2 - (row.top + row.height / 2),
					};
				}),
			);
			for (const badge of badges) {
				assert.ok(
					Math.abs(badge.left - badges[0].left) <= 1 && badge.left <= 14,
					`${where}: badge left ${badge.left}`,
				);
				assert.ok(
					Math.abs(badge.centre) <= 1,
					`${where}: badge centre ${badge.centre}`,
				);
			}
			assert.equal(
				await browser.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				true,
				`${where}: no sideways scroll`,
			);
		}
		// Narrower: the least important column ("Median") drops out; the rest still line up and the
		// table does not stack (labels over values appear only at phone width).
		await browser.open(`${fixture.origin}/`, 1101, 800);
		await browser.waitFor(() => document.querySelector(".home-table"));
		assert.deepEqual(
			await browser.evaluate(() => ({
				row: getComputedStyle(document.querySelector(".home-table tbody tr"))
					.display,
				shown: [...document.querySelectorAll(".home-table thead th")]
					.filter((th) => getComputedStyle(th).display !== "none")
					.map((th) => th.textContent),
			})),
			{
				row: "table-row",
				shown: ["Workflow", "Runs", "Last result", "Cost", "Last runs"],
			},
		);
		sameColumns(
			await columnLefts(browser, ".home-table tr", "th, td"),
			"1101px left",
		);
		await browser.open(`${fixture.origin}/`, 390, 844);
		await browser.waitFor(() => document.querySelector(".home-table"));
		assert.deepEqual(
			await browser.evaluate(() => ({
				page: document.documentElement.scrollWidth <= innerWidth,
				head: getComputedStyle(document.querySelector(".home-table thead"))
					.display,
			})),
			{ page: true, head: "none" },
		);
	},
);

test(
	"dashboard Chrome: Recent results are aligned rows: a status column, a flexible title, then date, duration and cost",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		for (const [width, height] of [
			[1280, 800],
			[1440, 900],
			[2304, 1190],
		]) {
			await browser.open(`${fixture.origin}/`, width, height);
			await browser.waitFor(() => document.querySelector(".home-row.recent"));
			await browser.evaluate(() =>
				document.querySelector('[data-home-key="stopped"]')?.click(),
			);
			const where = `${width}px`;
			const lefts = await columnLefts(
				browser,
				"#home-recent .home-row.recent",
				":scope > *",
			);
			sameColumns(lefts, `${where} left`);
			sameColumns(
				lefts.map((row) => row.slice(2)),
				`${where} right`,
				1,
			);
			const detail = await browser.evaluate(() =>
				[...document.querySelectorAll("#home-recent .home-row.recent")].map(
					(row) => {
						const box = row.getBoundingClientRect();
						const badge = row
							.querySelector(".result-badge")
							.getBoundingClientRect();
						const style = (selector) =>
							getComputedStyle(row.querySelector(selector));
						return {
							centre: badge.top + badge.height / 2 - (box.top + box.height / 2),
							badgeLeft: badge.left - box.left,
							align: ["date", "dur"].map(
								(name) => style(`.home-row-${name}`).textAlign,
							),
							cost: style(".home-cost").textAlign,
							figures: style(".home-row-dur").fontVariantNumeric,
							// The agents sit after a gap, in their own box, when the run has them.
							gap: (() => {
								const agents = row.querySelector(".home-row-agents");
								const name = row.querySelector(".home-row-wf");
								return agents
									? agents.getBoundingClientRect().left -
											name.getBoundingClientRect().right
									: null;
							})(),
							task: row.querySelector(".home-row-task")
								? row.querySelector(".home-row-task").getBoundingClientRect()
										.top >=
									row.querySelector(".home-row-name").getBoundingClientRect()
										.bottom -
										1
								: null,
						};
					},
				),
			);
			for (const row of detail) {
				assert.ok(
					Math.abs(row.centre) <= 1,
					`${where}: badge centred ${row.centre}`,
				);
				assert.ok(Math.abs(row.badgeLeft - detail[0].badgeLeft) <= 1, where);
				assert.deepEqual(row.align, ["right", "right"], where);
				assert.equal(row.cost, "right", where);
				assert.match(row.figures, /tabular-nums/, where);
				if (row.gap !== null)
					assert.ok(
						row.gap >= 8,
						`${where}: gap before the agents is ${row.gap}`,
					);
				if (row.task !== null)
					assert.equal(row.task, true, `${where}: the task is the second line`);
			}
		}
		// A phone: duration and cost sit under the date, still in their own columns.
		await browser.open(`${fixture.origin}/`, 390, 844);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		const phone = await columnLefts(
			browser,
			"#home-recent .home-row.recent",
			".home-row-date, .home-row-dur, .home-cost",
		);
		sameColumns(phone, "390px right", 1);
		assert.deepEqual(
			await browser.evaluate(() => ({
				page: document.documentElement.scrollWidth <= innerWidth,
				under: [
					...document.querySelectorAll("#home-recent .home-row.recent"),
				].every(
					(row) =>
						row.querySelector(".home-row-dur").getBoundingClientRect().top >=
						row.querySelector(".home-row-date").getBoundingClientRect().bottom -
							1,
				),
			})),
			{ page: true, under: true },
		);
	},
);

test(
	"dashboard Chrome: no middle dot and no em dash in the text of the overview, run, report, palette and rail",
	chromeOptions,
	async (t) => {
		const { browser, fixture } = await reviewFixture(t);
		// A report's own words are data; this one has none of the marks, so only ours are scanned.
		fixture.reports.set(
			complete,
			deepReport.replaceAll("—", "-").replaceAll("·", ","),
		);
		const none = async (where) =>
			assert.deepEqual(await scanMarks(browser), [], where);
		// The overview, with the stopped runs shown and a need dismissed (every state of its parts).
		await browser.open(`${fixture.origin}/`, 1440, 900);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		await browser.evaluate(() =>
			document.querySelector('[data-home-key="stopped"]')?.click(),
		);
		await none("overview");
		await browser.open(`${fixture.origin}/`, 390, 844);
		await browser.waitFor(() => document.querySelector(".home-row.recent"));
		await none("overview on a phone");
		// A run with its rail, graph and an inspector open on a task, for a failed run and a finished one.
		for (const [query, name] of [
			[`run=${failed}&task=map-implementation.main`, "failed run"],
			[`run=${complete}&task=triage.main`, "finished run"],
			[`run=${running}`, "running run"],
			[`run=${running}&view=details`, "run details"],
			[`run=${failed}&dialog=resume`, "resume dialog"],
		]) {
			await browser.open(`${fixture.origin}/?${query}`, 1440, 900);
			await browser.waitFor(() => document.querySelector(".run-row"));
			await browser.waitFor(() => document.querySelector("#task-count"));
			await none(name);
		}
		// The same dialog, read-only (its note used to be "Read-only, action disabled" with a dash).
		fixture.setReadonly(true);
		await browser.open(
			`${fixture.origin}/?run=${failed}&dialog=resume`,
			1440,
			900,
		);
		await browser.waitFor(() => document.querySelector("dialog[open]"));
		assert.match(await text2(browser, "dialog"), /Read-only: actions are off/);
		await none("resume dialog, read-only");
		fixture.setReadonly(false);
		// The report page.
		await browser.open(
			`${fixture.origin}/?run=${complete}&view=report`,
			1440,
			900,
		);
		await browser.waitFor(() => document.querySelector(".finding-card"));
		await none("report page");
		// The palette.
		await browser.open(`${fixture.origin}/?run=${running}`, 1440, 900);
		await browser.waitFor(() => document.querySelector(".run-row"));
		await browser.key("k", 4);
		await browser.waitFor(() => document.querySelector(".palette-input"));
		await none("palette");
		// The timeline layout of a run.
		await browser.open(
			`${fixture.origin}/?run=${complete}&layout=timeline`,
			1440,
			900,
		);
		await browser.waitFor(() => document.querySelector("#timeline"));
		await none("timeline");
	},
);

test(
	"dashboard Chrome: cards side by side in the top-down graph share their top edge",
	chromeOptions,
	async (t) => {
		// 2026-11-13 (owner): a taller card beside a shorter one left the shorter one's title lower;
		// cards in one layer are top-aligned so their titles read as one line.
		const { browser, fixture } = await reviewFixture(t);
		// A one-agent stage beside the three-agent reviewers card: both follow triage.
		const live = fixture.runs.get(running);
		const triage = live.tasks.find((task) => task.specId === "triage.main");
		live.tasks.splice(1, 0, {
			...structuredClone(triage),
			taskId: "task-context",
			specId: "context.main",
			stageId: "context",
			dependsOn: ["triage.main"],
		});
		let pairs = 0;
		for (const runId of [running, complete, failed]) {
			await browser.open(`${fixture.origin}/?run=${runId}`);
			await browser.waitFor(() => document.querySelector(".node[data-stage]"));
			const boxes = await browser.evaluate(() =>
				[...document.querySelectorAll(".node[data-stage]")].map((node) => {
					const box = node.querySelector(".outline").getBoundingClientRect();
					return { top: box.top, bottom: box.bottom, height: box.height };
				}),
			);
			for (const [i, a] of boxes.entries())
				for (const b of boxes.slice(i + 1)) {
					if (a.bottom <= b.top || b.bottom <= a.top) continue;
					if (Math.abs(a.height - b.height) < 1) continue;
					pairs += 1;
					assert.ok(
						Math.abs(a.top - b.top) <= 1,
						`${runId}: cards of ${a.height}px and ${b.height}px start ${Math.abs(a.top - b.top)}px apart`,
					);
				}
		}
		assert.ok(
			pairs > 0,
			"a fixture has a layer with cards of different heights",
		);
	},
);
