// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	createFixtureServer,
	injection,
} from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
const options = {
	skip: chrome ? false : "Chrome is not installed",
	timeout: 120_000,
};

test(
	"dashboard simplicity: absent metrics are omitted, zero and independent coverage remain",
	options,
	async (t) => {
		const fixture = await createFixtureServer();
		t.after(() => fixture.close());
		const browser = await createBrowser(chrome);
		t.after(() => browser.close());
		const runs = [...fixture.runs.values()];
		for (const run of runs) {
			delete run.activeMs;
			delete run.cost;
		}
		await browser.open(`${fixture.origin}/`);
		await browser.waitFor(() => document.querySelector(".home-stats"));
		const read = () =>
			browser.evaluate(() => ({
				stats: [...document.querySelectorAll(".home-stat-name")].map(
					(n) => n.textContent,
				),
				unknown: [
					...document.querySelectorAll(
						"#home-recent .home-row-dur, #home-recent .home-cost",
					),
				].map((n) => n.textContent),
				table: document.querySelector(".home-table").textContent,
			}));
		assert.deepEqual((await read()).stats, ["runs"]);
		assert.deepEqual((await read()).unknown, []);
		assert.doesNotMatch((await read()).table, /n\/a/);
		const target = runs.find(
			(r) => r.status === "completed" && r.reportAvailable,
		);
		target.activeMs = 0;
		target.cost = { costUsd: 0, agentsReporting: 1, agentTotal: 2 };
		fixture.publish();
		await browser.waitFor(
			() => document.querySelector(".home-cost")?.textContent === "$0.0000+",
		);
		const zero = await browser.evaluate(() => ({
			cost: document.querySelector("#home-recent .home-cost").textContent,
			title: document.querySelector("#home-recent .home-cost").title,
			time: document.querySelector("#home-recent .home-row-dur").textContent,
			notes: [...document.querySelectorAll(".home-stat-note")].map(
				(n) => n.textContent,
			),
		}));
		assert.equal(zero.cost, "$0.0000+");
		assert.match(
			zero.title,
			/1 of 2 agents reported.*true total may be higher/,
		);
		assert.equal(zero.time, "0.00s");
		assert.ok(
			zero.notes.includes(`1 of ${runs.length} runs reported, not waiting`),
		);
		delete target.activeMs;
		fixture.publish();
		await browser.waitFor(
			() => !document.querySelector("#home-recent .home-row-dur"),
		);
		assert.deepEqual(
			(await read()).stats,
			["runs", "spend"],
			"cost does not imply time availability",
		);
	},
);

test(
	"dashboard simplicity: short evidence is visible, only long blocks fold without content loss",
	options,
	async (t) => {
		const fixture = await createFixtureServer();
		t.after(() => fixture.close());
		const browser = await createBrowser(chrome);
		t.after(() => browser.close());
		const id = [...fixture.runs.values()].find(
			(r) => r.status === "completed" && r.reportAvailable,
		).runId;
		const blocks = [
			"x".repeat(600),
			"x".repeat(601),
			Array(8).fill("short").join("\n"),
			Array(9).fill("short").join("\n"),
		];
		const report =
			"# Findings\n\n## High findings\n\n" +
			blocks
				.map(
					(body, i) =>
						`### finding-00${i + 1} — Boundary ${i}\n\nSeverity: **${i % 2 ? "medium" : "high"}**  \nVerifier verdict: **${i < 2 ? "KEEP" : "WEAKEN"}**  \n\nReviewer/source evidence:\n\n${body}\n\nVerifier evidence:\n\nVerified ${i}.\n\nCaveat / counter-evidence:\n\n${injection}\n\nRationale:\n\nKeep this caveat.\n`,
				)
				.join("\n");
		fixture.reports.set(id, report);
		for (const width of [1440, 390]) {
			await browser.open(
				`${fixture.origin}/?run=${id}&view=report`,
				width,
				900,
			);
			await browser.waitFor(
				() => document.querySelectorAll(".finding-card").length === 4,
			);
			const result = await browser.evaluate(() => ({
				cards: [...document.querySelectorAll(".finding-card")].map((c) => ({
					folds: c.querySelectorAll("details").length,
					closed: [...c.querySelectorAll("details")].every((d) => !d.open),
					shortCount: [...c.querySelectorAll("section.finding-part")].filter(
						(s) => /Verifier evidence|Caveat/.test(s.textContent),
					).length,
					shortVisible: [...c.querySelectorAll("section.finding-part")]
						.filter((s) => /Verifier evidence|Caveat/.test(s.textContent))
						.every((s) => s.getBoundingClientRect().height > 0),
					caveat: c.textContent.includes(
						"<script>globalThis.dashboardInjected = true</script>",
					),
				})),
				injected: !!globalThis.dashboardInjected,
				active: document.querySelectorAll(
					"#report-content script, #report-content a, #report-content img",
				).length,
			}));
			assert.deepEqual(
				result.cards.map((c) => c.folds),
				[0, 1, 0, 1],
			);
			assert.ok(
				result.cards.every(
					(c) => c.shortCount === 2 && c.closed && c.shortVisible && c.caveat,
				),
			);
			assert.equal(result.injected, false);
			assert.equal(result.active, 0);
			await browser.evaluate(() =>
				document.querySelectorAll(".finding-fold").forEach((d) => {
					d.open = true;
				}),
			);
			const evidence = await browser.evaluate(() =>
				[...document.querySelectorAll(".finding-card")].map(
					(c) =>
						[...c.querySelectorAll(".finding-part")]
							.find((p) => /Reviewer\/source evidence/.test(p.textContent))
							.querySelector(".finding-text").textContent,
				),
			);
			assert.deepEqual(
				evidence.map((s) => s.replace(/\s/g, "")),
				blocks.map((s) => s.replace(/\s/g, "")),
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
				document
					.querySelector(
						'[data-filter-key="severity"][data-filter-value="high"]',
					)
					.click();
				document.querySelector('[data-filter-value="weakened"]').click();
			});
			assert.deepEqual(
				await browser.evaluate(() =>
					[...document.querySelectorAll(".finding-card")]
						.filter((c) => !c.hidden)
						.map((c) => c.getAttribute("aria-label")),
				),
				["finding-003"],
			);
			assert.deepEqual(
				await browser.evaluate(() =>
					[...document.querySelectorAll(".outline-link")]
						.filter((n) => !n.hidden && n.title.startsWith("finding-"))
						.map((n) => n.title.split(":")[0]),
				),
				["finding-003"],
			);
			await browser.evaluate(() =>
				document.querySelector('[data-copy-finding="finding-003"]').click(),
			);
			const copied = await browser.evaluate(() => globalThis.copiedText);
			assert.match(copied, /finding-003/);
			assert.match(copied, /Verified 2\./);
			assert.ok(copied.includes(injection));
			assert.doesNotMatch(copied, /finding-00[124]/);
			await browser.evaluate(() =>
				document.querySelector(".copy-report").click(),
			);
			assert.equal(await browser.evaluate(() => globalThis.copiedText), report);
			await browser.evaluate(() =>
				document.querySelector(".filter-clear").click(),
			);
			assert.equal(
				await browser.evaluate(
					() =>
						[...document.querySelectorAll(".finding-card")].filter(
							(c) => !c.hidden,
						).length,
				),
				4,
			);
		}
	},
);

test(
	"dashboard simplicity: code task is not an agent model call and unknown launch commands stay absent",
	options,
	async (t) => {
		const fixture = await createFixtureServer();
		t.after(() => fixture.close());
		const browser = await createBrowser(chrome);
		t.after(() => browser.close());
		const run = [...fixture.runs.values()].find((r) =>
			r.tasks.some((task) => task.kind === "support"),
		);
		const task = run.tasks.find((task) => task.kind === "support");
		run.launch = {
			host: "cli",
			command: "",
		};
		task.model = "inherited-not-called";
		await browser.open(
			`${fixture.origin}/?run=${run.runId}&stage=${task.stageId}`,
		);
		await browser.waitFor(() =>
			[...document.querySelectorAll("#inspector button")].some(
				(b) => b.textContent === "Open task ›",
			),
		);
		assert.equal(
			await browser.evaluate(() =>
				document.querySelector("#inspector").textContent.includes("Open agent"),
			),
			false,
		);
		assert.doesNotMatch(
			await browser.evaluate(
				() => document.querySelector(".agents-meta").textContent,
			),
			/inherited-not-called|claude|codex|pi/,
		);
		assert.match(
			await browser.evaluate(
				() => document.querySelector(".agents-meta").textContent,
			),
			/Code step.*no model call/,
		);
		await browser.open(
			`${fixture.origin}/?run=${run.runId}&task=${task.specId}`,
		);
		await browser.waitFor(() => document.querySelector(".executor-line"));
		assert.equal(
			await browser.evaluate(
				() => document.querySelector(".executor-line").textContent,
			),
			"Code step · no model call",
		);
		assert.equal(
			await browser.evaluate(
				() => document.querySelectorAll('[role="tab"]').length,
			),
			4,
		);
		await browser.open(`${fixture.origin}/?run=${run.runId}&view=details`);
		await browser.waitFor(() =>
			document
				.querySelector(".inspector-head")
				?.textContent.includes("Run details"),
		);
		assert.equal(
			await browser.evaluate(() =>
				document
					.querySelector("#inspector")
					.textContent.includes("Launch command"),
			),
			false,
		);
		run.launch.command =
			"agent-workflow run review 'Explain undefined in JavaScript'";
		await browser.open(`${fixture.origin}/?run=${run.runId}&view=details`);
		await browser.waitFor(() =>
			document
				.querySelector("#inspector")
				.textContent.includes("Launch command"),
		);
		assert.ok(
			await browser.evaluate(() =>
				document
					.querySelector("#inspector")
					.textContent.includes("Explain undefined in JavaScript"),
			),
		);
	},
);

test(
	"E: captured literal task words are not censored; blank/absent commands stay omitted",
	options,
	async (t) => {
		const f = await createFixtureServer();
		t.after(() => f.close());
		const b = await createBrowser(chrome);
		t.after(() => b.close());
		const r = [...f.runs.values()][0];
		for (const command of [
			undefined,
			"",
			"   ",
			"agent-workflow run review 'Explain undefined in JavaScript'",
		]) {
			r.launch = { host: "cli", ...(command === undefined ? {} : { command }) };
			await b.open(`${f.origin}/?run=${r.runId}&view=details`);
			await b.waitFor(() =>
				document
					.querySelector(".inspector-head")
					?.textContent.includes("Run details"),
			);
			const commands = await b.evaluate(() =>
				[...document.querySelectorAll("#inspector .command")].map(
					(n) => n.textContent,
				),
			);
			// commandBlock's exact preformatted text excludes its Copy button.
			const text = await b.evaluate(() =>
				[...document.querySelectorAll("#inspector .command pre")].map(
					(n) => n.textContent,
				),
			);
			if (command?.trim())
				assert.ok(
					text.includes(command),
					JSON.stringify({ command, text, commands }),
				);
			else
				assert.equal(
					await b.evaluate(() =>
						document
							.querySelector("#inspector")
							.textContent.includes("Launch command"),
					),
					false,
				);
		}
	},
);

test(
	"E: task metadata and each selected-stream terminal handoff stay truthful",
	options,
	async (t) => {
		const f = await createFixtureServer();
		t.after(() => f.close());
		const b = await createBrowser(chrome);
		t.after(() => b.close());
		const r = [...f.runs.values()].find((r) =>
			r.tasks.some((t) => t.kind !== "support"),
		);
		const task = r.tasks.find((t) => t.kind !== "support");
		for (const metadata of [
			{ executor: "codex", model: "actual/model", effort: "high" },
			{ executor: "codex" },
			{},
		]) {
			delete r.executor;
			delete task.executor;
			delete task.model;
			delete task.effort;
			Object.assign(task, metadata);
			await b.open(`${f.origin}/?run=${r.runId}&task=${task.specId}`);
			await b.waitFor(() => !!document.querySelector(".task-details"));
			assert.equal(
				await b.evaluate(
					() => document.querySelector(".executor-line")?.textContent ?? null,
				),
				`Executor: ${metadata.executor || "unknown"}, Recorded model: ${metadata.model || "unknown"}, Executor-reported model: unknown / not reported, Recorded effort: ${metadata.effort || "unknown"}`,
			);
		}
		for (const [tab, stream] of [
			["result", "output"],
			["output", "output"],
			["stderr", "stderr"],
			["events", "events"],
		]) {
			await b.open(
				`${f.origin}/?run=${r.runId}&task=${task.specId}&tab=${tab}`,
			);
			await b.waitFor(() => !!document.querySelector(".task-details"));
			const commands = await b.evaluate(() => {
				const d = document.querySelector(".task-details");
				d.open = true;
				return [...d.querySelectorAll(".command pre")].map(
					(n) => n.textContent,
				);
			});
			assert.equal(commands.length, 1);
			assert.ok(commands[0].endsWith(`--stream ${stream}`), commands[0]);
			assert.ok(commands[0].includes(r.runId));
			assert.ok(commands[0].includes(task.specId));
		}
	},
);

test(
	"E: stacked workflow metrics omit unknown captions, not zero; median coverage is grammatical",
	options,
	async (t) => {
		const f = await createFixtureServer();
		t.after(() => f.close());
		const b = await createBrowser(chrome);
		t.after(() => b.close());
		for (const r of f.runs.values()) {
			delete r.cost;
			delete r.activeMs;
		}
		await b.open(f.origin, 390, 900);
		await b.waitFor(() => !!document.querySelector(".home-table"));
		const cells = await b.evaluate(() =>
			[
				...document.querySelectorAll(
					".home-table td.c-cost, .home-table td.c-median",
				),
			].map((n) => ({
				empty: !n.textContent,
				shown: n.getBoundingClientRect().height > 0,
				title: n.title,
			})),
		);
		assert.ok(cells.length > 2);
		assert.ok(cells.every((c) => c.empty && !c.shown));
		assert.ok(cells.some((c) => c.title === "No completed runs"));
		const r = [...f.runs.values()].find((r) => r.status === "completed");
		r.cost = { costUsd: 0, agentsReporting: 1, agentTotal: 1 };
		r.activeMs = 0;
		f.publish();
		await b.waitFor(() => !!document.querySelector(".home-table .home-cost"));
		assert.equal(
			await b.evaluate(
				() =>
					document
						.querySelector(".home-table .home-cost")
						.getBoundingClientRect().height > 0,
			),
			true,
		);
		assert.ok(
			await b.evaluate(() =>
				[...document.querySelectorAll(".c-median")].some(
					(n) => n.title === "Active time reported for 1 of 1 completed run",
				),
			),
		);
	},
);
