// test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
import { projectWorkflowSettingsPath } from "../../dist/hosts/project-workflow-settings.js";
import { projectCapturedConfiguration } from "../../dist/hosts/dashboard/projection.js";
const tokens = ({
	storeEpoch,
	revision,
	definitionFingerprint,
	resolutionToken,
}) => ({ storeEpoch, revision, definitionFingerprint, resolutionToken });
async function route(p, name = "manage") {
	const catalog = await p.http(`${p.base}/workflows`);
	const entry = catalog.data.data.workflows.find(
		(entry) => entry.name === name,
	);
	assert.match(entry.workflowKey, /^[a-f0-9]{64}$/);
	return `${p.base}/workflows/${entry.workflowKey}/settings`;
}
const draft = {
	defaults: {
		executor: "management-fake",
		model: "fixture-model",
		effort: "high",
	},
};

test("canonical settings GET/preview/check/complete-intent PUT and CAS conflicts", async (t) => {
	const p = await managementProject(t);
	const path = await route(p);
	const before = await p.http(path);
	assert.equal(before.status, 200);
	const expected = tokens(before.data.settings);
	assert.equal(before.data.settings.present, false);
	const probes = await p.probeCount();
	await p.http(path);
	assert.equal(await p.probeCount(), probes, "GET never probes");
	const file = projectWorkflowSettingsPath(p.cwd, { env: p.env });
	assert.equal(existsSync(file), false);
	for (const op of ["preview", "check"]) {
		const preview = await p.http(`${path}/${op}`, {
			method: "POST",
			body: { expected, intent: draft },
		});
		assert.equal(preview.status, 200, JSON.stringify(preview.data));
		assert.equal(
			preview.data.check.data.configuration.slots.read.model.value,
			"fixture-model",
		);
		assert.equal(
			preview.data.check.data.configuration.slots.read.model.source,
			"project-default",
		);
		assert.equal(existsSync(file), false);
	}
	assert.equal(existsSync(p.effects), false);
	assert.deepEqual((await p.http(`${p.base}/runs`)).data.runs, []);
	const saved = await p.http(path, {
		method: "PUT",
		body: { expected, intent: draft },
	});
	assert.equal(saved.status, 200, JSON.stringify(saved.data));
	const bytes = await readFile(file, "utf8");
	const stale = await p.http(path, {
		method: "PUT",
		body: { expected, intent: {} },
	});
	assert.equal(stale.status, 409);
	assert.equal(await readFile(file, "utf8"), bytes);
	for (const key of Object.keys(expected)) {
		const current = (await p.http(path)).data.settings;
		const conflict = await p.http(path, {
			method: "PUT",
			body: { intent: {}, expected: { ...tokens(current), [key]: "stale" } },
		});
		assert.equal(conflict.status, 409, key + JSON.stringify(conflict.data));
	}
});

test("HTTP registered-project/key authorization, spoofing and full method/security guards", async (t) => {
	const p = await managementProject(t);
	const path = await route(p);
	const expected = tokens((await p.http(path)).data.settings);
	for (const field of [
		"path",
		"identity",
		"editableSlots",
		"target",
		"env",
		"workflow",
	]) {
		const response = await p.http(path, {
			method: "PUT",
			body: { expected, intent: draft, [field]: "/tmp/spoof" },
		});
		assert.equal(response.status, 400, field);
	}
	for (const intent of [
		{ defaults: { model: "missing-binding" } },
		{ defaults: { executor: "management-fake", model: null } },
		{ slots: { unknown: { executor: "management-fake" } } },
	]) {
		const response = await p.http(path, {
			method: "PUT",
			body: { expected, intent },
		});
		assert.equal(response.status, 400, JSON.stringify(response.data));
	}
	assert.equal(
		(await p.http(`${p.base}/workflows/${"0".repeat(64)}/settings`)).status,
		404,
	);
	assert.equal(
		(await p.http(`${p.base}/workflows/manage/settings`)).status,
		404,
		"names cannot authorize settings",
	);
	assert.equal(
		(
			await p.http(
				`/api/projects/missing-${"0".repeat(12)}/workflows/${"0".repeat(64)}/settings`,
			)
		).status,
		404,
	);
	for (const [method, suffix] of [
		["PUT", ""],
		["POST", "/preview"],
		["POST", "/check"],
	]) {
		const body = { expected, intent: draft };
		assert.equal(
			(await p.http(path + suffix, { method, body, guarded: false })).status,
			403,
		);
		for (const headers of [
			{ Origin: "http://evil.invalid" },
			{ "X-AW-CSRF": "bad" },
			{ "Sec-Fetch-Site": "cross-site" },
		])
			assert.equal(
				(await p.http(path + suffix, { method, body, headers })).status,
				403,
			);
		assert.equal(
			(
				await p.http(path + suffix, {
					method,
					body,
					headers: { "Content-Type": "text/plain" },
				})
			).status,
			400,
		);
	}
	for (const [method, suffix] of [
		["POST", ""],
		["DELETE", ""],
		["PUT", "/preview"],
		["GET", "/check"],
	])
		assert.equal((await p.http(path + suffix, { method })).status, 405);
	assert.equal(existsSync(p.effects), false);
});

test("readonly allows settings reads but rejects PUT and preview/check POST", async (t) => {
	const p = await managementProject(t, { readonly: true });
	const path = await route(p);
	const read = await p.http(path);
	assert.equal(read.status, 200);
	for (const [method, suffix] of [
		["PUT", ""],
		["POST", "/preview"],
		["POST", "/check"],
	])
		assert.equal(
			(
				await p.http(path + suffix, {
					method,
					body: { expected: tokens(read.data.settings), intent: draft },
				})
			).status,
			403,
		);
});

test("authored hierarchy preserves topology and real dependencies without fictional dynamic leaves", async (t) => {
	const p = await managementProject(t);
	await profileGraphFixtures(p.cwd);
	const graph = (await p.http(`${p.base}/workflows/expanding-flow`)).data.graph;
	assert.equal(
		graph.authored.find((node) => node.id === "iterate").kind,
		"group",
	);
	assert.equal(
		graph.authored.find((node) => node.id === "iterate.check").parentId,
		"iterate",
	);
	assert.equal(
		graph.authored.find((node) => node.id === "adaptive").kind,
		"controller",
	);
	assert.deepEqual(
		graph.authored.find((node) => node.id === "adaptive").dependsOn,
		["iterate"],
	);
	assert.equal(
		graph.editableSlots.some((slot) => slot.id === "adaptive"),
		false,
	);
	assert.equal(
		graph.editableSlots.some((slot) => slot.id.startsWith("adaptive.$")),
		false,
	);
	const single = (await p.http(`${p.base}/workflows/model-flow`)).data.graph;
	assert.equal(
		single.authored.find((node) => node.id === "record").kind,
		"code",
	);
	assert.deepEqual(
		single.authored.find((node) => node.id === "combine").dependsOn,
		["verify-a", "verify-b"],
	);
	assert.ok(graph.tasks.some((task) => task.kind === "loop"));
	assert.equal(graph.templateTasks.length, 2);
	assert.deepEqual(
		graph.templateTasks.find((task) => task.stageId === "iterate.check")
			.dependsOn,
		["iterate.work"],
		"loop dependency is the actual compiled template order, not a dotted-id guess",
	);
});

test("captured projection is allowlisted, detached and has no current settings/capture paths", async () => {
	const configuration = {
		schema: "agent-workflow-configuration-v1",
		capture: { identity: { physicalSpecPath: "/secret" } },
		slots: {
			read: {
				executor: { value: "fake", source: "project-default" },
				model: {
					value: "then",
					source: "project-slot",
					originSlot: "read",
					secret: "hidden",
				},
				effort: {
					requested: "max",
					resolved: "high",
					reason: "clamped",
					source: "project-slot",
				},
			},
		},
		shadowed: [],
	};
	const projected = projectCapturedConfiguration(configuration);
	assert.equal(projected.slots.read.model.value, "then");
	assert.equal(projected.slots.read.effort.requested, "max");
	assert.equal(projected.slots.read.effort.resolved, "high");
	assert.doesNotMatch(
		JSON.stringify(projected),
		/secret|hidden|physicalSpecPath|capture/,
	);
	projected.slots.read.model.value = "mutated";
	assert.equal(configuration.slots.read.model.value, "then");
});

test("duplicate catalog names retain explicit selected source keys and isolate saves", async (t) => {
	const p = await managementProject(t);
	const spec = JSON.parse(
		await readFile(
			join(p.cwd, ".agent-workflow/workflows/manage.json"),
			"utf8",
		),
	);
	await mkdir(join(p.cwd, ".agent-workflow/workflows/manage"));
	await writeFile(
		join(p.cwd, ".agent-workflow/workflows/manage/spec.json"),
		JSON.stringify({ ...spec, description: "second source" }),
	);
	const catalog = (
		await p.http(`${p.base}/workflows`)
	).data.data.workflows.filter((entry) => entry.name === "manage");
	assert.equal(catalog.length, 2);
	assert.notEqual(catalog[0].workflowKey, catalog[1].workflowKey);
	const routes = catalog.map(
		(entry) => `${p.base}/workflows/${entry.workflowKey}/settings`,
	);
	const reads = await Promise.all(routes.map((path) => p.http(path)));
	for (const read of reads)
		assert.equal(read.status, 200, JSON.stringify(read.data));
	const save = await p.http(routes[1], {
		method: "PUT",
		body: { expected: tokens(reads[1].data.settings), intent: draft },
	});
	assert.equal(save.status, 200, JSON.stringify(save.data));
	assert.equal((await p.http(routes[0])).data.settings.present, false);
	assert.equal(
		(await p.http(routes[1])).data.settings.intent.defaults.model,
		"fixture-model",
	);
	assert.equal(
		(await p.http(routes[1].replace(/\/settings$/, ""))).status,
		200,
		"canonical key also selects detail",
	);
});

test("capability refusal preserves calculable configuration and does not forbid configuration save", async (t) => {
	const p = await managementProject(t);
	const path = await route(p);
	const expected = tokens((await p.http(path)).data.settings);
	const intent = {
		defaults: { executor: "management-offline", model: "manual-unknown" },
	};
	const preview = await p.http(`${path}/preview`, {
		method: "POST",
		body: { expected, intent },
	});
	assert.equal(preview.status, 200, JSON.stringify(preview.data));
	assert.equal(preview.data.check.outcome, "refused");
	assert.equal(preview.data.check.data.refusal.code, "EXECUTOR_NOT_INSTALLED");
	assert.equal(
		preview.data.check.data.configuration.slots.read.model.value,
		"manual-unknown",
	);
	assert.equal(
		preview.data.check.data.configuration.slots.read.model.source,
		"project-default",
	);
	const saved = await p.http(path, {
		method: "PUT",
		body: { expected, intent },
	});
	assert.equal(saved.status, 200, JSON.stringify(saved.data));
	assert.equal(existsSync(p.effects), false);
});

test("dynamic editable templates bind to actual draft-effective controller executor", async (t) => {
	const p = await managementProject(t);
	const base = join(p.cwd, ".agent-workflow/workflows");
	await writeFile(
		join(base, "controller.mjs"),
		"export default async function run() { throw new Error('must not run'); }\n",
	);
	await writeFile(
		join(base, "dynamic-settings.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "dynamic-settings",
			defaults: { agent: "reader", tools: ["read"], readOnly: true },
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./controller.mjs",
							decisionLoop: {
								planner: { agent: "reader" },
								workerDefaults: { agent: "reader" },
							},
						},
					},
				],
			},
		}),
	);
	const path = await route(p, "dynamic-settings");
	const expected = tokens((await p.http(path)).data.settings);
	const intent = {
		defaults: { executor: "management-fake" },
		slots: {
			"adaptive.$workerDefaults": {
				executor: "management-fake",
				model: "fixture-model",
			},
		},
	};
	const preview = await p.http(`${path}/preview`, {
		method: "POST",
		body: { expected, intent },
	});
	assert.equal(preview.status, 200, JSON.stringify(preview.data));
	assert.equal(
		preview.data.editableSlots.find(
			(slot) => slot.id === "adaptive.$workerDefaults",
		).parentExecutor,
		"management-fake",
	);
	assert.equal(
		preview.data.editableSlots.some((slot) => slot.id === "adaptive"),
		false,
	);
	assert.equal(
		(await p.http(path, { method: "PUT", body: { expected, intent } })).status,
		200,
	);
	const fresh = tokens((await p.http(path)).data.settings);
	const invalid = { ...intent, defaults: { executor: "codex" } };
	assert.equal(
		(
			await p.http(path, {
				method: "PUT",
				body: { expected: fresh, intent: invalid },
			})
		).status,
		400,
	);
});

test("compile errors retain inspectable definition hierarchy and writable intent", async (t) => {
	const p = await managementProject(t);
	const file = join(p.cwd, ".agent-workflow/workflows/manage.json");
	const spec = JSON.parse(await readFile(file, "utf8"));
	spec.artifactGraph.stages[0].agent = "missing-agent";
	await writeFile(file, JSON.stringify(spec));
	const detail = await p.http(`${p.base}/workflows/manage`);
	assert.equal(detail.status, 200, JSON.stringify(detail.data));
	assert.match(detail.data.graph.error, /agent|missing/i);
	assert.ok(detail.data.graph.authored.some((node) => node.id === "read"));
	const settings = await p.http(await route(p));
	assert.equal(settings.status, 200);
	assert.deepEqual(settings.data.settings.intent, {});
});

test("known model incompatibility is refused without changing the store, empty reset needs no usable baseline", async (t) => {
	const p = await managementProject(t);
	const path = await route(p);
	const expected = tokens((await p.http(path)).data.settings);
	const invalid = await p.http(path, {
		method: "PUT",
		body: {
			expected,
			intent: {
				defaults: {
					executor: "management-fake",
					model: "not-in-complete-inventory",
				},
			},
		},
	});
	assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
	assert.equal(
		existsSync(projectWorkflowSettingsPath(p.cwd, { env: p.env })),
		false,
	);
	const saved = await p.http(path, {
		method: "PUT",
		body: { expected, intent: draft },
	});
	assert.equal(saved.status, 200);
	const specPath = join(p.cwd, ".agent-workflow/workflows/manage.json");
	const spec = JSON.parse(await readFile(specPath, "utf8"));
	spec.artifactGraph.stages[0].agent = "missing-after-save";
	await writeFile(specPath, JSON.stringify(spec));
	const read = await p.http(path);
	assert.equal(read.status, 200);
	const reset = await p.http(path, {
		method: "PUT",
		body: { expected: tokens(read.data.settings), intent: {} },
	});
	assert.equal(reset.status, 200, JSON.stringify(reset.data));
	assert.deepEqual((await p.http(path)).data.settings.intent, {});
});

test("actual alias winner drift yields resolution conflict for a still-discovered explicit source", async (t) => {
	const p = await managementProject(t);
	const path = await route(p);
	const expected = tokens((await p.http(path)).data.settings);
	await mkdir(join(p.cwd, "workflows/manage.json"), { recursive: true });
	const spec = JSON.parse(
		await readFile(
			join(p.cwd, ".agent-workflow/workflows/manage.json"),
			"utf8",
		),
	);
	await writeFile(
		join(p.cwd, "workflows/manage.json/spec.json"),
		JSON.stringify(spec),
	);
	const latest = await p.http(path);
	assert.equal(latest.status, 200, JSON.stringify(latest.data));
	assert.notEqual(
		latest.data.settings.resolutionToken,
		expected.resolutionToken,
	);
	const conflict = await p.http(path, {
		method: "PUT",
		body: { expected, intent: draft },
	});
	assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
	assert.equal(
		existsSync(projectWorkflowSettingsPath(p.cwd, { env: p.env })),
		false,
	);
});
