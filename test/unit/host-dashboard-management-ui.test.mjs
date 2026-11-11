// test-tier: integration
// Real Chrome, real dashboard routes and a probe-only fake executor: no model/agent CLI calls.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { waitForSavedProfile } from "../helpers/dashboard-profile-wait.mjs";
import { profileAction } from "../../dist/hosts/catalog.js";

const chrome = await findChrome();
async function navigate(browser, url, view) {
	await browser.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await browser.send("Page.navigate", { url });
	await browser.waitFor(
		() =>
			document.readyState === "complete" &&
			!!document.querySelector(".management-nav"),
	);
	if (view)
		await browser.waitFor(() => !!document.querySelector(".management-page"));
}
async function set(browser, label, value) {
	await browser.evaluate(
		(label, value) => {
			const input = document.querySelector(`[aria-label="${label}"]`);
			if (!input) throw new Error(`Missing field ${label}`);
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}
// 2026-11-11: a workflow opens from anywhere on its card, on a page of its own.
async function openWorkflowCard(browser, name) {
	await browser.evaluate((name) => {
		const card = document.querySelector(
			`a.workflow-card[data-workflow="${name}"] .workflow-card-text`,
		);
		if (!card) throw new Error(`Missing workflow card ${name}`);
		card.click();
	}, name);
	await browser.waitFor(
		() =>
			new URLSearchParams(location.search).has("workflow") &&
			!!document.querySelector('[data-management-action="check"]'),
	);
	assert.equal(
		await browser.evaluate(() =>
			new URLSearchParams(location.search).get("workflow"),
		),
		name,
	);
}
async function clickText(browser, text) {
	await browser.evaluate((text) => {
		const button = [...document.querySelectorAll("#center button")].find(
			(node) => node.textContent === text,
		);
		if (!button) throw new Error(`Missing button ${text}`);
		button.click();
	}, text);
}
test("Chrome management: all five views, profile edit, check preview and prune preview; deep links and reduced motion", {
	timeout: 120000,
}, async (t) => {
	assert.ok(
		chrome,
		"Chrome is required for dashboard management UI validation",
	);
	const p = await managementProject(t);
	const terminal = await persistManagementRun(p.cwd, "workflow_ui_terminal");
	await profileAction(p.ctx, {
		op: "set",
		name: "ui-profile",
		values: { executor: "codex", model: "fixture-model", effort: "low" },
	});
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	const url = `${p.origin}/?project=${p.server.projectId}`;
	await navigate(browser, `${url}&view=profiles`, "profiles");
	await browser.waitFor(() =>
		[...document.querySelectorAll("#center button")].some(
			(node) => node.textContent === "ui-profile",
		),
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".management-nav a")].map(
				(node) => node.textContent,
			),
		),
		["Runs", "Workflows", "Profiles", "Maintenance", "Executors"],
	);
	await clickText(browser, "ui-profile");
	await browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile name"]'),
	);
	await set(browser, "Model", "fixture-model");
	await set(browser, "Effort", "high");
	await browser.click('[data-management-action="save-profile"]');
	await browser.waitFor(() =>
		document.querySelector("#center")?.textContent.includes("Updated profile"),
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "ui-profile" })).data
			.profile.effort,
		"high",
	);
	await browser.click('.management-nav a[href*="view=workflows"]');
	await browser.waitFor(() =>
		document
			.querySelector('[data-management="workflows"]')
			?.textContent.includes("Management fixture"),
	);
	await openWorkflowCard(browser, "manage");
	assert.ok(
		await browser.evaluate(
			() =>
				document.querySelectorAll(".property-table.numbered tbody tr").length >
					0 && !!document.querySelector("a.back-link"),
		),
		"the workflow page lists its stages and links back",
	);
	// 2026-11-11 (owner): Effort offers the chosen executor's levels, narrowed by the model's.
	const effort = () =>
		browser.evaluate(() => ({
			options: [...document.querySelector('[aria-label="Effort"]').options].map(
				(option) => option.value,
			),
			note: document.querySelector("[data-effort-note]").textContent,
		}));
	assert.equal((await effort()).options.length, 9, "Automatic: every level");
	await set(browser, "Executor", "claude");
	assert.deepEqual((await effort()).options, [
		"",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	assert.match((await effort()).note, /^Effort on claude: low · medium/);
	await set(browser, "Effort", "max");
	await set(browser, "Executor", "codex");
	await set(browser, "Model", "fixture-model");
	assert.deepEqual(
		await effort(),
		{
			options: ["", "low", "medium", "high", "max"],
			note: "Effort for fixture-model on codex: low · medium · high.",
		},
		"the model's levels; a kept choice it lacks stays visible as unavailable",
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('[aria-label="Effort"]').selectedOptions[0]
					.textContent,
		),
		"max (not available here)",
	);
	await set(browser, "Model", "");
	await set(browser, "Effort", "");
	await browser.click('[data-management-action="check"]');
	await browser.waitFor(() =>
		document.querySelector("#center")?.textContent.includes("Preflight passed"),
	);
	assert.equal(
		await browser.evaluate(() =>
			document
				.querySelector("#center")
				.textContent.includes("Capability check"),
		),
		true,
	);
	assert.equal(
		await browser.evaluate(() =>
			document.querySelector("#center").textContent.includes("aw run 'manage'"),
		),
		true,
	);
	assert.equal(existsSync(p.effects), false, "check/probes never submit work");
	await persistManagementRun(p.cwd, "workflow_ui_stopped", "interrupted");
	await browser.click('.management-nav a[href*="view=maintenance"]');
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="prune-preview"]'),
	);
	// 2026-11-11 (owner): an unfinished run is a row with Dismiss; an empty reason is recorded as
	// "Dismissed in the dashboard", and Show again brings the notice back.
	await browser.waitFor(
		() =>
			!!document.querySelector('[data-notice-dismiss="workflow_ui_stopped"]'),
	);
	await browser.click('[data-notice-dismiss="workflow_ui_stopped"]');
	await browser.waitFor(
		() =>
			!document.querySelector('[data-notice-dismiss="workflow_ui_stopped"]') &&
			document
				.querySelector(".more-details")
				?.textContent.includes("Dismissed in the dashboard"),
	);
	await clickText(browser, "Show again");
	await browser.waitFor(
		() =>
			!!document.querySelector('[data-notice-dismiss="workflow_ui_stopped"]'),
	);
	await set(browser, "Keep the newest finished runs", "0");
	await browser.click('[data-management-action="prune-preview"]');
	// 2026-11-11 (owner): the preview is a table of runs, each with what happens to it.
	await browser.waitFor(() =>
		document
			.querySelector('[data-prune-run="workflow_ui_terminal"]')
			?.closest("tr")
			?.textContent.includes("Will delete"),
	);
	assert.match(
		await browser.evaluate(
			() => document.querySelector(".prune-summary").textContent,
		),
		/^\d+ runs? would be deleted, freeing [\d.]+ (?:B|KB|MB)\./,
	);
	assert.equal(existsSync(terminal.dir), true, "preview never deletes");
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('[data-management-action="prune-delete"]')
					.hidden,
		),
		false,
	);
	await set(browser, "Keep the newest finished runs", "1");
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('[data-management-action="prune-delete"]')
					.hidden,
		),
		true,
		"editing parameters invalidates confirmation",
	);
	await browser.click('.management-nav a[href*="view=executors"]');
	await browser.waitFor(() =>
		document
			.querySelector("#center")
			?.textContent.includes("Default executor here"),
	);
	// 2026-11-11 (owner): a status table first; the doctor text stays under Details.
	assert.ok(
		await browser.evaluate(() => {
			const rows = [
				...document.querySelectorAll(".property-table.executors tbody tr"),
			].map((row) => row.textContent);
			return (
				rows.some(
					(row) => row.startsWith("management-fake") || row.includes("pi"),
				) &&
				/\d+ of \d+ ready\./.test(document.querySelector(".lead").textContent)
			);
		}),
	);
	await clickText(browser, "Refresh");
	await browser.waitFor(() =>
		document
			.querySelector("#center")
			?.textContent.includes("Permission mode default"),
	);
	// Return to Runs through the same sidebar. Use its URL rather than the browser helper's run-only open().
	await browser.click('.management-nav a:not([href*="view="])');
	await browser.waitFor(() => !!document.querySelector("#task-count"));
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('.management-nav a[aria-current="page"]')
					.textContent,
		),
		"Runs",
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document
					.getAnimations()
					.filter((animation) => animation.playState === "running").length,
		),
		0,
	);
	assert.deepEqual(browser.errors, [], "no script, CSP or network errors");
	assert.equal(existsSync(p.effects), false);
});

test("Chrome executor default profiles: built-in shown, edited with the full effort list, restored", {
	timeout: 120000,
}, async (t) => {
	assert.ok(
		chrome,
		"Chrome is required for dashboard management UI validation",
	);
	const p = await managementProject(t);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const url = `${p.origin}/?project=${p.server.projectId}`;
	await navigate(browser, `${url}&view=profiles`, "profiles");
	await browser.waitFor(
		() => !!document.querySelector('[data-executor-default="codex"]'),
	);
	const rows = await browser.evaluate(() =>
		[...document.querySelectorAll("[data-executor-default]")].map((row) => [
			row.dataset.executorDefault,
			row.textContent,
			row.nextElementSibling?.textContent ?? "",
		]),
	);
	assert.deepEqual(
		rows.map(([id]) => id),
		["codex", "claude", "pi"],
	);
	assert.match(rows[0][1], /built-in; fields you do not set fall back/);
	assert.match(rows[0][2], /planning\s+codex:gpt-5\.6-luna:high/);
	assert.match(rows[1][2], /default\s+claude:sonnet:medium/);
	assert.match(rows[2][1], /pi's own model and effort/);
	await clickText(browser, "Edit codex default");
	await browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile name"]'),
	);
	assert.deepEqual(
		await browser.evaluate(() => {
			const name = document.querySelector('[aria-label="Profile name"]');
			const effort = document.querySelector('[aria-label="Effort"]');
			return [
				name.value,
				name.readOnly,
				[...effort.options].map((option) => option.value),
			];
		}),
		[
			"codex",
			true,
			["", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
		],
	);
	await set(browser, "Effort", "max");
	await browser.click('[data-management-action="save-profile"]');
	await waitForSavedProfile(browser);
	const shown = await profileAction(p.ctx, { op: "show", name: "codex" });
	assert.equal(shown.data.profile.effort, "max");
	assert.equal(shown.data.profile.roles, undefined);
	assert.deepEqual(shown.data.effective.roles.planning, {
		executor: "codex",
		model: "gpt-5.6-luna",
		effort: "max",
	});
	await browser.waitFor(() =>
		document
			.querySelector('[data-executor-default="codex"]')
			?.nextElementSibling?.textContent.match(
				/planning\s+codex:gpt-5\.6-luna:max/,
			),
	);
	await clickText(browser, "Restore built-in codex");
	await browser.waitFor(
		() =>
			!![...document.querySelectorAll("#center button")].find(
				(node) => node.textContent === "Edit codex default",
			) &&
			![...document.querySelectorAll("#center button")].some(
				(node) => node.textContent === "Restore built-in codex",
			),
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "codex" })).data.builtIn,
		true,
	);
	assert.deepEqual(browser.errors, [], "no script, CSP or network errors");
	assert.equal(existsSync(p.effects), false);
});

test("Chrome readonly management: navigation stays available and all action mutations are disabled", {
	timeout: 60000,
}, async (t) => {
	assert.ok(
		chrome,
		"Chrome is required for dashboard management UI validation",
	);
	const p = await managementProject(t, { readonly: true });
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await navigate(
		browser,
		`${p.origin}/?project=${p.server.projectId}&view=maintenance`,
		"maintenance",
	);
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="prune-preview"]'),
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('[data-management-action="prune-preview"]')
					.disabled,
		),
		true,
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector("#readonly-badge").textContent,
		),
		"Read-only",
	);
	await browser.click('.management-nav a[href*="view=workflows"]');
	await browser.waitFor(() =>
		document
			.querySelector('[data-management="workflows"]')
			?.textContent.includes("Management fixture"),
	);
	await openWorkflowCard(browser, "manage");
	assert.equal(
		await browser.evaluate(
			() => document.querySelector('[data-management-action="check"]').disabled,
		),
		true,
	);
	// 2026-11-11 (owner): selects draw their own chevron and pad like inputs; a disabled
	// primary reads as an outlined button, not a washed-out block.
	assert.deepEqual(
		await browser.evaluate(() => {
			const style = (selector) =>
				getComputedStyle(document.querySelector(selector));
			const select = style(".management-field select");
			const input = style(".management-field input");
			const check = style('[data-management-action="check"]');
			return {
				appearance: select.appearance,
				sameIndent: select.paddingLeft === input.paddingLeft,
				sameHeight: select.height === input.height,
				chevron: select.backgroundImage.includes("linear-gradient"),
				disabledOpacity: check.opacity,
			};
		}),
		{
			appearance: "none",
			sameIndent: true,
			sameHeight: true,
			chevron: true,
			disabledOpacity: "1",
		},
	);
	assert.deepEqual(browser.errors, []);
});
