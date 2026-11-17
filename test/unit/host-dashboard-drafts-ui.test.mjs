// test-tier: integration
// Real Chrome, native dialogs and history; only isolated management fixtures are written.
import assert from "node:assert/strict";
import test from "node:test";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
import { profileAction } from "../../dist/hosts/catalog.js";

const chrome = await findChrome();
async function fixture(t, options = {}) {
	assert.ok(chrome);
	const p = await managementProject(t, options);
	await profileGraphFixtures(p.cwd);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: {
			executor: "claude",
			model: "hidden/model",
			strictCapabilities: ["readOnly"],
		},
	});
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	if (options.noNavigation)
		await b.send("Page.addScriptToEvaluateOnNewDocument", {
			source:
				'Object.defineProperty(window, "navigation", { value: undefined });',
		});
	const url = `${p.origin}/?project=${p.server.projectId}&view=profiles&workflow=model-flow`;
	return { ...p, b, url };
}
async function load(b, url) {
	await b.send("Page.navigate", { url });
	await b.waitFor(() => !!document.querySelector(".profile-overview"));
}
async function edit(b) {
	await b.click('[data-profile-open="daily"]');
	await b.waitFor(
		() => !!document.querySelector('[data-management-action="save-profile"]'),
	);
}
async function set(b, label, value) {
	await b.evaluate(
		(label, value) => {
			const field = document.querySelector(`[aria-label="${label}"]`);
			if (!field) throw Error(`Missing ${label}`);
			field.value = value;
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}
async function strictValue(b) {
	return b.evaluate(
		() =>
			document.querySelector(
				'[aria-label="Strict capabilities (comma separated)"]',
			).value,
	);
}
async function dialog(b, action, accept, type) {
	const event = b.nextEvent("Page.javascriptDialogOpening");
	const pending = action();
	const opened = await event;
	assert.equal(opened.type, type);
	await b.send("Page.handleJavaScriptDialog", { accept });
	await pending;
}
async function dirty(b) {
	return b.evaluate(
		() =>
			!window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
	);
}
async function button(b, text) {
	await b.evaluate((text) => {
		const node = [...document.querySelectorAll("#center button")].find(
			(n) => n.textContent === text && n.checkVisibility(),
		);
		if (!node) throw Error(`Missing button ${text}`);
		node.click();
	}, text);
}
async function confirmPolicy(b, answer) {
	await b.evaluate((answer) => {
		window.guardCalls = 0;
		window.confirm = () => {
			window.guardCalls++;
			return answer;
		};
	}, answer);
}

for (const noNavigation of [false, true])
	test(`settings drafts: native reload/leave reject and accept preserve document or restore saved values (Navigation API absent: ${noNavigation})`, {
		timeout: 60000,
	}, async (t) => {
		const { b, url, ctx } = await fixture(t, { noNavigation });
		const saved = (await profileAction(ctx, { op: "show", name: "daily" })).data
			.profile;
		await load(b, url);
		await edit(b); // trusted mouse activation
		await set(b, "Strict capabilities (comma separated)", "unsaved-native");
		const before = await b.evaluate(() => {
			window.documentMarker = "same";
			return location.href;
		});
		await dialog(b, () => b.send("Page.reload"), false, "beforeunload");
		assert.equal(await strictValue(b), "unsaved-native");
		assert.equal(await b.evaluate(() => window.documentMarker), "same");
		assert.equal(await b.evaluate(() => location.href), before);
		await dialog(
			b,
			() =>
				b.send("Page.navigate", {
					url: url.replace("view=profiles", "view=workflows"),
				}),
			false,
			"beforeunload",
		);
		assert.equal(await strictValue(b), "unsaved-native");
		assert.equal(await b.evaluate(() => location.href), before);
		await dialog(b, () => b.send("Page.reload"), true, "beforeunload");
		await b.waitFor(
			() =>
				!!document.querySelector('[data-management-action="save-profile"]') &&
				!window.documentMarker,
		);
		assert.equal(await strictValue(b), "readOnly");
		await b.click('[aria-label="Strict capabilities (comma separated)"]');
		await set(b, "Strict capabilities (comma separated)", "leave-again");
		await dialog(
			b,
			() =>
				b.send("Page.navigate", {
					url: url.replace("view=profiles", "view=workflows"),
				}),
			true,
			"beforeunload",
		);
		await b.waitFor(
			() => new URLSearchParams(location.search).get("view") === "workflows",
		);
		assert.deepEqual(
			(await profileAction(ctx, { op: "show", name: "daily" })).data.profile,
			saved,
		);
	});

for (const noNavigation of [false, true])
	test(`settings drafts: repeated browser Back cancellation retains exact history and Forward saved values (Navigation API absent: ${noNavigation})`, {
		timeout: 60000,
	}, async (t) => {
		const { b, url } = await fixture(t, { noNavigation });
		await load(b, url);
		await edit(b);
		assert.equal(await b.evaluate(() => !window.navigation), noNavigation);
		await set(b, "Strict capabilities (comma separated)", "unsaved-history");
		const original = await b.send("Page.getNavigationHistory");
		const address = await b.evaluate(() => location.href);
		await confirmPolicy(b, false);
		for (let i = 0; i < 2; i++) {
			const native = noNavigation
				? b.nextEvent("Page.javascriptDialogOpening", 1000).catch(() => null)
				: null;
			const traversal = b.send("Page.navigateToHistoryEntry", {
				entryId: original.entries[original.currentIndex - 1].id,
			});
			if (native) {
				const opened = await native;
				if (opened) {
					console.log(
						"OLD-RED absent Navigation API unexpected native dialog",
						opened.type,
					);
					await b.send("Page.handleJavaScriptDialog", { accept: false });
					console.log(
						"OLD-RED history after native Cancel",
						JSON.stringify({
							original,
							actual: await b.send("Page.getNavigationHistory"),
							address,
							actualAddress: await b.evaluate(() => location.href),
							model: await strictValue(b),
						}),
					);
				}
			}
			await traversal;
			await b.waitFor(`window.guardCalls === ${i + 1}`, 3000);
			assert.equal(await b.evaluate(() => location.href), address);
			assert.equal(await strictValue(b), "unsaved-history");
			assert.deepEqual(await b.send("Page.getNavigationHistory"), original);
		}
		await confirmPolicy(b, true);
		await b.send("Page.navigateToHistoryEntry", {
			entryId: original.entries[original.currentIndex - 1].id,
		});
		await b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		const back = await b.send("Page.getNavigationHistory");
		assert.equal(back.currentIndex, original.currentIndex - 1);
		assert.equal(back.entries.length, original.entries.length);

		await b.send("Page.navigateToHistoryEntry", {
			entryId: original.entries[original.currentIndex].id,
		});
		await b.waitFor(
			() => !!document.querySelector('[data-management-action="save-profile"]'),
		);
		assert.equal(await strictValue(b), "readOnly");
		assert.equal(
			(await b.send("Page.getNavigationHistory")).currentIndex,
			original.currentIndex,
		);
	});

for (const noNavigation of [false, true])
	test(`settings drafts: app Back refuses before changing URL; undo, successful Save and explicit Cancel are quiet (Navigation API absent: ${noNavigation})`, {
		timeout: 60000,
	}, async (t) => {
		const { b, url } = await fixture(t, { noNavigation });
		await load(b, url);
		await edit(b);
		await confirmPolicy(b, false);
		await set(b, "Strict capabilities (comma separated)", "draft");
		const address = await b.evaluate(() => location.href);
		await b.click("[data-profile-back]");
		assert.equal(await b.evaluate(() => location.href), address);
		assert.equal(await strictValue(b), "draft");
		assert.equal(await b.evaluate(() => window.guardCalls), 1);
		await set(b, "Strict capabilities (comma separated)", "readOnly");
		await b.click("[data-profile-back]");
		await b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		await edit(b);
		await confirmPolicy(b, false);
		await set(
			b,
			"Strict capabilities (comma separated)",
			"readOnly, contextIsolation",
		);
		const beforeSave = await b.send("Page.getNavigationHistory");
		await b.click('[data-management-action="save-profile"]');
		await b.waitFor(() => !!document.querySelector(".profile-save-status"));
		const afterSave = await b.send("Page.getNavigationHistory");
		assert.equal(afterSave.currentIndex, beforeSave.currentIndex - 1);
		assert.equal(afterSave.entries.length, beforeSave.entries.length);
		await b.send("Page.navigateToHistoryEntry", {
			entryId: beforeSave.entries[beforeSave.currentIndex].id,
		});
		await b.waitFor(
			() => !!document.querySelector('[data-management-action="save-profile"]'),
		);
		assert.equal(
			(await b.send("Page.getNavigationHistory")).currentIndex,
			beforeSave.currentIndex,
		);
		assert.equal(await strictValue(b), "readOnly, contextIsolation");
		await confirmPolicy(b, false);
		await set(b, "Strict capabilities (comma separated)", "explicit-discard");
		await b.evaluate(() =>
			[...document.querySelectorAll("button")]
				.find((n) => n.textContent === "Discard changes" && n.checkVisibility())
				.click(),
		);
		await b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		await edit(b);
		assert.equal(await strictValue(b), "readOnly, contextIsolation");
	});

test("settings drafts: clean view interactions, same values, normalization and undo are quiet; readonly never warns", {
	timeout: 60000,
}, async (t) => {
	const { b, url } = await fixture(t);
	await load(b, url);
	await edit(b);
	assert.equal(await dirty(b), false);
	await b.click('[aria-label="Strict capabilities (comma separated)"]');
	await b.evaluate(() =>
		document.querySelector('button[aria-label^="Theme:"]').click(),
	);
	assert.equal(await dirty(b), false);
	await set(b, "Strict capabilities (comma separated)", "readOnly");
	await set(b, "Strict capabilities (comma separated)", " readOnly, , ");
	assert.equal(await dirty(b), false);
	await set(b, "Strict capabilities (comma separated)", "changed");
	assert.equal(await dirty(b), true);
	await set(b, "Strict capabilities (comma separated)", "readOnly");
	assert.equal(await dirty(b), false);
	await set(b, "Profile permission mode", "safe");
	assert.equal(await dirty(b), true);
	await set(b, "Profile permission mode", "");
	assert.equal(await dirty(b), false);
	await button(b, "Discard changes");
	await b.waitFor(
		() => !!document.querySelector(".profile-overview:not([hidden])"),
	);
	assert.equal(await dirty(b), false);
	const ro = await fixture(t, { readonly: true });
	await load(ro.b, `${ro.url}&profile=daily`);
	await ro.b.waitFor(
		() =>
			!!document.querySelector(
				'[aria-label="Strict capabilities (comma separated)"]',
			),
	);
	await set(
		ro.b,
		"Strict capabilities (comma separated)",
		"readonly-programmatic",
	);
	assert.equal(await dirty(ro.b), false);
});

test("settings drafts: failed and invalid saves, cancelled Delete, default change refusal, and project storage refusal", {
	timeout: 60000,
}, async (t) => {
	const { b, url } = await fixture(t);
	await load(b, `${url}&profile=daily`); // deep link, no editor marker
	await b.waitFor(
		() =>
			!!document.querySelector(
				'[aria-label="Strict capabilities (comma separated)"]',
			),
	);
	await set(b, "Strict capabilities (comma separated)", "failed-save");
	await b.evaluate(() => {
		const fetch = window.fetch;
		window.fetch = (url, options) =>
			options?.method === "PUT"
				? Promise.reject(Error("fixture network failure"))
				: fetch(url, options);
	});
	await button(b, "Save profile");
	await b.waitFor(() =>
		document
			.querySelector(".profile-editor [role=alert]")
			?.textContent.includes("fixture network failure"),
	);
	assert.equal(await dirty(b), true);

	await button(b, "Delete daily");
	await button(b, "Keep profile");
	assert.equal(await dirty(b), true);
	await confirmPolicy(b, false);
	await button(b, "Use daily by default");
	assert.equal(await dirty(b), true);
	assert.equal(await strictValue(b), "failed-save");
	await confirmPolicy(b, true);
	await button(b, "Use daily by default"); // injected network failure must not unregister the draft
	await b.waitFor(() =>
		document
			.querySelector(".profile-editor [role=alert]")
			?.textContent.includes("fixture network failure"),
	);
	assert.equal(await dirty(b), true);
	await confirmPolicy(b, false);
	const before = await b.evaluate(() => ({
		href: location.href,
		project: document.querySelector('[aria-label="Project"]').value,
		storage: localStorage.getItem("agent-workflow:project"),
	}));
	await set(b, "Project", "all");
	assert.deepEqual(
		await b.evaluate(() => ({
			href: location.href,
			project: document.querySelector('[aria-label="Project"]').value,
			storage: localStorage.getItem("agent-workflow:project"),
		})),
		before,
	);
	assert.equal(await strictValue(b), "failed-save");
	await button(b, "Discard changes");
	await b.waitFor(
		() => !!document.querySelector(".profile-overview:not([hidden])"),
	);
	await b.click("[data-profile-new]");
	await b.waitFor(
		() => !!document.querySelector('[aria-label="Profile name"]'),
	);
	await set(b, "Strict capabilities (comma separated)", "invalid-name-draft");
	await button(b, "Save profile");
	assert.equal(
		await b.evaluate(() =>
			document
				.querySelector('[aria-label="Profile name"]')
				.getAttribute("aria-invalid"),
		),
		"true",
	);
	assert.equal(await dirty(b), true);
	await confirmPolicy(b, false);
	await b.click("[data-profile-back]");
	assert.equal(await strictValue(b), "invalid-name-draft");
	await button(b, "Discard changes");
	await b.waitFor(
		() => !!document.querySelector(".profile-overview:not([hidden])"),
	);
});

for (const noNavigation of [false, true])
	test(`settings drafts: native cross-document Back and Forward cancellation, direct link and accepted project switch (Navigation API absent: ${noNavigation})`, {
		timeout: 60000,
	}, async (t) => {
		const { b, url } = await fixture(t, { noNavigation });
		await load(b, url);
		await load(b, `${url}&profile=daily`);
		await b.waitFor(
			() =>
				!!document.querySelector(
					'[aria-label="Strict capabilities (comma separated)"]',
				),
		);
		await b.click('[aria-label="Strict capabilities (comma separated)"]'); // trusted activation in this document
		await set(b, "Strict capabilities (comma separated)", "deep-native");
		const original = await b.send("Page.getNavigationHistory");
		for (let i = 0; i < 2; i++) {
			await dialog(
				b,
				() => b.evaluate(() => history.back()),
				false,
				"beforeunload",
			);
			assert.equal(await strictValue(b), "deep-native");
			assert.deepEqual(await b.send("Page.getNavigationHistory"), original);
		}
		await dialog(
			b,
			() => b.evaluate(() => history.back()),
			true,
			"beforeunload",
		);
		await b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		await b.evaluate(() => history.forward());
		await b.waitFor(
			() =>
				!!document.querySelector(
					'[aria-label="Strict capabilities (comma separated)"]',
				),
		);
		assert.equal(await strictValue(b), "readOnly");
		// Create a genuine cross-document forward destination without sentinels.
		await b.send("Page.navigate", {
			url: url.replace("view=profiles", "view=workflows"),
		});
		await b.waitFor(
			() => new URLSearchParams(location.search).get("view") === "workflows",
		);
		await b.evaluate(() => history.back());
		await b.waitFor(
			() =>
				!!document.querySelector(
					'[aria-label="Strict capabilities (comma separated)"]',
				),
		);
		await b.click('[aria-label="Strict capabilities (comma separated)"]');
		await set(b, "Strict capabilities (comma separated)", "forward-native");
		const beforeForward = await b.send("Page.getNavigationHistory");
		await dialog(
			b,
			() => b.evaluate(() => history.forward()),
			false,
			"beforeunload",
		);
		assert.equal(await strictValue(b), "forward-native");
		assert.deepEqual(await b.send("Page.getNavigationHistory"), beforeForward);
		await dialog(
			b,
			() => b.evaluate(() => history.forward()),
			true,
			"beforeunload",
		);
		await b.waitFor(
			() => new URLSearchParams(location.search).get("view") === "workflows",
		);
		await b.evaluate(() => history.back());
		await b.waitFor(
			() =>
				!!document.querySelector(
					'[aria-label="Strict capabilities (comma separated)"]',
				),
		);
		assert.equal(await strictValue(b), "readOnly");
		await b.click('[aria-label="Strict capabilities (comma separated)"]');
		await set(b, "Strict capabilities (comma separated)", "project-discard");
		await confirmPolicy(b, true);
		await set(b, "Project", "all");
		await b.waitFor(
			() => new URLSearchParams(location.search).get("project") === "all",
		);
		assert.equal(
			await b.evaluate(() => localStorage.getItem("agent-workflow:project")),
			"all",
		);
		assert.equal(await dirty(b), false);
	});

// The workflow-page Check form was deleted (2026-11-16, owner); opening the page alone is not a draft.
test("settings drafts: workflow page has no Check form and opening it registers no settings draft", {
	timeout: 60000,
}, async (t) => {
	const { b, url } = await fixture(t);
	await b.send("Page.navigate", {
		url: url.replace("view=profiles", "view=workflows"),
	});
	await b.waitFor(() => !!document.querySelector(".project-workflow-actions"));
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelectorAll(
					'[data-management-action="check"], [aria-label="Check profile"]',
				).length,
		),
		0,
	);
	assert.equal(await dirty(b), false);
});

test("settings drafts: default changes require consent before mutation and never save the discarded profile", {
	timeout: 60000,
}, async (t) => {
	const { b, url, ctx } = await fixture(t);
	await load(b, url);
	await edit(b);
	await set(
		b,
		"Strict capabilities (comma separated)",
		"not-saved-by-default-change",
	);

	await confirmPolicy(b, false);
	await button(b, "Use daily by default");
	assert.equal(
		(await profileAction(ctx, { op: "list" })).data.default,
		undefined,
	);
	assert.equal(await dirty(b), true);
	await confirmPolicy(b, true);
	await button(b, "Use daily by default");
	await b.waitFor(() =>
		document
			.querySelector('[data-profile-open="daily"]')
			?.textContent.includes("Default profile"),
	);
	assert.equal(await dirty(b), false);
	await edit(b);
	assert.equal(await strictValue(b), "readOnly");
});

test("settings drafts: clearing strict capabilities stays dirty; cancelled Delete and successful Delete/Restore preserve their existing confirmation", {
	timeout: 60000,
}, async (t) => {
	const { b, url, ctx } = await fixture(t);
	await profileAction(ctx, {
		op: "set",
		name: "daily",
		values: {
			roles: { verification: { executor: "claude", model: "readOnly" } },
		},
	});
	await profileAction(ctx, {
		op: "set",
		name: "codex",
		values: { model: "custom" },
	});
	await load(b, `${url}&profile=daily`);
	await b.waitFor(
		() =>
			!!document.querySelector(
				'[aria-label="Strict capabilities (comma separated)"]',
			),
	);
	await set(b, "Strict capabilities (comma separated)", "");
	assert.equal(await dirty(b), true);
	await button(b, "Delete daily");
	await button(b, "Keep profile");
	assert.equal(await dirty(b), true);
	await confirmPolicy(b, false); // destructive Confirm already is the intentional discard
	await button(b, "Delete daily");
	await button(b, "Confirm");
	await b.waitFor(
		() => !!document.querySelector(".profile-overview:not([hidden])"),
	);
	assert.equal(await dirty(b), false);
	await b.click('[data-profile-open="codex"]');
	await b.waitFor(
		() =>
			!!document.querySelector(
				'[aria-label="Strict capabilities (comma separated)"]',
			),
	);
	await set(
		b,
		"Strict capabilities (comma separated)",
		"unsaved-before-restore",
	);

	await button(b, "Restore built-in codex");
	await button(b, "Keep profile");
	assert.equal(await dirty(b), true);
	await button(b, "Restore built-in codex");
	await button(b, "Confirm");
	await b.waitFor(
		() => !!document.querySelector(".profile-overview:not([hidden])"),
	);
	assert.equal(await dirty(b), false);
	assert.equal(
		(await profileAction(ctx, { op: "list" })).data.profiles.length,
		0,
	);
});

test("settings drafts: pending nextEvent settles on browser close", {
	timeout: 15000,
}, async () => {
	const b = await createBrowser(chrome);
	const waiter = b.nextEvent("Never.emitted", 10000);
	// Install both handlers immediately: cleanup must not create an unhandled rejection.
	const settled = waiter.then(
		() => "resolved",
		() => "rejected",
	);
	await b.close();
	await assert.rejects(b.nextEvent("After.close"), /Browser closed/);
	let timer;
	try {
		assert.notEqual(
			await Promise.race([
				settled,
				new Promise((resolve) => {
					timer = setTimeout(() => resolve("pending"), 100);
				}),
			]),
			"pending",
		);
	} finally {
		clearTimeout(timer);
	}
});

for (const during of ["late", "undo", "leave", "failure"])
	test(`settings drafts: profile Save response protects intervening edits (${during})`, {
		timeout: 60000,
	}, async (t) => {
		const { b, url, ctx } = await fixture(t);
		if (during === "late")
			await b.send("Emulation.setDeviceMetricsOverride", {
				width: 390,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
		await load(b, url);
		await edit(b);
		await set(b, "Strict capabilities (comma separated)", "contextIsolation");
		await b.evaluate((failure) => {
			const fetch = window.fetch;
			window.fetch = async (...args) => {
				const response = await fetch(...args);
				if (
					new URL(args[0], location.href).pathname === "/api/profiles/daily" &&
					args[1]?.method === "PUT"
				) {
					window.heldResponse = { status: response.status };
					await new Promise((resolve) => {
						window.releaseSave = resolve;
					});
					return failure
						? new Response(
								JSON.stringify({ error: "isolated response failure" }),
								{ status: 500 },
							)
						: response;
				}
				return response;
			};
		}, during === "failure");
		await b.click('[data-management-action="save-profile"]');
		await b.waitFor(() => !!window.heldResponse);
		assert.equal(await b.evaluate(() => window.heldResponse.status), 200);
		{
			await set(
				b,
				"Strict capabilities (comma separated)",
				"edited-during-save",
			);
			if (during === "undo")
				await set(
					b,
					"Strict capabilities (comma separated)",
					"contextIsolation",
				);
			if (during === "leave") {
				// A successful default change intentionally replaces the editor in this document.
				await confirmPolicy(b, true);

				await button(b, "Use daily by default");
				await b.waitFor(
					() => !!document.querySelector(".profile-overview:not([hidden])"),
				);
			}
			if (during === "late")
				await b.evaluate(() => {
					const input = document.querySelector(
						'[aria-label="Strict capabilities (comma separated)"]',
					);
					// Common fields are directly visible.
					input.focus();
					input.scrollIntoView({ block: "center" });
				});
			await b.evaluate(() => window.releaseSave());
			if (during === "late") {
				await b.waitFor(
					() =>
						!!document.querySelector(".profile-editor .profile-save-status"),
					3000,
				);
				assert.equal(await strictValue(b), "edited-during-save");
				assert.equal(await dirty(b), true);
				assert.deepEqual(
					await b.evaluate(() => {
						const r = document
							.querySelector(".profile-editor .profile-save-status")
							.getBoundingClientRect();
						return {
							visible: r.top >= 0 && r.bottom <= innerHeight,
							focused:
								document.activeElement ===
								document.querySelector(
									'[aria-label="Strict capabilities (comma separated)"]',
								),
							editable:
								!document.activeElement.disabled &&
								!document.activeElement.readOnly,
						};
					}),
					{ visible: true, focused: true, editable: true },
				);
				assert.match(
					await b.evaluate(
						() => document.querySelector(".profile-save-status").textContent,
					),
					/unsaved/i,
				);
				await set(
					b,
					"Strict capabilities (comma separated)",
					"contextIsolation",
				);
				assert.equal(await dirty(b), false);
			} else if (during === "failure") {
				await b.waitFor(
					() => !!document.querySelector(".profile-editor .management-error"),
				);
				assert.equal(await strictValue(b), "edited-during-save");
				assert.equal(await dirty(b), true);
			} else if (during === "undo") {
				await b.waitFor(
					() => !!document.querySelector(".profile-overview:not([hidden])"),
				);
				await edit(b);
				assert.equal(await strictValue(b), "contextIsolation");
				assert.equal(await dirty(b), false);
			} else {
				// A protocol round-trip after completion must not resurrect or annotate the old editor.
				await b.evaluate(
					() =>
						new Promise((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(resolve)),
						),
				);
				assert.equal(
					await b.evaluate(
						() => !!document.querySelector(".profile-save-status"),
					),
					false,
				);
				assert.equal(
					await b.evaluate(
						() => !!document.querySelector(".profile-overview:not([hidden])"),
					),
					true,
				);
			}
			assert.equal(
				(
					await profileAction(ctx, { op: "show", name: "daily" })
				).data.profile.strictCapabilities.join(", "),
				"contextIsolation",
			);
		}
	});

test("settings drafts: sidebar same-tab departure uses native app confirmation once", {
	timeout: 60000,
}, async (t) => {
	const { b, url } = await fixture(t);
	await load(b, url);
	await edit(b);
	await set(b, "Strict capabilities (comma separated)", "sidebar-draft");
	const original = await b.send("Page.getNavigationHistory");
	const address = await b.evaluate(() => location.href);
	// Select the app-owned sidebar link without changing its href/default action.
	const link = await b.evaluate(() =>
		[...document.querySelectorAll('a[href*="view=workflows"]')].map((a) => ({
			id: a.id,
			cls: a.className,
			text: a.textContent,
		})),
	);
	assert.ok(link.length);
	const actual = '.management-nav a[href*="view=workflows"]';
	await dialog(b, () => b.click(actual), false, "confirm");
	assert.equal(await strictValue(b), "sidebar-draft");
	assert.equal(await b.evaluate(() => location.href), address);
	assert.deepEqual(await b.send("Page.getNavigationHistory"), original);
	await dialog(b, () => b.click(actual), true, "confirm");
	await b.waitFor(
		() => new URLSearchParams(location.search).get("view") === "workflows",
	);
	assert.equal(b.errors.length, 0);
});

test("settings drafts: delegated links keep native exceptions and clean/undo navigation quiet", {
	timeout: 60000,
}, async (t) => {
	const { b, url } = await fixture(t);
	await load(b, url);
	await edit(b);
	await set(b, "Strict capabilities (comma separated)", "link-exceptions");
	await confirmPolicy(b, false);
	const before = await b.send("Page.getNavigationHistory");
	const result = await b.evaluate(() => {
		const link = document.querySelector(
			'.management-nav a[href*="view=workflows"]',
		);
		const href = link.getAttribute("href");
		const outcomes = [];
		// Observe cancellation after the app's bubble listener, then suppress the
		// default in this test only so modified/download targets do not open windows.
		let prevented;
		const observe = (event) => {
			prevented = event.defaultPrevented;
			event.preventDefault();
		};
		document.addEventListener("click", observe);
		const click = (options) => {
			link.dispatchEvent(
				new MouseEvent("click", {
					bubbles: true,
					cancelable: true,
					...options,
				}),
			);
			outcomes.push(prevented);
		};
		for (const options of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ shiftKey: true },
			{ altKey: true },
			{ button: 1 },
		])
			click(options);
		link.target = "_blank";
		click({});
		link.removeAttribute("target");
		link.setAttribute("download", "");
		click({});
		link.removeAttribute("download");
		for (const fragment of ["#center", "#"]) {
			link.href = fragment;
			click({});
		}
		link.setAttribute("href", href);
		const prevent = (event) => event.preventDefault();
		link.addEventListener("click", prevent);
		click({});
		link.removeEventListener("click", prevent);
		document.removeEventListener("click", observe);
		return {
			outcomes,
			href: link.getAttribute("href"),
			expectedHref: href,
			calls: window.guardCalls,
		};
	});
	assert.deepEqual(result.outcomes, [
		false,
		false,
		false,
		false,
		false,
		false,
		false,
		false,
		false,
		true,
	]);
	assert.equal(result.calls, 0);
	assert.equal(result.href, result.expectedHref);
	assert.equal(await strictValue(b), "link-exceptions");
	assert.deepEqual(await b.send("Page.getNavigationHistory"), before);
	await set(b, "Strict capabilities (comma separated)", "readOnly");
	await b.click('.management-nav a[href*="view=workflows"]');
	await b.waitFor(
		() =>
			document.querySelector(".management-page h1")?.textContent ===
			"Workflows",
	);
	assert.equal(await b.evaluate(() => window.guardCalls), undefined); // real departure, no app/native dialog blocked it
	await load(b, url);
	await confirmPolicy(b, false);
	await b.click('.management-nav a[href*="view=workflows"]');
	await b.waitFor(
		() =>
			document.querySelector(".management-page h1")?.textContent ===
			"Workflows",
	);
});

for (const noNavigation of [false, true])
	test(`F2: new profile Save focuses saved row (Navigation API absent: ${noNavigation})`, {
		timeout: 60000,
	}, async (t) => {
		const { b, url } = await fixture(t, { noNavigation });
		await load(b, url);
		await b.evaluate(() =>
			history.replaceState(
				{ ...history.state, unrelatedF: "preserved" },
				"",
				location.href,
			),
		);
		await b.click("[data-profile-new]");
		await b.waitFor(
			() => !!document.querySelector('[aria-label="Profile name"]'),
		);
		await set(b, "Profile name", "focus-saved");
		const before = await b.send("Page.getNavigationHistory");
		await button(b, "Save profile");
		await b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		const actual = await b.evaluate(() => ({
			focus: document.activeElement.getAttribute("data-profile-open"),
			state: history.state,
		}));
		console.log("F2 evidence", JSON.stringify({ noNavigation, actual }));
		assert.equal(actual.focus, "focus-saved");
		assert.equal(actual.state.unrelatedF, "preserved");
		assert.equal(!!actual.state.newProfileReturn, false);
		const after = await b.send("Page.getNavigationHistory");
		assert.equal(after.currentIndex, before.currentIndex - 1);
		assert.equal(after.entries.length, before.entries.length);
		await b.send("Page.navigateToHistoryEntry", {
			entryId: before.entries[before.currentIndex].id,
		});
		await b.waitFor(
			() => !!document.querySelector('[data-profile-edit="focus-saved"]'),
		);
		assert.equal(await dirty(b), false);
	});
