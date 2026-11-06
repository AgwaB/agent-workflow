import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import {
	canonicalProjectPath,
	fromStatePath,
	projectId,
	registerProject,
	stateBase,
	toStatePath,
} from "../../dist/core/state-location.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import {
	createRunRecord,
	listRunRecords,
	readRunRecord,
	workflowsRoot,
} from "../../dist/core/store.js";
import { listWorkflows } from "../../dist/core/workflow-specs.js";
import "../helpers/register-default-executor.mjs";

if (!process.env.AGENT_WORKFLOW_HOME)
	throw new Error("Run with test/run-unit.mjs to isolate user state");

async function project(t, name = "My Project_! !") {
	const root = await mkdtemp(join(tmpdir(), "state-location-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, name);
	await mkdir(cwd);
	return { root, cwd };
}

test("project identity uses a bounded normalized slug and canonical path digest", async (t) => {
	const { root, cwd } = await project(t);
	const canonical = realpathSync.native(cwd);
	assert.equal(
		projectId(cwd),
		`my-project-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`,
	);
	assert.equal(projectId(cwd), projectId(resolve(cwd, ".")));
	const alias = join(root, "alias");
	await symlink(cwd, alias);
	assert.equal(projectId(alias), projectId(cwd));
	assert.notEqual(
		projectId(join(root, "other", basename(cwd))),
		projectId(cwd),
	);
	assert.match(projectId(join(root, "!!!")), /^project-[a-f0-9]{12}$/u);
	assert.match(projectId(join(root, "A".repeat(50))), /^a{32}-[a-f0-9]{12}$/u);
	assert.equal(
		canonicalProjectPath(join(root, "missing")),
		resolve(root, "missing"),
	);
});

test("state base is cached separately for each home override and preserves relative metadata", async (t) => {
	const { root, cwd } = await project(t);
	const previous = process.env.AGENT_WORKFLOW_HOME;
	t.after(() => {
		process.env.AGENT_WORKFLOW_HOME = previous;
	});
	process.env.AGENT_WORKFLOW_HOME = join(root, "home-a");
	const first = stateBase(cwd);
	assert.equal(
		first,
		join(realpathSync.native(root), "home-a", "projects", projectId(cwd)),
	);
	assert.equal(stateBase(cwd), first);
	process.env.AGENT_WORKFLOW_HOME = join(root, "home-b");
	assert.notEqual(stateBase(cwd), first);
	const ref =
		".agent-workflow/workflows/workflow_test/tasks/task-1/result.json";
	assert.equal(toStatePath(cwd, fromStatePath(cwd, ref)), ref);
	process.env.AGENT_WORKFLOW_HOME = join(root, "home-a");
	assert.equal(stateBase(cwd), first);
});

test("registry records canonical project identity, refreshes launches, and stays private", async (t) => {
	const { cwd } = await project(t);
	await registerProject(cwd);
	const base = stateBase(cwd),
		file = join(base, "project.json");
	const first = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(first, {
		schema: "agent-workflow-project-v1",
		id: projectId(cwd),
		path: realpathSync.native(cwd),
		name: basename(cwd),
		createdAt: first.createdAt,
		lastSeenAt: first.lastSeenAt,
	});
	assert.equal((await stat(base)).mode & 0o777, 0o700);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await new Promise((done) => setTimeout(done, 10));
	await registerProject(cwd);
	const second = JSON.parse(await readFile(file, "utf8"));
	assert.equal(second.createdAt, first.createdAt);
	assert.ok(second.lastSeenAt > first.lastSeenAt);
	await writeFile(
		file,
		JSON.stringify({ ...second, path: join(cwd, "foreign") }),
	);
	await assert.rejects(
		() => registerProject(cwd),
		/path mismatch.*refusing to merge/u,
	);
	assert.equal(
		JSON.parse(await readFile(file, "utf8")).path,
		join(cwd, "foreign"),
	);
});

test("registry refuses symlinked project bases and registry files", async (t) => {
	const { root, cwd } = await project(t);
	await registerProject(cwd);
	const base = stateBase(cwd),
		file = join(base, "project.json"),
		outside = join(root, "outside.json");
	await writeFile(outside, await readFile(file));
	await chmod(outside, 0o600);
	await rm(file);
	await symlink(outside, file);
	await assert.rejects(() => registerProject(cwd));
	await rm(base, { recursive: true });
	await symlink(root, base);
	await assert.rejects(
		() => registerProject(cwd),
		/Unsafe project state directory/u,
	);
});

test("new runs live only under state base; stale project run trees never become runs or specs", async (t) => {
	const { cwd } = await project(t);
	const spec = {
		schemaVersion: 1,
		name: "local",
		artifactGraph: {
			stages: [{ id: "one", support: { uses: "./helper.mjs" } }],
		},
	};
	const definitions = join(cwd, ".agent-workflow", "workflows");
	await mkdir(join(definitions, "local"), { recursive: true });
	await writeFile(
		join(definitions, "local", "spec.json"),
		JSON.stringify(spec),
	);
	await writeFile(
		join(definitions, "local", "helper.mjs"),
		"export default () => ({schema:'stage-control-v1',digest:'done'});",
	);
	const stale = join(definitions, "workflow_stale");
	await mkdir(stale);
	await writeFile(
		join(stale, "run.json"),
		JSON.stringify({ runId: "workflow_stale", status: "running" }),
	);
	await writeFile(
		join(stale, "spec.json"),
		JSON.stringify({ ...spec, name: "stale" }),
	);
	const abandoned = join(definitions, "workflow_abandoned");
	await mkdir(abandoned);
	await writeFile(
		join(abandoned, "spec.json"),
		JSON.stringify({ ...spec, name: "abandoned" }),
	);
	const authored = join(cwd, "workflows", "workflow_authored");
	await mkdir(authored, { recursive: true });
	await writeFile(
		join(authored, "spec.json"),
		JSON.stringify({ ...spec, name: "authored" }),
	);
	assert.deepEqual(await listRunRecords(cwd), []);
	await assert.rejects(
		() => readRunRecord(cwd, "workflow_stale"),
		/not found/u,
	);
	const listed = await listWorkflows(cwd);
	assert.ok(listed.some((row) => row.name === "local"));
	assert.ok(listed.some((row) => row.name === "workflow_authored"));
	assert.ok(!listed.some((row) => row.name === "workflow_abandoned"));
	assert.ok(
		!listed.some(
			(row) => row.name === "workflow_stale" || row.name === "stale",
		),
	);
	const compiled = await compileWorkflow(spec, {
		cwd,
		specPath: join(definitions, "local", "spec.json"),
	});
	const { run, runDir } = await createRunRecord(
		cwd,
		compiled,
		join(definitions, "local", "spec.json"),
	);
	assert.equal(run.cwd, cwd);
	assert.equal(runDir, join(workflowsRoot(cwd), run.runId));
	assert.ok(runDir.startsWith(stateBase(cwd)));
	assert.ok(existsSync(join(stateBase(cwd), "project.json")));
	assert.equal(existsSync(join(definitions, run.runId)), false);
	assert.equal(
		run.tasks[0].files.result,
		`.agent-workflow/workflows/${run.runId}/tasks/task-1/result.json`,
	);
});

test("concurrent launches keep one private project identity", async (t) => {
	const { cwd } = await project(t);
	await Promise.all(Array.from({ length: 8 }, () => registerProject(cwd)));
	const file = join(stateBase(cwd), "project.json");
	const first = JSON.parse(await readFile(file, "utf8"));
	await Promise.all(Array.from({ length: 8 }, () => registerProject(cwd)));
	const second = JSON.parse(await readFile(file, "utf8"));
	assert.equal(second.path, canonicalProjectPath(cwd));
	assert.equal(second.createdAt, first.createdAt);
	assert.ok(second.lastSeenAt >= first.lastSeenAt);
	assert.equal((await stat(file)).nlink, 1);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await chmod(file, 0o644);
	await assert.rejects(() => registerProject(cwd), /Unsafe project registry/u);
});
