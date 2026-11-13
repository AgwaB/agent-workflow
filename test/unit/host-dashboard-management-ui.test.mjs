// test-tier: integration
// Real Chrome, real dashboard routes and a probe-only fake executor: no model/agent CLI calls.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { scanMarks } from "../helpers/dashboard-marks.mjs";
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
// Finished runs older than the fixture's others, oldest first; returns their directories.
async function persistOldRuns(cwd, count) {
	const dirs = [];
	for (let index = 0; index < count; index++) {
		const at = new Date(Date.UTC(2025, 0, 1 + index)).toISOString();
		const { dir } = await persistManagementRun(
			cwd,
			`workflow_ui_old_${String(index).padStart(2, "0")}`,
			"completed",
			{ createdAt: at, updatedAt: at },
		);
		dirs.push(dir);
	}
	return dirs;
}
test("Chrome management: the views, profile edit, check preview and the overview's needs and clean-up; deep links and reduced motion", {
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
		["Overview", "Runs", "Workflows", "Profiles", "Executors"],
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
	assert.match((await effort()).note, /^Effort on claude: low, medium/);
	await set(browser, "Effort", "max");
	await set(browser, "Executor", "codex");
	await set(browser, "Model", "fixture-model");
	assert.deepEqual(
		await effort(),
		{
			options: ["", "low", "medium", "high", "max"],
			note: "Effort for fixture-model on codex: low, medium, high.",
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
	// 2026-11-13 (owner: "too many choices"): no Maintenance view. A run stopped without a user stop
	// is a need on the overview, dismissed with one click; old runs go with one confirmed button.
	await persistManagementRun(p.cwd, "workflow_ui_stopped", "interrupted");
	const userStop = await persistManagementRun(
		p.cwd,
		"workflow_ui_user_stop",
		"interrupted",
	);
	userStop.run.tasks[0].statusDetail = "workflow_stopped";
	await writeFile(join(userStop.dir, "run.json"), JSON.stringify(userStop.run));
	const old = await persistOldRuns(p.cwd, 51);
	await browser.click('.management-nav a:not([href*="view="])');
	await browser.waitFor(
		() =>
			!!document.querySelector('.home-need[data-run="workflow_ui_stopped"]') &&
			!!document.querySelector(".home-cleanup"),
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".home-need")].map((need) => [
				need.dataset.run,
				need.querySelector(".home-need-reason b").textContent,
				[...need.querySelectorAll("button")].map((node) => node.textContent),
			]),
		),
		[["workflow_ui_stopped", "Stopped unexpectedly", ["Inspect", "Dismiss"]]],
		"the run the user stopped is not a need",
	);
	await clickText(browser, "Dismiss");
	await browser.waitFor(
		() =>
			!document.querySelector(".home-need") &&
			!!document.querySelector('[data-home-key="restore"]'),
	);
	// The dismissal is the shared acknowledgement the host reminders read.
	let acknowledged;
	for (let tries = 0; tries < 50 && !acknowledged; tries++) {
		acknowledged = (
			await p.http(`${p.base}/notices`)
		).data.data.acknowledgements.find(
			(entry) => entry.runId === "workflow_ui_stopped" && entry.active,
		);
		if (!acknowledged) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(acknowledged?.reason, "Dismissed in the dashboard");
	await clickText(browser, "Show 1 dismissed");
	await browser.waitFor(
		() =>
			!!document.querySelector('.home-need[data-run="workflow_ui_stopped"]'),
	);
	// Clean up: the line names how many runs go; Delete asks once, with the list.
	const line = await browser.evaluate(
		() => document.querySelector(".home-cleanup p").textContent,
	);
	const count = Number(
		/^(\d+) old runs? can be deleted \([\d.]+ (?:B|KB|MB)\)The newest 50 finished runs are kept\.$/.exec(
			line,
		)?.[1],
	);
	assert.ok(count > 0, line);
	assert.equal(existsSync(old[0]), true, "showing the line deletes nothing");
	await clickText(browser, "Clean up…");
	await browser.waitFor(
		() => !!document.querySelector(".home-cleanup.confirming"),
	);
	const listed = await browser.evaluate(() =>
		[...document.querySelectorAll("[data-cleanup-run]")].map(
			(node) => node.dataset.cleanupRun,
		),
	);
	assert.equal(listed.length, count);
	assert.ok(listed.includes("workflow_ui_old_00"), listed.join());
	await clickText(browser, "Cancel");
	await browser.waitFor(
		() =>
			!document.querySelector(".home-cleanup.confirming") &&
			!!document.querySelector('[data-home-key="cleanup"]'),
	);
	assert.equal(existsSync(old[0]), true, "Cancel deletes nothing");
	await clickText(browser, "Clean up…");
	// A preview that no longer matches (another host changed the runs) deletes nothing: the server
	// answers 409 with the new list and the confirmation asks again.
	await browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = (url, options = {}) => {
			if (!String(url).endsWith("/prune")) return original(url, options);
			window.fetch = original;
			const body = { ...JSON.parse(options.body), digest: "0".repeat(64) };
			return original(url, { ...options, body: JSON.stringify(body) });
		};
	});
	await clickText(browser, `Delete ${count} runs`);
	await browser.waitFor(
		() =>
			/^The list changed/.test(
				document.querySelector(".home-cleanup [role=alert]")?.textContent ?? "",
			) && !!document.querySelector(".home-cleanup.confirming"),
	);
	assert.equal(existsSync(old[0]), true, "a changed preview deletes nothing");
	await clickText(browser, `Delete ${count} runs`);
	await browser.waitFor(
		() =>
			/^Deleted \d+ runs?, freeing /.test(
				document.querySelector(".home-cleanup-done")?.textContent ?? "",
			) && !document.querySelector(".home-cleanup"),
	);
	assert.equal(existsSync(old[0]), false, "the oldest run is gone");
	assert.equal(existsSync(old.at(-1)), true, "the newest are kept");
	// An old link to the Maintenance view opens the overview.
	await navigate(browser, `${url}&view=maintenance`);
	await browser.waitFor(() => !!document.querySelector("#home-view"));
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
	// 2026-11-12: Overview is the first item and the project's landing page (no run, no view).
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".management-nav a")].map(
				(link) => link.textContent,
			),
		),
		["Overview", "Runs", "Workflows", "Profiles", "Executors"],
	);
	await browser.click('.management-nav a:not([href*="view="])');
	await browser.waitFor(() => !!document.querySelector("#home-view"));
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('.management-nav a[aria-current="page"]')
					.textContent,
		),
		"Overview",
	);
	// Return to Runs through the same sidebar: it opens the latest run.
	await browser.click('.management-nav a[href*="view=runs"]');
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
	assert.deepEqual(
		// The one expected error: the 409 of the changed clean-up preview, above.
		browser.errors.filter(
			(error) => !(/ 409 /.test(error.text) && error.url?.endsWith("/prune")),
		),
		[],
		"no script, CSP or network errors",
	);
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
	// Read-only: no clean-up line, even with runs to clean up (the preview is a write route).
	await persistOldRuns(p.cwd, 51);
	await navigate(browser, `${p.origin}/?project=${p.server.projectId}`);
	await browser.waitFor(
		() => !!document.querySelector("#home-project .home-stats"),
	);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(
		await browser.evaluate(() => !!document.querySelector(".home-cleanup")),
		false,
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

// 2026-11-12 (owner, pass 2): no middle dot and no em dash in the dashboard's own text, on every
// management page, read-write and read-only. An unknown value reads "n/a".
test("Chrome management: no middle dot and no em dash in workflows, profiles, executors and the overview", {
	timeout: 120000,
}, async (t) => {
	assert.ok(
		chrome,
		"Chrome is required for dashboard management UI validation",
	);
	for (const readonly of [false, true]) {
		const p = await managementProject(t, { readonly });
		await persistManagementRun(p.cwd, "workflow_ui_terminal");
		await persistManagementRun(p.cwd, "workflow_ui_stopped", "interrupted");
		await profileAction(p.ctx, {
			op: "set",
			name: "ui-profile",
			values: { executor: "codex", model: "fixture-model", effort: "low" },
		});
		const browser = await createBrowser(chrome);
		t.after(() => browser.close());
		const url = `${p.origin}/?project=${p.server.projectId}`;
		for (const view of ["workflows", "profiles", "executors"]) {
			await navigate(browser, `${url}&view=${view}`, view);
			await browser.waitFor(
				() =>
					document.querySelector(".management-page")?.textContent.length > 40,
			);
			assert.deepEqual(
				await scanMarks(browser),
				[],
				`${view}${readonly ? " (read-only)" : ""}`,
			);
		}
		// A workflow's own page, with its check and parameters.
		await navigate(browser, `${url}&view=workflows`, "workflows");
		await browser.waitFor(() =>
			document
				.querySelector('[data-management="workflows"]')
				?.textContent.includes("Management fixture"),
		);
		await openWorkflowCard(browser, "manage");
		assert.deepEqual(await scanMarks(browser), [], "a workflow page");
		// The overview with a need and, read-write, the clean-up confirmation with its list open.
		await persistOldRuns(p.cwd, 51);
		await navigate(browser, url);
		await browser.waitFor(
			() =>
				!!document.querySelector(".home-need") &&
				!!document.querySelector("#home-project .home-stats"),
		);
		if (!readonly) {
			await browser.waitFor(
				() => !!document.querySelector('[data-home-key="cleanup"]'),
			);
			await clickText(browser, "Clean up…");
			await browser.waitFor(
				() => !!document.querySelector(".home-cleanup.confirming"),
			);
		}
		await browser.evaluate(() =>
			document
				.querySelectorAll("details")
				.forEach((details) => details.setAttribute("open", "")),
		);
		assert.deepEqual(await scanMarks(browser), [], "overview, opened");
	}
});
