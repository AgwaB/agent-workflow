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
	await clickText(browser, "manage");
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="check"]'),
	);
	await set(browser, "Executor", "codex");
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
	await browser.click('.management-nav a[href*="view=maintenance"]');
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="prune-preview"]'),
	);
	await set(browser, "Keep newest terminal runs", "0");
	await browser.click('[data-management-action="prune-preview"]');
	await browser.waitFor(() =>
		document
			.querySelector("#center")
			?.textContent.includes("workflow_ui_terminal: Would delete"),
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
	await set(browser, "Keep newest terminal runs", "1");
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
	await clickText(browser, "manage");
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="check"]'),
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector('[data-management-action="check"]').disabled,
		),
		true,
	);
	assert.deepEqual(browser.errors, []);
});
