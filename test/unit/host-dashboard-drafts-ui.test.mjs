// test-tier: integration
// Real Chrome dialogs/history and permission-only executor drafts in isolated homes.
import assert from "node:assert/strict";
import test from "node:test";
import {
	executorsFixture,
	loadExecutors,
	setPermission,
	toggleCapability,
	savePermissions,
	seedProfile,
	storedProfile,
} from "../helpers/dashboard-profiles.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
const opts = { timeout: 60000 };
async function fixture(t, options = {}) {
	const p = await executorsFixture(t, options);
	await profileGraphFixtures(p.cwd);
	await seedProfile(p, {
		model: "hidden/model",
		strictCapabilities: ["readOnly"],
	});
	if (options.noNavigation)
		await p.b.send("Page.addScriptToEvaluateOnNewDocument", {
			source:
				'Object.defineProperty(window, "navigation", { value: undefined });',
		});
	await loadExecutors(p);
	// Trusted activation enables the browser's native beforeunload dialog.
	await p.b.click('[data-executor-permissions="codex"] summary');
	return p;
}
async function value(b) {
	return b.evaluate(
		() => document.querySelector('[aria-label="codex permission mode"]').value,
	);
}
async function dirty(b) {
	return b.evaluate(
		() =>
			!window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
	);
}
async function policy(b, answer) {
	await b.evaluate((answer) => {
		window.guardCalls = 0;
		window.confirm = () => {
			window.guardCalls++;
			return answer;
		};
	}, answer);
}
async function dialog(b, action, accept, type) {
	const opening = b.nextEvent("Page.javascriptDialogOpening");
	const pending = action();
	assert.equal((await opening).type, type);
	await b.send("Page.handleJavaScriptDialog", { accept });
	await pending;
}
async function discard(b) {
	await b.evaluate(() =>
		document
			.querySelector(
				'[data-executor-permissions="codex"] [data-discard-permissions]',
			)
			.click(),
	);
}
const workflowLink = '.management-nav a[href*="view=workflows"]';

for (const noNavigation of [false, true]) {
	test(
		`executor drafts: native reload/leave rejection and acceptance (Navigation API absent: ${noNavigation})`,
		opts,
		async (t) => {
			const p = await fixture(t, { noNavigation }),
				{ b } = p;
			await setPermission(b, "safe");
			await b.evaluate(() => {
				window.documentMarker = "same";
			});
			await dialog(b, () => b.send("Page.reload"), false, "beforeunload");
			assert.equal(await value(b), "safe");
			assert.equal(await b.evaluate(() => window.documentMarker), "same");
			await dialog(
				b,
				() =>
					b.send("Page.navigate", {
						url: p.url.replace("view=executors", "view=workflows"),
					}),
				false,
				"beforeunload",
			);
			assert.equal(await value(b), "safe");
			await dialog(b, () => b.send("Page.reload"), true, "beforeunload");
			await b.waitFor(
				() =>
					!!document.querySelector('[aria-label="codex permission mode"]') &&
					!window.documentMarker,
			);
			assert.equal(await value(b), "");
			await b.click('[data-executor-permissions="codex"] summary');
			await setPermission(b, "free");
			await dialog(
				b,
				() =>
					b.send("Page.navigate", {
						url: p.url.replace("view=executors", "view=workflows"),
					}),
				true,
				"beforeunload",
			);
			await b.waitFor(
				() => document.querySelector("h1")?.textContent === "Workflows",
			);
			assert.equal((await storedProfile(p)).permissionMode, undefined);
		},
	);

	test(
		`executor drafts: same-document Back cancellation preserves exact history and Forward (Navigation API absent: ${noNavigation})`,
		opts,
		async (t) => {
			const { b } = await fixture(t, { noNavigation });
			await b.evaluate(() =>
				history.pushState(
					{
						...history.state,
						dashboardHistoryIndex:
							(history.state?.dashboardHistoryIndex || 0) + 1,
					},
					"",
					location.href + "&layout=lr",
				),
			);
			// Synchronize the app's current history entry before editing.
			await b.evaluate(() => {
				window.beforeHistoryReload = true;
				dispatchEvent(new PopStateEvent("popstate"));
			});
			await b.waitFor(
				() =>
					!window.beforeHistoryReload &&
					document.querySelector('[aria-label="codex permission mode"]')
						?.value === "",
			);
			await setPermission(b, "safe");
			const original = await b.send("Page.getNavigationHistory"),
				address = await b.evaluate(() => location.href);
			await policy(b, false);
			for (let i = 0; i < 2; i++) {
				await b.evaluate(() => history.back());
				await b.waitFor(`window.guardCalls === ${i + 1}`);
				assert.equal(await value(b), "safe");
				assert.equal(await b.evaluate(() => location.href), address);
				assert.deepEqual(await b.send("Page.getNavigationHistory"), original);
			}
			await policy(b, true);
			await b.evaluate(() => history.back());
			await b.waitFor(
				() =>
					new URL(location.href).searchParams.get("layout") !== "lr" &&
					document.querySelector('[aria-label="codex permission mode"]')
						?.value === "",
			);
			assert.equal(await value(b), "");
			await b.evaluate(() => {
				window.beforeForward = true;
				history.forward();
			});
			await b.waitFor(
				() =>
					!window.beforeForward &&
					new URL(location.href).searchParams.get("layout") === "lr" &&
					document.querySelector('[aria-label="codex permission mode"]')
						?.value === "",
			);
			assert.equal(await value(b), "");
			assert.equal(
				(await b.send("Page.getNavigationHistory")).currentIndex,
				original.currentIndex,
			);
		},
	);

	test(
		`executor drafts: cross-document Back/Forward cancellation and accepted project switch (Navigation API absent: ${noNavigation})`,
		opts,
		async (t) => {
			const p = await fixture(t, { noNavigation }),
				{ b } = p;
			await b.send("Page.navigate", { url: p.url + "&layout=lr" });
			await b.waitFor(
				() => !!document.querySelector('[aria-label="codex permission mode"]'),
			);
			await b.click('[data-executor-permissions="codex"] summary');
			await setPermission(b, "safe");
			const original = await b.send("Page.getNavigationHistory");
			await dialog(
				b,
				() => b.evaluate(() => history.back()),
				false,
				"beforeunload",
			);
			assert.deepEqual(await b.send("Page.getNavigationHistory"), original);
			assert.equal(await value(b), "safe");
			await dialog(
				b,
				() => b.evaluate(() => history.back()),
				true,
				"beforeunload",
			);
			await b.waitFor(
				() =>
					new URL(location.href).searchParams.get("layout") !== "lr" &&
					document.querySelector('[aria-label="codex permission mode"]')
						?.value === "",
			);
			await b.click('[data-executor-permissions="codex"] summary');
			await setPermission(b, "free");
			await dialog(
				b,
				() => b.evaluate(() => history.forward()),
				false,
				"beforeunload",
			);
			assert.equal(await value(b), "free");
			await dialog(
				b,
				() => b.evaluate(() => history.forward()),
				true,
				"beforeunload",
			);
			await b.waitFor(
				() =>
					new URL(location.href).searchParams.get("layout") === "lr" &&
					document.querySelector('[aria-label="codex permission mode"]')
						?.value === "",
			);
			assert.equal(await value(b), "");
			await setPermission(b, "safe");
			await policy(b, true);
			await b.evaluate(() => {
				const c = document.querySelector('[aria-label="Project"]');
				c.value = "all";
				c.dispatchEvent(new Event("change", { bubbles: true }));
			});
			await b.waitFor(
				() => new URL(location.href).searchParams.get("project") === "all",
			);
			assert.equal(
				await b.evaluate(() => localStorage.getItem("agent-workflow:project")),
				"all",
			);
			assert.equal(await dirty(b), false);
		},
	);
}

test(
	"executor drafts: clean interactions, undo, clearing strict and Discard; readonly never warns",
	opts,
	async (t) => {
		const { b } = await fixture(t);
		assert.equal(await dirty(b), false);
		await b.evaluate(() =>
			document.querySelector('button[aria-label^="Theme:"]').click(),
		);
		await toggleCapability(b, "readOnly");
		assert.equal(await dirty(b), true);
		await toggleCapability(b, "readOnly");
		assert.equal(await dirty(b), false);
		await setPermission(b, "safe");
		assert.equal(await dirty(b), true);
		await setPermission(b, "");
		assert.equal(await dirty(b), false);
		await setPermission(b, "free");
		await policy(b, false);
		await discard(b);
		assert.equal(await dirty(b), false);
		assert.equal(await b.evaluate(() => window.guardCalls), 0);
		const ro = await fixture(t, { readonly: true });
		await setPermission(ro.b, "safe");
		assert.equal(await dirty(ro.b), false);
	},
);

test(
	"executor drafts: failed save retains draft and project/storage refusal leaves selection untouched",
	opts,
	async (t) => {
		const { b } = await fixture(t);
		await setPermission(b, "safe");
		await b.evaluate(() => {
			const original = window.fetch;
			window.fetch = (url, options) =>
				options?.method === "PUT"
					? Promise.reject(Error("fixture network failure"))
					: original(url, options);
			document
				.querySelector(
					'[data-executor-permissions="codex"] [data-save-permissions]',
				)
				.click();
		});
		await b.waitFor(() =>
			document
				.querySelector('[data-executor-permissions="codex"] [role="alert"]')
				?.textContent.includes("fixture network failure"),
		);
		assert.equal(await dirty(b), true);
		await policy(b, false);
		const before = await b.evaluate(() => ({
			href: location.href,
			project: document.querySelector('[aria-label="Project"]').value,
			storage: localStorage.getItem("agent-workflow:project"),
		}));
		await b.evaluate(() => {
			const c = document.querySelector('[aria-label="Project"]');
			c.value = "all";
			c.dispatchEvent(new Event("change", { bubbles: true }));
		});
		assert.deepEqual(
			await b.evaluate(() => ({
				href: location.href,
				project: document.querySelector('[aria-label="Project"]').value,
				storage: localStorage.getItem("agent-workflow:project"),
			})),
			before,
		);
		assert.equal(await value(b), "safe");
	},
);

for (const during of ["late", "undo", "leave", "failure"])
	test(
		`executor drafts: Save response protects intervening edits (${during})`,
		opts,
		async (t) => {
			const p = await fixture(t),
				{ b } = p;
			await setPermission(b, "safe");
			await b.evaluate((failure) => {
				const original = window.fetch;
				window.fetch = async (...args) => {
					const response = await original(...args);
					if (
						String(args[0]) === "/api/profiles/codex" &&
						args[1]?.method === "PUT"
					) {
						window.heldResponse = response.status;
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
				document
					.querySelector(
						'[data-executor-permissions="codex"] [data-save-permissions]',
					)
					.click();
			}, during === "failure");
			await b.waitFor(() => window.heldResponse === 200);
			await setPermission(b, "free");
			if (during === "undo") await setPermission(b, "safe");
			if (during === "leave") {
				await policy(b, true);
				// Replace the page in-document through the existing Refresh, which intentionally discards drafts.
				await b.evaluate(() =>
					[...document.querySelectorAll("button")]
						.find((n) => n.textContent === "Refresh")
						.click(),
				);
				await b.waitFor(
					() =>
						document.querySelector('[aria-label="codex permission mode"]')
							?.value === "safe",
				);
			}
			await b.evaluate(() => window.releaseSave());
			if (during === "failure") {
				await b.waitFor(() =>
					document
						.querySelector('[data-executor-permissions="codex"] [role="alert"]')
						?.textContent.includes("isolated response failure"),
				);
				assert.equal(await value(b), "free");
				assert.equal(await dirty(b), true);
			} else if (during === "leave") {
				await b.waitFor(
					() =>
						!document.querySelector(
							'[data-executor-permissions="codex"] [data-save-permissions]',
						).disabled,
				);
				assert.equal(
					await b.evaluate(
						() =>
							document.querySelectorAll(
								'[data-executor-permissions="codex"] [role="status"]',
							).length,
					),
					0,
				);
				assert.equal(await dirty(b), false);
			} else {
				await b.waitFor(() =>
					document
						.querySelector(
							'[data-executor-permissions="codex"] [role="status"]',
						)
						?.textContent.startsWith("Saved."),
				);
				assert.equal(await value(b), during === "late" ? "free" : "safe");
				assert.equal(await dirty(b), during === "late");
				if (during === "late") {
					await setPermission(b, "safe");
					assert.equal(await dirty(b), false);
				}
			}
			assert.equal((await storedProfile(p)).permissionMode, "safe");
		},
	);

test(
	"executor drafts: row saves/discards are independent and Refresh refuses draft loss",
	opts,
	async (t) => {
		const { b } = await fixture(t);
		await setPermission(b, "safe");
		await setPermission(b, "free", "pi");
		await savePermissions(b);
		assert.equal(await dirty(b), true);
		await policy(b, false);
		await b.evaluate(() =>
			[...document.querySelectorAll("button")]
				.find((n) => n.textContent === "Refresh")
				.click(),
		);
		await b.waitFor(() => window.guardCalls === 1);
		assert.equal(
			await b.evaluate(
				() => document.querySelector('[aria-label="pi permission mode"]').value,
			),
			"free",
		);
		await b.evaluate(() =>
			document
				.querySelector(
					'[data-executor-permissions="pi"] [data-discard-permissions]',
				)
				.click(),
		);
		assert.equal(await dirty(b), false);
	},
);

test(
	"executor drafts: sidebar same-tab departure uses one native app confirmation",
	opts,
	async (t) => {
		const { b } = await fixture(t);
		await setPermission(b, "safe");
		const before = await b.send("Page.getNavigationHistory");
		await dialog(b, () => b.click(workflowLink), false, "confirm");
		assert.equal(await value(b), "safe");
		assert.deepEqual(await b.send("Page.getNavigationHistory"), before);
		await dialog(b, () => b.click(workflowLink), true, "confirm");
		await b.waitFor(
			() => document.querySelector("h1")?.textContent === "Workflows",
		);
		assert.deepEqual(b.errors, []);
	},
);

test(
	"workflow page opening has no Check form and registers no settings draft",
	opts,
	async (t) => {
		const p = await fixture(t);
		await p.b.send("Page.navigate", {
			url:
				p.url.replace("view=executors", "view=workflows") +
				"&workflow=model-flow",
		});
		await p.b.waitFor(
			() => !!document.querySelector(".project-workflow-actions"),
		);
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelectorAll(
						'[data-management-action="check"], [aria-label="Check profile"]',
					).length,
			),
			0,
		);
		assert.equal(await dirty(p.b), false);
	},
);

test(
	"executor drafts: delegated links preserve native exceptions and quiet clean navigation",
	opts,
	async (t) => {
		const { b } = await fixture(t);
		await setPermission(b, "safe");
		await policy(b, false);
		const before = await b.send("Page.getNavigationHistory");
		const result = await b.evaluate(() => {
			const link = document.querySelector(
				'.management-nav a[href*="view=workflows"]',
			);
			const href = link.getAttribute("href"),
				outcomes = [];
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
		assert.equal(await value(b), "safe");
		assert.deepEqual(await b.send("Page.getNavigationHistory"), before);
		await setPermission(b, "");
		await b.click(workflowLink);
		await b.waitFor(
			() => document.querySelector("h1")?.textContent === "Workflows",
		);
		assert.equal(await b.evaluate(() => window.guardCalls), undefined);
	},
);

test(
	"executor drafts: Refresh failure and intervening edits keep guards registered",
	opts,
	async (t) => {
		const { b } = await fixture(t);
		await setPermission(b, "safe");
		await policy(b, true);
		await b.evaluate(() => {
			const original = window.fetch;
			window.fetch = (path, options) =>
				String(path).startsWith("/api/doctor?refresh")
					? Promise.reject(Error("fixture refresh failure"))
					: original(path, options);
			[...document.querySelectorAll("button")]
				.find((n) => n.textContent === "Refresh")
				.click();
		});
		await b.waitFor(() =>
			document
				.querySelector('.page-actions [role="alert"]')
				?.textContent.includes("fixture refresh failure"),
		);
		assert.equal(await dirty(b), true);
		assert.equal(await value(b), "safe");
		await b.evaluate(() => {
			const original = window.fetch;
			window.fetch = async (path, options) => {
				if (String(path).startsWith("/api/doctor?refresh")) {
					const response = await original("/api/doctor", options);
					window.heldRefresh = true;
					await new Promise((resolve) => {
						window.releaseRefresh = resolve;
					});
					return response;
				}
				return original(path, options);
			};
			[...document.querySelectorAll("button")]
				.find((n) => n.textContent === "Refresh")
				.click();
		});
		await b.waitFor(() => window.heldRefresh);
		await setPermission(b, "free");
		await b.evaluate(() => window.releaseRefresh());
		await b.waitFor(() =>
			document
				.querySelector('.page-actions [role="status"]')
				?.textContent.includes("Settings changed during refresh"),
		);
		assert.equal(await value(b), "free");
		assert.equal(await dirty(b), true);
		await savePermissions(b);
		assert.equal(await dirty(b), false);
	},
);

test("settings drafts: pending nextEvent settles on browser close", {
	timeout: 15000,
}, async () => {
	const b = await createBrowser(await findChrome());
	const pending = b.nextEvent("Never.emitted", 10000).then(
		() => "resolved",
		() => "rejected",
	);
	await b.close();
	assert.equal(await pending, "rejected");
	await assert.rejects(b.nextEvent("After.close"), /Browser closed/);
});
