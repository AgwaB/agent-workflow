import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { projectId } from "../../dist/core/state-location.js";
import { projectWorkflowSettingsKey } from "../../dist/core/workflow-specs.js";
import {
	projectWorkflowSettingsPath,
	PROJECT_WORKFLOW_SETTINGS_SCHEMA,
	listProjectWorkflowSettings,
} from "../../dist/hosts/project-workflow-settings.js";
import {
	previewProjectSettingsRecoveryAction,
	projectSettingsRecoveryAction,
	projectSettingsRecoveryRequest,
} from "../../dist/hosts/api.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";

async function fixture(t, seed = true) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "aw-local-recovery-")),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".git"), { recursive: true });
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(root, "home") };
	const ctx = { cwd, env };
	const identity = {
		scope: "project-shared",
		relativeSpec: "workflows/undiscovered.json",
	};
	const key = projectWorkflowSettingsKey(identity);
	const otherIdentity = { ...identity, relativeSpec: "workflows/other.json" };
	const otherKey = projectWorkflowSettingsKey(otherIdentity);
	const entry = {
		identity,
		revision: "revision",
		definitionFingerprint: "a".repeat(64),
		intent: {
			defaults: { executor: "missing", model: "unknown" },
			slots: {
				orphan: { executor: "missing", effort: "high" },
				sibling: { executor: "pi", model: "keep" },
			},
		},
	};
	const file = projectWorkflowSettingsPath(cwd, { env });
	if (seed) {
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		await writeFile(
			file,
			JSON.stringify({
				schema: PROJECT_WORKFLOW_SETTINGS_SCHEMA,
				storeEpoch: "epoch",
				workflows: {
					[key]: entry,
					[otherKey]: { ...entry, identity: otherIdentity },
				},
			}),
			{ mode: 0o600 },
		);
	}
	const cli = async (args) => {
		let stdout = "",
			stderr = "";
		const code = await runAgentWorkflowCli(
			["project-settings", ...args, "--json"],
			{
				cwd,
				env,
				stdout: (s) => {
					stdout += s;
				},
				stderr: (s) => {
					stderr += s;
				},
			},
		);
		return { code, out: JSON.parse(stdout), stderr };
	};
	return {
		root,
		cwd,
		env,
		ctx,
		file,
		key,
		otherKey,
		entry,
		cli,
		id: projectId(cwd),
		tokens: ["--store-epoch", "epoch", "--revision", "revision"],
	};
}

test("project-settings CLI reads are noncreating, exact-key and reject unknown arguments", async (t) => {
	const f = await fixture(t, false);
	const listed = await f.cli(["list"]);
	assert.equal(listed.code, 0);
	assert.equal(listed.out.data.projectId, f.id);
	assert.deepEqual(listed.out.data.affected.workflows, {});
	assert.equal(
		(await f.cli(["show", "--key", f.key])).out.data.affected.revision,
		"absent",
	);
	assert.equal((await f.cli(["inspect-recovery"])).code, 1);
	await assert.rejects(stat(f.env.AGENT_WORKFLOW_HOME), { code: "ENOENT" });
	for (const args of [
		["list", "--cwd", f.cwd],
		["list", "--key", f.key],
		["show", "--key", "../../outside"],
		["reset", "--key", f.key, ...f.tokens],
		["clear-project", "--raw-digest", "bad"],
	])
		assert.equal((await f.cli(args)).code, 2);
	await assert.rejects(stat(f.env.AGENT_WORKFLOW_HOME), { code: "ENOENT" });
});

test("CLI selected deletion preserves siblings/shared/other entries and stale CAS preserves bytes", async (t) => {
	const f = await fixture(t);
	const shared = join(
		f.env.AGENT_WORKFLOW_HOME,
		"workflow-preferences",
		"v1",
		"preferences.json",
	);
	await mkdir(dirname(shared), { recursive: true });
	await writeFile(shared, "shared preference sentinel");
	const before = await readFile(f.file);
	const args = [
		"clear-binding",
		"--key",
		f.key,
		"--binding",
		"slot",
		"--slot",
		"orphan",
		...f.tokens,
	];
	assert.equal((await f.cli(args)).code, 2);
	assert.equal(
		(await f.cli([...args, "--confirm-project", "wrong-project"])).code,
		2,
	);
	assert.deepEqual(await readFile(f.file), before);
	const changed = await f.cli([...args, "--confirm-project", f.id]);
	assert.equal(changed.code, 0);
	assert.match(changed.stderr, /orphan/);
	assert.match(changed.stderr, /missing/);
	const listed = await listProjectWorkflowSettings(f.cwd, { env: f.env });
	assert.deepEqual(listed.workflows[f.key].intent, {
		defaults: f.entry.intent.defaults,
		slots: { sibling: f.entry.intent.slots.sibling },
	});
	assert.deepEqual(listed.workflows[f.otherKey], {
		...f.entry,
		identity: { scope: "project-shared", relativeSpec: "workflows/other.json" },
	});
	assert.equal(await readFile(shared, "utf8"), "shared preference sentinel");
	const bytes = await readFile(f.file);
	assert.equal((await f.cli([...args, "--confirm-project", f.id])).code, 1);
	assert.deepEqual(await readFile(f.file), bytes);
	const defaults = await f.cli([
		"clear-binding",
		"--key",
		f.key,
		"--binding",
		"defaults",
		"--store-epoch",
		listed.storeEpoch,
		"--revision",
		listed.workflows[f.key].revision,
		"--confirm-project",
		f.id,
	]);
	assert.equal(defaults.code, 0);
	assert.deepEqual(
		(await listProjectWorkflowSettings(f.cwd, { env: f.env })).workflows[f.key]
			.intent,
		{ slots: { sibling: f.entry.intent.slots.sibling } },
	);
});

test("CLI reset, purge and whole clear are distinct, scoped CAS operations", async (t) => {
	const f = await fixture(t);
	const listed = (await f.cli(["list"])).out.data.affected;
	assert.equal(
		(
			await f.cli([
				"reset",
				"--key",
				f.key,
				...f.tokens,
				"--confirm-project",
				f.id,
			])
		).code,
		0,
	);
	const read = (await f.cli(["show", "--key", f.key])).out.data.affected;
	assert.deepEqual(read.entry.intent, {});
	const bytes = await readFile(f.file);
	assert.equal(
		(
			await f.cli([
				"clear-project",
				"--store-epoch",
				listed.storeEpoch,
				"--raw-digest",
				listed.rawDigest,
				"--confirm-project",
				f.id,
			])
		).code,
		1,
	);
	assert.deepEqual(await readFile(f.file), bytes);
	assert.equal(
		(
			await f.cli([
				"purge",
				"--key",
				f.key,
				"--store-epoch",
				read.storeEpoch,
				"--revision",
				read.revision,
				"--confirm-project",
				f.id,
			])
		).code,
		0,
	);
	const current = (await f.cli(["list"])).out.data.affected;
	assert.notEqual(current.storeEpoch, read.storeEpoch);
	assert.equal(current.workflows[f.key], undefined);
	assert.ok(current.workflows[f.otherKey]);
	assert.equal(
		(
			await f.cli([
				"clear-project",
				"--store-epoch",
				current.storeEpoch,
				"--raw-digest",
				current.rawDigest,
				"--confirm-project",
				f.id,
			])
		).code,
		0,
	);
	assert.deepEqual((await f.cli(["list"])).out.data.affected.workflows, {});
});

test("CLI malformed recovery requires inspected digest and preserves exact BOM backup", async (t) => {
	const f = await fixture(t);
	const raw = Buffer.from("\ufeff{malformed\n");
	await writeFile(f.file, raw);
	assert.equal((await f.cli(["list"])).code, 1);
	const inspected = (await f.cli(["inspect-recovery"])).out.data.affected;
	assert.equal(inspected.malformed, true);
	const args = ["recover", "--raw-digest", inspected.rawDigest];
	assert.equal((await f.cli(args)).code, 2);
	assert.deepEqual(await readFile(f.file), raw);
	assert.equal(
		(
			await f.cli([
				"recover",
				"--raw-digest",
				"0".repeat(64),
				"--confirm-project",
				f.id,
			])
		).code,
		1,
	);
	assert.deepEqual(await readFile(f.file), raw);
	const recovered = await f.cli([...args, "--confirm-project", f.id]);
	assert.equal(recovered.code, 0);
	assert.deepEqual(await readFile(recovered.out.data.changed.backupPath), raw);
	assert.equal(
		(await stat(recovered.out.data.changed.backupPath)).mode & 0o777,
		0o600,
	);
	assert.deepEqual((await f.cli(["list"])).out.data.affected.workflows, {});
	const valid = (await f.cli(["inspect-recovery"])).out.data.affected;
	const bytes = await readFile(f.file);
	assert.equal(
		(
			await f.cli([
				"recover",
				"--raw-digest",
				valid.rawDigest,
				"--confirm-project",
				f.id,
			])
		).code,
		2,
	);
	assert.deepEqual(await readFile(f.file), bytes);
});

test("shared recovery actions reject spoofing, readonly, unknown schema/metadata and never repair intent", async (t) => {
	const f = await fixture(t);
	const request = {
		op: "clear-binding",
		projectId: f.id,
		key: f.key,
		storeEpoch: "epoch",
		revision: "revision",
		binding: "defaults",
	};
	const bytes = await readFile(f.file);
	for (const field of [
		"confirm",
		"path",
		"identity",
		"intent",
		"editableSlots",
		"schema",
		"env",
		"cwd",
	])
		assert.throws(
			() => projectSettingsRecoveryRequest({ ...request, [field]: true }),
			/not valid/,
		);
	await assert.rejects(
		projectSettingsRecoveryAction({ ...f.ctx, readonly: true }, request),
		/read-only/,
	);
	await assert.rejects(
		previewProjectSettingsRecoveryAction(f.ctx, {
			...request,
			projectId: "other",
		}),
		/scope/,
	);
	await assert.rejects(
		projectSettingsRecoveryAction(
			{ ...f.ctx, env: { ...f.env, AGENT_WORKFLOW_ROLE: "worker" } },
			request,
		),
	);
	assert.deepEqual(await readFile(f.file), bytes);
	await projectSettingsRecoveryAction(f.ctx, request);
	const remaining = (await listProjectWorkflowSettings(f.cwd, { env: f.env }))
		.workflows[f.key].intent;
	assert.deepEqual(remaining, { slots: f.entry.intent.slots });
});
