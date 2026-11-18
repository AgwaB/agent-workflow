// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";
const chrome = await findChrome();
async function browser(t) {
	assert.ok(chrome, "native Chrome required");
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	return b;
}
async function mark(b) {
	await b.evaluate(() => {
		window.__documentMarker = "same-document";
		window.__navNode = document.querySelector(".management-nav");
		window.__searchNode = document.querySelector(".search");
	});
}
async function sameDocument(b) {
	assert.equal(
		await b.evaluate(() => window.__documentMarker),
		"same-document",
	);
}

test("N1/N2: sidebar, workflow cards and Back/Forward preserve the document and shell", {
	timeout: 90000,
}, async (t) => {
	const p = await managementProject(t);
	await persistManagementRun(p.cwd, "workflow_spa_navigation");
	const b = await browser(t);
	await b.open(`${p.origin}/?project=${p.server.projectId}`);
	await mark(b);
	for (const view of ["workflows", "executors", "runs", "overview"]) {
		const selector =
			view === "overview"
				? '.management-nav a:not([href*="view="])'
				: `.management-nav a[href*="view=${view}"]`;
		await b.click(selector);
		await b.waitFor(
			view === "workflows"
				? () => !!document.querySelector(".workflow-card")
				: view === "executors"
					? () => !!document.querySelector(".executors")
					: view === "runs"
						? () => !!document.querySelector(".run-header")
						: () => !!document.querySelector("#home-view"),
		);
		await sameDocument(b);
		assert.equal(
			await b.evaluate(
				(s) => document.querySelector(s).getAttribute("aria-current"),
				selector,
			),
			"page",
		);
		assert.match(
			await b.evaluate(() => document.title),
			view === "workflows"
				? /Workflows/
				: view === "executors"
					? /Executors/
					: view === "runs"
						? /Management history/
						: /Overview/,
		);
	}
	for (const [direction, views] of [
		["back", ["runs", "executors", "workflows"]],
		["forward", ["executors", "runs", "overview"]],
	]) {
		for (const view of views) {
			await b.evaluate((direction) => history[direction](), direction);
			await b.waitFor(
				view === "workflows"
					? () => !!document.querySelector(".workflow-card")
					: view === "executors"
						? () => !!document.querySelector(".executors")
						: view === "runs"
							? () => !!document.querySelector(".run-header")
							: () => !!document.querySelector("#home-view"),
			);
			await sameDocument(b);
		}
	}
	await b.click('.management-nav a[href*="view=workflows"]');
	await b.waitFor(() => !!document.querySelector(".workflow-card"));
	await b.evaluate(() => {
		window.__navNode = document.querySelector(".management-nav");
		document.querySelector('.management-nav a[href*="view=workflows"]').focus();
	});
	await b.click(".workflow-card");
	await b.waitFor(() => !!document.querySelector(".project-workflow-actions"));
	await sameDocument(b);
	assert.equal(
		await b.evaluate(
			() => window.__navNode === document.querySelector(".management-nav"),
		),
		true,
	);
	assert.equal(
		await b.evaluate(
			() => window.__searchNode === document.querySelector(".search"),
		),
		true,
	);
	await b.click(".back-link");
	await b.waitFor(() => !!document.querySelector(".workflow-card"));
	await b.evaluate(() => history.back());
	await b.waitFor(() => !!document.querySelector(".project-workflow-actions"));
	await sameDocument(b);
	await b.evaluate(() => history.forward());
	await b.waitFor(() => !!document.querySelector(".workflow-card"));
	await sameDocument(b);
	// Native alternate destinations must not be intercepted (suppress the test event's default last).
	assert.deepEqual(
		await b.evaluate(() => {
			const link = document.querySelector(".workflow-card");
			const results = [];
			const observe = (event) => {
				results.push(event.defaultPrevented);
				event.preventDefault();
			};
			window.addEventListener("click", observe);
			for (const init of [
				{ ctrlKey: true },
				{ metaKey: true },
				{ shiftKey: true },
				{ altKey: true },
				{ button: 1 },
			])
				link.dispatchEvent(
					new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
				);
			for (const [key, value] of [
				["target", "_blank"],
				["download", "fixture"],
			]) {
				link.setAttribute(key, value);
				link.dispatchEvent(
					new MouseEvent("click", { bubbles: true, cancelable: true }),
				);
				link.removeAttribute(key);
			}
			window.removeEventListener("click", observe);
			return results;
		}),
		Array(7).fill(false),
	);
	await b.evaluate(() => {
		const link = document.createElement("a");
		link.href =
			document.querySelector('.management-nav a[href*="view=executors"]').href +
			"#center";
		document.querySelector("#rail").append(link);
		link.click();
		link.remove();
	});
	await b.waitFor(() => !!document.querySelector(".executors"));
	await sameDocument(b);
	assert.equal(await b.evaluate(() => location.hash), "#center");
	assert.deepEqual(b.errors, []);
});

test("N3: project switching and history reload project data and SSE in the same document", {
	timeout: 60000,
}, async (t) => {
	const f = await createFixtureServer({
		readonly: true,
		extraProjects: [
			{
				id: "empty-project",
				name: "Empty project",
				counts: { running: 0, needsAttention: 0, lastActivity: null },
			},
		],
	});
	t.after(() => f.close());
	const b = await browser(t);
	await b.open(`${f.origin}/?project=payments-api-123456789abc`);
	await mark(b);
	await b.evaluate(() => {
		const chooser = document.querySelector("#project-switcher");
		chooser.value = "empty-project";
		chooser.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await b.waitFor(() =>
		document
			.querySelector("#home-view")
			?.textContent.includes("No runs in this project"),
	);
	await sameDocument(b);
	assert.equal(
		await b.evaluate(() => document.querySelector("#project").textContent),
		"Empty project",
	);
	await b.waitFor(() =>
		document.querySelector("#connection")?.textContent.includes("Live"),
	);
	assert.ok(
		b.requests.some((r) => r.includes("/api/events?project=empty-project")),
	);
	await b.evaluate(() => history.back());
	await b.waitFor(() => !!document.querySelector(".home-grid"));
	await sameDocument(b);
	assert.equal(
		await b.evaluate(() => document.querySelector("#project").textContent),
		"payments-api",
	);
	await b.evaluate(() => history.forward());
	await b.waitFor(() =>
		document
			.querySelector("#home-view")
			?.textContent.includes("No runs in this project"),
	);
	await sameDocument(b);
	assert.deepEqual(b.errors, []);
});

test("N4/N5: departed run response is fenced; loading keeps the old view and progress", {
	timeout: 60000,
}, async (t) => {
	const f = await createFixtureServer({ readonly: true });
	t.after(() => f.close());
	const b = await browser(t);
	await b.open(f.origin);
	await mark(b);
	await b.evaluate(() => {
		const original = fetch;
		window.fetch = async (...args) => {
			const response = await original(...args);
			if (/\/runs\/[^/]+$/.test(String(args[0])))
				await new Promise((resolve) => {
					window.__releaseRun = resolve;
				});
			return response;
		};
	});
	await b.click('.management-nav a[href*="view=runs"]');
	await b.waitFor(
		() =>
			!!window.__releaseRun &&
			!document.querySelector("#global-progress").hidden,
	);
	await sameDocument(b);
	assert.equal(
		await b.evaluate(() => !!document.querySelector("#home-view")),
		true,
		"previous view remains while loading",
	);
	await b.click('.management-nav a:not([href*="view="])');
	await b.waitFor(
		() =>
			!!document.querySelector("#home-view") &&
			!document.querySelector("#center").inert,
	);
	await b.evaluate(async () => {
		window.__releaseRun();
		await new Promise(requestAnimationFrame);
	});
	await b.waitFor(() => document.querySelector("#global-progress").hidden);
	assert.equal(
		await b.evaluate(
			() =>
				!!document.querySelector("#home-view") &&
				!document.querySelector(".run-header"),
		),
		true,
	);
	await sameDocument(b);
	assert.deepEqual(b.errors, []);
});

test("N5: centre-only transitions have a CSS fallback and preserve outside focus", {
	timeout: 60000,
}, async (t) => {
	const p = await managementProject(t);
	const b = await browser(t);
	for (const fallback of [false, true]) {
		await b.open(`${p.origin}/?project=${p.server.projectId}`);
		await mark(b);
		await b.evaluate((fallback) => {
			window.__centreAnimations = 0;
			window.__viewTransitions = 0;
			const original = Element.prototype.animate;
			Element.prototype.animate = function (...args) {
				if (this.id === "center") window.__centreAnimations++;
				return original.apply(this, args);
			};
			if (fallback) document.startViewTransition = undefined;
			else {
				const transition = document.startViewTransition.bind(document);
				document.startViewTransition = (...args) => {
					window.__viewTransitions++;
					return transition(...args);
				};
			}
			document.querySelector(".search").focus();
			document
				.querySelector('.management-nav a[href*="view=workflows"]')
				.click();
		}, fallback);
		await b.waitFor(() => !!document.querySelector(".workflow-card"));
		await sameDocument(b);
		assert.deepEqual(
			await b.evaluate(() => [
				window.__centreAnimations,
				window.__viewTransitions,
			]),
			fallback ? [1, 0] : [0, 1],
		);
		assert.equal(
			await b.evaluate(() => document.activeElement === window.__searchNode),
			true,
		);
		assert.equal(
			await b.evaluate(
				() =>
					getComputedStyle(document.querySelector("#center"))
						.viewTransitionName,
			),
			"dashboard-center",
		);
	}
	assert.deepEqual(b.errors, []);
});

test("N5: reduced motion disables centre transitions during in-app navigation", {
	timeout: 60000,
}, async (t) => {
	const p = await managementProject(t);
	const b = await browser(t);
	await b.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	await b.open(`${p.origin}/?project=${p.server.projectId}`);
	await mark(b);
	await b.evaluate(() => {
		window.__centreAnimations = 0;
		const original = Element.prototype.animate;
		Element.prototype.animate = function (...args) {
			if (this.id === "center") window.__centreAnimations++;
			return original.apply(this, args);
		};
		window.__viewTransitions = 0;
		const transition = document.startViewTransition?.bind(document);
		if (transition)
			document.startViewTransition = (...args) => {
				window.__viewTransitions++;
				return transition(...args);
			};
	});
	await b.click('.management-nav a[href*="view=workflows"]');
	await b.waitFor(() => !!document.querySelector(".workflow-card"));
	await sameDocument(b);
	assert.deepEqual(
		await b.evaluate(() => [
			window.__centreAnimations,
			window.__viewTransitions,
		]),
		[0, 0],
	);
	assert.deepEqual(b.errors, []);
});
