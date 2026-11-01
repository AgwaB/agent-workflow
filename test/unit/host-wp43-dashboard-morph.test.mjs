// 2026-11-01 (owner choice): a status change that reshapes the graph (a foreach card collapses or
// expands, later cards move) morphs from the previous geometry instead of jumping; the old content
// fades out as an inert copy; reduced motion keeps the instant redraw.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
const load = async (name) =>
	JSON.parse(
		await readFile(
			new URL(`../fixtures/dashboard/matrix/${name}.json`, import.meta.url),
			"utf8",
		),
	);
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Items running (card with rows) and, next, all items done with the report running (collapsed). */
async function states() {
	const running = await load("foreach-3-running");
	const finished = await load("foreach-3-finished");
	const expanded = clone(running);
	for (const task of expanded.tasks)
		if (/^check-claims\.c\d$/.test(task.specId))
			Object.assign(task, { status: "running", statusDetail: "running" });
	const collapsed = clone(finished);
	collapsed.runId = running.runId;
	collapsed.status = "running";
	collapsed.live = true;
	const report = collapsed.tasks.find((task) => task.specId === "report.main");
	Object.assign(report, { status: "running", statusDetail: "running" });
	delete report.completedAt;
	delete report.outcome;
	return { expanded, collapsed };
}

const geometry = () =>
	Object.fromEntries(
		[...document.querySelectorAll("#canvas .node[data-stage]")].map((node) => [
			node.dataset.stage,
			{
				transform: node.getAttribute("transform"),
				height: Number(
					node.querySelector(":scope > rect.outline").getAttribute("height"),
				),
			},
		]),
	);

/** Running animations on cards, their outlines and old-content copies (not the live breathing). */
const morphs = () =>
	document.getAnimations().flatMap((animation) => {
		const target = animation.effect?.target;
		if (!target?.closest?.("#canvas .node")) return [];
		if (animation.effect.getTiming().iterations === Infinity) return [];
		const keyframes = animation.effect.getKeyframes();
		return [
			{
				stage: target.closest(".node").dataset.stage,
				target: target.matches(".node")
					? "card"
					: target.matches("rect.outline")
						? "outline"
						: target.matches(".morph-old")
							? "old"
							: "content",
				properties: [
					...new Set(
						keyframes.flatMap((frame) =>
							Object.keys(frame).filter(
								(key) =>
									!["offset", "easing", "composite", "computedOffset"].includes(
										key,
									),
							),
						),
					),
				],
				from: keyframes[0],
			},
		];
	});

test("dashboard graph: reshaping status changes morph from the previous geometry; reduced motion is instant", {
	timeout: 60_000,
}, async (t) => {
	const { expanded, collapsed } = await states();
	const fixture = await createFixtureServer({ snapshots: [expanded] });
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/?run=${expanded.runId}`);
	await browser.waitFor(() =>
		document.querySelector(
			'#canvas .node[data-stage="check-claims"] .agent-row',
		),
	);
	// Let the first-load entrance replay finish; this test is about later redraws.
	await new Promise((resolve) => setTimeout(resolve, 2500));
	await browser.send("Animation.enable");
	await browser.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
	const before = await browser.evaluate(geometry);

	fixture.runs.set(collapsed.runId, collapsed);
	fixture.publish();
	await browser.waitFor(
		() =>
			document
				.querySelector('#canvas .node[data-stage="report"]')
				?.classList.contains("running") &&
			document.querySelector("#canvas .morph-old"),
	);
	const during = await browser.evaluate(morphs);
	const after = await browser.evaluate(geometry);
	assert.ok(
		after["check-claims"].height < before["check-claims"].height,
		"the foreach card collapsed",
	);
	const outline = during.find(
		(item) => item.stage === "check-claims" && item.target === "outline",
	);
	assert.ok(outline, JSON.stringify(during));
	assert.deepEqual(outline.properties.sort(), ["height", "width"]);
	assert.equal(
		Number.parseFloat(outline.from.height),
		before["check-claims"].height,
		"the outline starts at its previous height",
	);
	assert.ok(
		during.some((item) => item.stage === "report" && item.target === "card"),
		"the card below moves instead of jumping",
	);
	assert.ok(during.some((item) => item.target === "old"));
	// The old content is a display-only copy: nothing focusable, no hooks, hidden from AT.
	assert.deepEqual(
		await browser.evaluate(() => {
			const old = document.querySelector("#canvas .morph-old");
			return {
				hidden: old.getAttribute("aria-hidden"),
				focusable: old.querySelectorAll("[tabindex],[role]").length,
				hooks: [...old.querySelectorAll("*")].filter((el) =>
					el.getAttributeNames().some((name) => name.startsWith("data-")),
				).length,
				rows: old.querySelectorAll(".agent-row,.stage-row").length,
			};
		}),
		{ hidden: "true", focusable: 0, hooks: 0, rows: 0 },
	);
	// At normal speed it settles: copies removed, card geometry exactly the new layout.
	await browser.send("Animation.setPlaybackRate", { playbackRate: 1 });
	await browser.waitFor(
		() =>
			!document.querySelector("#canvas .morph-old") &&
			document.getAnimations().every(
				(animation) =>
					// Live breathing (infinite) stays; the finite morph must be over.
					animation.effect?.getTiming().iterations === Infinity ||
					!animation.effect?.target?.matches?.(".node, .node > rect.outline"),
			),
	);
	assert.deepEqual(await browser.evaluate(geometry), after);

	// Reduced motion: the same reshape (expanding again) is an instant redraw.
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	fixture.runs.set(expanded.runId, clone(expanded));
	fixture.publish();
	await browser.waitFor(() =>
		document.querySelector(
			'#canvas .node[data-stage="check-claims"] .agent-row',
		),
	);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(await browser.evaluate(morphs), []);
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll("#canvas .morph-old").length,
		),
		0,
	);
});
