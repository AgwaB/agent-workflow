// test-tier: integration
// Sanitized projections from real, guarded test-executor runs. No executor/provider is loaded here.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const directory = new URL("../fixtures/dashboard/matrix/", import.meta.url);
const snapshots = await Promise.all(
	(await readdir(directory))
		.filter((name) => name.endsWith(".json") && name !== "manifest.json")
		.sort()
		.map(async (name) => ({
			name: name.slice(0, -5),
			run: JSON.parse(await readFile(new URL(name, directory), "utf8")),
		})),
);
const viewports = [
	[1440, 900, "td"],
	[1280, 800, "td"],
	[1920, 1080, "td"],
	[1440, 900, "lr"],
];
const agents = (run) =>
	run.tasks.filter(
		(task) =>
			!task.placeholder && !["support", "dynamic", "loop"].includes(task.kind),
	);

// Ellipsis on bounded titles is intentional; overflowing the card or colliding with status is not.
function layoutProblems() {
	const problems = [];
	if (document.documentElement.scrollWidth > innerWidth)
		problems.push("document overflows horizontally");
	for (const el of document.querySelectorAll(
		".hero-sub,.sentence,.result-summary,.need,.need small,.inspector-head,.item-filters",
	))
		if (el.scrollWidth > el.clientWidth + 1)
			problems.push(`overflow: ${el.className}`);
	for (const text of document.querySelectorAll(".node text")) {
		const a = text.getBBox();
		const b = text.closest(".node").querySelector(".outline").getBBox();
		if (
			a.x < 0 ||
			a.y < 0 ||
			a.x + a.width > b.width + 1 ||
			a.y + a.height > b.height + 1
		)
			problems.push(`card text outside outline: ${text.textContent}`);
	}
	for (const row of document.querySelectorAll(".agent-row")) {
		const name = row.querySelector(".agent-name").getBoundingClientRect();
		const status = row.querySelector(".agent-state").getBoundingClientRect();
		if (name.right > status.left - 4)
			problems.push(`row title overlaps status: ${row.textContent}`);
	}
	for (const row of document.querySelectorAll(".agent-content")) {
		const title = row.querySelector(".agent-title").getBoundingClientRect();
		const time = row.querySelector(".agent-time").getBoundingClientRect();
		if (title.right > time.left + 1)
			problems.push("inspector title overlaps time");
	}
	return problems;
}

const chrome = await findChrome();
test("dashboard matrix: shape/state projections, viewport geometry, counts and keyboard", {
	skip: chrome ? false : "Chrome is not installed",
	timeout: 300_000,
}, async (t) => {
	const fixture = await createFixtureServer({
		snapshots: snapshots.map(({ run }) => run),
		readonly: true,
	});
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const shots = process.env.AW_DASHBOARD_MATRIX_SCREENSHOTS;
	if (shots) await mkdir(shots, { recursive: true });
	// Disable entrance replay for geometry assertions, and prove live CSS/WAAPI motion is disabled.
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	for (const { name, run } of snapshots) {
		await t.test(name, async () => {
			const expected = agents(run);
			const done = expected.filter(
				(task) => task.status === "completed",
			).length;
			assert.equal(
				run.taskSummary.total,
				run.tasks.length,
				"projection task total",
			);
			for (const status of [
				"pending",
				"running",
				"completed",
				"failed",
				"blocked",
				"interrupted",
				"skipped",
			])
				assert.equal(
					run.taskSummary[status],
					run.tasks.filter((task) => task.status === status).length,
					`projection ${status} total`,
				);
			assert.deepEqual(run.agentSummary, {
				completed: done,
				total: expected.length,
			});
			const foreach = run.tasks.find(
				(task) => task.kind === "foreach",
			)?.stageId;
			for (const [width, height, layout] of viewports) {
				await browser.open(
					`${fixture.origin}/?run=${run.runId}&layout=${layout}${foreach ? `&stage=${foreach}` : ""}`,
					width,
					height,
				);
				await browser.waitFor(() => document.querySelector(".node text tspan"));
				const label = `${name} ${width}x${height} ${layout}`;
				if (shots) {
					const shot = await browser.send("Page.captureScreenshot", {
						format: "png",
					});
					await writeFile(
						join(shots, `${name}-${width}x${height}-${layout}.png`),
						Buffer.from(shot.data, "base64"),
					);
				}
				assert.deepEqual(await browser.evaluate(layoutProblems), [], label);
				const counts = await browser.evaluate(() => ({
					rail: document.querySelector(
						'.run-row[aria-current="true"] .run-count',
					)?.textContent,
					header: document.querySelector("#hero-sub").textContent,
					groupCounts: [...document.querySelectorAll("[data-group] span")].map(
						(el) => Number(el.textContent),
					),
					rows: document.querySelectorAll("[data-item]").length,
					meta: document.querySelector(".agents-meta")?.textContent,
					segments: document.querySelectorAll("[data-segment]").length,
					parallel: [...document.querySelectorAll(".node.group")].map((el) => ({
						members: el.dataset.members.split(",").length,
						ids: el.dataset.members.split(","),
						rows: el.querySelectorAll(".stage-row").length,
						fraction: el.querySelector(".fraction").textContent,
					})),
					resultLabel: document
						.querySelector(".result-label")
						?.firstChild?.textContent?.trim(),
					resultSummary: Boolean(document.querySelector(".result-summary")),
					animations: document.getAnimations().length,
					readonly: [...document.querySelectorAll("[data-action]")].every(
						(button) => button.disabled,
					),
					accessible: [...document.querySelectorAll(".node,.agent-row")].every(
						(node) =>
							node.getAttribute("aria-label") &&
							node.getAttribute("tabindex") === "0",
					),
					meaningColors: Object.entries({
						running: "rgb(111, 191, 142)",
						blocked: "rgb(217, 165, 72)",
						failed: "rgb(229, 103, 90)",
					}).every(([status, color]) =>
						[...document.querySelectorAll(`.status-icon.${status}`)].every(
							(icon) => getComputedStyle(icon).color === color,
						),
					),
					neutralDone: [
						...document.querySelectorAll(".segment.completed.ok"),
					].every((el) => getComputedStyle(el).fill === "rgb(90, 90, 90)"),
				}));
				assert.equal(
					counts.rail,
					done === expected.length
						? `${done} agents`
						: `${done} of ${expected.length} agents`,
					label,
				);
				assert.ok(
					counts.header.includes(
						["running", "blocked"].includes(run.status)
							? `${done} of ${expected.length} agent`
							: `${expected.length} agent`,
					),
					label,
				);
				assert.equal(counts.animations, 0, `reduced motion: ${label}`);
				// Only a run that finished its work shows a Result (an earlier stage's summary must not
				// read as the outcome of a failed, stopped or blocked run).
				if (
					!["completed", "running", "pending"].includes(run.status) &&
					!run.verdictGate
				) {
					assert.notEqual(counts.resultLabel, "Result", label);
					assert.equal(counts.resultSummary, false, label);
				}
				assert.ok(
					counts.readonly &&
						counts.accessible &&
						counts.neutralDone &&
						counts.meaningColors,
					label,
				);
				if (expected.length === 1)
					assert.doesNotMatch(counts.header, /\b1 agents\b/, label);
				for (const group of counts.parallel) {
					assert.equal(group.members, group.rows, label);
					const completedMembers = group.ids.filter((id) => {
						const tasks = run.tasks.filter(
							(task) => task.stageId === id && !task.placeholder,
						);
						return (
							tasks.length > 0 &&
							tasks.every((task) =>
								["completed", "skipped"].includes(task.status),
							) &&
							tasks.some((task) => task.status === "completed")
						);
					}).length;
					assert.equal(
						Number(group.fraction.split("/")[0]),
						completedMembers,
						label,
					);
					assert.equal(
						Number(group.fraction.split("/")[1]),
						group.members,
						label,
					);
				}
				if (foreach) {
					const items = expected.filter((task) => task.stageId === foreach);
					assert.equal(counts.rows, items.length, label);
					assert.equal(
						counts.groupCounts.reduce((sum, n) => sum + n, 0),
						items.length,
						label,
					);
					assert.equal(
						counts.meta,
						`${items.length} agents · ${items.filter((task) => task.status === "completed").length} done`,
						label,
					);
					assert.equal(
						counts.segments,
						items.length <= 48 ? items.length : 0,
						label,
					);
				}
				if (run.tasks.some((task) => task.kind === "dynamic-agent")) {
					assert.match(
						await browser.evaluate(
							() =>
								document.querySelector('[data-stage-line="adaptive"]')
									.textContent,
						),
						/of 2 agents done/,
						label,
					);
					await browser.click('[data-stage="adaptive"]');
					assert.equal(
						await browser.evaluate(
							() => document.querySelector(".agents-meta").textContent,
						),
						`2 agents · ${expected.filter((task) => task.kind === "dynamic-agent" && task.status === "completed").length} done`,
						label,
					);
					assert.equal(
						await browser.evaluate(
							() => document.querySelectorAll("[data-item]").length,
						),
						2,
						"controller never appears as a generated agent row",
					);
					assert.deepEqual(await browser.evaluate(layoutProblems), [], label);
				}
				// Native keyboard activation of SVG cards, then Escape restores graph focus.
				await browser.evaluate(() => document.querySelector(".node").focus());
				await browser.key("Enter");
				assert.equal(
					await browser.evaluate(
						() => document.querySelector("#inspector").hidden,
					),
					false,
					label,
				);
				await browser.key("Escape");
				assert.equal(
					await browser.evaluate(() =>
						document.activeElement.matches("[data-stage]"),
					),
					true,
					label,
				);
			}
		});
	}
	assert.deepEqual(browser.errors, [], "no console errors or CSP violations");
	assert.ok(
		browser.requests.every((url) => url.startsWith(fixture.origin)),
		"no remote requests",
	);
	assert.equal(
		fixture.mutations.length,
		0,
		"readonly inspection never mutates runs",
	);
});

test("dashboard live matrix: focus survives updates and all sampled frames retain content", {
	skip: chrome ? false : "Chrome is not installed",
	timeout: 60_000,
}, async (t) => {
	const base = snapshots.find(({ name }) => name === "foreach-18-running").run;
	const parallel = snapshots.find(
		({ name }) => name === "parallel-running",
	).run;
	const fixture = await createFixtureServer({ snapshots: [base, parallel] });
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const run = fixture.runs.get(base.runId);
	await browser.open(`${fixture.origin}/?run=${run.runId}&stage=check-claims`);
	await browser.waitFor(() => document.querySelector('[data-filter="all"]'));
	await browser.evaluate(() =>
		document.querySelector('[data-filter="all"]').focus(),
	);
	const focus = () =>
		browser.evaluate(() => document.activeElement.dataset.filter);
	assert.equal(await focus(), "all");
	// Same topology, genuine activity change. A live repaint must not discard keyboard focus.
	run.tasks.find((task) => task.status === "running").activity = {
		kind: "read",
		label: "Reading updated evidence",
		at: run.updatedAt,
	};
	run.updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
	fixture.publish();
	await browser.waitFor(
		() =>
			document.querySelector(".agent-sub")?.textContent ===
			"Reading updated evidence",
	);
	assert.equal(
		await focus(),
		"all",
		"status filter retains keyboard focus after SSE",
	);
	await browser.evaluate(() =>
		document.querySelector('#run-header [aria-label="Run details"]').focus(),
	);
	run.tasks.find((task) => task.status === "running").activity.label =
		"Reading again";
	run.updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
	fixture.publish();
	await browser.waitFor(
		() => document.querySelector(".agent-sub")?.textContent === "Reading again",
	);
	assert.equal(
		await browser.evaluate(() =>
			document.activeElement.getAttribute("aria-label"),
		),
		"Run details",
		"header retains keyboard focus after SSE",
	);
	// Capture observable DOM geometry every 125 ms (8 fps). Clock-only updates must leave card
	// positions and the canvas node intact; legitimate status changes have a separate handoff test.
	const frames = await browser.evaluate(async () => {
		const canvas = document.querySelector("#canvas");
		const frames = [];
		for (let i = 0; i < 24; i++) {
			const rect = document
				.querySelector(".node .outline")
				.getBoundingClientRect();
			frames.push({
				canvas: canvas === document.querySelector("#canvas"),
				cards: document.querySelectorAll(".node").length,
				rows: document.querySelectorAll("[data-item]").length,
				x: rect.x,
				y: rect.y,
				w: rect.width,
			});
			await new Promise((resolve) => setTimeout(resolve, 125));
		}
		return frames;
	});
	assert.ok(
		frames.every(
			(frame) => frame.canvas && frame.cards > 0 && frame.rows === 18,
		),
	);
	assert.ok(
		frames.every(
			(frame) =>
				frame.x === frames[0].x &&
				frame.y === frames[0].y &&
				frame.w === frames[0].w,
		),
		// 2026-11-11: failed once on macOS/Node 26 CI (42986253099, passed on rerun; 40/40 locally): name the frames.
		`clock ticks do not jump the graph: ${JSON.stringify(
			frames
				.map((frame, index) => ({ index, ...frame }))
				.filter(
					(frame) =>
						frame.x !== frames[0].x ||
						frame.y !== frames[0].y ||
						frame.w !== frames[0].w,
				)
				.slice(0, 4),
		)} vs first ${JSON.stringify(frames[0])}`,
	);
	await browser.click('[data-filter="running"]');
	const lastRunning = run.tasks.find((task) => task.status === "running");
	lastRunning.status = lastRunning.statusDetail = "completed";
	run.taskSummary.running--;
	run.taskSummary.completed++;
	run.agentSummary.completed++;
	run.updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
	fixture.publish();
	await browser.waitFor(
		() =>
			document.querySelector('[data-filter="running"]')?.textContent ===
			"Running 0",
	);
	assert.equal(
		await browser.evaluate(() => document.activeElement.dataset.filter),
		"running",
		"a selected zero-count filter retains keyboard focus",
	);
	assert.equal(
		await browser.evaluate(() =>
			document
				.querySelector('[data-filter="running"]')
				.getAttribute("aria-pressed"),
		),
		"true",
	);
	await browser.click('[data-filter="all"]');
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll("[data-item]").length,
		),
		18,
	);
	await browser.open(`${fixture.origin}/?run=${parallel.runId}`);
	await browser.waitFor(
		() => document.querySelectorAll(".stage-row").length === 3,
	);
	await browser.evaluate(() =>
		document.querySelectorAll(".stage-row")[1].focus(),
	);
	const member = await browser.evaluate(
		() => document.activeElement.dataset.stage,
	);
	const current = fixture.runs.get(parallel.runId);
	current.updatedAt = new Date(
		Date.parse(current.updatedAt) + 1000,
	).toISOString();
	for (const task of current.tasks) {
		if (task.stageId === "plan") task.status = task.statusDetail = "completed";
		if (task.stageId === member) task.status = task.statusDetail = "running";
	}
	await browser.evaluate(() => {
		window.matrixFocusedMember = document.activeElement;
	});
	fixture.publish();
	await browser.waitFor(() => !window.matrixFocusedMember.isConnected);
	assert.equal(
		await browser.evaluate(() => document.activeElement.dataset.stage),
		member,
		"parallel member retains keyboard focus after SSE",
	);
	assert.equal(
		await browser.evaluate(() =>
			document.activeElement.classList.contains("stage-row"),
		),
		true,
	);
	assert.deepEqual(browser.errors, []);
});
