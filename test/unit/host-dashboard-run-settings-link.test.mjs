// test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDashboardManagement } from "../../dist/hosts/dashboard/management.js";
import { projectWorkflowSettingsPath } from "../../dist/hosts/project-workflow-settings.js";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";

const link = (p, id, suffix = "") =>
	p.http(`${p.base}/runs/${id}/workflow-settings-target${suffix}`);
const catalog = async (p) =>
	(await p.http(`${p.base}/workflows`)).data.data.workflows;
const configuration = (entry) => ({
	schema: "agent-workflow-configuration-v1",
	capture: {
		key: entry.workflowKey,
		identity: entry.identity,
		storeEpoch: "recorded-epoch",
		revision: "recorded-revision",
		definitionFingerprint: "recorded-fingerprint",
		intent: {
			defaults: { executor: "nonexistent-recorded", model: "old-model" },
		},
		privateNote: "capture-secret",
	},
	slots: {},
	shadowed: [],
});
async function duplicate(p) {
	const file = join(p.cwd, ".agent-workflow/workflows/manage.json");
	await mkdir(join(p.cwd, ".agent-workflow/workflows/manage"));
	await writeFile(
		join(p.cwd, ".agent-workflow/workflows/manage/spec.json"),
		await readFile(file),
	);
	const entries = (await catalog(p)).filter((entry) => entry.name === "manage");
	assert.equal(entries.length, 2);
	assert.notEqual(entries[0].workflowKey, entries[1].workflowKey);
	return entries;
}
function assertTarget(response, id, key) {
	assert.equal(response.status, 200, JSON.stringify(response.data));
	assert.deepEqual(response.data, { runId: id, target: { workflowKey: key } });
}
function assertUnavailable(response, reason) {
	assert.equal(response.status, 200, JSON.stringify(response.data));
	assert.deepEqual(Object.keys(response.data).sort(), [
		"reason",
		"runId",
		"target",
	]);
	assert.equal(response.data.target, null);
	assert.equal(response.data.reason, reason);
}

test("captured identity selects exact current source despite duplicate names, legacy path and invalid current settings", async (t) => {
	const p = await managementProject(t);
	const entries = await duplicate(p);
	const selected = entries.find((entry) =>
		entry.specPath.endsWith("/spec.json"),
	);
	assert.ok(selected);
	const id = "workflow_captured";
	const stored = await persistManagementRun(p.cwd, id, "completed", {
		name: "a different display name",
		specPath: "/never/read/arbitrary-recorded-secret.json",
		configuration: configuration(selected),
	});
	const original = await readFile(join(stored.dir, "run.json"), "utf8");
	// The lookup must not read/recompute current local settings or compile/probe the captured intent.
	const settings = projectWorkflowSettingsPath(p.cwd, { env: p.env });
	await mkdir(join(settings, ".."), { recursive: true });
	await writeFile(settings, "malformed current settings sentinel");
	assertTarget(await link(p, id), id, selected.workflowKey);
	assert.equal(await p.probeCount(), 0);
	assert.equal(existsSync(p.effects), false);
	assert.equal(await readFile(join(stored.dir, "run.json"), "utf8"), original);
	assert.equal(
		await readFile(settings, "utf8"),
		"malformed current settings sentinel",
	);
	// Definition content can change: the link means current settings for the same source, not historical values.
	const source = resolve(p.cwd, selected.specPath);
	const spec = JSON.parse(await readFile(source, "utf8"));
	spec.description = "changed after the run";
	await writeFile(source, JSON.stringify(spec));
	assertTarget(await link(p, id), id, selected.workflowKey);
	await rm(source);
	assertUnavailable(await link(p, id), "definition-unmatched");
});

test("no-local legacy run uses recorded source, not workflow name or alias winner", async (t) => {
	const p = await managementProject(t);
	const entries = await duplicate(p);
	for (const [i, entry] of entries.entries()) {
		const id = `workflow_legacy_${i}`;
		await persistManagementRun(p.cwd, id, "completed", {
			name: entries[1 - i].name,
			specPath: resolve(p.cwd, entry.specPath),
		});
		assertTarget(await link(p, id), id, entry.workflowKey);
	}
	const entry = entries[0];
	await persistManagementRun(p.cwd, "workflow_relative", "completed", {
		name: "not the alias",
		specPath: entry.specPath,
	});
	assertTarget(
		await link(p, "workflow_relative"),
		"workflow_relative",
		entry.workflowKey,
	);
	await persistManagementRun(p.cwd, "workflow_name_only", "completed", {
		name: "manage",
		specPath: "",
	});
	assertUnavailable(
		await link(p, "workflow_name_only"),
		"recorded-source-missing",
	);
	for (const specPath of [
		"manage",
		"/tmp/private-never-read-secret",
		"does-not-exist.json",
	]) {
		await persistManagementRun(p.cwd, "workflow_unmatched", "completed", {
			name: "manage",
			specPath,
		});
		const response = await link(p, "workflow_unmatched");
		assertUnavailable(response, "definition-unmatched");
		assert.doesNotMatch(
			JSON.stringify(response.data),
			/secret|specPath|capture|identity/,
		);
	}
	assert.equal(await p.probeCount(), 0);
	assert.equal(existsSync(p.effects), false);
});

test("legacy lookup does not depend on an unrelated startup root still existing", async (t) => {
	const p = await managementProject(t);
	const entry = (await catalog(p)).find((row) => row.name === "manage");
	const id = "workflow_other_project";
	await persistManagementRun(p.cwd, id, "completed", {
		specPath: resolve(p.cwd, entry.specPath),
	});
	const path = `${p.base}/runs/${id}/workflow-settings-target`;
	const management = createDashboardManagement({
		context: { ...p.ctx, cwd: join(p.cwd, "missing-startup-root") },
		now: Date.now,
		project: async (projectId) => {
			assert.equal(projectId, p.server.projectId);
			return p.ctx;
		},
		body: async () => {
			throw new Error("readonly lookup must not read a body");
		},
	});
	const response = await management(
		{ method: "GET" },
		new URL(path, p.origin),
		path.split("/").slice(1),
	);
	assert.equal(response.status, 200, JSON.stringify(response.value));
	assert.deepEqual(response.value, {
		runId: id,
		target: { workflowKey: entry.workflowKey },
	});
	assert.equal(await p.probeCount(), 0);
	assert.equal(existsSync(p.effects), false);
});

test("capture mismatches never fall back to an otherwise matching source or name", async (t) => {
	const p = await managementProject(t);
	const entry = (await catalog(p)).find((entry) => entry.name === "manage");
	for (const [capture, reason] of [
		[
			{ ...configuration(entry).capture, key: "0".repeat(64) },
			"definition-unmatched",
		],
		[
			{
				...configuration(entry).capture,
				identity: { scope: "project-private", relativeSpec: "different.json" },
			},
			"definition-unmatched",
		],
		[{ key: entry.workflowKey }, "recorded-identity-insufficient"],
		[{ identity: entry.identity }, "recorded-identity-insufficient"],
		[
			{ ...configuration(entry).capture, key: { toString: null } },
			"recorded-identity-insufficient",
		],
		[null, "recorded-identity-insufficient"],
	]) {
		await persistManagementRun(p.cwd, "workflow_mismatch", "completed", {
			name: "manage",
			specPath: resolve(p.cwd, entry.specPath),
			configuration: { ...configuration(entry), capture },
		});
		assertUnavailable(await link(p, "workflow_mismatch"), reason);
	}
});

test("multiple discovered source aliases are explicitly ambiguous rather than choosing the first", async (t) => {
	const p = await managementProject(t);
	const entry = (await catalog(p)).find((entry) => entry.name === "manage");
	const source = resolve(p.cwd, entry.specPath);
	await mkdir(join(p.cwd, ".agent-workflow/workflows/another"));
	await symlink(
		source,
		join(p.cwd, ".agent-workflow/workflows/another/spec.json"),
	);
	const rows = (await catalog(p)).filter(
		(row) =>
			resolve(p.cwd, row.specPath) === source ||
			row.specPath.endsWith("another/spec.json"),
	);
	assert.equal(
		rows.length,
		2,
		"fixture has two catalog definitions for the physical source",
	);
	await persistManagementRun(p.cwd, "workflow_ambiguous", "completed", {
		specPath: source,
	});
	assertUnavailable(
		await link(p, "workflow_ambiguous"),
		"definition-ambiguous",
	);
	await persistManagementRun(p.cwd, "workflow_ambiguous_capture", "completed", {
		configuration: configuration(entry),
	});
	assertUnavailable(
		await link(p, "workflow_ambiguous_capture"),
		"definition-ambiguous",
	);
});

test("lookup requires an exact valid project Run id, accepts readonly GET and rejects client authority", async (t) => {
	const p = await managementProject(t);
	const entry = (await catalog(p)).find((entry) => entry.name === "manage");
	const id = "workflow_exact_long_id";
	const stored = await persistManagementRun(p.cwd, id, "running", {
		specPath: resolve(p.cwd, entry.specPath),
	});
	const original = await readFile(join(stored.dir, "run.json"), "utf8");
	assertTarget(await link(p, id), id, entry.workflowKey);
	for (const missing of ["workflow_exact", "workflow_missing"]) {
		const response = await link(p, missing);
		assert.equal(response.status, 404, JSON.stringify(response.data));
		assert.doesNotMatch(
			JSON.stringify(response.data),
			/specPath|capture|run.json/,
		);
	}
	for (const invalid of [
		"invalid",
		"workflow_bad%2Fpath",
		"workflow_bad%5Cpath",
		"workflow_bad%00",
	])
		assert.equal((await link(p, invalid)).status, 400, invalid);
	for (const query of [
		"?path=/tmp/private",
		"?name=manage",
		"?workflowKey=" + entry.workflowKey,
	])
		assert.equal((await link(p, id, query)).status, 400);
	for (const method of ["POST", "PUT", "DELETE", "PATCH"])
		assert.equal(
			(
				await p.http(`${p.base}/runs/${id}/workflow-settings-target`, {
					method,
					body: { path: entry.specPath },
				})
			).status,
			405,
		);
	assert.equal(
		(
			await p.http(
				`/api/projects/unknown-000000000000/runs/${id}/workflow-settings-target`,
			)
		).status,
		404,
	);
	const foreignCwd = join(p.cwd, "other-project");
	await mkdir(foreignCwd);
	await persistManagementRun(foreignCwd, "workflow_foreign", "completed", {
		specPath: resolve(p.cwd, entry.specPath),
	});
	assert.equal((await link(p, "workflow_foreign")).status, 404);
	const ro = await p.start({ env: p.env, readonly: true });
	const response = await fetch(
		`${new URL(ro.url).origin}${p.base}/runs/${id}/workflow-settings-target`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		runId: id,
		target: { workflowKey: entry.workflowKey },
	});
	assert.equal(await readFile(join(stored.dir, "run.json"), "utf8"), original);
	assert.equal(await p.probeCount(), 0);
	assert.equal(existsSync(p.effects), false);
});
