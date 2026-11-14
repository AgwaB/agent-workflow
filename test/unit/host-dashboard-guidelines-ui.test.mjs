// test-tier: integration
// Isolated Chrome fixtures only; no models or real user profile writes.
import assert from "node:assert/strict";
import test from "node:test";
import { profileAction } from "../../dist/hosts/catalog.js";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";

const chrome = await findChrome();
async function open(t, suffix = "&createProfile=1", width = 390) {
	assert.ok(chrome, "Chrome is required");
	const p = await managementProject(t);
	await profileGraphFixtures(p.cwd);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Emulation.setDeviceMetricsOverride", {
		width,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	const url = `${p.origin}/?project=${p.server.projectId}&view=profiles&workflow=model-flow`;
	await browser.send("Page.navigate", { url: url + suffix });
	await browser.waitFor(() => !!document.querySelector(".profile-overview"));
	if (suffix)
		await browser.waitFor(
			() => !!document.querySelector('[data-management-action="save-profile"]'),
		);
	return { ...p, browser, url };
}
async function set(browser, label, value) {
	await browser.evaluate(
		(label, value) => {
			const node = document.querySelector(`[aria-label="${label}"]`);
			node.closest("details")?.setAttribute("open", "");
			node.value = value;
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}

test("G1: blank profile name has one visible connected error, correction preserves drafts and saves", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	const b = p.browser;
	await set(b, "Model", "manual/keep-this-id");
	await set(b, "Profile name", "   ");
	await b.evaluate(() => {
		const hint = document.createElement("p");
		hint.id = "existing-name-hint";
		hint.textContent = "Existing help";
		document.querySelector('[aria-label="Profile name"]').after(hint);
		document
			.querySelector('[aria-label="Profile name"]')
			.setAttribute("aria-describedby", hint.id);
		window.profilePuts = 0;
		const original = window.fetch;
		window.fetch = (...args) => {
			if (args[1]?.method === "PUT") window.profilePuts++;
			return original(...args);
		};
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		await b.click('[data-management-action="save-profile"]');
		await b.waitFor(
			() =>
				!document.querySelector('[data-management-action="save-profile"]')
					.disabled,
		);
		const result = await b.evaluate(() => {
			const name = document.querySelector('[aria-label="Profile name"]');
			const ids = (name.getAttribute("aria-describedby") || "").split(/\s+/);
			const error = ids
				.map((id) => document.getElementById(id))
				.find(
					(node) => node?.textContent === "Enter a profile name before saving.",
				);
			const nr = name.getBoundingClientRect(),
				er = error?.getBoundingClientRect();
			return {
				invalid: name.getAttribute("aria-invalid"),
				focused: document.activeElement === name,
				connected: !!error,
				visible:
					!!er &&
					er.top >= 0 &&
					er.bottom <= innerHeight &&
					nr.top >= 0 &&
					nr.bottom <= innerHeight,
				count: [...document.querySelectorAll('[role="alert"]')].filter(
					(node) => node.textContent === "Enter a profile name before saving.",
				).length,
				puts: window.profilePuts,
				model: document.querySelector('[aria-label="Model"]').value,
			};
		});
		assert.deepEqual(result, {
			invalid: "true",
			focused: true,
			connected: true,
			visible: true,
			count: 1,
			puts: 0,
			model: "manual/keep-this-id",
		});
	}
	await set(b, "Profile name", "corrected");
	assert.deepEqual(
		await b.evaluate(() => {
			const name = document.querySelector('[aria-label="Profile name"]');
			return [
				name.getAttribute("aria-invalid"),
				name.getAttribute("aria-describedby"),
				document.querySelectorAll('[role="alert"]:not([hidden])').length,
			];
		}),
		[null, "existing-name-hint", 0],
	);
	// A real host rejection stays actionable; local validation must not disguise API failure.
	await set(b, "Profile name", "invalid name");
	await b.click('[data-management-action="save-profile"]');
	await b.waitFor(
		() =>
			!!document.querySelector('.profile-editor [role="alert"]:not([hidden])'),
	);
	assert.match(
		await b.evaluate(
			() =>
				document.querySelector('.profile-editor [role="alert"]:not([hidden])')
					.textContent,
		),
		/invalid profile name/,
	);
	assert.equal(
		await b.evaluate(() => !!document.querySelector(".profile-save-status")),
		false,
	);
	await set(b, "Profile name", "corrected");
	await b.click('[data-management-action="save-profile"]');
	await b.waitFor(() => !!document.querySelector(".profile-save-status"));
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "corrected" })).data.profile
			.model,
		"manual/keep-this-id",
	);
});

test("G3: narrow and coarse controls retain usable geometry and desktop density", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	const b = p.browser;
	await b.waitFor(() => !!document.querySelector(".profile-flow .code-switch"));
	for (const [width, coarse] of [
		[390, false],
		[390, true],
		[1280, true],
		[1280, false],
		[1600, false],
	]) {
		await b.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await b.send("Emulation.setTouchEmulationEnabled", {
			enabled: coarse,
			maxTouchPoints: 1,
		});
		await b.evaluate(
			() => (document.querySelector(".profile-common").open = true),
		);
		const sizes = await b.evaluate(() => {
			const rect = (node) => {
				const r = node.getBoundingClientRect();
				return [r.width, r.height];
			};
			return {
				coarse: matchMedia("(pointer: coarse)").matches,
				font: parseFloat(
					getComputedStyle(document.querySelector('[aria-label="Model"]'))
						.fontSize,
				),
				buttons: [
					...document.querySelectorAll(
						".profile-editor-actions button, .top button, .profile-flow .toolbar button, .code-switch, .management-nav a, .profile-row, summary",
					),
				]
					.filter((node) => node.getBoundingClientRect().width)
					.map((node) => ({
						name: node.textContent || node.title,
						size: rect(node),
					})),
				overflow: document.documentElement.scrollWidth > innerWidth,
			};
		});
		assert.equal(sizes.coarse, coarse);
		const touchSized = width <= 800 || coarse;
		assert.equal(sizes.font, touchSized ? 16 : 14);
		assert.equal(sizes.overflow, false);
		if (touchSized)
			for (const control of sizes.buttons)
				assert.ok(
					control.size.every((size) => size >= 44),
					JSON.stringify(control),
				);
		else
			assert.equal(
				sizes.buttons.find((entry) => entry.name === "Save profile").size[1],
				32,
			);
	}
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await b.click(".profile-flow .code-switch");
	await b.waitFor(
		() =>
			document
				.querySelector(".profile-flow .code-switch")
				?.getAttribute("aria-checked") === "true",
	);
	await b.click('.profile-flow .toolbar button[title="Fit graph"]');
	const geometry = await b.evaluate(() => {
		const rect = (selector) =>
			document.querySelector(selector).getBoundingClientRect();
		const chip = rect(".profile-flow .code-switch");
		const first = rect(".profile-flow .node");
		return { chipBottom: chip.bottom, firstTop: first.top };
	});
	assert.ok(geometry.firstTop >= geometry.chipBottom, JSON.stringify(geometry));
	const lastGeometry = await b.evaluate(() => {
		const nodes = [...document.querySelectorAll(".profile-flow .node")];
		nodes[0].focus();
		for (let index = 0; index < nodes.length + 5; index++)
			document.activeElement.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		const last = nodes.at(-1),
			box = last.getBoundingClientRect();
		const canvas = last.closest(".canvas").getBoundingClientRect();
		const toolbar = document
			.querySelector(".profile-flow .toolbar")
			.getBoundingClientRect();
		const controls = [
			...document.querySelectorAll(
				".profile-flow .code-switch, .profile-flow .toolbar button, .profile-flow .more",
			),
		].filter((node) => node.getBoundingClientRect().width);
		const overlaps = [];
		for (let i = 0; i < controls.length; i++)
			for (let j = i + 1; j < controls.length; j++) {
				const a = controls[i].getBoundingClientRect(),
					b = controls[j].getBoundingClientRect();
				if (
					a.left < b.right &&
					a.right > b.left &&
					a.top < b.bottom &&
					a.bottom > b.top
				)
					overlaps.push([controls[i].textContent, controls[j].textContent]);
			}
		return {
			focused: document.activeElement === last,
			inside: box.top >= canvas.top && box.bottom <= canvas.bottom,
			clear:
				box.bottom <= toolbar.top ||
				box.right <= toolbar.left ||
				box.left >= toolbar.right,
			overlaps,
		};
	});
	assert.deepEqual(lastGeometry, {
		focused: true,
		inside: true,
		clear: true,
		overlaps: [],
	});
	await b.click('[aria-label="Effort"]');
	assert.equal(
		await b.evaluate(() => {
			const input = document.querySelector('[aria-label="Effort"]');
			const menu = document.getElementById(input.getAttribute("aria-controls"));
			return (
				[...menu.querySelectorAll('[role="option"]')].every(
					(node) => node.getBoundingClientRect().height >= 44,
				) && parseFloat(getComputedStyle(menu).fontSize) >= 16
			);
		}),
		true,
	);
	await b.key("Escape");
	await b.click('[data-management-action="save-profile"]');
	await b.waitFor(
		() => document.activeElement?.getAttribute("aria-label") === "Profile name",
	);
	assert.deepEqual(b.errors, []);
});

test("G4: profile rows are encoded links; modified activation leaves original history intact", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t, "", 1280);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily.test-_1",
		values: { model: "manual/id" },
	});
	await p.browser.send("Page.reload");
	await p.browser.waitFor(
		() => !!document.querySelector('[data-profile-open="daily.test-_1"]'),
	);
	const rows = await p.browser.evaluate(() =>
		[...document.querySelectorAll("[data-profile-open]")].map((node) => ({
			tag: node.tagName,
			name: node.dataset.profileOpen,
			href: node.href,
			height: node.getBoundingClientRect().height,
		})),
	);
	assert.ok(rows.length > 1);
	for (const row of rows) {
		assert.equal(row.tag, "A");
		assert.equal(
			row.height,
			53,
			"fine-pointer desktop rows retain the original button density",
		);
		const url = new URL(row.href);
		assert.equal(url.searchParams.get("profile"), row.name);
		assert.equal(url.searchParams.get("workflow"), "model-flow");
		assert.equal(url.searchParams.get("project"), p.server.projectId);
	}
	assert.equal(
		await p.browser.evaluate(() => {
			const link = document.querySelector(
				'[data-profile-open="daily.test-_1"]',
			);
			const before = location.href,
				length = history.length;
			for (const options of [
				{ metaKey: true },
				{ ctrlKey: true },
				{ shiftKey: true },
				{ altKey: true },
				{ button: 1 },
			]) {
				const event = new MouseEvent("click", {
					bubbles: true,
					cancelable: true,
					...options,
				});
				// Observe the app handler without letting this synthetic event open extra test tabs.
				let prevented;
				const observe = (e) => {
					prevented = e.defaultPrevented;
					e.preventDefault();
				};
				document.addEventListener("click", observe, { once: true });
				link.dispatchEvent(event);
				if (prevented || location.href !== before || history.length !== length)
					return false;
			}
			return true;
		}),
		true,
	);
	// A trusted middle-click uses the anchor's native new-tab path, not the SPA handler.
	const before = await p.browser.evaluate(() => ({
		href: location.href,
		length: history.length,
	}));
	const position = await p.browser.evaluate(() => {
		const link = document.querySelector('[data-profile-open="daily.test-_1"]');
		link.scrollIntoView({ block: "nearest" });
		const box = link.getBoundingClientRect();
		return {
			x: box.x + box.width / 2,
			y: box.y + box.height / 2,
			href: link.href,
		};
	});
	for (const type of ["mousePressed", "mouseReleased"])
		await p.browser.send("Input.dispatchMouseEvent", {
			type,
			x: position.x,
			y: position.y,
			button: "middle",
			clickCount: 1,
		});
	let child;
	for (let attempt = 0; attempt < 100 && !child; attempt++) {
		child = (
			await p.browser.send("Target.getTargets", {}, null)
		).targetInfos.find((target) => target.url === position.href);
		if (!child) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(child, "middle-click opens the editor href in another tab");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			href: location.href,
			length: history.length,
		})),
		before,
	);
	await p.browser.send(
		"Target.closeTarget",
		{ targetId: child.targetId },
		null,
	);
	await p.browser.click('[data-profile-open="daily.test-_1"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[data-profile-edit="daily.test-_1"]'),
	);
	await p.browser.click("[data-profile-back]");
	await p.browser.waitFor(
		() => document.activeElement?.dataset.profileOpen === "daily.test-_1",
	);
});

test("G5: first Tab exposes skip link, activation focuses main without navigation or draft reset", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	const b = p.browser;
	await set(b, "Profile name", "unsaved-name");
	await b.evaluate(() => {
		document.activeElement?.blur();
		window.skipDocument = document;
	});
	// Reset the sequential keyboard starting point to the document's beginning.
	await b.evaluate(() => {
		const start = document.createElement("span");
		start.tabIndex = -1;
		document.body.prepend(start);
		start.focus();
		start.remove();
	});
	await b.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Tab",
		code: "Tab",
		windowsVirtualKeyCode: 9,
	});
	await b.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Tab",
		code: "Tab",
		windowsVirtualKeyCode: 9,
	});
	const before = await b.evaluate(() => ({
		href: location.href,
		length: history.length,
		first: document.activeElement.textContent,
		visible: document.activeElement.getBoundingClientRect().top >= 0,
	}));
	assert.equal(before.first, "Skip to content");
	assert.equal(before.visible, true);
	await b.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
	});
	await b.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
	});
	assert.deepEqual(
		await b.evaluate(() => ({
			href: location.href,
			length: history.length,
			focus: document.activeElement.id,
			draft: document.querySelector('[aria-label="Profile name"]').value,
			same: document === window.skipDocument,
			tabIndex: document.querySelector("main").tabIndex,
		})),
		{
			href: before.href,
			length: before.length,
			focus: "center",
			draft: "unsaved-name",
			same: true,
			tabIndex: -1,
		},
	);
	await b.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Tab",
		code: "Tab",
		windowsVirtualKeyCode: 9,
	});
	await b.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Tab",
		code: "Tab",
		windowsVirtualKeyCode: 9,
	});
	assert.equal(
		await b.evaluate(() => !!document.activeElement.closest("main")),
		true,
	);
});
