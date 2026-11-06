import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
import {
	profileAction,
	workflowPreferenceAction,
} from "../../dist/hosts/catalog.js";
import { acquireRunFileLease } from "../../dist/core/store.js";
import { dashboardCsrf } from "../../dist/hosts/dashboard/security.js";

const write = (method, body = {}) => ({ method, body });

test("management catalogs and check reuse host actions, never resolve request paths or start work", async (t) => {
	const p = await managementProject(t);
	const catalog = await p.http(`${p.base}/workflows`);
	assert.equal(catalog.status, 200);
	assert.ok(
		catalog.data.data.workflows.some((workflow) => workflow.name === "manage"),
	);
	// A same-name file in cwd must not shadow the server-discovered workflow definition.
	await writeFile(join(p.cwd, "manage"), "not a workflow");
	const detail = await p.http(`${p.base}/workflows/manage`);
	assert.equal(detail.status, 200, JSON.stringify(detail.data));
	assert.equal(detail.data.validation.data.valid, true);
	assert.equal(detail.data.validation.data.tasks, 1);
	assert.match(detail.data.spec.data.spec, /Management fixture/);
	assert.ok(Array.isArray(detail.data.roles.data.roles));
	const agents = await p.http(`${p.base}/agents`);
	assert.equal(agents.status, 200);
	assert.ok(agents.data.data.agents.some((agent) => agent.name === "reader"));
	const checked = await p.http(
		`${p.base}/workflows/manage/check`,
		write("POST", {
			executor: "management-fake",
			model: "fixture-model",
			effort: "low",
			permissionMode: "safe",
		}),
	);
	assert.equal(checked.status, 200, JSON.stringify(checked.data));
	assert.equal(checked.data.action, "check");
	assert.equal(checked.data.outcome, "success", checked.data.text);
	assert.ok(
		checked.data.data.capability.preview.startsWith("Capability check"),
	);
	assert.equal(checked.data.data.runId, undefined);
	assert.equal(
		existsSync(p.effects),
		false,
		"no submit, reconcile, artifact or model calls",
	);
	const runs = await p.http(`${p.base}/runs`);
	assert.deepEqual(runs.data.runs, [], "check creates no run");
	for (const suffix of ["workflows/missing", "workflows/missing/check"])
		assert.equal(
			(
				await p.http(
					`${p.base}/${suffix}`,
					suffix.endsWith("check") ? write("POST") : {},
				)
			).status,
			404,
		);
	for (const suffix of [
		"workflows/bad%2Fname",
		"workflows/%2Ehidden",
		"workflows/bad%5Cname",
		"workflows/bad%00name",
	])
		assert.equal((await p.http(`${p.base}/${suffix}`)).status, 400, suffix);
	for (const body of [
		{ executor: "../x" },
		{ executor: "unknown" },
		{ effort: "unbounded" },
		{ permissionMode: "unsafe" },
		{ profile: "../x" },
		{ detach: true },
		{ model: 123 },
	])
		assert.equal(
			(await p.http(`${p.base}/workflows/manage/check`, write("POST", body)))
				.status,
			400,
			JSON.stringify(body),
		);
});

test("profile API round trip equals profileAction show, including roles, presets, defaults, unset and delete", async (t) => {
	const p = await managementProject(t);
	assert.equal((await p.http("/api/profiles")).status, 200);
	const presets = await p.http("/api/profiles/presets");
	assert.equal(presets.status, 200);
	assert.ok(presets.data.data.presets.some((preset) => preset.id === "mixed"));
	const path = "/api/profiles/local";
	const saved = await p.http(
		path,
		write("PUT", {
			values: {
				executor: "management-fake",
				model: "fixture-model",
				effort: "low",
				permissionMode: "safe",
				roles: { verification: { executor: "codex", model: "fixture-model" } },
			},
			makeDefault: true,
		}),
	);
	assert.equal(saved.status, 200, JSON.stringify(saved.data));
	const shown = await profileAction(p.ctx, { op: "show", name: "local" });
	assert.deepEqual(saved.data.data.profile, shown.data.profile);
	assert.deepEqual((await p.http(path)).data, shown);
	assert.equal((await p.http("/api/profiles")).data.data.default, "local");
	assert.equal(
		(await p.http("/api/profiles-default", write("PUT", { name: null })))
			.status,
		200,
	);
	assert.equal((await p.http("/api/profiles")).data.data.default, undefined);
	assert.equal(
		(await p.http("/api/profiles-default", write("PUT", { name: "local" })))
			.status,
		200,
	);
	const update = await p.http(
		path,
		write("PUT", {
			unset: ["model", "roles.verification"],
			values: { effort: "high" },
		}),
	);
	assert.equal(update.status, 200);
	assert.equal(update.data.data.profile.model, undefined);
	assert.equal(update.data.data.profile.roles, undefined);
	const preset = await p.http(
		"/api/profiles/from-preset",
		write("PUT", { preset: "mixed" }),
	);
	assert.equal(preset.status, 200);
	assert.ok(preset.data.data.profile.roles);
	assert.equal((await p.http(path, write("DELETE"))).status, 200);
	assert.equal((await p.http(path)).status, 404);
	assert.equal((await p.http(path, write("DELETE"))).status, 404);
	for (const method of ["GET", "PUT", "DELETE"])
		assert.equal(
			(await p.http("/api/profiles/bad%2Fname", write(method))).status,
			400,
		);
	for (const body of [
		{ values: [] },
		{ values: { executor: "missing" } },
		{ values: { roles: { default: { executor: "../x" } } } },
		{ unset: [123] },
		{ makeDefault: "yes" },
		{ preset: 1 },
		{ values: { extra: true } },
		{ path: "/tmp/profiles" },
	])
		assert.equal(
			(await p.http(path, write("PUT", body))).status,
			400,
			JSON.stringify(body),
		);
	assert.equal(
		(await p.http("/api/profiles-default", write("PUT", { name: "../x" })))
			.status,
		400,
	);
});

test("workflow preferences resolve only registered project catalogs and share the user-level action store", async (t) => {
	const p = await managementProject(t);
	assert.equal((await p.http("/api/workflow-preferences")).status, 200);
	const path = `/api/workflow-preferences/manage?project=${p.server.projectId}`;
	assert.equal((await p.http(path)).status, 200);
	const saved = await p.http(
		path,
		write("PUT", {
			profile: "codex",
			roles: { verification: { executor: "claude", model: "fixture-model" } },
		}),
	);
	assert.equal(saved.status, 200, JSON.stringify(saved.data));
	const shown = await workflowPreferenceAction(p.ctx, {
		op: "show",
		workflow: "manage",
	});
	assert.deepEqual((await p.http(path)).data, shown);
	assert.equal(
		(await p.http(path, write("PUT", { unset: ["roles.verification"] })))
			.status,
		200,
	);
	assert.equal((await p.http(path, write("DELETE"))).status, 200);
	assert.equal((await p.http(path)).data.data.preference, undefined);
	assert.equal(
		(await p.http("/api/workflow-preferences/bad%2Fname")).status,
		400,
	);
	assert.equal(
		(
			await p.http(
				"/api/workflow-preferences/missing",
				write("PUT", { profile: "codex" }),
			)
		).status,
		404,
	);
	assert.equal(
		(await p.http(path, write("PUT", { profile: "missing" }))).status,
		400,
	);
	assert.equal((await p.http(path, write("PUT", { roles: [] }))).status, 400);
	assert.equal(
		(await p.http(path, write("PUT", { unset: [true] }))).status,
		400,
	);
	assert.equal(
		(
			await p.http(
				"/api/workflow-preferences/manage?project=unknown-000000000000",
			)
		).status,
		404,
	);
});

test("executor models are descriptor-validated; doctor caches 60 seconds and explicit refresh probes again", async (t) => {
	const p = await managementProject(t);
	const first = await p.http("/api/doctor");
	assert.equal(first.status, 200);
	assert.equal(first.data.action, "doctor");
	assert.equal(first.data.data.executors.length, 4);
	assert.equal(await p.probeCount(), 4);
	assert.deepEqual((await p.http("/api/doctor")).data, first.data);
	assert.equal(await p.probeCount(), 4);
	p.advance(59_999);
	assert.deepEqual((await p.http("/api/doctor")).data, first.data);
	assert.equal(await p.probeCount(), 4);
	const refresh = await p.http("/api/doctor?refresh=1");
	assert.equal(refresh.status, 200);
	assert.equal(
		await p.probeCount(),
		8,
		"Refresh invalidates both report and adapter probe caches",
	);
	p.advance(60_000);
	assert.equal((await p.http("/api/doctor")).status, 200);
	const models = await p.http("/api/executors/models?executor=management-fake");
	assert.equal(models.status, 200);
	assert.deepEqual(models.data.data.executors[0].models, ["fixture-model"]);
	assert.equal(models.data.data.executors[0].modelListComplete, true);
	assert.equal(
		(await p.http("/api/executors/models")).data.data.executors.length,
		3,
	);
	for (const id of ["bad%2Fid", "unknown", "%00"])
		assert.equal(
			(await p.http(`/api/executors/models?executor=${id}`)).status,
			400,
		);
	assert.equal((await p.http("/api/doctor?refresh=0")).status, 400);
	assert.equal(existsSync(p.effects), false);
});

test("prune digest mismatch deletes nothing, refreshes the preview, binds parameters and preserves protected runs", async (t) => {
	const p = await managementProject(t);
	const first = await persistManagementRun(p.cwd, "workflow_terminal");
	const active = await persistManagementRun(
		p.cwd,
		"workflow_active",
		"running",
	);
	const protectedRun = await persistManagementRun(p.cwd, "workflow_protected");
	const lease = await acquireRunFileLease(
		p.cwd,
		protectedRun.run.runId,
		"supervisor",
	);
	assert.ok(lease);
	t.after(() => lease.release());
	const path = `${p.base}/prune`;
	const preview = await p.http(`${path}/preview`, write("POST", { keep: 0 }));
	assert.equal(preview.status, 200, JSON.stringify(preview.data));
	assert.match(preview.data.digest, /^[a-f0-9]{64}$/);
	assert.ok(
		preview.data.data.runs.find((run) => run.runId === "workflow_terminal")
			?.selected,
	);
	assert.equal(
		preview.data.data.runs.find((run) => run.runId === "workflow_protected")
			?.protected,
		true,
	);
	assert.equal(existsSync(first.dir), true);
	const second = await persistManagementRun(
		p.cwd,
		"workflow_added_after_preview",
	);
	const stale = await p.http(
		path,
		write("POST", { keep: 0, digest: preview.data.digest }),
	);
	assert.equal(stale.status, 409, JSON.stringify(stale.data));
	assert.notEqual(stale.data.preview.digest, preview.data.digest);
	for (const { dir } of [first, second, active, protectedRun])
		assert.equal(existsSync(dir), true, dir);
	const changedParams = await p.http(
		path,
		write("POST", { keep: 1, digest: stale.data.preview.digest }),
	);
	assert.equal(changedParams.status, 409);
	for (const { dir } of [first, second]) assert.equal(existsSync(dir), true);
	const deleted = await p.http(
		path,
		write("POST", { keep: 0, digest: stale.data.preview.digest }),
	);
	assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
	assert.equal(deleted.data.data.dryRun, false);
	for (const { dir } of [first, second])
		assert.equal(existsSync(dir), false, dir);
	for (const { dir } of [active, protectedRun])
		assert.equal(existsSync(dir), true, dir);
	for (const body of [
		{ keep: -1 },
		{ keep: 100001 },
		{ keep: "0" },
		{ olderThanDays: 36501 },
		{ olderThanDays: 1.1 },
		{ runIds: ["workflow_active"] },
	])
		assert.equal(
			(await p.http(`${path}/preview`, write("POST", body))).status,
			400,
		);
	assert.equal((await p.http(path, write("POST", { keep: 0 }))).status, 400);
	assert.equal(
		(await p.http(path, write("POST", { keep: 0, digest: "wrong" }))).status,
		400,
	);
});

test("notices list/acknowledge/clear retain exact state and reason without changing run history", async (t) => {
	const p = await managementProject(t);
	const { dir } = await persistManagementRun(
		p.cwd,
		"workflow_notice",
		"failed",
	);
	const before = await readFile(join(dir, "run.json"), "utf8");
	const path = `${p.base}/notices`;
	const listed = await p.http(path);
	assert.equal(listed.status, 200);
	const notice = listed.data.data.notices.find(
		(run) => run.runId === "workflow_notice",
	);
	assert.ok(notice);
	const ack = `${path}/workflow_notice/acknowledge`;
	assert.equal(
		(
			await p.http(
				ack,
				write("POST", {
					state: notice.sha256,
					reason: "Reviewed; keep history",
				}),
			)
		).status,
		200,
	);
	const acknowledged = (await p.http(path)).data.data.acknowledgements;
	assert.equal(acknowledged[0].reason, "Reviewed; keep history");
	assert.equal(acknowledged[0].active, true);
	assert.equal(await readFile(join(dir, "run.json"), "utf8"), before);
	assert.equal(
		(await p.http(`${path}/workflow_notice/clear`, write("POST"))).status,
		200,
	);
	assert.deepEqual((await p.http(path)).data.data.acknowledgements, []);
	assert.equal(
		(
			await p.http(
				ack,
				write("POST", { state: "0".repeat(64), reason: "Stale" }),
			)
		).status,
		409,
	);
	for (const body of [
		{ state: "bad", reason: "x" },
		{ state: notice.sha256 },
		{ state: notice.sha256, reason: 42 },
	])
		assert.equal((await p.http(ack, write("POST", body))).status, 400);
	assert.equal(
		(await p.http(`${path}/bad%2Fid/clear`, write("POST"))).status,
		400,
	);
	assert.equal(
		(
			await p.http(
				`${path}/workflow_missing/acknowledge`,
				write("POST", { state: notice.sha256, reason: "x" }),
			)
		).status,
		404,
	);
});

// Every management mutation must pass the same security gate, before action dispatch or body parsing.
const mutations = (p) => [
	["POST", `${p.base}/workflows/manage/check`, {}],
	["PUT", "/api/profiles/local", { values: { executor: "codex" } }],
	["DELETE", "/api/profiles/local", {}],
	["PUT", "/api/profiles-default", { name: null }],
	["PUT", "/api/workflow-preferences/manage", { profile: "codex" }],
	["DELETE", "/api/workflow-preferences/manage", {}],
	["POST", `${p.base}/prune/preview`, {}],
	["POST", `${p.base}/prune`, { digest: "0".repeat(64) }],
	[
		"POST",
		`${p.base}/notices/workflow_missing/acknowledge`,
		{ state: "0".repeat(64), reason: "x" },
	],
	["POST", `${p.base}/notices/workflow_missing/clear`, {}],
];
test("all management mutations refuse readonly, missing/invalid CSRF, Origin and fetch metadata", async (t) => {
	const p = await managementProject(t);
	for (const [method, path, body] of mutations(p)) {
		for (const headers of [
			{ "X-AW-CSRF": "" },
			{ "X-AW-CSRF": "wrong" },
			{ Origin: "" },
			{ Origin: "http://evil.example" },
			{ "Sec-Fetch-Site": "cross-site" },
			{ "Sec-Fetch-Site": "none" },
		]) {
			assert.equal(
				(await p.http(path, { method, body, headers })).status,
				403,
				`${method} ${path} ${JSON.stringify(headers)}`,
			);
		}
		// Actual absent headers, not just empty values.
		for (const omit of ["Origin", "X-AW-CSRF", "Sec-Fetch-Site"]) {
			const headers = {
				"Content-Type": "application/json",
				Origin: p.origin,
				"X-AW-CSRF": dashboardCsrf(p.server.token),
				"Sec-Fetch-Site": "same-origin",
			};
			delete headers[omit];
			assert.equal(
				(await p.http(path, { method, body, headers, guarded: false })).status,
				403,
				`${method} ${path} missing ${omit}`,
			);
		}
	}
	assert.equal(existsSync(p.effects), false);
	assert.equal(
		existsSync(
			join(p.env.AGENT_WORKFLOW_HOME, "user-profiles/v1/profiles.json"),
		),
		false,
	);
	const readonly = await p.start({ env: p.env, readonly: true });
	for (const [method, path, body] of mutations(p)) {
		const response = await fetch(`${new URL(readonly.url).origin}${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: new URL(readonly.url).origin,
				"Sec-Fetch-Site": "same-origin",
				"X-AW-CSRF": dashboardCsrf(readonly.token),
			},
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 403, `${method} ${path}`);
	}
});

test("every project management resource rejects unknown registry ids", async (t) => {
	const p = await managementProject(t);
	for (const [method, suffix, body] of [
		["GET", "workflows"],
		["GET", "workflows/manage"],
		["POST", "workflows/manage/check", {}],
		["GET", "agents"],
		["POST", "prune/preview", {}],
		["POST", "prune", { digest: "0".repeat(64) }],
		["GET", "notices"],
		["POST", "notices/workflow_x/acknowledge", {}],
		["POST", "notices/workflow_x/clear", {}],
	])
		assert.equal(
			(
				await p.http(
					`/api/projects/unknown-000000000000/${suffix}`,
					write(method, body),
				)
			).status,
			404,
			suffix,
		);
	assert.equal((await p.http("/api/projects/bad/workflows")).status, 400);
});

test("management responses redact secrets, including profile values and action text", async (t) => {
	const p = await managementProject(t);
	const secret = "management-private-secret-value";
	const redactedServer = await p.start({
		env: { ...p.env, OPENAI_API_KEY: secret },
	});
	const origin = new URL(redactedServer.url).origin;
	await profileAction(p.ctx, {
		op: "set",
		name: "redaction",
		values: { model: secret },
	});
	const response = await fetch(`${origin}/api/profiles`);
	const text = await response.text();
	assert.equal(response.status, 200);
	assert.equal(text.includes(secret), false);
	assert.match(text, /REDACTED/);
});
