// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const complete = "workflow_mvt23704_e8e6d7";
const chrome = await findChrome();
async function setup(t, width = 390, height = 844, motion = false) {
	assert.ok(chrome, "native Chrome is required for graph hit tests");
	const fixture = await createFixtureServer({ readonly: true });
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	// Static fixture has no catalog lookup: provide only E1's safe null-target GET.
	// All original runtime/CSP/network-error assertions stay unchanged.
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
	 const originalFetch = window.fetch;
	 window.fetch = (...args) => {
	  const match = /^\\/api\\/projects\\/[^/]+\\/runs\\/(workflow_[A-Za-z0-9_-]+)\\/workflow-settings-target$/.exec(String(args[0]));
	  if (match && (!args[1]?.method || args[1].method === 'GET')) return Promise.resolve(new Response(JSON.stringify({runId:match[1],target:null,reason:'definition-unavailable'}),{status:200}));
	  return originalFetch(...args);
	 };
	`,
	});
	await browser.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await browser.send("Emulation.setTouchEmulationEnabled", {
		enabled: width <= 800,
	});
	await browser.send("Emulation.setEmulatedMedia", {
		features: [
			{
				name: "prefers-reduced-motion",
				value: motion ? "no-preference" : "reduce",
			},
		],
	});
	await browser.open(
		`${fixture.origin}/?run=${complete}&view=runs`,
		width,
		height,
	);
	assert.deepEqual(await browser.evaluate(() => [innerWidth, innerHeight]), [
		width,
		height,
	]);
	await browser.waitFor(() => !!document.querySelector("#canvas .node"));
	await browser.click('#canvas .code-switch[aria-checked="false"]');
	await browser.waitFor(
		() => !!document.querySelector('#canvas .code-switch[aria-checked="true"]'),
	);
	await browser.click('#canvas button[title="Fit graph (F)"]');
	return browser;
}

async function reachable(browser, id) {
	const measured = await browser.evaluate((id) => {
		const node = [...document.querySelectorAll("#canvas .node")].find(
			(n) => n.dataset.stage === id,
		);
		const r = node.querySelector(":scope > .outline").getBoundingClientRect();
		const canvas = document
			.querySelector("#canvas .graph")
			.getBoundingClientRect();
		const hit = document.elementFromPoint(
			r.x + r.width / 2,
			r.y + r.height / 2,
		);
		return {
			id,
			inside:
				r.left >= canvas.left &&
				r.right <= canvas.right &&
				r.top >= canvas.top &&
				r.bottom <= canvas.bottom,
			hit: node.contains(hit),
			rect: r.toJSON(),
			canvas: canvas.toJSON(),
		};
	}, id);
	assert.equal(measured.inside, true, JSON.stringify(measured));
	assert.equal(measured.hit, true, JSON.stringify(measured));
	await clearOfControls(browser, "#canvas .toolbar");
	await clearOfControls(browser, "#canvas .code-switch");
}

async function controlsReachable(browser) {
	const controls = await browser.evaluate(() =>
		[
			...document.querySelectorAll(
				"#canvas .toolbar button, #canvas .code-switch, #canvas .more:not([hidden])",
			),
		].map((node) => {
			const r = node.getBoundingClientRect();
			return {
				label: node.getAttribute("aria-label") || node.textContent,
				inside:
					r.left >= 0 &&
					r.right <= innerWidth &&
					r.top >= 0 &&
					r.bottom <= innerHeight,
				hit: node.contains(
					document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
				),
			};
		}),
	);
	assert.ok(controls.length >= 7, JSON.stringify(controls));
	assert.equal(
		controls.every((c) => c.inside && c.hit),
		true,
		JSON.stringify(controls),
	);
}

// Intersect with the actual SVG viewport: off-screen nodes may pan, but no visible
// portion of a card may be painted under (or intercepted by) either control rail.
async function geometry(browser, selector) {
	return browser.evaluate((selector) => {
		const canvas = document
			.querySelector("#canvas .graph")
			.getBoundingClientRect();
		const control = document.querySelector(selector).getBoundingClientRect();
		return [...document.querySelectorAll("#canvas .node > .outline")].map(
			(node) => {
				const r = node.getBoundingClientRect();
				const left = Math.max(r.left, canvas.left, control.left);
				const right = Math.min(r.right, canvas.right, control.right);
				const top = Math.max(r.top, canvas.top, control.top);
				const bottom = Math.min(r.bottom, canvas.bottom, control.bottom);
				const overlap = right > left && bottom > top;
				const hit = overlap
					? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
					: null;
				return {
					id: node.parentNode.dataset.stage,
					rect: r.toJSON(),
					control: control.toJSON(),
					overlapWidth: Math.max(0, right - left),
					overlapHeight: Math.max(0, bottom - top),
					overlap,
					intercepted: !!hit && !node.parentNode.contains(hit),
					hit: hit?.outerHTML.slice(0, 200),
				};
			},
		);
	}, selector);
}
async function clearOfControls(browser, selector) {
	const measured = await geometry(browser, selector);
	assert.equal(
		measured.some((n) => n.intercepted),
		false,
		JSON.stringify(measured),
	);
	assert.equal(
		measured.some((n) => n.overlap),
		false,
		JSON.stringify(measured),
	);
}

for (const [name, selector] of [
	["bottom toolbar", "#canvas .toolbar"],
	["top code switch", "#canvas .code-switch"],
]) {
	test(`Run readable Fit does not paint nodes beneath the ${name}`, {
		timeout: 60000,
	}, async (t) => {
		const browser = await setup(t);
		await clearOfControls(browser, selector);
		assert.deepEqual(browser.errors, []);
	});
}

for (const [width, height] of [
	[390, 844],
	[320, 640],
	[1440, 900],
]) {
	test(`Run drawable geometry, navigation and controls at ${width}x${height}`, {
		timeout: 120000,
	}, async (t) => {
		const browser = await setup(t, width, height);
		for (const layout of ["Top-down", "Left-right"]) {
			await browser.click(`#canvas [aria-label="${layout}"]`);
			for (const shown of [true, false]) {
				if (!shown) await browser.click("#canvas .code-switch");
				await browser.click('#canvas button[title="Fit graph (F)"]');
				const state = await browser.evaluate(() => ({
					ids: [...document.querySelectorAll("#canvas .node")].map(
						(n) => n.dataset.stage,
					),
					stops: document.querySelectorAll("#canvas .node, #canvas .agent-row")
						.length,
					code: document.querySelectorAll("#canvas .node.support").length,
					zoom: Number(
						/scale\(([^)]+)\)/.exec(
							document
								.querySelector("#canvas svg.graph > g")
								.getAttribute("transform"),
						)[1],
					),
				}));
				assert.equal(
					state.ids.length,
					shown ? 8 : 4,
					"fixture topology is not truncated",
				);
				assert.equal(state.code, shown ? 4 : 0);
				assert.ok(state.zoom >= 0.7, `readable Fit floor: ${state.zoom}`);
				await clearOfControls(browser, "#canvas .toolbar");
				await clearOfControls(browser, "#canvas .code-switch");
				await controlsReachable(browser);

				// Pan beyond both ends using real wheel input; clamp keeps each end reachable.
				for (const delta of [10000, -10000]) {
					const point = await browser.evaluate(() => {
						const r = document
							.querySelector("#canvas .graph")
							.getBoundingClientRect();
						return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
					});
					await browser.send("Input.dispatchMouseEvent", {
						type: "mouseWheel",
						...point,
						deltaX: layout === "Left-right" ? delta : 0,
						deltaY: layout === "Top-down" ? delta : 0,
					});
					// A frame is a rendering boundary, not a time-based retry.
					await browser.evaluate(
						() =>
							new Promise((resolve) =>
								requestAnimationFrame(() => requestAnimationFrame(resolve)),
							),
					);
					await reachable(browser, delta > 0 ? state.ids.at(-1) : state.ids[0]);
					await controlsReachable(browser);
					const hint = await browser.evaluate(
						() =>
							document.querySelector("#canvas .more:not([hidden])")?.dataset
								.more,
					);
					if (hint) {
						const before = await browser.evaluate(() =>
							document
								.querySelector("#canvas svg.graph > g")
								.getAttribute("transform"),
						);
						await browser.click(`#canvas [data-more="${hint}"]`);
						assert.notEqual(
							await browser.evaluate(() =>
								document
									.querySelector("#canvas svg.graph > g")
									.getAttribute("transform"),
							),
							before,
							"hint actually pans the camera",
						);
						await controlsReachable(browser);
					}
				}

				// Native keyboard traversal visits every card in both directions.
				await browser.click('#canvas button[title="Fit graph (F)"]');
				await browser.evaluate(() =>
					document.querySelector("#canvas .node").focus(),
				);
				const visited = new Set([state.ids[0]]);
				for (const key of ["ArrowDown", "ArrowUp"]) {
					for (let i = 1; i < state.stops; i++) {
						await browser.key(key);
						const id = await browser.evaluate(
							() => document.activeElement.closest(".node")?.dataset.stage,
						);
						assert.ok(id, "keyboard focus stays on the graph");
						visited.add(id);
						await reachable(browser, id);
					}
				}
				assert.deepEqual([...visited].sort(), [...state.ids].sort());
				await browser.click("#canvas .toolbar button:nth-child(2)"); // Focus final stage.
				await reachable(browser, state.ids.at(-1));
				await browser.evaluate(() =>
					[...document.querySelectorAll("#canvas .node")].at(-1).focus(),
				);
				await browser.key("Enter");
				await browser.waitFor(
					() => !document.querySelector("#inspector").hidden,
				);
				if (width > 800) {
					await controlsReachable(browser);
					// Opening the inspector resizes a manual camera without changing its
					// selection. Focus must still reveal that selection in the smaller viewport.
					await browser.click("#canvas .toolbar button:nth-child(2)");
					await reachable(browser, state.ids.at(-1));
				}
				await browser.key("Escape");
				await browser.waitFor(
					() => document.querySelector("#inspector").hidden,
				);
				await controlsReachable(browser);
				t.diagnostic(
					JSON.stringify({ width, height, layout, shown, ...state }),
				);
			}
			await browser.click("#canvas .code-switch"); // Restore shown for next orientation.
		}
		assert.deepEqual(browser.errors, []);
	});
}

async function frames(browser) {
	await browser.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	);
}

for (const motion of [false, true]) {
	test(`Run hint changes preserve the input camera (motion ${motion})`, {
		timeout: 60000,
	}, async (t) => {
		const browser = await setup(t, 1440, 900, motion);
		await frames(browser);
		await browser.evaluate(async () => {
			await Promise.all(
				document
					.getAnimations()
					.filter((a) =>
						Number.isFinite(a.effect.getComputedTiming().iterations),
					)
					.map((a) => a.finished),
			);
			window.hintInputs = [];
			window.observerErrors = [];
			addEventListener("error", (event) =>
				window.observerErrors.push(event.message),
			);
			const drawing = document.querySelector("#canvas .graph-drawing");
			drawing.addEventListener("wheel", () =>
				window.hintInputs.push({
					transform: drawing.querySelector("svg > g").getAttribute("transform"),
					height: drawing.clientHeight,
					hints: document.querySelectorAll("#canvas .more:not([hidden])")
						.length,
				}),
			);
		});
		const counts = [];
		for (const deltaY of [-100, 100]) {
			await browser.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: 700,
				y: 500,
				deltaX: 0,
				deltaY,
				modifiers: 2,
			});
			await browser.waitFor(() => window.hintInputs.length > 0);
			await frames(browser);
			const state = await browser.evaluate(() => ({
				input: window.hintInputs.pop(),
				transform: document
					.querySelector("#canvas svg.graph > g")
					.getAttribute("transform"),
				height: document.querySelector("#canvas .graph-drawing").clientHeight,
				hints: document.querySelectorAll("#canvas .more:not([hidden])").length,
				errors: window.observerErrors,
			}));
			t.diagnostic(JSON.stringify(state));
			assert.equal(
				state.transform,
				state.input.transform,
				"observer must not shift the camera after input",
			);
			assert.equal(state.height, state.input.height);
			assert.deepEqual(state.errors, []);
			counts.push(state.hints);
		}
		assert.ok(counts[0] > 0, "zoom creates offscreen hints");
		assert.equal(counts[1], 0, "zoom back removes all hints");
		assert.deepEqual(browser.errors, []);
	});
}

for (const [width, height] of [
	[320, 480],
	[390, 568],
	[844, 390],
]) {
	test(`Run short viewport has scroll-reachable controls and drawing at ${width}x${height}`, {
		timeout: 60000,
	}, async (t) => {
		const browser = await setup(t, width, height);
		await frames(browser);
		const drawing = await browser.evaluate(() => {
			const drawing = document.querySelector("#canvas .graph-drawing");
			return { height: drawing.clientHeight, width: drawing.clientWidth };
		});
		t.diagnostic(JSON.stringify(drawing));
		assert.ok(
			drawing.height >= 100,
			"retain a useful drawing area, not a zero-height flex child",
		);
		const selectors = await browser.evaluate(() => [
			"#canvas .code-switch",
			...[...document.querySelectorAll("#canvas .toolbar button")].map(
				(n, i) => {
					// M2 wraps only layout buttons in a labelled segmented group.
					n.dataset.reachability = String(i);
					return `#canvas [data-reachability="${i}"]`;
				},
			),
			...[...document.querySelectorAll("#canvas .more:not([hidden])")].map(
				(n) => `#canvas [data-more="${n.dataset.more}"]`,
			),
		]);
		for (const selector of selectors) {
			const measured = await browser.evaluate((selector) => {
				const node = document.querySelector(selector);
				node.scrollIntoView({ block: "center", inline: "nearest" });
				const r = node.getBoundingClientRect();
				const shell = document.querySelector("#canvas").getBoundingClientRect();
				return {
					selector,
					rect: r.toJSON(),
					shell: shell.toJSON(),
					inside:
						r.top >= shell.top &&
						r.bottom <= shell.bottom &&
						r.left >= shell.left &&
						r.right <= shell.right,
					hit: node.contains(
						document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
					),
				};
			}, selector);
			assert.ok(measured.inside && measured.hit, JSON.stringify(measured));
		}
		for (const layout of ["Top-down", "Left-right"]) {
			const selector = `#canvas [aria-label="${layout}"]`;
			await browser.evaluate(
				(selector) =>
					document.querySelector(selector).scrollIntoView({ block: "center" }),
				selector,
			);
			await browser.click(selector);
			for (const shown of [true, false]) {
				if (!shown) {
					await browser.evaluate(() =>
						document
							.querySelector("#canvas .code-switch")
							.scrollIntoView({ block: "center" }),
					);
					await browser.click("#canvas .code-switch");
				}
				const state = await browser.evaluate(() => ({
					ids: [...document.querySelectorAll("#canvas .node")].map(
						(n) => n.dataset.stage,
					),
					zoom: Number(
						/scale\(([^)]+)\)/.exec(
							document
								.querySelector("#canvas svg.graph > g")
								.getAttribute("transform"),
						)[1],
					),
				}));
				assert.equal(state.ids.length, shown ? 8 : 4);
				assert.ok(state.zoom >= 0.7, `readable Fit floor: ${state.zoom}`);
				await browser.evaluate(() =>
					document
						.querySelector("#canvas .node")
						.focus({ preventScroll: true }),
				);
				await browser.key("ArrowUp"); // Reveal the first card and the scrollable drawing.
				await reachable(browser, state.ids[0]);
				for (const id of state.ids.slice(1)) {
					await browser.key("ArrowDown");
					assert.equal(
						await browser.evaluate(
							() => document.activeElement.closest(".node").dataset.stage,
						),
						id,
					);
					await reachable(browser, id);
				}
			}
			await browser.evaluate(() =>
				document
					.querySelector("#canvas .code-switch")
					.scrollIntoView({ block: "center" }),
			);
			await browser.click("#canvas .code-switch");
		}
		assert.deepEqual(browser.errors, []);
	});
}

test("Run overflowing horizontal camera retains its original 16px bounds gutter", {
	timeout: 60000,
}, async (t) => {
	const browser = await setup(t, 1440, 900);
	await browser.click('#canvas [aria-label="Left-right"]');
	await browser.click('#canvas button[title="Fit graph (F)"]');
	await frames(browser);
	for (const deltaX of [-10000, 10000]) {
		await browser.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: 700,
			y: 500,
			deltaX,
			deltaY: 0,
		});
		await frames(browser);
		const measured = await browser.evaluate((end) => {
			const nodes = [...document.querySelectorAll("#canvas .node > .outline")];
			const r = nodes[end ? nodes.length - 1 : 0].getBoundingClientRect();
			const drawing = document
				.querySelector("#canvas .graph")
				.getBoundingClientRect();
			const k = Number(
				/scale\(([^)]+)\)/.exec(
					document
						.querySelector("#canvas svg.graph > g")
						.getAttribute("transform"),
				)[1],
			);
			return {
				gutter: end ? drawing.right - r.right : r.left - drawing.left,
				expected: 16 + 8 * k,
			};
		}, deltaX > 0);
		t.diagnostic(JSON.stringify(measured));
		assert.ok(
			Math.abs(measured.gutter - measured.expected) < 0.01,
			JSON.stringify(measured),
		);
	}
	assert.deepEqual(browser.errors, []);
});

test("Run motion-enabled code morph lands on the final native camera", {
	timeout: 60000,
}, async (t) => {
	const browser = await setup(t, 1440, 900, true);
	await browser.click('#canvas [aria-label="Left-right"]');
	await frames(browser);
	await browser.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter((a) => Number.isFinite(a.effect.getComputedTiming().iterations))
				.map((a) => a.finished),
		);
	});
	for (const shown of [false, true]) {
		// Start away from Fit so toggling shape must actually glide the camera.
		await browser.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: 700,
			y: 500,
			deltaX: 10000,
			deltaY: 0,
		});
		await frames(browser);
		// Record the viewport animation when it is created: on a slow runner it can finish (and leave
		// getAnimations()) before a lookup after the click's frames, which is not "no glide".
		await browser.evaluate(() => {
			window.viewportAnimations = [];
			if (window.restoreAnimate) window.restoreAnimate();
			const original = Element.prototype.animate;
			Element.prototype.animate = function (...args) {
				const animation = original.apply(this, args);
				if (this.matches("#canvas svg.graph > g"))
					window.viewportAnimations.push(animation);
				return animation;
			};
			window.restoreAnimate = () => {
				Element.prototype.animate = original;
			};
		});
		await browser.click("#canvas .code-switch");
		await frames(browser);
		const measured = await browser.evaluate(async () => {
			const viewport = document.querySelector("#canvas svg.graph > g");
			window.restoreAnimate();
			const animation = window.viewportAnimations.find(
				(a) => a.effect.target === viewport,
			);
			if (!animation) return { animation: false };
			const end = new DOMMatrix(
				animation.effect.getKeyframes().at(-1).transform,
			);
			await animation.finished;
			await new Promise((r) =>
				requestAnimationFrame(() => requestAnimationFrame(r)),
			);
			const actual = new DOMMatrix(getComputedStyle(viewport).transform);
			return {
				animation: true,
				end: [end.a, end.d, end.e, end.f],
				actual: [actual.a, actual.d, actual.e, actual.f],
			};
		});
		t.diagnostic(JSON.stringify({ shown, ...measured }));
		assert.equal(
			measured.animation,
			true,
			"the viewport really glides, not only card opacity",
		);
		for (let i = 0; i < measured.end.length; i++) {
			assert.ok(
				Math.abs(measured.end[i] - measured.actual[i]) < 0.01,
				JSON.stringify(measured),
			);
		}
		await clearOfControls(browser, "#canvas .toolbar");
		await clearOfControls(browser, "#canvas .code-switch");
	}
	assert.deepEqual(browser.errors, []);
});
