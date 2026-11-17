// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
const chrome = await findChrome();
async function setup(t, options = {}) {
	assert.ok(chrome);
	const p = await managementProject(t, options);
	const a = await persistManagementRun(p.cwd, "workflow_delete_ui_a");
	const b = await persistManagementRun(p.cwd, "workflow_delete_ui_b");
	const active = await persistManagementRun(
		p.cwd,
		"workflow_delete_ui_active",
		"running",
	);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
 window.__deleteRequests=[]; window.__deleteMode=''; window.__releasePreview=null;
 const originalFetch=window.fetch;
 window.fetch=async (...args)=>{
  const path=String(args[0]),opts=args[1]||{};
  if(!path.includes('/run-deletions')) return originalFetch(...args);
  const body=JSON.parse(opts.body);window.__deleteRequests.push({path,body});
  const response=await originalFetch(...args);
  if(path.endsWith('/preview')) {
   if(window.__deleteMode==='hold') {window.__deleteMode='';await new Promise(resolve=>window.__releasePreview=resolve);}
   if(window.__deleteMode==='disclosure') {const data=await response.json();data.data.runs[0].worktrees=[{path:'.agent-workflow/worktrees/owned-test',branch:'owned',dirty:true,commits:3}];data.data.runs[0].ownedSessions={deleted:0,notFound:0,unsupported:2};data.data.runs[0].error='fixture resource warning';return new Response(JSON.stringify(data),{status:200});}
   if(window.__deleteMode==='protected') {const data=await response.json();data.data.runs[0].protected=true;return new Response(JSON.stringify(data),{status:200});}
  }
  if(path.endsWith('/run-deletions') && window.__deleteMode==='hold-commit') {
   window.__deleteMode=''; await new Promise(resolve=>window.__releaseCommit=resolve);
  }
  return response;
 };
 `,
	});
	const url = `${p.origin}/?project=${p.server.projectId}&view=history`;
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	await browser.send("Page.navigate", { url });
	await browser.waitFor(
		() => document.querySelectorAll("[data-history-id]").length === 3,
	);
	return { ...p, a, b, active, browser, url };
}
const select = (p, id) => p.browser.click(`[aria-label="Select ${id}"]`);
const review = async (p) => {
	await p.browser.click('[data-testid="selected-delete-review"]');
	await p.browser.waitFor(
		() =>
			!document.querySelector('[data-testid="selected-delete-preview"]').hidden,
	);
};

async function assertDiagnosticsFit(p, selector) {
	await p.browser.evaluate((selector) => {
		const technical = document.querySelector(`${selector} .deletion-technical`);
		if (technical) technical.open = true;
	}, selector);
	const geometry = await p.browser.evaluate((selector) => {
		const root = document.querySelector(selector);
		const bounds = document.querySelector("#center").getBoundingClientRect();
		const nodes = [...root.querySelectorAll(".diagnostic-fields > div, pre")];
		return {
			count: nodes.length,
			clipped: nodes.flatMap((node) => {
				const rect = node.getBoundingClientRect();
				return rect.width < 16 ||
					rect.left < bounds.left - 1 ||
					rect.right > bounds.right + 1 ||
					node.scrollWidth > node.clientWidth + 1
					? [
							{
								text: node.textContent.slice(0, 80),
								left: rect.left,
								right: rect.right,
								width: rect.width,
								overflow: node.scrollWidth - node.clientWidth,
							},
						]
					: [];
			}),
		};
	}, selector);
	assert.ok(geometry.count > 0, "diagnostic fields must actually be rendered");
	assert.deepEqual(
		geometry.clipped,
		[],
		"nested resource/error details must remain readable within the history page",
	);
}

test("Secondary selected deletion retains primary/shared groups and actual project list; exact cancel/commit never expands selection or prunes broadly", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll('[aria-label="Dashboard views"] a')].map(
				(n) => n.textContent,
			),
		),
		["Overview", "Workflows", "Run history"],
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll('nav[aria-label="Shared settings"] a')].map(
				(n) => n.textContent,
			),
		),
		["Profiles", "Executors"],
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[aria-label="Select workflow_delete_ui_active"]',
				).disabled,
		),
		true,
	);
	await select(p, p.a.run.runId);
	await review(p);
	const text = await p.browser.evaluate(
		() =>
			document.querySelector('[data-testid="selected-delete-preview"]')
				.textContent,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				!!document.querySelector(
					'[data-testid="selected-delete-preview"] .deletion-technical:not([open])',
				),
		),
		true,
		"only duplicate technical object is folded",
	);
	await assertDiagnosticsFit(p, '[data-testid="selected-delete-preview"]');
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[
				...document.querySelector('[data-testid="selected-delete-preview"]')
					.childNodes,
			]
				.filter((node) => node.nodeType === 3)
				.map((node) => node.textContent.trim())
				.filter(Boolean),
		),
		[],
		"missing optional preview content must not become visible text",
	);
	assert.match(text, /workflow_delete_ui_a/);
	assert.doesNotMatch(text, /workflow_delete_ui_b/);
	assert.match(
		text,
		/attached logs\/reports.*owned managed worktrees.*dirty changes.*engine-owned sessions.*unsupported sessions remain.*No guaranteed recovery or undo.*main checkout and project settings.*other projects.*global adapter state/s,
	);
	await p.browser.click('[data-testid="selected-delete-cancel"]');
	assert.ok(existsSync(p.a.dir));
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Select workflow_delete_ui_a"]')
					.checked,
		),
		true,
	);
	await review(p);
	const added = await persistManagementRun(p.cwd, "workflow_added_unselected");
	await p.browser.click('[data-testid="selected-delete-confirm"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="selected-delete-status"]')
			.textContent.includes("Deleted exactly 1"),
	);
	assert.equal(existsSync(p.a.dir), false);
	for (const r of [p.b, p.active, added]) assert.ok(existsSync(r.dir));
	const requests = await p.browser.evaluate(() => window.__deleteRequests);
	assert.ok(requests.length >= 3);
	for (const req of requests) {
		assert.deepEqual(req.body.runIds, [p.a.run.runId]);
		assert.equal("keep" in req.body, false);
		assert.equal("olderThanDays" in req.body, false);
		assert.doesNotMatch(req.path, /prune/);
	}
	assert.equal(existsSync(p.effects), false);
});

test("owned worktree facts are visible without claiming source unaffected; protected previews cannot confirm", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t);
	await p.browser.evaluate(() => (window.__deleteMode = "disclosure"));
	await select(p, p.a.run.runId);
	await review(p);
	const text = await p.browser.evaluate(
		() =>
			document.querySelector('[data-testid="selected-delete-preview"]')
				.textContent,
	);
	assert.match(
		text,
		/Owned worktree: .agent-workflow\/worktrees\/owned-test; branch: owned; dirty: true; unique commits: 3/,
	);
	assert.doesNotMatch(text, /source unaffected/);
	const visible = await p.browser.evaluate(
		() =>
			document.querySelector('[data-testid="selected-delete-preview"]')
				.innerText,
	);
	assert.match(visible, /workflow_delete_ui_a/);
	assert.match(
		visible,
		/Owned worktree: .agent-workflow\/worktrees\/owned-test; branch: owned; dirty: true; unique commits: 3/,
	);
	assert.match(visible, /unsupported 2 \(left in place\)/);
	assert.match(visible, /error: fixture resource warning/);
	assert.match(visible, /No guaranteed recovery or undo/);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".deletion-technical").open,
		),
		false,
	);
	await p.browser.click('[data-testid="selected-delete-cancel"]');
	await p.browser.evaluate(() => (window.__deleteMode = "protected"));
	await review(p);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="selected-delete-confirm"]')
					.disabled,
		),
		true,
	);
	assert.ok(existsSync(p.a.dir));
});

test("409 retains exact selection and demands fresh explicit review/confirmation without automatic retries", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t);
	await select(p, p.a.run.runId);
	await review(p);
	// Test-owned selected record changes after preview; actual E1 digest conflict, not synthetic success.
	const { writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	p.a.run.updatedAt = "2026-01-02T00:00:00.000Z";
	await writeFile(join(p.a.dir, "run.json"), JSON.stringify(p.a.run));
	await p.browser.click('[data-testid="selected-delete-confirm"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="selected-delete-status"]')
			.textContent.includes("Conflict (409)"),
	);
	assert.ok(existsSync(p.a.dir));
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Select workflow_delete_ui_a"]')
					.checked,
		),
		true,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="selected-delete-preview"]')
					.hidden,
		),
		true,
	);
	assert.equal(
		(await p.browser.evaluate(() => window.__deleteRequests)).length,
		2,
	);
	await review(p);
	assert.ok(existsSync(p.a.dir));
	await p.browser.click('[data-testid="selected-delete-confirm"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="selected-delete-status"]')
			.textContent.includes("Deleted exactly 1"),
	);
	assert.equal(existsSync(p.a.dir), false);
	assert.ok(existsSync(p.b.dir));
});

test("late preview cannot authorize changed selection or departed All-project scope", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t);
	await p.browser.evaluate(() => (window.__deleteMode = "hold"));
	await select(p, p.a.run.runId);
	await p.browser.click('[data-testid="selected-delete-review"]');
	await p.browser.waitFor(() => !!window.__releasePreview);
	await select(p, p.b.run.runId);
	await p.browser.evaluate(() => window.__releasePreview());
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="selected-delete-preview"]')
					.hidden,
		),
		true,
	);
	await p.browser.evaluate(() => {
		window.__deleteMode = "hold";
		window.__releasePreview = null;
	});
	await p.browser.click('[data-testid="selected-delete-review"]');
	await p.browser.waitFor(() => !!window.__releasePreview);
	await p.browser.send("Page.navigate", {
		url: `${p.origin}/?project=all&view=history`,
	});
	await p.browser.waitFor(() =>
		document.querySelector("#center").textContent.includes("Choose a project"),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelectorAll('[data-testid="selected-delete-confirm"]')
					.length,
		),
		0,
	);
	for (const r of [p.a, p.b, p.active]) assert.ok(existsSync(r.dir));
});

test("readonly history remains inspectable, no deletion control is enabled", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t, { readonly: true });
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector("#center").textContent,
		),
		/Read-only: deletion unavailable/,
	);
	assert.equal(
		await p.browser.evaluate(() =>
			[
				...document.querySelectorAll(
					'.history-list input, [data-testid="selected-delete-review"]',
				),
			].every((n) => n.disabled),
		),
		true,
	);
});

test("a sent deletion cannot be falsely cancelled or leave the remaining selection controls stuck", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t);
	await select(p, p.a.run.runId);
	await review(p);
	await p.browser.evaluate(() => {
		window.__deleteMode = "hold-commit";
	});
	await p.browser.click('[data-testid="selected-delete-confirm"]');
	await p.browser.waitFor(() => typeof window.__releaseCommit === "function");
	assert.equal(
		existsSync(p.a.dir),
		false,
		"actual isolated deletion already happened before the held response",
	);
	await p.browser.click('[data-testid="selected-delete-cancel"]');
	assert.doesNotMatch(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="selected-delete-status"]')
					.textContent,
		),
		/Deletion cancelled/,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="selected-delete-cancel"]')
					.disabled,
		),
		true,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="selected-delete-preview"]')
					.hidden,
		),
		false,
	);
	await p.browser.evaluate(() => window.__releaseCommit());
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="selected-delete-status"]')
			.textContent.includes("Deleted exactly 1"),
	);
	await assertDiagnosticsFit(p, '[data-testid="selected-delete-status"]');
	const outcome = await p.browser.evaluate(() => {
		const range = document.createRange();
		range.selectNodeContents(
			document.querySelector('[data-testid="selected-delete-status"]')
				.firstChild,
		);
		const rect = range.getBoundingClientRect();
		return {
			top: rect.top,
			bottom: rect.bottom,
			viewportTop: document.querySelector("#center").getBoundingClientRect()
				.top,
			viewportBottom: innerHeight,
		};
	});
	assert.ok(
		outcome.top >= outcome.viewportTop &&
			outcome.bottom <= outcome.viewportBottom,
		`The explicit deletion outcome must be visible after the long preview: ${JSON.stringify(outcome)}`,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Select workflow_delete_ui_b"]')
					.disabled,
		),
		false,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				window.__deleteRequests.filter((r) => r.path.endsWith("/run-deletions"))
					.length,
		),
		1,
	);
	for (const r of [p.b, p.active]) assert.ok(existsSync(r.dir));
});

test("partial/protected commit result is never represented as full success", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t);
	await p.browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (...args) => {
			if (String(args[0]).endsWith("/run-deletions"))
				return new Response(
					JSON.stringify({
						outcome: "failed",
						data: {
							runs: [
								{
									runId: "workflow_delete_ui_a",
									deleted: true,
									detached: true,
									purged: false,
									retainedEvidencePath: "test-retained-evidence",
									ownedSessions: { deleted: 1, notFound: 0, unsupported: 2 },
									error: "test partial purge",
								},
							],
						},
					}),
					{ status: 200 },
				);
			return original(...args);
		};
	});
	await select(p, p.a.run.runId);
	await review(p);
	await p.browser.click('[data-testid="selected-delete-confirm"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="selected-delete-status"]')
			.textContent.includes("Not full success"),
	);
	const text = await p.browser.evaluate(
		() =>
			document.querySelector('[data-testid="selected-delete-status"]')
				.textContent,
	);
	assert.match(text, /test-retained-evidence/);
	assert.match(text, /test partial purge/);
	assert.match(text, /unsupported/);
	assert.doesNotMatch(text, /Deleted exactly/);
	assert.ok(
		existsSync(p.a.dir),
		"synthetic partial fixture did not dispatch actual delete",
	);
});

for (const readonly of [false, true]) {
	test(`secondary deletion returns to familiar History and All projects requires scope (readonly=${readonly})`, {
		timeout: 90000,
	}, async (t) => {
		const p = await setup(t, { readonly });
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelector("#center h1").textContent,
			),
			"Delete selected Runs",
		);
		await p.browser.click('#center a[href*="view=runs"]');
		await p.browser.waitFor(
			() =>
				document.querySelectorAll(".run-row").length === 3 &&
				!!document.querySelector(".run-header"),
		);
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelectorAll("[data-history-id]").length,
			),
			0,
		);
		assert.ok(
			await p.browser.evaluate(
				() => !!document.querySelector('.run-row[aria-current="true"]'),
			),
		);
		await p.browser.click(".run-actions summary");
		await p.browser.click('[data-testid="manage-run-deletion"]');
		await p.browser.waitFor(
			() => document.querySelectorAll("[data-history-id]").length === 3,
		);
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelector("#center h1").textContent,
			),
			"Delete selected Runs",
		);
		await p.browser.send("Page.navigate", {
			url: `${p.origin}/?project=all&view=runs`,
		});
		await p.browser.waitFor(
			() => !!document.querySelector(".projects-overview"),
		);
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelectorAll("[data-history-id]").length,
			),
			0,
		);
		assert.equal(
			await p.browser.evaluate(
				() =>
					document.querySelectorAll(
						'.run-actions, [data-testid="manage-run-deletion"]',
					).length,
			),
			0,
		);
		await p.browser.send("Page.navigate", {
			url: `${p.origin}/?project=all&view=history`,
		});
		await p.browser.waitFor(() =>
			document
				.querySelector("#center")
				.textContent.includes("Choose a project before deleting selected Runs"),
		);
		assert.equal(
			await p.browser.evaluate(
				() =>
					document.querySelectorAll(
						'input[type="checkbox"], [data-testid="selected-delete-confirm"]',
					).length,
			),
			0,
		);
	});
}
