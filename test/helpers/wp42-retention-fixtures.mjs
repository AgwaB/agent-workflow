// New in agent-workflow (WP42, WP39b review): fixtures for the retention-deleter regression tests
// (core-wp42-*.test.mjs): temporary git repositories, synthetic classifier records as the runtime writes
// them for the router's comparison call, and workflow runs that record a managed worktree.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const roots = [];
after(async () => {
	for (const p of roots)
		await rm(p, { recursive: true, force: true, maxRetries: 5 });
});
export async function temp() {
	const p = await realpath(await mkdtemp(join(tmpdir(), "aw-wp42-")));
	roots.push(p);
	return p;
}
export async function json(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(data));
}
export const at = "2026-01-01T00:00:00.000Z";
export const ROUTER_RUNS = ".agent-workflow/workflows/auto-router-runs";
export function git(cwd, args) {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=aw-test",
			"-c",
			"user.email=aw-test@example.invalid",
			...args,
		],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}
export async function repo() {
	const p = await temp();
	git(p, ["init", "-q"]);
	await writeFile(join(p, "README.md"), "base\n");
	await writeFile(join(p, ".gitignore"), ".agent-workflow/\n");
	git(p, ["add", "."]);
	git(p, ["commit", "-q", "--no-gpg-sign", "--no-verify", "-m", "base"]);
	return p;
}
/** A runtime run id (`run_<base36 ms>_<6 hex>`), the only format the runtime generates. */
export function classifierId() {
	return `run_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}
/** The record the runtime writes for the router's one-shot comparison call. */
export async function classifier(dir, id, extra = {}) {
	await json(join(dir, id, "run.json"), {
		schemaVersion: 2,
		runId: id,
		correlationId: "workflow-auto-compare-v1",
		mode: "single",
		status: "completed",
		failureKind: null,
		dependency: null,
		cwd: "/somewhere",
		runsDir: ROUTER_RUNS,
		startedAt: at,
		updatedAt: at,
		completedAt: at,
		activeAttemptId: null,
		latestAttemptId: null,
		attempts: [],
		...extra,
	});
	await writeFile(join(dir, id, "valuable.txt"), "retained data\n");
}
export async function workflow(cwd, worktree, runId = "workflow_probe") {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await json(join(dir, "run.json"), {
		schemaVersion: 1,
		runId,
		createdAt: at,
		updatedAt: at,
		type: "workflow",
		tasks: [
			{
				taskId: "task-1",
				specId: "w",
				status: "completed",
				cwd: worktree?.path ?? cwd,
				worktree,
			},
		],
	});
	return dir;
}
export const managedBranch = "agent-workflow/workflow_probe-task-1";
export const managedPath = (cwd) =>
	join(
		cwd,
		".agent-workflow",
		"workflows",
		"workflow_probe",
		"worktrees",
		"task-1",
	);
export const branchExists = (cwd, branch) =>
	git(cwd, ["branch", "--list", branch]) !== "";
