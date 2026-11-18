// test-tier: integration
// X1–X4: Executors is observation-only; shared profile storage belongs to other hosts.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { userProfilesPath } from "../../dist/hosts/user-profiles.js";
import { profileAction } from "../../dist/hosts/catalog.js";
import {
	executorsFixture,
	loadExecutors,
	seedProfile,
} from "../helpers/dashboard-profiles.mjs";
const opts = { timeout: 60000 };

test(
	"E1 Shared settings contains only Executors and legacy Profiles links land there",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		for (const suffix of ["", "&profile=daily", "&createProfile=1"]) {
			await p.b.send("Page.navigate", {
				url: p.url.replace("view=executors", "view=profiles") + suffix,
			});
			await p.b.waitFor(() => !!document.querySelector(".management-page h1"));
			assert.deepEqual(
				await p.b.evaluate(() => ({
					title: document.querySelector("h1").textContent,
					links: [
						...document.querySelectorAll('[aria-label="Shared settings"] a'),
					].map((n) => n.textContent),
					profiles: document.querySelectorAll(
						'a[href*="view=profiles"], .profiles-page',
					).length,
					view: new URL(location.href).searchParams.get("view"),
					legacy: ["profile", "createProfile"].some((key) =>
						new URL(location.href).searchParams.has(key),
					),
				})),
				{
					title: "Executors",
					links: ["Executors"],
					profiles: 0,
					view: "executors",
					legacy: false,
				},
			);
		}
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"X1 Executors has status columns only, no permission editor or profile requests",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await loadExecutors(p);
		assert.deepEqual(
			await p.b.evaluate(() => ({
				headers: [...document.querySelectorAll(".executors th")].map(
					(n) => n.textContent,
				),
				rows: document.querySelectorAll(".executors tbody tr").length,
				controls: document.querySelectorAll(
					".executors select, .executors input, [data-executor-permissions], [data-save-permissions], [data-discard-permissions]",
				).length,
			})),
			{ headers: ["Executor", "Status", "Version"], rows: 4, controls: 0 },
		);
		assert.doesNotMatch(
			await p.b.evaluate(
				() => document.querySelector(".management-page").innerText,
			),
			/Strict capabilities|Advanced|\bSave\b|\bDiscard\b|Permission mode/,
		);
		await p.b.click('[data-management-action="doctor-refresh"]');
		await p.b.waitFor(
			() =>
				!document.querySelector('[data-management-action="doctor-refresh"]')
					.disabled,
		);
		assert.ok(
			p.b.requests.every(
				(url) =>
					!/\/api\/(profiles(?:[/?]|$)|executors\/models|workflow-preferences)/.test(
						url,
					),
			),
			JSON.stringify(p.b.requests),
		);
		assert.deepEqual(p.b.errors, []);
	},
);

for (const readonly of [false, true]) {
	for (const mode of ["free", "safe"]) {
		test(
			`X2 ${readonly ? "readonly" : "writable"} Executors shows one ${mode} fact from the doctor's effective default`,
			opts,
			async (t) => {
				const p = await executorsFixture(t, { readonly });
				await seedProfile(p, {
					permissionMode: mode === "free" ? "safe" : "free",
				});
				await seedProfile(p, { permissionMode: mode }, "daily");
				await profileAction(p.ctx, { op: "default", name: "daily" });
				await loadExecutors(p);
				const meaning =
					mode === "free"
						? "Free — workers run without approvals or sandbox"
						: "Safe — workers run sandboxed with approvals limited to their tools";
				assert.deepEqual(
					await p.b.evaluate(() =>
						[
							...document.querySelectorAll(
								'[data-testid="executor-permission-fact"]',
							),
						].map((n) => ({
							text: n.textContent,
							visible: n.checkVisibility(),
							aboveTable: Boolean(
								n.compareDocumentPosition(
									document.querySelector(".executors"),
								) & Node.DOCUMENT_POSITION_FOLLOWING,
							),
						})),
					),
					[
						{
							text: `Permissions: ${meaning}. Use --permission-mode safe to restrict.`,
							visible: true,
							aboveTable: true,
						},
					],
				);
				assert.deepEqual(
					await p.b.evaluate(() => ({
						defaults: [
							...document.querySelectorAll(".management-card h2"),
						].some((n) => n.textContent === "Defaults"),
						status: /Runs use pi unless you choose another executor\.$/.test(
							document.querySelector(".management-card .lead")?.textContent,
						),
					})),
					{ defaults: false, status: true },
					"no Defaults card; the Status line names the default executor",
				);
				assert.deepEqual(p.b.errors, []);
			},
		);
	}
}

test(
	"X2 Refresh replaces the effective permission fact without duplicating it",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await loadExecutors(p);
		await seedProfile(p, { permissionMode: "safe" }, "daily");
		await profileAction(p.ctx, { op: "default", name: "daily" });
		await p.b.click('[data-management-action="doctor-refresh"]');
		await p.b.waitFor(
			() =>
				!document.querySelector('[data-management-action="doctor-refresh"]')
					.disabled,
		);
		assert.deepEqual(
			await p.b.evaluate(() =>
				[
					...document.querySelectorAll(
						'[data-testid="executor-permission-fact"]',
					),
				].map((n) => n.textContent),
			),
			[
				"Permissions: Safe — workers run sandboxed with approvals limited to their tools. Use --permission-mode safe to restrict.",
			],
		);
	},
);

test(
	"E3 visiting and refreshing Executors leaves every saved profile byte and default unchanged",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await seedProfile(
			p,
			{
				executor: "codex",
				model: "manual/named",
				roles: { planning: { effort: "high" } },
			},
			"daily",
		);
		await seedProfile(p, {
			permissionMode: "safe",
			strictCapabilities: ["toolAllowlist.detail", "readOnly"],
		});
		await profileAction(p.ctx, { op: "default", name: "daily" });
		const path = userProfilesPath(p.env),
			original = await readFile(path, "utf8");
		await loadExecutors(p);
		assert.doesNotMatch(
			await p.b.evaluate(() => document.querySelector("#center").innerText),
			/Your profiles|New profile|Default profile|Use daily|Delete daily|Restore built-in|Set per executor in Profiles/,
		);
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelectorAll(
						"[data-profile-open], [data-profile-new], .profile-editor",
					).length,
			),
			0,
		);
		await p.b.click('[data-management-action="doctor-refresh"]');
		await p.b.waitFor(
			() =>
				!document.querySelector('[data-management-action="doctor-refresh"]')
					.disabled,
		);
		assert.equal(await readFile(path, "utf8"), original);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Unknown profile storage remains byte-identical and its doctor warning stays visible",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await seedProfile(p, {
			model: "manual/unlisted",
			roles: { verification: { model: "retained" } },
		});
		const path = userProfilesPath(p.env),
			store = JSON.parse(await readFile(path, "utf8"));
		store.profiles.codex.futureOpaque = {
			raw: "  unchanged  ",
			nested: [1, false, null],
		};
		const original = JSON.stringify(store, null, 2) + "\n";
		await writeFile(path, original);
		await loadExecutors(p);
		assert.match(
			await p.b.evaluate(
				() => document.querySelector(".management-page").innerText,
			),
			/unknown field "futureOpaque"/,
		);
		assert.equal(
			await p.b.evaluate(
				() => document.querySelectorAll("[data-save-permissions]").length,
			),
			0,
		);
		assert.equal(await readFile(path, "utf8"), original);
	},
);
