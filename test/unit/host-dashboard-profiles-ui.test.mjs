// test-tier: integration
// Real Chrome/routes and isolated storage; no executor or model calls.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { userProfilesPath } from "../../dist/hosts/user-profiles.js";
import {
	profilesFixture,
	loadProfiles,
	editProfile,
	setProfileField,
	profileButton,
	saveProfile,
	storedProfile,
	seedProfile,
} from "../helpers/dashboard-profiles.mjs";
import {
	profileAction,
	workflowPreferenceAction,
} from "../../dist/hosts/catalog.js";

const opts = { timeout: 60000 };

test(
	"P1 Profiles deletes model, executor, effort, diagram, assignments and presets rather than folding them",
	opts,
	async (t) => {
		const p = await profilesFixture(t);
		await seedProfile(p, {
			executor: "codex",
			model: "manual/model",
			effort: "high",
			roles: { verification: { model: "role/model" } },
		});
		await loadProfiles(p);
		await editProfile(p.b);
		assert.deepEqual(
			await p.b.evaluate(() => ({
				removed: [
					...document.querySelectorAll(
						".profile-editor input, .profile-editor select",
					),
				]
					.map((n) => n.getAttribute("aria-label"))
					.filter((label) =>
						/Executor|Model|Effort|preset|scope|workflow/i.test(label),
					),
				diagrams: document.querySelectorAll(
					".profile-editor .graph, .role-inspector, .visual-role-editor, [data-profile-configure]",
				).length,
				buttons: [...document.querySelectorAll(".profile-editor button")]
					.map((n) => n.textContent)
					.filter((text) =>
						/preset|assignment|Model settings|Profile options/i.test(text),
					),
			})),
			{ removed: [], diagrams: 0, buttons: [] },
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"P2 Profiles has no workflow-specific settings or preference/catalog requests and does not change saved preferences",
	opts,
	async (t) => {
		const p = await profilesFixture(t);
		await workflowPreferenceAction(p.ctx, {
			op: "set",
			workflow: "manage",
			profile: "mixed",
			roles: { verification: { model: "untouched" } },
		});
		const before = await workflowPreferenceAction(p.ctx, {
			op: "show",
			workflow: "manage",
		});
		await p.b.send("Page.addScriptToEvaluateOnNewDocument", {
			source: `window.profileRequests=[];const original=window.fetch;window.fetch=(path,options)=>{window.profileRequests.push(String(path));return original(path,options);};`,
		});
		await loadProfiles(p);
		assert.deepEqual(
			await p.b.evaluate(() => ({
				panels: document.querySelectorAll(
					'.profile-preferences, [aria-label="Workflow to configure"], [aria-label="Workflow preferred profile"]',
				).length,
				wording: document
					.querySelector(".profiles-page")
					.textContent.includes("Workflow-specific settings"),
				requests: window.profileRequests.filter((path) =>
					/workflow-preferences|profiles\/presets|executors\/models|\/workflows/.test(
						path,
					),
				),
			})),
			{ panels: 0, wording: false, requests: [] },
		);
		assert.deepEqual(
			await workflowPreferenceAction(p.ctx, { op: "show", workflow: "manage" }),
			before,
		);
	},
);

test(
	"P3 Profiles presents only permission/strict settings, profile management and Save/Discard",
	opts,
	async (t) => {
		const p = await profilesFixture(t);
		await seedProfile(p, {
			executor: "codex",
			model: "do-not-summarize",
			effort: "low",
			permissionMode: "safe",
			strictCapabilities: ["readOnly"],
		});
		await loadProfiles(p);
		assert.deepEqual(
			await p.b.evaluate(() => ({
				intro: document.querySelector("h1 + p").textContent,
				summary: document.querySelector(
					'[data-profile-open="daily"] .profile-summary',
				).textContent,
			})),
			{
				intro: "Manage shared profile permissions and strict capabilities.",
				summary: "Permissions: safe, Strict: readOnly",
			},
		);
		await editProfile(p.b);
		assert.deepEqual(
			await p.b.evaluate(() =>
				[
					...document.querySelectorAll(
						".profile-editor input, .profile-editor select",
					),
				]
					.filter((n) => n.checkVisibility())
					.map((n) => n.getAttribute("aria-label")),
			),
			["Profile permission mode", "Strict capabilities (comma separated)"],
		);
		for (const label of [
			"Save profile",
			"Discard changes",
			"Use daily by default",
			"Delete daily",
		])
			assert.equal(
				await p.b.evaluate(
					(label) =>
						[...document.querySelectorAll(".profile-editor button")].some(
							(n) => n.textContent === label && n.checkVisibility(),
						),
					label,
				),
				true,
				label,
			);
	},
);

test(
	"P4 Profiles Save patches only visible fields and preserves supported hidden stored values; create invents no model settings",
	opts,
	async (t) => {
		const p = await profilesFixture(t);
		const values = {
			executor: "codex",
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
			source: `window.profileWrites=[];const original=window.fetch;window.fetch=async(path,options={})=>{if(options.method==='PUT'&&String(path).includes('/api/profiles/'))window.profileWrites.push(JSON.parse(options.body));const response=await original(path,options);if(String(path)==='/api/profiles'&&response.ok){const data=await response.json();data.data.profiles.forEach(p=>p.futureOpaque={raw:'  unchanged  ',nested:[1,false,null]});return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});}return response;};`,
		});
		await loadProfiles(p);
		await editProfile(p.b);
		// Native permission select remains visible; the baseline only exposes it behind Profile options.
		await p.b.evaluate(() => {
			const c = document.querySelector(
				'[aria-label="Profile permission mode"]',
			);
			c.value = "free";
			c.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await saveProfile(p.b);
		assert.deepEqual(await p.b.evaluate(() => window.profileWrites), [
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
		await editProfile(p.b);
		await setProfileField(p.b, "Profile permission mode", "");
		await setProfileField(p.b, "Strict capabilities (comma separated)", "");
		await saveProfile(p.b);
		const cleared = await storedProfile(p);
		assert.equal(cleared.permissionMode, undefined);
		assert.equal(cleared.strictCapabilities, undefined);
		for (const key of ["executor", "model", "effort", "roles"])
			assert.equal(
				JSON.stringify(cleared[key]),
				JSON.stringify(values[key]),
				key,
			);
		await p.b.click("[data-profile-new]");
		await p.b.waitFor(
			() => !!document.querySelector('[aria-label="Profile name"]'),
		);
		await setProfileField(p.b, "Profile name", "minimal");
		await saveProfile(p.b);
		const created = await storedProfile(p, "minimal");
		assert.deepEqual(Object.keys(created).sort(), ["name", "updatedAt"]);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Profiles create, default/clear, delete confirmation and restore built-in remain available",
	opts,
	async (t) => {
		const p = await profilesFixture(t);
		await seedProfile(p, { permissionMode: "safe" });
		await seedProfile(
			p,
			{ model: "saved-model", roles: { planning: { effort: "high" } } },
			"codex",
		);
		await loadProfiles(p);
		await editProfile(p.b);
		await profileButton(p.b, "Use daily by default");
		await p.b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		assert.equal(
			(await profileAction(p.ctx, { op: "list" })).data.default,
			"daily",
		);
		await editProfile(p.b);
		await profileButton(p.b, "Clear default");
		await p.b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		assert.equal(
			(await profileAction(p.ctx, { op: "list" })).data.default,
			undefined,
		);
		await editProfile(p.b);
		await profileButton(p.b, "Delete daily");
		await profileButton(p.b, "Keep profile");
		assert.ok(await storedProfile(p));
		await profileButton(p.b, "Delete daily");
		await profileButton(p.b, "Confirm");
		await p.b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		assert.equal(
			(await profileAction(p.ctx, { op: "list" })).data.profiles.some(
				(p) => p.name === "daily",
			),
			false,
		);
		await editProfile(p.b, "codex");
		await profileButton(p.b, "Restore built-in codex");
		await profileButton(p.b, "Confirm");
		await p.b.waitFor(
			() => !!document.querySelector(".profile-overview:not([hidden])"),
		);
		assert.equal(
			(await profileAction(p.ctx, { op: "list" })).data.profiles.length,
			0,
		);
		await editProfile(p.b, "codex");
		assert.equal(
			await p.b.evaluate(
				() => document.querySelectorAll(".profile-options").length,
			),
			0,
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Profiles readonly leaves navigation available and all retained mutation controls disabled",
	opts,
	async (t) => {
		const p = await profilesFixture(t, { readonly: true });
		await seedProfile(p, { permissionMode: "safe" });
		await loadProfiles(p);
		await editProfile(p.b);
		assert.deepEqual(
			await p.b.evaluate(() => ({
				fields: [
					...document.querySelectorAll(
						".profile-editor select, .profile-editor input",
					),
				]
					.filter((n) => n.checkVisibility())
					.map((n) => n.disabled),
				actions: [
					...document.querySelectorAll(
						'.profile-options button, [data-management-action="save-profile"]',
					),
				]
					.filter((n) => n.checkVisibility())
					.map((n) => n.disabled),
				back: document.querySelector("[data-profile-back]").disabled,
			})),
			{ fields: [true, true], actions: [true, true, true], back: false },
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"P4 boundary: the existing store rejects unknown fields without allowing UI Save or changing original bytes",
	opts,
	async (t) => {
		const p = await profilesFixture(t);
		await seedProfile(p, {
			executor: "codex",
			model: "manual/unlisted",
			effort: "ultra",
			roles: { verification: { model: "manual/role" } },
		});
		const path = userProfilesPath(p.env);
		const store = JSON.parse(await readFile(path, "utf8"));
		store.profiles.daily.futureOpaque = {
			raw: "  unchanged  ",
			nested: [1, false, null],
		};
		const original = JSON.stringify(store, null, 2) + "\n";
		await writeFile(path, original);
		await p.b.send("Page.navigate", { url: p.url + "&profile=daily" });
		await p.b.waitFor(
			() => !!document.querySelector('.management-page [role="alert"]'),
		);
		assert.match(
			await p.b.evaluate(
				() =>
					document.querySelector('.management-page [role="alert"]').textContent,
			),
			/unknown field "futureOpaque"/,
		);
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelectorAll('[data-management-action="save-profile"]')
						.length,
			),
			0,
		);
		assert.equal(await readFile(path, "utf8"), original);
	},
);
