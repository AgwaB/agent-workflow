import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	createFixtureServer,
	injection,
} from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
const RUN = "workflow_mvt9k2qa_7c41e0";
const AT = Date.parse("2026-10-29T08:10:00.000Z");
const iso = (seconds) => new Date(AT + seconds * 1000).toISOString();

function redesignRun(base) {
	const task = (specId, status, extra = {}) => ({
		...structuredClone(base.tasks[0]),
		taskId: `task-${specId}`,
		specId,
		stageId: specId.split(".")[0],
		kind: "single",
		agent: "researcher",
		status,
		statusDetail: status,
		startedAt: iso(-12),
		completedAt: status === "completed" ? iso(-2) : undefined,
		elapsedMs: status === "completed" ? 10000 : undefined,
		dependsOn: [],
		...extra,
	});
	const agents = [
		task("verify-claims.one", "running", {
			title: injection,
			activity: { kind: "read", label: "Reading the cited paper", at: iso(-1) },
		}),
		task("verify-claims.two", "completed", {
			title: "A partial finding",
			outcome: { status: "partly", tone: "warn", text: "No significance test" },
		}),
		task("verify-claims.three", "completed", {
			outcome: { status: "not_checked", tone: "err", text: injection },
		}),
		task("verify-claims.four", "pending", { startedAt: undefined }),
		task("verify-claims.five", "completed", {
			title: "Verified statement",
			outcome: { status: "verified", tone: "ok", text: "Source agrees" },
		}),
		task("verify-claims.six", "failed", {
			lastMessage: "The source could not be opened",
			completedAt: iso(-1),
			elapsedMs: 11000,
		}),
	].map((t) => ({ ...t, kind: "foreach", dependsOn: ["collect.main"] }));
	return {
		...structuredClone(base),
		runId: "workflow_redesign",
		name: "deep-research",
		updatedAt: iso(0),
		taskSummary: { ...base.taskSummary, total: 8, completed: 4, failed: 1 },
		tasks: [
			task("collect.main", "completed"),
			...agents,
			task("final-audit.main", "pending", {
				startedAt: undefined,
				dependsOn: agents.map((t) => t.specId),
			}),
		],
	};
}

test("dashboard redesign: agent contracts, handoffs and reduced motion in Chrome", {
	skip: chrome ? false : "Chrome is not installed",
	timeout: 120_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const run = redesignRun(fixture.runs.get(RUN));
	fixture.runs.set(run.runId, run);
	const open = (extra = "") =>
		browser.open(`${fixture.origin}/?run=${run.runId}${extra}`);
	const publish = async (change) => {
		change();
		run.updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
		fixture.publish();
	};

	await t.test(
		"grouped rows retain titles, activity, outcomes, one-word times and task links",
		async () => {
			await open("&stage=verify-claims");
			await browser.waitFor(() => document.querySelector("[data-item]"));
			const rows = await browser.evaluate(() => ({
				groups: [...document.querySelectorAll("[data-group]")].map(
					(el) => el.textContent,
				),
				rows: [...document.querySelectorAll("[data-item]")].map((row) => ({
					id: row.dataset.item,
					title: row.querySelector(".agent-title").textContent,
					line: row.querySelector(".agent-sub")?.textContent ?? null,
					time: row.querySelector(".agent-time").textContent,
					index: row.querySelector(".agent-index").textContent,
					button: row.tagName,
				})),
				injected: Boolean(window.dashboardInjected),
				modes: document.querySelectorAll("[data-mode]").length,
			}));
			assert.deepEqual(rows.groups, [
				"Running1",
				"Needs a look3",
				"Waiting1",
				"Done1",
			]);
			assert.deepEqual(
				rows.rows.map((r) => r.id),
				[
					"verify-claims.one",
					"verify-claims.two",
					"verify-claims.three",
					"verify-claims.six",
					"verify-claims.four",
					"verify-claims.five",
				],
			);
			assert.equal(rows.rows[0].title, injection);
			assert.equal(rows.rows[0].line, "Reading the cited paper");
			assert.match(rows.rows[0].time, /^1\ds$/);
			assert.equal(rows.rows[1].line, "Partly · No significance test");
			assert.equal(rows.rows[1].time, "10s");
			assert.equal(rows.rows[2].line, `Not checked · ${injection}`);
			assert.equal(rows.rows[3].line, "The source could not be opened");
			assert.equal(rows.rows[3].time, "11s");
			assert.equal(rows.rows[4].time, "");
			assert.equal(rows.rows[4].title, "four");
			assert.equal(rows.rows[5].line, null);
			assert.equal(rows.rows[3].index, "6");
			assert.ok(rows.rows.every((r) => r.button === "BUTTON"));
			assert.equal(rows.injected, false);
			assert.equal(rows.modes, 0);
			await browser.click('[data-item="verify-claims.one"]');
			assert.equal(
				await browser.evaluate(
					() => document.querySelector("[data-activity]")?.textContent,
				),
				"Reading the cited paper",
			);
			await publish(() => {
				delete run.tasks[1].activity;
			});
			await browser.waitFor(
				() =>
					document.querySelector("[data-activity]")?.textContent ===
					"Starting…",
			);
			await open("&task=verify-claims.two");
			assert.equal(
				await browser.evaluate(
					() => document.querySelector(".inspector-head .outcome")?.textContent,
				),
				"Partly · No significance test",
			);
			await open("&stage=verify-claims");
			await browser.evaluate(() => {
				const input = document.querySelector(".items-tools input");
				input.value = "partial finding";
				input.dispatchEvent(new Event("input"));
			});
			assert.equal(
				await browser.evaluate(
					() => document.querySelectorAll("[data-item]").length,
				),
				1,
			);
			await browser.evaluate(() => {
				const input = document.querySelector(".items-tools input");
				input.value = "";
				input.dispatchEvent(new Event("input"));
			});
		},
	);

	await t.test(
		"stage strips encode waiting, running, neutral done, warning and hatched errors",
		async () => {
			const strip = await browser.evaluate(() => ({
				title: document.querySelector('[data-stage="verify-claims"] .node-name')
					.textContent,
				segments: [...document.querySelectorAll("[data-segment]")].map(
					(el) => ({
						classes: el.getAttribute("class"),
						fill: el.getAttribute("fill"),
						label: el.getAttribute("aria-label"),
					}),
				),
			}));
			assert.equal(strip.title, "Verify claims");
			assert.equal(strip.segments.length, 6);
			assert.match(strip.segments[0].classes, /running/);
			assert.match(strip.segments[1].classes, /completed warn/);
			assert.equal(strip.segments[2].fill, "url(#failure-hatch)");
			assert.match(strip.segments[3].classes, /pending/);
			assert.match(strip.segments[4].classes, /completed ok/);
			assert.equal(strip.segments[5].fill, "url(#failure-hatch)");
			assert.match(strip.segments[1].label, /partly/);
		},
	);

	await t.test(
		"packets follow actual start/completion diffs, use outcome tones, and settle",
		async () => {
			assert.equal(
				await browser.evaluate(
					() => document.querySelectorAll(".handoff-packet,.pulse").length,
				),
				0,
			);
			await publish(() => {
				run.tasks[4].status = "running";
				run.tasks[4].startedAt = iso(0);
			});
			await browser.waitFor(() =>
				document.querySelector('.handoff-packet[data-handoff="start"]'),
			);
			assert.equal(
				await browser.evaluate(
					() =>
						document.querySelector(".handoff-packet").closest("[data-link]")
							.dataset.link,
				),
				"collect>verify-claims",
			);
			assert.ok(
				await browser.evaluate(() => {
					const delays = [...document.querySelectorAll(".segment.running")].map(
						(el) => getComputedStyle(el).animationDelay,
					);
					return delays.length === 2 && new Set(delays).size === 2;
				}),
			);
			// The row changes group, but content is clipped into normal-flow row slots during FLIP.
			assert.ok(
				await browser.evaluate(() => {
					const rows = [...document.querySelectorAll("[data-item]")];
					return rows.every(
						(row, i) =>
							i === 0 ||
							rows[i - 1].getBoundingClientRect().bottom <=
								row.getBoundingClientRect().top,
					);
				}),
			);
			await publish(() => {
				run.tasks[4].status = "completed";
				run.tasks[4].outcome = {
					status: "partly",
					tone: "warn",
					text: "Evidence is incomplete",
				};
			});
			await browser.waitFor(() =>
				document.querySelector('.handoff-packet.warn[data-handoff="complete"]'),
			);
			assert.equal(
				await browser.evaluate(
					() =>
						document
							.querySelector(".handoff-packet.warn")
							.closest("[data-link]").dataset.link,
				),
				"verify-claims>final-audit",
			);
			await browser.waitFor(() => !document.querySelector(".handoff-packet"));
			fixture.publish();
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(
				await browser.evaluate(
					() => document.querySelectorAll(".handoff-packet").length,
				),
				0,
			);
		},
	);

	await t.test(
		"running progress ring becomes a neutral drawn check and degraded result",
		async () => {
			assert.match(
				await browser.evaluate(() =>
					document.querySelector(".hero-badge").getAttribute("class"),
				),
				/running/,
			);
			assert.equal(
				await browser.evaluate(
					() => document.querySelectorAll(".hero-check").length,
				),
				0,
			);
			await publish(() => {
				run.status = "completed";
				run.verdict = "incomplete";
				run.reportAvailable = true;
				for (const task of run.tasks) task.status = "completed";
				run.tasks.at(-1).outcome = {
					status: "incomplete",
					tone: "warn",
					text: "Held back the synthesis",
				};
			});
			await browser.waitFor(() => document.querySelector(".hero-check"));
			assert.deepEqual(
				await browser.evaluate(() => ({
					title: document.querySelector("h1").textContent,
					ringOffset: document
						.querySelector(".hero-ring")
						.getAttribute("stroke-dashoffset"),
					colour: getComputedStyle(document.querySelector(".hero-ring")).stroke,
					result: document.querySelector(".result").textContent,
					stageWarn: document
						.querySelector('[data-stage="final-audit"]')
						.classList.contains("outcome-warn"),
					foreachWarn: document
						.querySelector('[data-stage="verify-claims"]')
						.classList.contains("outcome-warn"),
				})),
				{
					title: "Finished",
					ringOffset: "0",
					colour: "rgb(237, 237, 237)",
					result:
						"ResultIncompleteHeld back the synthesisFinished just now with verdict incomplete. Report is ready.",
					stageWarn: true,
					foreachWarn: false,
				},
			);
		},
	);

	await t.test(
		"reduced motion has final ring/check, no breathing, shimmer, FLIP or packets",
		async () => {
			await browser.send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-reduced-motion", value: "reduce" }],
			});
			await open("&stage=verify-claims");
			assert.equal(
				await browser.evaluate(() => document.getAnimations().length),
				0,
			);
			await publish(() => {
				run.status = "running";
				run.tasks[1].status = "running";
			});
			await browser.waitFor(() =>
				document.querySelector(".hero-badge.running"),
			);
			assert.deepEqual(
				await browser.evaluate(() => ({
					animations: document.getAnimations().length,
					packets: document.querySelectorAll(".handoff-packet").length,
					shimmer: getComputedStyle(document.querySelector(".activity span"))
						.animationName,
					breathing: getComputedStyle(
						document.querySelector(".segment.running"),
					).animationName,
				})),
				{ animations: 0, packets: 0, shimmer: "none", breathing: "none" },
			);
			await publish(() => {
				run.status = "failed";
			});
			await browser.waitFor(() => document.querySelector(".hero-badge.failed"));
			assert.equal(
				await browser.evaluate(
					() => document.querySelector(".hero-number").textContent,
				),
				"✕",
			);
			await publish(() => {
				run.status = "blocked";
			});
			await browser.waitFor(() =>
				document.querySelector(".hero-badge.blocked"),
			);
			assert.equal(
				await browser.evaluate(
					() => document.querySelector(".hero-number").textContent,
				),
				"!",
			);
			assert.equal(
				await browser.evaluate(
					() => document.querySelectorAll("[style]").length,
				),
				0,
			);
		},
	);
	assert.deepEqual(browser.errors, []);
});
