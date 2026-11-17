// test-tier: integration
// E1–E3: the removed Profiles page redirects; executor permissions retain store semantics.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { userProfilesPath } from "../../dist/hosts/user-profiles.js";
import { LEVEL_CAPABILITY_NAMES } from "../../dist/sdk/capabilities.js";
import { profileAction } from "../../dist/hosts/catalog.js";
import {
	executorsFixture,
	loadExecutors,
	setPermission,
	toggleCapability,
	savePermissions,
	seedProfile,
	storedProfile,
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
	"E2 executor rows offer Automatic/Free/Safe and known strict checkboxes under Advanced; P4 retention",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		const values = {
			executor: "claude",
			model: "manual/unlisted",
			effort: "ultra",
			permissionMode: "safe",
			strictCapabilities: ["readOnly"],
			roles: {
				verification: {
					executor: "claude",
					model: "manual/role",
					effort: "max",
				},
				"agent:future": { model: "unmapped" },
			},
		};
		await seedProfile(p, values);
		await p.b.send("Page.addScriptToEvaluateOnNewDocument", {
			source: `window.permissionWrites=[];const original=window.fetch;window.fetch=(path,options={})=>{if(options.method==='PUT'&&String(path).includes('/api/profiles/'))window.permissionWrites.push(JSON.parse(options.body));return original(path,options);};`,
		});
		await loadExecutors(p);
		assert.deepEqual(
			await p.b.evaluate(() =>
				[...document.querySelectorAll("[data-executor-permissions]")]
					.map((n) => n.dataset.executorPermissions)
					.sort(),
			),
			["antigravity", "claude", "codex", "pi"],
		);
		assert.deepEqual(
			await p.b.evaluate(() => {
				const row = document.querySelector(
					'[data-executor-permissions="codex"]',
				);
				return {
					options: [...row.querySelectorAll("select option")].map((n) => [
						n.value,
						n.textContent,
					]),
					folded: !row.querySelector("details").open,
					advanced: row.querySelector("summary").textContent,
					capabilities: [...row.querySelectorAll('input[type="checkbox"]')].map(
						(n) => n.value,
					),
					textInputs: row.querySelectorAll('input:not([type="checkbox"])')
						.length,
				};
			}),
			{
				options: [
					["", "Automatic"],
					["free", "Free"],
					["safe", "Safe"],
				],
				folded: true,
				advanced: "Advanced",
				capabilities: [...LEVEL_CAPABILITY_NAMES],
				textInputs: 0,
			},
		);
		await setPermission(p.b, "free");
		await savePermissions(p.b);
		assert.deepEqual(await p.b.evaluate(() => window.permissionWrites), [
			{
				values: { permissionMode: "free", strictCapabilities: ["readOnly"] },
				unset: [],
			},
		]);
		const after = await storedProfile(p);
		for (const key of ["executor", "model", "effort", "roles"])
			assert.equal(
				JSON.stringify(after[key]),
				JSON.stringify(values[key]),
				key,
			);
		assert.equal(after.permissionMode, "free");
		await setPermission(p.b, "");
		await toggleCapability(p.b, "readOnly");
		await savePermissions(p.b);
		const cleared = await storedProfile(p);
		assert.equal(cleared.permissionMode, undefined);
		assert.equal(cleared.strictCapabilities, undefined);
		for (const key of ["executor", "model", "effort", "roles"])
			assert.equal(
				JSON.stringify(cleared[key]),
				JSON.stringify(values[key]),
				key,
			);
		await toggleCapability(p.b, "contextIsolation");
		await savePermissions(p.b);
		assert.deepEqual((await storedProfile(p)).strictCapabilities, [
			"contextIsolation",
		]);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"E3 named profiles and their management controls disappear without changing saved bytes or default",
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
		await setPermission(p.b, "safe");
		await savePermissions(p.b);
		const before = JSON.parse(original),
			after = JSON.parse(await readFile(path, "utf8"));
		assert.equal(
			JSON.stringify(after.profiles.daily),
			JSON.stringify(before.profiles.daily),
		);
		assert.equal(after.default, before.default);
	},
);

test(
	"E2 readonly disables permission edits and saves but keeps Advanced and navigation available",
	opts,
	async (t) => {
		const p = await executorsFixture(t, { readonly: true });
		await loadExecutors(p);
		const state = await p.b.evaluate(() => ({
			rows: document.querySelectorAll("[data-executor-permissions]").length,
			disabled: [
				...document.querySelectorAll(
					"[data-executor-permissions] input, [data-executor-permissions] select, [data-save-permissions], [data-discard-permissions]",
				),
			].every((n) => n.disabled),
			nav: [
				...document.querySelectorAll('[aria-label="Shared settings"] a'),
			].map((n) => n.textContent),
		}));
		assert.deepEqual(state, { rows: 4, disabled: true, nav: ["Executors"] });
		await p.b.evaluate(() =>
			document.querySelector("[data-executor-permissions] summary").click(),
		);
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelector("[data-executor-permissions] details").open,
			),
			true,
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Executor permission Save retains dotted strict constraints authored elsewhere and never loads model/preference editors",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await seedProfile(p, {
			strictCapabilities: ["toolAllowlist.detail", "readOnly"],
		});
		await loadExecutors(p);
		await setPermission(p.b, "safe");
		await savePermissions(p.b);
		assert.deepEqual((await storedProfile(p)).strictCapabilities, [
			"toolAllowlist.detail",
			"readOnly",
		]);
		assert.ok(
			p.b.requests.every(
				(url) => !/\/api\/(executors\/models|workflow-preferences)/.test(url),
			),
		);
		assert.equal(
			await p.b.evaluate(() =>
				document
					.querySelector('[data-executor-permissions="codex"] details')
					.textContent.includes("Also required: toolAllowlist.detail"),
			),
			true,
		);
	},
);

test(
	"Existing unknown profile storage blocks permission editing and remains byte-identical",
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
		await p.b.send("Page.navigate", { url: p.url });
		await p.b.waitFor(() =>
			document
				.querySelector('.management-page [role="alert"]')
				?.textContent.includes('unknown field "futureOpaque"'),
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
