// test-tier: integration
// Retained permission editor feedback and layout now belong to Executors.
import assert from "node:assert/strict";
import test from "node:test";
import {
	executorsFixture,
	loadExecutors,
	setPermission,
	seedProfile,
	savePermissions,
} from "../helpers/dashboard-profiles.mjs";
const opts = { timeout: 60000 };

test(
	"Executors legacy deep links survive reload and Back/Forward without a Profiles page",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await loadExecutors(p);
		await loadExecutors(
			p,
			p.url.replace("view=executors", "view=profiles") +
				"&profile=missing&createProfile=1",
		);
		await p.b.waitFor(
			() => new URL(location.href).searchParams.get("view") === "executors",
		);
		await p.b.send("Page.reload");
		await p.b.waitFor(
			() => !!document.querySelector('[data-executor-permissions="codex"]'),
		);
		await p.b.evaluate(() => history.back());
		await p.b.waitFor(
			() => !!document.querySelector('[data-executor-permissions="codex"]'),
		);
		await p.b.evaluate(() => history.forward());
		await p.b.waitFor(() => document.title.startsWith("Executors"));
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelectorAll(
						".profiles-page, [data-profile-open], [data-profile-new]",
					).length,
			),
			0,
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Executor Save failure keeps the narrow draft and bounded, visible feedback",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await p.b.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await loadExecutors(p);
		await setPermission(p.b, "safe");
		await p.b.evaluate(() => {
			const original = window.fetch;
			window.fetch = (path, options) =>
				options?.method === "PUT"
					? Promise.resolve(
							new Response(
								JSON.stringify({
									error:
										"Long server failure: " + "unbroken-detail".repeat(200),
								}),
								{ status: 500 },
							),
						)
					: original(path, options);
			document
				.querySelector(
					'[data-executor-permissions="codex"] [data-save-permissions]',
				)
				.click();
		});
		await p.b.waitFor(() =>
			document
				.querySelector('[data-executor-permissions="codex"] [role="alert"]')
				?.textContent.startsWith("Long server failure"),
		);
		await p.b.evaluate(() =>
			document
				.querySelector(
					'[data-executor-permissions="codex"] .executor-permission-feedback',
				)
				.scrollIntoView({ block: "center", inline: "nearest" }),
		);
		assert.deepEqual(
			await p.b.evaluate(() => {
				const row = document.querySelector(
						'[data-executor-permissions="codex"]',
					),
					feedback = row.querySelector(".executor-permission-feedback"),
					r = feedback.getBoundingClientRect();
				return {
					visible: r.top >= 0 && r.bottom <= innerHeight,
					scrollable: feedback.scrollHeight > feedback.clientHeight,
					overflow: document.documentElement.scrollWidth > innerWidth,
					value: row.querySelector("select").value,
					saveEnabled: !row.querySelector("[data-save-permissions]").disabled,
				};
			}),
			{
				visible: true,
				scrollable: true,
				overflow: false,
				value: "safe",
				saveEnabled: true,
			},
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Executor permission controls, Save/Discard and Advanced checkboxes remain reachable at narrow and wide widths",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await seedProfile(p, {
			permissionMode: "safe",
			strictCapabilities: ["readOnly"],
		});
		for (const width of [390, 1600]) {
			await p.b.send("Emulation.setDeviceMetricsOverride", {
				width,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await loadExecutors(p);
			// Save/Discard appear once the row has unsaved changes.
			await setPermission(p.b, "free");
			for (const selector of [
				"select",
				"[data-save-permissions]",
				"[data-discard-permissions]",
				"summary",
			]) {
				const geometry = await p.b.evaluate((selector) => {
					const node = document
						.querySelector('[data-executor-permissions="codex"]')
						.querySelector(selector);
					node.scrollIntoView({ block: "center", inline: "center" });
					const r = node.getBoundingClientRect();
					return {
						visible:
							r.top >= 0 &&
							r.bottom <= innerHeight &&
							r.left >= 0 &&
							r.right <= innerWidth,
						covered: !node.contains(
							document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
						),
						overflow: document.documentElement.scrollWidth > innerWidth,
					};
				}, selector);
				assert.deepEqual(
					geometry,
					{ visible: true, covered: false, overflow: false },
					`${width} ${selector}`,
				);
			}
			await p.b.evaluate(() =>
				document
					.querySelector('[data-executor-permissions="codex"] summary')
					.click(),
			);
			assert.equal(
				await p.b.evaluate(() =>
					[
						...document.querySelectorAll(
							'[data-executor-permissions="codex"] input',
						),
					].every((n) => n.checkVisibility()),
				),
				true,
			);
			// Leave the row clean so the next width's reload is not an unsaved departure.
			await p.b.evaluate(() =>
				document
					.querySelector(
						'[data-executor-permissions="codex"] [data-discard-permissions]',
					)
					.click(),
			);
		}
		await setPermission(p.b, "free");
		await savePermissions(p.b);
		assert.deepEqual(p.b.errors, []);
	},
);
