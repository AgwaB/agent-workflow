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
			json: "Ship it — owner: release; blocking: true",
		},
	);
	assert.equal(
		await browser.evaluate(() => document.querySelector(".report-toc")),
		null,
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
			document.querySelector("dialog").dataset.page ?? null,
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
	await browser.key("Escape");
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
	await browser.key("Escape");

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
		return { retry, launch, decision, unknown: statusSentence(run) };
	});
	assert.match(mapped.retry, /rate-limit retry \(2 of 4, 6:40\)/);
	assert.equal(mapped.retry, mapped.launch);
	assert.match(mapped.decision, /you need to decide/);
	assert.doesNotMatch(mapped.unknown, /private_unknown_engine_code/);

	// A run update that changes nothing structural keeps the drawn graph (so the flow animation
	// keeps its phase and hover survives); a status change redraws it.
	// First drawing of a run replays the journey: every card and link gets a scripted fade
	// (layer by layer) on top of the stylesheet's flow animations. 2026-11-05 (CI: on a slower
	// machine the replay, about 1 s, had finished and left getAnimations() before the check ran):
	// count the scripted animations as they start instead.
	const { identifier: replayHook } = await browser.send(
		"Page.addScriptToEvaluateOnNewDocument",
		{
			source: `(() => {
				const animate = Element.prototype.animate;
				window.__awAnimated = [];
				Element.prototype.animate = function (...args) {
					window.__awAnimated.push(this);
					return animate.apply(this, args);
				};
			})();`,
		},
	);
	await open(`run=${running}`);
	await browser.waitFor(() => document.querySelector(".edge.active"));
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
	await new Promise((resolve) => setTimeout(resolve, 400));
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
		"Failed — verifier ids did not match",
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
	await new Promise((resolve) => setTimeout(resolve, 450)); // the column narrows (0.28 s)
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
	await browser.waitFor(() => document.querySelector(".report-toc"));
	const contents = () =>
		browser.evaluate(() => ({
			expanded: document
				.querySelector(".toc-toggle")
				.getAttribute("aria-expanded"),
			entries: [...document.querySelectorAll(".toc-entry")].filter(
				(entry) => entry.getClientRects().length,
			).length,
		}));
	assert.deepEqual(await contents(), { expanded: "false", entries: 0 });
	await browser.evaluate(() => document.querySelector(".toc-toggle").click());
	assert.deepEqual(await contents(), { expanded: "true", entries: 3 });
	await browser.evaluate(() =>
		document.querySelectorAll(".toc-entry")[1].click(),
	);
	assert.deepEqual(await contents(), { expanded: "false", entries: 0 });
});

test("dashboard Chrome: panels and dialogs share one motion family, both ways", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
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
