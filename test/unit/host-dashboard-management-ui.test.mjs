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
import {
	setPermission,
	savePermissions,
} from "../helpers/dashboard-profiles.mjs";
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
	const key = await browser.evaluate(
		(name) =>
			document.querySelector(`a.workflow-card[data-workflow="${name}"]`)
				?.dataset.workflowKey,
		name,
	);
	assert.match(key, /^[a-f0-9]{64}$/);
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
			!!document.querySelector(
				'[data-management-action="save-project-settings"]',
			) &&
			!!document.querySelector(".workflow-description"),
	);
	assert.equal(
		await browser.evaluate(() =>
			new URLSearchParams(location.search).get("workflow"),
		),
		key,
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll(
					'[data-management-action="check"], [data-testid="saved-launch-check"], .management-diagnostics',
				).length,
		),
		0,
		"workflow diagnostics are deleted",
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
test("Chrome management: the views, permission edit, check preview and the overview's needs and clean-up; deep links and reduced motion", {
	timeout: 120000,
}, async (t) => {
	assert.ok(
		chrome,
		"Chrome is required for dashboard management UI validation",
	);
	const p = await managementProject(t);
	await persistManagementRun(p.cwd, "workflow_ui_terminal");
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
	await navigate(browser, `${url}&view=executors`, "executors");
	await browser.waitFor(
		() => !!document.querySelector('[data-executor-permissions="codex"]'),
	);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".management-nav a")].map(
				(node) => node.textContent,
			),
		),
		["Overview", "Workflows", "Run history", "Executors"],
	);
	await setPermission(browser, "safe");
	await savePermissions(browser);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "codex" })).data.profile
			.permissionMode,
		"safe",
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
				document.querySelectorAll(".profile-flow .node").length > 0 &&
				!!document.querySelector("a.back-link"),
		),
		"the workflow page shows its graph and links back",
	);
	assert.equal(
		await browser.evaluate(
			() => document.querySelector(".workflow-description").textContent,
		),
		"Management fixture",
	);
	await set(browser, "All tasks Executor", "codex");
	await set(browser, "All tasks Model", "fixture-model");
	await set(browser, "All tasks Effort", "high");
	await browser.click('[data-management-action="save-project-settings"]');
	await browser.waitFor(
		() =>
			document.querySelector('[data-testid="workflow-settings-status"]')
				.textContent === "Settings saved.",
	);
	assert.equal(
		existsSync(p.effects),
		false,
		"draft calculation and Save never submit work",
	);
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
	// Broad cleanup is deliberately separated from selected-record deletion.
	await browser.click(".advanced-maintenance > summary");
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
			?.querySelector(".property-table.executors"),
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
	// Exercise the real doctor's version-warning wording, not the synthetic responses below.
	const versions = await browser.evaluate(() => ({
		executors: [...document.querySelectorAll(".executors tbody tr")]
			.filter((row) => row.children[2].textContent.includes(", tested on"))
			.map((row) => row.children[0].textContent),
		headers: [...document.querySelectorAll(".executors th")].map(
			(node) => node.textContent,
		),
		notes: [...document.querySelectorAll(".management-card .notes-list > li")]
			.filter((node) => !node.closest("details"))
			.map((node) => node.textContent),
	}));
	assert.ok(versions.executors.length >= 2);
	assert.ok(
		!versions.notes.some((note) => /differs from the verified/.test(note)),
	);
	const merged = versions.notes.filter((note) =>
		/installed version differs from the tested one \(see Version\)/.test(note),
	);
	assert.equal(merged.length, 1);
	assert.equal(
		merged[0],
		`${versions.executors.slice(0, -1).join(", ")} and ${versions.executors.at(-1)}: installed version differs from the tested one (see Version). Capability rows marked probed may not hold.`,
	);
	assert.ok(!versions.headers.includes("What to do"));
	await clickText(browser, "Refresh");
	await browser.waitFor(() =>
		document
			.querySelector("#center")
			?.querySelector(".property-table.executors"),
	);
	// 2026-11-12: Overview is the first item and the project's landing page (no run, no view).
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".management-nav a")].map(
				(link) => link.textContent,
			),
		),
		["Overview", "Workflows", "Run history", "Executors"],
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
	// Primary History restores observation; selected deletion remains secondary.
	await browser.click('.management-nav a[href*="view=runs"]');
	await browser.waitFor(
		() =>
			!!document.querySelector(".run-row") &&
			!!document.querySelector(".run-header"),
	);
	await browser.click(".run-actions summary");
	await browser.click('[data-testid="manage-run-deletion"]');
	await browser.waitFor(
		() => !!document.querySelector(".history-list [data-history-id]"),
	);
	await navigate(browser, `${url}&view=runs`);
	await browser.waitFor(() => !!document.querySelector("#task-count"));
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('.management-nav a[aria-current="page"]')
					.textContent,
		),
		"Run history",
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

test("Chrome executor defaults: permission Save and Automatic do not pin built-in model settings", {
	timeout: 60000,
}, async (t) => {
	assert.ok(chrome);
	const p = await managementProject(t);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await navigate(
		browser,
		`${p.origin}/?project=${p.server.projectId}&view=executors`,
		"executors",
	);
	await browser.waitFor(
		() => !!document.querySelector('[data-executor-permissions="codex"]'),
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelector('[aria-label="codex permission mode"]').value,
		),
		"",
	);
	await setPermission(browser, "safe");
	await savePermissions(browser);
	const shown = await profileAction(p.ctx, { op: "show", name: "codex" });
	assert.equal(shown.data.profile.permissionMode, "safe");
	for (const key of ["executor", "model", "effort", "roles"])
		assert.equal(shown.data.profile[key], undefined, key);
	assert.deepEqual(shown.data.effective.roles.planning, {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "high",
	});
	await setPermission(browser, "");
	await savePermissions(browser);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "codex" })).data.profile
			.permissionMode,
		undefined,
	);
	assert.deepEqual(browser.errors, []);
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
			() =>
				document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		),
		true,
	);
	assert.equal(
		await browser.evaluate(() =>
			[
				...document.querySelectorAll(
					".project-workflow-editor input, .project-workflow-editor select, [data-testid='project-settings-reload']",
				),
			].every((node) => node.disabled),
		),
		true,
	);
	assert.deepEqual(
		await browser.evaluate(() => {
			const style = (selector) =>
				getComputedStyle(document.querySelector(selector));
			const select = style('[aria-label="All tasks Model"]');
			const input = style('[aria-label="All tasks Executor"]');
			return {
				appearance: select.appearance,
				sameIndent: select.paddingLeft === input.paddingLeft,
				sameHeight: select.height === input.height,
				chevron: select.backgroundImage.includes("linear-gradient"),
				disabledOpacity: style(
					'[data-management-action="save-project-settings"]',
				).opacity,
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
test("Chrome management: no middle dot and no em dash in workflows, executors and the overview", {
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
		for (const view of ["workflows", "executors"]) {
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
			await browser.click(".advanced-maintenance > summary");
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

test("Chrome management: workflow detail keeps the graph and drops the stage table and routine validation", {
	timeout: 60000,
}, async (t) => {
	const p = await managementProject(t);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const url = `${p.server.url}&project=${p.server.projectId}&view=workflows`;
	await navigate(browser, url);
	await browser.waitFor(
		() => !!document.querySelector('[data-workflow="deep-research"]'),
	);
	await t.test("catalog built-in tag", async () =>
		assert.match(
			await browser.evaluate(
				() =>
					document.querySelector(
						'[data-workflow="deep-research"] .workflow-tags',
					).textContent,
			),
			/built-in/,
		),
	);
	await openWorkflowCard(browser, "deep-research");
	await browser.waitFor(() => !!document.querySelector(".profile-flow .node"));
	const detail = await browser.evaluate(() => ({
		tags: document.querySelectorAll(".management-page > p .workflow-tags")
			.length,
		name: document.querySelector("h1").textContent,
		tables: document.querySelectorAll(".property-table.numbered").length,
		alerts: [
			...document.querySelectorAll('[data-testid="workflow-spec-problems"]'),
		].length,
		text: document.querySelector(".management-page").textContent,
	}));
	await t.test("detail badges removed while the workflow name remains", () => {
		assert.equal(detail.tags, 0);
		assert.equal(detail.name, "deep-research");
	});
	await t.test("redundant stage table and routine validation removed", () => {
		assert.equal(detail.tables, 0);
		assert.equal(detail.alerts, 0);
		for (const text of [
			"Validation and task summary",
			"Read-only stage summary",
			"Valid specification",
		])
			assert.equal(detail.text.includes(text), false, text);
	});
	// A real definition problem is still shown, as one short alert without a section.
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `(() => {
		const original = window.fetch;
		window.fetch = async (url, options) => {
			const response = await original(url, options);
			if (!new URL(url, location.href).pathname.endsWith('/workflows/' + new URLSearchParams(location.search).get('workflow'))) return response;
			const data = await response.json();
			data.validation = { data: { warnings: ["unique spec warning"], blockedPermissionPreviews: [{ taskId: "read", reason: "unique blocked reason" }] } };
			return new Response(JSON.stringify(data), {
				headers: { "Content-Type": "application/json" },
			});
		};
	})();`,
	});
	await browser.click("a.back-link");
	await browser.waitFor(
		() =>
			!new URLSearchParams(location.search).has("workflow") &&
			!!document.querySelector('[data-workflow="manage"]'),
	);
	await openWorkflowCard(browser, "manage");
	assert.deepEqual(
		await browser.evaluate(() => ({
			problems: [
				...document.querySelectorAll(
					'[data-testid="workflow-spec-problems"] li',
				),
			].map((n) => n.textContent),
			role: document
				.querySelector('[data-testid="workflow-spec-problems"]')
				?.getAttribute("role"),
			heading: [
				...document.querySelectorAll(
					".management-page h2, .management-page h3",
				),
			].some((n) => /Validation/.test(n.textContent)),
		})),
		{
			problems: [
				"Warning: unique spec warning",
				"Blocked: read: unique blocked reason",
			],
			role: "alert",
			heading: false,
		},
	);
});

for (const mode of ["ready", "fix", "four", "one"]) {
	test(`Chrome management: executors table and notes omit repeats (${mode})`, {
		timeout: 60000,
	}, async (t) => {
		const p = await managementProject(t);
		const browser = await createBrowser(chrome);
		t.after(() => browser.close());
		await navigate(browser, `${p.server.url}&project=${p.server.projectId}`);
		await browser.waitFor(() => !!document.querySelector("#home-view"));
		const ids = ["pi", "claude", "codex", "antigravity"];
		const entries = ids.map((id, i) => ({
			id,
			notes: [
				"Executor capability availability depends on the installed CLI and its authenticated account. ".repeat(
					8,
				),
			],
			usable: mode !== "fix" || i !== 3,
			state: mode === "fix" && i === 3 ? "logged-out" : "ready",
			cliVersion: "2",
			verifiedVersion: "1",
			versionMatchesVerified:
				mode === "four" || ((mode === "one" || mode === "fix") && i === 0)
					? false
					: true,
			...(mode === "fix" && i === 3
				? {
						fix: "Log in to Antigravity using the CLI login command, then return here and check again. Your account must have access to the configured workspace.",
					}
				: {}),
		}));
		const security = [
			"codex: 2 allow rules in 1 file under /fixture/codex/rules let matching commands run without approval (readOnly is emulated for Codex workers)",
			"codex: global instructions /fixture/codex/AGENTS.md (1 file) are loaded into every Codex worker (context isolation is emulated)",
		];
		const versions = entries
			.filter((e) => !e.versionMatchesVerified)
			.map(
				(e) =>
					`${e.id}: installed 2 differs from the verified 1; capability rows marked probed may not hold`,
			);
		const doctorData = {
			executors: entries,
			warnings: [versions[0], ...security, ...versions.slice(1)].filter(
				Boolean,
			),
			node: { supported: false, version: "1", required: "22" },
			home: { writable: false, path: "/fixture/home" },
		};
		await browser.send("Page.addScriptToEvaluateOnNewDocument", {
			source: `(() => {
			const original = window.fetch;
			window.fetch = (url, options) => String(url).startsWith('/api/doctor')
				? Promise.resolve(new Response(JSON.stringify({data:${JSON.stringify(doctorData)}}), {headers:{'Content-Type':'application/json'}}))
				: original(url, options);
		})();`,
		});
		await browser.click('.management-nav a[href*="view=executors"]');
		await browser.waitFor(
			() => !!document.querySelector(".property-table.executors"),
		);
		await browser.send("Emulation.setDeviceMetricsOverride", {
			width: 1600,
			height: 1000,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await browser.evaluate(() => {
			[...document.querySelectorAll("button")]
				.find((n) => n.textContent === "Executor diagnostics")
				.click();
		});
		const lines = await browser.evaluate(() => {
			const details = document.querySelector(
				".management-diagnostics .property-table",
			);
			return [...details.querySelectorAll("td:first-child")].map((n) => {
				const range = document.createRange();
				range.selectNodeContents(n);
				return [
					n.textContent,
					range.getClientRects().length,
					range.getBoundingClientRect().height,
				];
			});
		});
		assert.deepEqual(
			lines,
			ids.map((id) => [id, 1, lines[0][2]]),
		);
		await browser.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: false,
		});
		assert.equal(
			await browser.evaluate(() => {
				const details = document.querySelector(
					".management-diagnostics .property-table",
				);
				return (
					[...details.querySelectorAll("td:first-child")].every((n) => {
						const range = document.createRange();
						range.selectNodeContents(n);
						return (
							range.getClientRects().length === 1 &&
							range.getBoundingClientRect().width <= n.clientWidth
						);
					}) && document.body.scrollWidth === 390
				);
			}),
			true,
		);
		await t.test("F2 readable Status columns at 390px", async () => {
			const layout = await browser.evaluate(() => {
				const table = document.querySelector(".property-table.executors");
				const host = table.parentElement;
				const names = [...table.querySelectorAll("td:first-child strong")].map(
					(n) => {
						const range = document.createRange();
						range.selectNodeContents(n);
						return [n.textContent, range.getClientRects().length];
					},
				);
				const fix = table.querySelector("td:nth-child(4)");
				host.scrollLeft = host.scrollWidth;
				return {
					names,
					width: table.getBoundingClientRect().width,
					fixWidth: fix?.clientWidth,
					scrollable: ["auto", "scroll"].includes(
						getComputedStyle(host).overflowX,
					),
					reached: host.scrollLeft > 0,
				};
			});
			assert.deepEqual(
				layout.names,
				ids.map((id) => [id, 1]),
			);
			assert.ok(layout.width >= 640, JSON.stringify(layout));
			assert.ok(layout.scrollable && layout.reached, JSON.stringify(layout));
			if (mode === "fix")
				assert.ok(layout.fixWidth >= 200, JSON.stringify(layout));
		});
		const actual = await browser.evaluate(() => ({
			headers: [...document.querySelectorAll(".executors th")].map(
				(n) => n.textContent,
			),
			rows: [...document.querySelectorAll(".executors tbody tr")].map((n) =>
				[...n.children].map((c) => c.textContent),
			),
			notes: [...document.querySelectorAll(".management-card .notes-list > li")]
				.filter((n) => !n.closest("details"))
				.map((n) => n.textContent),
		}));
		await t.test("action column", () =>
			assert.deepEqual(actual.headers, [
				"Executor",
				"Status",
				"Version",
				...(mode === "fix" ? ["What to do"] : []),
				"Permissions",
			]),
		);
		if (mode === "fix")
			await t.test("empty ready actions", () =>
				assert.deepEqual(
					actual.rows.map((r) => r[3]),
					[
						"",
						"",
						"",
						"Log in to Antigravity using the CLI login command, then return here and check again. Your account must have access to the configured workspace.",
					],
				),
			);
		const others = [
			...security,
			"Node 1 is older than the required 22.",
			"The home /fixture/home is not writable.",
		];
		assert.deepEqual(
			actual.notes,
			mode === "four"
				? [
						...others,
						"pi, claude, codex and antigravity: installed version differs from the tested one (see Version). Capability rows marked probed may not hold.",
					]
				: mode === "one" || mode === "fix"
					? [versions[0], ...others]
					: others,
		);
	});
}

test("F2 management landing pages share margins at 1600 and fit 390/980", {
	timeout: 120000,
}, async (t) => {
	const p = await managementProject(t);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	for (const width of [1600, 390, 980]) {
		const boxes = [];
		for (const view of ["workflows", "executors"]) {
			await navigate(
				browser,
				`${p.server.url}&project=${p.server.projectId}&view=${view}`,
				view,
			);
			await browser.waitFor(
				`document.querySelector('[data-management="${view}"]') && ('${view}' !== 'executors' || document.querySelector('.property-table.executors'))`,
			);
			await browser.send("Emulation.setDeviceMetricsOverride", {
				width,
				height: 1000,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await browser.waitForMotionEnd();
			boxes.push(
				await browser.evaluate(() => {
					const page = document.querySelector(".management-page"),
						title = page.querySelector("h1");
					return {
						x: title.getBoundingClientRect().x,
						width: page.getBoundingClientRect().width,
						overflow: document.body.scrollWidth > innerWidth,
						pageOverflow: page.scrollWidth > page.clientWidth,
					};
				}),
			);
		}
		assert.ok(
			boxes.every((b) => !b.overflow && !b.pageOverflow),
			JSON.stringify({ width, boxes }),
		);
		assert.deepEqual(
			boxes.map((b) => [b.x, b.width]),
			Array(2).fill([boxes[0].x, boxes[0].width]),
			JSON.stringify({ width, boxes }),
		);
	}
});

test("Workflow normal view deletes diagnostics, routing tables and launch Check rather than hiding them", {
	timeout: 60000,
}, async (t) => {
	const p = await managementProject(t),
		browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `window.__checkPaths = []; const originalFetch = window.fetch; window.fetch = (...args) => { if (String(args[0]).endsWith('/check')) window.__checkPaths.push(String(args[0])); return originalFetch(...args); };`,
	});
	await navigate(
		browser,
		`${p.origin}/?project=${p.server.projectId}&view=workflows`,
	);
	await browser.waitFor(
		() => !!document.querySelector('[data-workflow="manage"]'),
	);
	await openWorkflowCard(browser, "manage");
	assert.deepEqual(
		await browser.evaluate(() => ({
			description: document.querySelector(".workflow-description").textContent,
			removed: document.querySelectorAll(
				".check-overrides, .management-diagnostics, .management-result, .command, .property-table, [data-management-action='check']",
			).length,
			about: [...document.querySelectorAll("h2")].some(
				(n) => n.textContent === "About",
			),
		})),
		{ description: "Management fixture", removed: 0, about: false },
	);
	await set(browser, "All tasks Executor", "codex");
	await set(browser, "All tasks Effort", "high");
	await browser.waitFor(
		() =>
			!document.querySelector(
				'[data-management-action="save-project-settings"]',
			).disabled,
	);
	assert.deepEqual(await browser.evaluate(() => window.__checkPaths), []);
	assert.equal(existsSync(p.effects), false);
});

test("Workflow unreadable spec retains visible errors without source or compiled-role disclosures", {
	timeout: 30000,
}, async (t) => {
	const p = await managementProject(t);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `(() => {
 const original = window.fetch;
 window.fetch = async (url, options) => {
  const response = await original(url, options);
  if (!new URL(url, location.href).pathname.endsWith('/workflows/' + new URLSearchParams(location.search).get('workflow'))) return response;
  const value = await response.json();
  value.specError = 'unreadable <img src=x onerror=alert(1)>';
  value.validation = {error: 'Invalid specification: unique validation failure'};
  value.roles = {data: {roles: [{role: 'unique-role', note: 'unique compiled data <script>bad()</script>'}]}};
  return new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
 };
 })();`,
	});
	await navigate(
		browser,
		`${p.origin}/?project=${p.server.projectId}&view=workflows&workflow=manage`,
	);
	await browser.waitFor(
		() => !!document.querySelector('[data-testid="workflow-spec-problems"]'),
	);
	const normal = await browser.evaluate(
		() => document.querySelector(".management-page").innerText,
	);
	assert.match(normal, /workflow spec could not be read/);
	assert.match(normal, /Invalid specification: unique validation failure/);
	assert.ok(!normal.includes("unique compiled data"));
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll(
					".management-diagnostics, .saved-launch-check",
				).length,
		),
		0,
	);
	assert.doesNotMatch(normal, /Resolved spec|Source|unique-role/);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll(
					".management-page img, .management-page script",
				).length,
		),
		0,
	);
	assert.equal(existsSync(p.effects), false);
});
