// test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
import { acquireRunFileLease } from "../../dist/core/store.js";
import { setWorkflowPruneAfterQuarantineForTests } from "../../dist/core/run-retention.js";
import { dashboardCsrf } from "../../dist/hosts/dashboard/security.js";
import { projectWorkflowSettingsPath } from "../../dist/hosts/project-workflow-settings.js";

const post = (body) => ({ method: "POST", body });
const preview = (p, runIds) =>
	p.http(`${p.base}/run-deletions/preview`, post({ runIds }));
const commit = (p, runIds, digest) =>
	p.http(`${p.base}/run-deletions`, post({ runIds, digest }));

test("exact HTTP deletion normalizes ids and never expands to unrelated new runs or ancillary state", async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(p.cwd, "workflow_selected_a");
	const b = await persistManagementRun(p.cwd, "workflow_selected_b");
	const active = await persistManagementRun(
		p.cwd,
		"workflow_active",
		"running",
	);
	const other = join(p.cwd, "other-project");
	await mkdir(other);
	const foreign = await persistManagementRun(other, "workflow_foreign");
	const home = process.env.AGENT_WORKFLOW_HOME;
	assert.ok(home);
	const sentinels = [
		projectWorkflowSettingsPath(p.cwd, { env: p.env }),
		projectWorkflowSettingsPath(other, { env: p.env }),
		join(p.cwd, ".agent-workflow/workflows/manage.json"),
		join(p.cwd, ".agent-workflow/host-launches/stale.json"),
		join(
			p.cwd,
			".agent-workflow/workflows/auto-router-runs/run_stale/request.json",
		),
		join(home, "executor-state/sentinel"),
		join(p.cwd, "source.txt"),
	];
	for (const file of sentinels) {
		await mkdir(join(file, ".."), { recursive: true });
		if (!existsSync(file)) await writeFile(file, "preserve exactly");
	}
	const bytes = await Promise.all(
		sentinels.map((file) => readFile(file, "utf8")),
	);
	await writeFile(join(a.dir, "output.log"), "selected output");
	await writeFile(join(a.dir, "report.md"), "selected report");
	const ids = [b.run.runId, a.run.runId, a.run.runId];
	const first = await preview(p, ids);
	assert.equal(first.status, 200, JSON.stringify(first.data));
	assert.equal(first.data.outcome, "success");
	assert.deepEqual(first.data.runIds, [a.run.runId, b.run.runId]);
	assert.deepEqual(
		first.data.data.runs.map((r) => r.runId).sort(),
		first.data.runIds,
	);
	const added = await persistManagementRun(
		p.cwd,
		"workflow_unrelated_after_preview",
	);
	const fresh = await preview(p, [a.run.runId, b.run.runId]);
	assert.equal(
		fresh.data.digest,
		first.data.digest,
		"unselected run is not added to confirmation",
	);
	assert.equal(
		(await commit(p, [a.run.runId], first.data.digest)).status,
		409,
		"requested set is bound",
	);
	assert.ok(existsSync(a.dir));
	const deleted = await commit(
		p,
		[a.run.runId, b.run.runId],
		first.data.digest,
	);
	assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
	assert.equal(deleted.data.outcome, "success");
	assert.ok(deleted.data.data.runs.every((r) => r.deleted && r.purged));
	assert.ok(
		deleted.data.data.runs.every(
			(r) => r.ownedSessions && r.ownedSessions.deleted === 0,
		),
	);
	assert.deepEqual(deleted.data.data.autoRouterRuns, []);
	assert.deepEqual(deleted.data.data.adapterState, []);
	assert.deepEqual(deleted.data.data.hostLaunchClaims.removed, []);
	for (const r of [a, b]) assert.equal(existsSync(r.dir), false);
	for (const r of [active, added, foreign]) assert.ok(existsSync(r.dir));
	assert.deepEqual(
		await Promise.all(sentinels.map((file) => readFile(file, "utf8"))),
		bytes,
	);
	assert.equal(existsSync(p.effects), false);
});

test("invalid, empty, missing, active, cross-project and prefix selections cannot dispatch deletion", async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(p.cwd, "workflow_exact_full");
	const active = await persistManagementRun(
		p.cwd,
		"workflow_active",
		"running",
	);
	const other = join(p.cwd, "other-project");
	await mkdir(other);
	const foreign = await persistManagementRun(other, "workflow_foreign");
	const digest = (await preview(p, [a.run.runId])).data.digest;
	for (const runIds of [
		undefined,
		[],
		"workflow_exact_full",
		[null],
		[123],
		[""],
		[" workflow_exact_full"],
		["exact"],
		["workflow_bad/path"],
		["workflow_bad\\path"],
		["workflow_bad\n"],
	]) {
		for (const suffix of ["", "/preview"])
			assert.equal(
				(
					await p.http(
						`${p.base}/run-deletions${suffix}`,
						post({ runIds, digest }),
					)
				).status,
				400,
				JSON.stringify(runIds),
			);
	}
	for (const id of [
		"workflow_missing",
		active.run.runId,
		foreign.run.runId,
		"workflow_exact",
	]) {
		const runIds = [a.run.runId, id];
		const failed = await preview(p, runIds);
		assert.equal(failed.status, 200);
		assert.equal(failed.data.outcome, "failed", JSON.stringify(failed.data));
		const refused = await commit(p, runIds, failed.data.digest);
		assert.equal(refused.status, 409);
		assert.equal(refused.data.preview.outcome, "failed");
		for (const r of [a, active, foreign]) assert.ok(existsSync(r.dir));
	}
	for (const field of [
		"keep",
		"olderThanDays",
		"cwd",
		"project",
		"path",
		"scope",
		"yes",
	])
		assert.equal(
			(
				await p.http(
					`${p.base}/run-deletions/preview`,
					post({ runIds: [a.run.runId], [field]: 0 }),
				)
			).status,
			400,
			field,
		);
	for (const digest of [undefined, "bad", 123, null])
		assert.equal((await commit(p, [a.run.runId], digest)).status, 400);
	assert.equal(
		(await p.http(`${p.base}/prune/preview`, post({ runIds: [a.run.runId] })))
			.status,
		400,
		"broad API still rejects exact selection",
	);
	assert.equal(
		(await p.http(`${p.base}/prune`, post({ runIds: [a.run.runId], digest })))
			.status,
		400,
	);
});

test("an empty retention root never counts as a confirmed exact selection", async (t) => {
	const p = await managementProject(t);
	const ids = ["workflow_missing_from_empty_root"];
	const result = await preview(p, ids);
	assert.equal(result.status, 200);
	assert.equal(result.data.outcome, "failed");
	assert.deepEqual(result.data.data.runs, []);
	const refused = await commit(p, ids, result.data.digest);
	assert.equal(refused.status, 409);
	assert.equal(refused.data.preview.outcome, "failed");
	assert.equal(existsSync(p.effects), false);
});

test("selected state, protection and project changes require fresh exact confirmation", async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(p.cwd, "workflow_selected");
	const ids = [a.run.runId];
	const first = await preview(p, ids);
	const lease = await acquireRunFileLease(p.cwd, a.run.runId, "supervisor");
	assert.ok(lease);
	t.after(() => lease.release());
	const stale = await commit(p, ids, first.data.digest);
	assert.equal(stale.status, 409);
	assert.equal(stale.data.preview.data.runs[0].protected, true);
	assert.match(stale.data.preview.data.runs[0].error, /lease/);
	assert.ok(existsSync(a.dir));
	const protectedCommit = await commit(p, ids, stale.data.preview.digest);
	assert.equal(protectedCommit.status, 200);
	assert.equal(protectedCommit.data.data.runs[0].deleted, false);
	await lease.release();
	const current = await preview(p, ids);
	await persistManagementRun(p.cwd, a.run.runId, "failed", {
		updatedAt: "2026-02-01T00:00:00.000Z",
	});
	assert.equal((await commit(p, ids, current.data.digest)).status, 409);
	assert.ok(existsSync(a.dir));
	const otherCwd = join(p.cwd, "another-registered-project");
	await mkdir(otherCwd);
	const other = await p.start({ cwd: otherCwd, env: p.env });
	const b = await persistManagementRun(otherCwd, a.run.runId, "failed", {
		updatedAt: "2026-02-01T00:00:00.000Z",
	});
	const fresh = await preview(p, ids);
	assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
	const cross = await p.http(
		`/api/projects/${other.projectId}/run-deletions`,
		post({ runIds: ids, digest: fresh.data.digest }),
	);
	assert.equal(
		cross.status,
		409,
		"digest binds trusted project: " + JSON.stringify(cross.data),
	);
	assert.ok(existsSync(b.dir));
	await persistManagementRun(p.cwd, a.run.runId, "running");
	assert.equal((await commit(p, ids, fresh.data.digest)).status, 409);
	assert.ok(existsSync(a.dir));
});

test("changed selected worktree resources invalidate confirmation and preserve complete protection metadata", async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(p.cwd, "workflow_resources");
	const ids = [a.run.runId];
	const first = await preview(p, ids);
	const branch = "agent-workflow/workflow_resources-task-1";
	const path = join(a.dir, "worktrees/task-1");
	await persistManagementRun(p.cwd, a.run.runId, "completed", {
		loopWorktrees: [{ path, branch }],
	});
	const conflict = await commit(p, ids, first.data.digest);
	assert.equal(conflict.status, 409);
	assert.notEqual(conflict.data.preview.digest, first.data.digest);
	const row = conflict.data.preview.data.runs[0];
	assert.equal(row.protected, true);
	assert.match(row.error, /worktree/);
	assert.equal(row.worktrees.length, 1);
	assert.equal(row.worktrees[0].branch, branch);
	assert.match(row.worktrees[0].path, /workflow_resources\/worktrees\/task-1$/);
	assert.equal(typeof row.worktrees[0].dirty, "boolean");
	assert.equal(typeof row.worktrees[0].commits, "number");
	assert.ok(row.worktrees[0].error);
	assert.equal("absolutePath" in row.worktrees[0], false);
	assert.equal("registered" in row.worktrees[0], false);
	assert.ok(existsSync(a.dir));
});

test("partial deletion error and retained recovery evidence are forwarded, not replaced with success", async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(p.cwd, "workflow_partial");
	const ids = [a.run.runId];
	const first = await preview(p, ids);
	setWorkflowPruneAfterQuarantineForTests(() => {
		throw new Error("fixture purge interruption");
	});
	t.after(() => setWorkflowPruneAfterQuarantineForTests());
	const result = await commit(p, ids, first.data.digest);
	assert.equal(result.status, 200);
	assert.equal(result.data.outcome, "failed");
	const row = result.data.data.runs[0];
	assert.equal(row.detached, true);
	assert.equal(row.deleted, false);
	assert.equal(row.purged, false);
	assert.match(row.error, /fixture purge interruption/);
	assert.ok(existsSync(row.retainedEvidencePath));
	assert.equal(existsSync(a.dir), false);
});

test("exact deletion routes retain central method/project/body/Origin/CSRF/readonly guards", async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(p.cwd, "workflow_guarded");
	const body = { runIds: [a.run.runId], digest: "0".repeat(64) };
	for (const suffix of ["", "/preview"]) {
		const path = `${p.base}/run-deletions${suffix}`;
		for (const method of ["GET", "PUT", "DELETE", "PATCH"])
			assert.equal((await p.http(path, { method, body })).status, 405, method);
		assert.equal(
			(
				await p.http(
					path.replace(p.server.projectId, "unknown-000000000000"),
					post(body),
				)
			).status,
			404,
		);
		for (const headers of [
			{ Origin: "http://evil.example" },
			{ "X-AW-CSRF": "wrong" },
			{ "Sec-Fetch-Site": "cross-site" },
		])
			assert.equal(
				(await p.http(path, { ...post(body), headers })).status,
				403,
			);
		for (const omitted of ["Origin", "X-AW-CSRF", "Sec-Fetch-Site"]) {
			const headers = {
				"Content-Type": "application/json",
				Origin: p.origin,
				"X-AW-CSRF": dashboardCsrf(p.server.token),
				"Sec-Fetch-Site": "same-origin",
			};
			delete headers[omitted];
			assert.equal(
				(await p.http(path, { ...post(body), headers, guarded: false })).status,
				403,
				omitted,
			);
		}
		assert.equal(
			(
				await p.http(path, {
					...post(body),
					headers: { "Content-Type": "text/plain" },
				})
			).status,
			400,
		);
		assert.equal(
			(await p.http(path, post({ runIds: ["workflow_" + "x".repeat(17000)] })))
				.status,
			413,
		);
		const malformed = await fetch(p.origin + path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: p.origin,
				"Sec-Fetch-Site": "same-origin",
				"X-AW-CSRF": dashboardCsrf(p.server.token),
			},
			body: "{",
		});
		assert.equal(malformed.status, 400);
	}
	const ro = await p.start({ env: p.env, readonly: true });
	const origin = new URL(ro.url).origin;
	for (const suffix of ["", "/preview"]) {
		const response = await fetch(`${origin}${p.base}/run-deletions${suffix}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: origin,
				"Sec-Fetch-Site": "same-origin",
				"X-AW-CSRF": dashboardCsrf(ro.token),
			},
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 403);
	}
	assert.ok(existsSync(a.dir));
	assert.equal(existsSync(p.effects), false);
});
