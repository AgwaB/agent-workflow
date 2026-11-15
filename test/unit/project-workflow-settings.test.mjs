import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	link,
	writeFile,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	validateProjectWorkflowSettingsIntent,
	validateProjectWorkflowSettingsSlots,
} from "../../dist/core/project-workflow-settings.js";
import {
	listWorkflows,
	projectWorkflowSettingsKey,
	resolveProjectWorkflowSettingsTarget,
	resolveWorkflowRef,
} from "../../dist/core/workflow-specs.js";
import { projectId, stateBase } from "../../dist/core/state-location.js";
import {
	readPrivateFileText,
	setSecureAtomicBeforeRenameHookForTests,
	setSecureReadAfterOpenHookForTests,
	writePrivateFileAtomic,
} from "../../dist/core/secure-atomic-write.js";
import {
	PROJECT_WORKFLOW_SETTINGS_ABSENT as ABSENT,
	ProjectWorkflowSettingsConflict,
	clearProjectWorkflowSettings,
	clearProjectWorkflowSettingsEntry,
	clearProjectWorkflowSettingsBinding,
	inspectProjectWorkflowSettingsRecovery,
	listProjectWorkflowSettings,
	projectWorkflowSettingsPath,
	readProjectWorkflowSettings,
	readProjectWorkflowSettingsEntry,
	recoverProjectWorkflowSettings,
	saveProjectWorkflowSettings,
} from "../../dist/hosts/project-workflow-settings.js";

const SPEC = {
	schemaVersion: 1,
	artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Check." }] },
};
const INTENT = {
	defaults: { executor: "codex", model: "example", effort: "high" },
	slots: { main: { executor: "claude", effort: "low" } },
};
const slots = [{ id: "main", kind: "model" }];
const sha = (raw) => createHash("sha256").update(raw).digest("hex");

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "project-workflow-settings-"));
	const home = join(root, "home");
	const env = { ...process.env, AGENT_WORKFLOW_HOME: home };
	const previous = process.env.AGENT_WORKFLOW_HOME;
	process.env.AGENT_WORKFLOW_HOME = home;
	t.after(async () => {
		setSecureAtomicBeforeRenameHookForTests(undefined);
		setSecureReadAfterOpenHookForTests(undefined);
		if (previous === undefined) delete process.env.AGENT_WORKFLOW_HOME;
		else process.env.AGENT_WORKFLOW_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	const a = join(root, "a"),
		b = join(root, "b");
	await mkdir(a);
	await mkdir(b);
	const author = async (
		project,
		relative = "workflows/alpha.json",
		spec = SPEC,
	) => {
		const file = join(project, relative);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(spec));
		return file;
	};
	await author(a);
	await author(b);
	const target = (ref = "alpha", project = a) =>
		resolveProjectWorkflowSettingsTarget(ref, project);
	const options = (ref = "alpha", project = a, editableSlots = slots) => ({
		env,
		resolveTarget: async () => ({
			target: await target(ref, project),
			editableSlots,
		}),
	});
	const save = async (
		intent = INTENT,
		ref = "alpha",
		project = a,
		expected,
	) => {
		const selected = await target(ref, project);
		return saveProjectWorkflowSettings(
			project,
			selected,
			expected ??
				(await readProjectWorkflowSettings(project, selected, { env })),
			intent,
			options(ref, project),
		);
	};
	return { root, home, env, a, b, author, target, options, save };
}

test("read/list/identity are noncreating, projects and workflows are isolated; shared preferences untouched", async (t) => {
	const f = await fixture(t);
	const target = await f.target();
	const absent = await readProjectWorkflowSettings(f.a, target, f);
	assert.equal(absent.storeEpoch, ABSENT);
	assert.equal(absent.revision, ABSENT);
	assert.deepEqual(absent.intent, {});
	assert.deepEqual((await listProjectWorkflowSettings(f.a, f)).workflows, {});
	assert.deepEqual(await readProjectWorkflowSettingsEntry(f.a, target.key, f), {
		storeEpoch: ABSENT,
		revision: ABSENT,
	});
	await assert.rejects(
		inspectProjectWorkflowSettingsRecovery(f.a, f),
		/No settings store/,
	);
	await assert.rejects(stat(f.home), { code: "ENOENT" });
	await mkdir(join(f.home, "workflow-preferences", "v1"), { recursive: true });
	const shared = join(f.home, "workflow-preferences", "v1", "preferences.json");
	await writeFile(shared, "do not touch");
	const saved = await f.save();
	assert.notEqual(saved.storeEpoch, ABSENT);
	assert.deepEqual(
		(await readProjectWorkflowSettings(f.a, target, f)).intent,
		INTENT,
	);
	assert.equal(
		(await readProjectWorkflowSettings(f.b, await f.target("alpha", f.b), f))
			.present,
		false,
	);
	await f.author(f.a, "workflows/beta.json");
	assert.deepEqual(
		(await readProjectWorkflowSettings(f.a, await f.target("beta"), f)).intent,
		{},
	);
	assert.equal(await readFile(shared, "utf8"), "do not touch");
	assert.notEqual(projectId(f.a), projectId(f.b));
	assert.equal(
		stateBase(f.a, f.env),
		join(await realpath(f.home), "projects", projectId(f.a)),
	);
	const alias = join(f.root, "alias");
	await symlink(f.a, alias, "dir");
	assert.equal(
		projectWorkflowSettingsPath(alias, f),
		projectWorkflowSettingsPath(f.a, f),
	);
	assert.deepEqual(await f.target("alpha", alias), target);
});

test("strict intent requires binding, rejects null/empty/unknown fields without losing data", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f),
		before = await readFile(file, "utf8");
	const invalid = [
		null,
		[],
		{ extra: 1 },
		{ defaults: null },
		{ defaults: {} },
		{ defaults: { model: "m" } },
		{ slots: { main: { effort: "high" } } },
		{ defaults: { executor: "" } },
		{ defaults: { executor: " codex" } },
		{ defaults: { executor: "codex", model: "" } },
		{ defaults: { executor: "codex", model: "Automatic" } },
		{ defaults: { executor: "codex", effort: null } },
		{ defaults: { executor: "codex", effort: "banana" } },
		{ defaults: { executor: "codex", permissions: "all" } },
		{ slots: null },
		{ slots: { "": { executor: "codex" } } },
		{ defaults: undefined },
		{ defaults: { executor: "codex", model: undefined } },
	];
	for (const value of invalid) {
		assert.throws(() => validateProjectWorkflowSettingsIntent(value));
		await assert.rejects(f.save(value));
	}
	for (const effort of [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
		"ultra",
	])
		assert.deepEqual(
			validateProjectWorkflowSettingsIntent({
				defaults: { executor: "codex", effort },
			}),
			{ defaults: { executor: "codex", effort } },
		);
	assert.equal(await readFile(file, "utf8"), before);
	await assert.rejects(
		saveProjectWorkflowSettings(
			f.a,
			await f.target(),
			await readProjectWorkflowSettings(f.a, await f.target(), f),
			INTENT,
			{
				...f.options(),
				validateIntent() {
					throw new Error("executor unavailable");
				},
			},
		),
		/executor unavailable/,
	);
	assert.equal(await readFile(file, "utf8"), before);
});

test("name/file alias/path share source identity, package excludes installation root, external paths canonicalize", async (t) => {
	const f = await fixture(t);
	const named = await f.target();
	for (const ref of [
		"alpha.json",
		"./workflows/alpha.json",
		join(f.a, "workflows", "alpha.json"),
	])
		assert.deepEqual(await f.target(ref), named);
	assert.deepEqual(named.identity, {
		scope: "project-shared",
		relativeSpec: "alpha.json",
	});
	await f.author(f.a, ".agent-workflow/workflows/private/spec.json");
	assert.equal((await f.target("private")).identity.scope, "project-private");
	await f.author(f.home, "workflows/user-only.json");
	assert.equal((await f.target("user-only")).identity.scope, "user");
	const pkg = (await listWorkflows(f.a)).find(
		(record) => record.scope === "package",
	);
	assert.ok(pkg);
	const packageTarget = await f.target(pkg.specPath);
	assert.equal(packageTarget.identity.scope, "package");
	assert.equal(
		JSON.stringify(packageTarget.identity).includes(dirname(pkg.specPath)),
		false,
	);
	assert.equal(
		projectWorkflowSettingsKey({
			relativeSpec: packageTarget.identity.relativeSpec,
			scope: "package",
		}),
		packageTarget.key,
	);
	const external = await f.author(f.root, "outside/spec.json");
	const externalAlias = join(f.root, "outside-link.json");
	await symlink(external, externalAlias);
	assert.deepEqual(await f.target(external), await f.target(externalAlias));
	assert.equal((await f.target(external)).identity.scope, "external");
	await f.save({}, "alpha");
	await f.author(f.a, "workflows/alpha.json", {
		...SPEC,
		description: "changed",
	});
	const changed = await f.target();
	assert.equal(changed.key, named.key);
	assert.notEqual(changed.definitionFingerprint, named.definitionFingerprint);
});

test("CAS refuses stale revisions, definitions and alias-winner drift even with old definition unchanged", async (t) => {
	const f = await fixture(t);
	const selected = await f.target(),
		initial = await readProjectWorkflowSettings(f.a, selected, f);
	const first = await f.save();
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, selected, initial, {}, f.options()),
		ProjectWorkflowSettingsConflict,
	);
	await f.author(f.a, "workflows/alpha.json", { ...SPEC, description: "edit" });
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, selected, first, {}, f.options()),
		ProjectWorkflowSettingsConflict,
	);
	// alpha and alpha.json are independently shadowable aliases.
	await f.author(f.home, "workflows/shadow.json");
	const path = join(f.home, "workflows/shadow.json"),
		old = await f.target(path);
	const draft = await readProjectWorkflowSettings(f.a, old, f);
	await f.author(f.a, "workflows/shadow/spec.json");
	const current = await f.target(path);
	assert.equal(current.key, old.key);
	assert.equal(current.definitionFingerprint, old.definitionFingerprint);
	assert.notEqual(current.resolutionToken, old.resolutionToken);
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, old, draft, {}, f.options(path)),
		ProjectWorkflowSettingsConflict,
	);
	assert.notEqual((await f.target("shadow")).key, old.key);
	assert.equal((await f.target("shadow.json")).key, old.key);
});

test("per-entry CAS allows independent saves and serializes same-entry writers", async (t) => {
	const f = await fixture(t);
	await f.save();
	await f.author(f.a, "workflows/beta.json");
	const a = await f.target(),
		b = await f.target("beta");
	const ar = await readProjectWorkflowSettings(f.a, a, f),
		br = await readProjectWorkflowSettings(f.a, b, f);
	await Promise.all([
		saveProjectWorkflowSettings(f.a, a, ar, {}, f.options()),
		saveProjectWorkflowSettings(f.a, b, br, INTENT, f.options("beta")),
	]);
	assert.deepEqual((await readProjectWorkflowSettings(f.a, a, f)).intent, {});
	assert.deepEqual(
		(await readProjectWorkflowSettings(f.a, b, f)).intent,
		INTENT,
	);
	assert.equal(
		Object.keys((await listProjectWorkflowSettings(f.a, f)).workflows).length,
		2,
	);
	const next = await readProjectWorkflowSettings(f.a, a, f);
	const results = await Promise.allSettled([
		saveProjectWorkflowSettings(f.a, a, next, INTENT, f.options()),
		saveProjectWorkflowSettings(f.a, a, next, {}, f.options()),
	]);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.ok(
		results.find((result) => result.status === "rejected").reason instanceof
			ProjectWorkflowSettingsConflict,
	);
	for (const mode of ["reset", "purge"]) {
		await clearProjectWorkflowSettingsEntry(
			f.a,
			a.key,
			await readProjectWorkflowSettingsEntry(f.a, a.key, f),
			mode,
			f,
		);
		assert.deepEqual(
			(await readProjectWorkflowSettings(f.a, b, f)).intent,
			INTENT,
		);
		assert.equal(
			Object.keys((await listProjectWorkflowSettings(f.a, f)).workflows).length,
			mode === "reset" ? 2 : 1,
		);
	}
});

test("reset tombstone and purge/all-clear epochs prevent ABA; orphan read/clear uses keys only", async (t) => {
	const f = await fixture(t);
	const saved = await f.save();
	const selected = await f.target();
	const reset = await clearProjectWorkflowSettingsEntry(
		f.a,
		selected.key,
		saved,
		"reset",
		f,
	);
	assert.notEqual(reset.revision, saved.revision);
	assert.equal(reset.storeEpoch, saved.storeEpoch);
	assert.deepEqual(
		(await readProjectWorkflowSettingsEntry(f.a, selected.key, f)).entry.intent,
		{},
	);
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, selected, saved, INTENT, f.options()),
		ProjectWorkflowSettingsConflict,
	);
	await rm(join(f.a, "workflows", "alpha.json"));
	assert.equal(
		Object.keys((await listProjectWorkflowSettings(f.a, f)).workflows).length,
		1,
	);
	const purged = await clearProjectWorkflowSettingsEntry(
		f.a,
		selected.key,
		reset,
		"purge",
		f,
	);
	assert.notEqual(purged.storeEpoch, reset.storeEpoch);
	assert.equal(purged.revision, ABSENT);
	await f.author(f.a);
	await assert.rejects(
		f.save({}, "alpha", f.a, { ...saved, revision: ABSENT }),
		ProjectWorkflowSettingsConflict,
	);
	const emptyDraft = await readProjectWorkflowSettings(f.a, selected, f);
	const listed = await listProjectWorkflowSettings(f.a, f);
	const cleared = await clearProjectWorkflowSettings(f.a, listed, f);
	assert.notEqual(cleared.storeEpoch, listed.storeEpoch);
	await assert.rejects(
		f.save({}, "alpha", f.a, emptyDraft),
		ProjectWorkflowSettingsConflict,
	);
	await assert.rejects(
		readProjectWorkflowSettingsEntry(f.a, "../../elsewhere", f),
		/key/,
	);
	assert.ok((await stat(projectWorkflowSettingsPath(f.a, f))).isFile());
	const snapshot = await listProjectWorkflowSettings(f.a, f);
	await f.save();
	await assert.rejects(
		clearProjectWorkflowSettings(f.a, snapshot, f),
		ProjectWorkflowSettingsConflict,
	);
});

test("unknown, code/group/controller and generated slots cannot save; declared dynamic leaf requires parent executor", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f),
		before = await readFile(file, "utf8");
	for (const id of ["unknown", "main.item-42", "code", "group", "controller"]) {
		const metadata = [
			...slots,
			...["code", "group", "controller"].map((kind) => ({ id: kind, kind })),
		];
		const intent = { slots: { [id]: { executor: "codex" } } };
		await assert.rejects(
			saveProjectWorkflowSettings(
				f.a,
				await f.target(),
				await readProjectWorkflowSettings(f.a, await f.target(), f),
				intent,
				f.options("alpha", f.a, metadata),
			),
			/noneditable/,
		);
	}
	const leaf = {
		slots: { "controller.$planner": { executor: "codex", model: "m" } },
	};
	assert.throws(
		() => validateProjectWorkflowSettingsSlots(leaf, []),
		/noneditable/,
	);
	for (const parentExecutor of [undefined, "claude"])
		assert.throws(
			() =>
				validateProjectWorkflowSettingsSlots(leaf, [
					{
						id: "controller.$planner",
						kind: "dynamic-profile",
						parentExecutor,
					},
				]),
			/controller executor/,
		);
	validateProjectWorkflowSettingsSlots(leaf, [
		{
			id: "controller.$planner",
			kind: "dynamic-profile",
			parentExecutor: "codex",
		},
	]);
	assert.equal(await readFile(file, "utf8"), before);
	// Existing orphan fields are readable, not silently discarded on unrelated edits.
	const raw = JSON.parse(before);
	raw.workflows[(await f.target()).key].intent.slots.orphan = {
		executor: "codex",
	};
	await writePrivateFileAtomic(file, JSON.stringify(raw));
	const orphaned = await readProjectWorkflowSettings(f.a, await f.target(), f);
	assert.ok(orphaned.intent.slots.orphan);
	await assert.rejects(f.save(orphaned.intent), /noneditable/);
	await clearProjectWorkflowSettingsEntry(
		f.a,
		orphaned.key,
		orphaned,
		"reset",
		f,
	);
});

test("malformed/unsupported/unknown stores preserve bytes on read/save/clear; explicit recovery needs digest and verified backup", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f),
		valid = await readFile(file, "utf8"),
		selected = await f.target();
	const expected = await readProjectWorkflowSettings(f.a, selected, f);
	const invalidStore = (error) => {
		assert.ok(!(error instanceof ProjectWorkflowSettingsConflict));
		return true;
	};
	for (const raw of [
		"{ broken",
		JSON.stringify({ ...JSON.parse(valid), schema: "future" }),
		JSON.stringify({ ...JSON.parse(valid), extra: 1 }),
		JSON.stringify({
			...JSON.parse(valid),
			workflows: { ...JSON.parse(valid).workflows, bad: {} },
		}),
	]) {
		await writePrivateFileAtomic(file, raw);
		await assert.rejects(readProjectWorkflowSettings(f.a, selected, f));
		await assert.rejects(
			saveProjectWorkflowSettings(f.a, selected, expected, INTENT, f.options()),
			invalidStore,
		);
		for (const mode of ["reset", "purge"])
			await assert.rejects(
				clearProjectWorkflowSettingsEntry(f.a, selected.key, expected, mode, f),
				invalidStore,
			);
		await assert.rejects(
			clearProjectWorkflowSettings(
				f.a,
				{ storeEpoch: expected.storeEpoch, rawDigest: sha(raw) },
				f,
			),
			invalidStore,
		);
		assert.equal(await readFile(file, "utf8"), raw);
	}
	const original = await readFile(file, "utf8");
	const inspection = await inspectProjectWorkflowSettingsRecovery(f.a, f);
	assert.equal(inspection.rawDigest, sha(original));
	assert.equal(inspection.malformed, true);
	const beforeNames = await readdir(dirname(file));
	await assert.rejects(
		recoverProjectWorkflowSettings(f.a, "0".repeat(64), f),
		ProjectWorkflowSettingsConflict,
	);
	assert.deepEqual(await readdir(dirname(file)), beforeNames);
	assert.equal(await readFile(file, "utf8"), original);
	setSecureReadAfterOpenHookForTests(async (path) => {
		if (path.endsWith(".bak")) await writeFile(path, "tampered backup");
	});
	await assert.rejects(
		recoverProjectWorkflowSettings(f.a, inspection.rawDigest, f),
		/backup verification failed/,
	);
	assert.equal(await readFile(file, "utf8"), original);
	setSecureReadAfterOpenHookForTests(undefined);
	const recovered = await recoverProjectWorkflowSettings(
		f.a,
		inspection.rawDigest,
		f,
	);
	assert.equal(await readFile(recovered.backupPath, "utf8"), original);
	assert.equal((await stat(recovered.backupPath)).mode & 0o777, 0o600);
	assert.deepEqual((await listProjectWorkflowSettings(f.a, f)).workflows, {});
	assert.equal(
		(await listProjectWorkflowSettings(f.a, f)).storeEpoch,
		recovered.storeEpoch,
	);
	await assert.rejects(
		recoverProjectWorkflowSettings(f.a, sha(await readFile(file, "utf8")), f),
		/valid/,
	);
});

test("save limits include tombstones and exact serialized bytes; oversized external data refuses read and supports explicit recovery", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f),
		base = JSON.parse(await readFile(file, "utf8"));
	const prototype = Object.values(base.workflows)[0];
	base.workflows = Object.fromEntries(
		Array.from({ length: 512 }, (_, index) => {
			const identity = {
				scope: "package",
				relativeSpec: `fixture-${index}.json`,
			};
			return [
				projectWorkflowSettingsKey(identity),
				{ ...prototype, identity, intent: {} },
			];
		}),
	);
	await writePrivateFileAtomic(file, JSON.stringify(base));
	assert.equal(
		Object.keys((await listProjectWorkflowSettings(f.a, f)).workflows).length,
		512,
	);
	let before = await readFile(file, "utf8");
	await assert.rejects(f.save({}), /entry limit/);
	assert.equal(await readFile(file, "utf8"), before);
	const key = Object.keys(base.workflows)[0];
	await clearProjectWorkflowSettingsEntry(
		f.a,
		key,
		{ storeEpoch: base.storeEpoch, revision: base.workflows[key].revision },
		"purge",
		f,
	);
	assert.equal(
		Object.keys((await listProjectWorkflowSettings(f.a, f)).workflows).length,
		511,
	);
	await f.save({});
	assert.equal(
		Object.keys((await listProjectWorkflowSettings(f.a, f)).workflows).length,
		512,
	);
	before = await readFile(file, "utf8");
	await assert.rejects(
		f.save({ defaults: { executor: "codex", model: "x".repeat(1_048_576) } }),
		/size limit/,
	);
	assert.equal(await readFile(file, "utf8"), before);
	await writePrivateFileAtomic(file, "x".repeat(1_048_577));
	await assert.rejects(listProjectWorkflowSettings(f.a, f), /size limit/);
	const raw = await inspectProjectWorkflowSettingsRecovery(f.a, f);
	assert.equal(raw.malformed, true);
	await recoverProjectWorkflowSettings(f.a, raw.rawDigest, f);
});

test("secure IO refuses symlink/hardlink stores and unsafe directories, atomic failure preserves prior generation", async (t) => {
	const f = await fixture(t);
	const saved = await f.save();
	const selected = await f.target(),
		file = projectWorkflowSettingsPath(f.a, f),
		before = await readFile(file, "utf8");
	setSecureAtomicBeforeRenameHookForTests((path) => {
		if (path === file) throw new Error("publication failed");
	});
	await assert.rejects(f.save({}), /publication failed/);
	assert.equal(await readFile(file, "utf8"), before);
	setSecureAtomicBeforeRenameHookForTests(undefined);
	const other = join(f.root, "other.json");
	await writePrivateFileAtomic(other, before);
	await rm(file);
	await symlink(other, file);
	await assert.rejects(readProjectWorkflowSettings(f.a, selected, f));
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, selected, saved, {}, f.options()),
	);
	await assert.rejects(inspectProjectWorkflowSettingsRecovery(f.a, f));
	assert.equal(await readFile(other, "utf8"), before);
	await rm(file);
	await link(other, file);
	await assert.rejects(readProjectWorkflowSettings(f.a, selected, f));
	await assert.rejects(recoverProjectWorkflowSettings(f.a, sha(before), f));
	await rm(file);
	await rm(dirname(file), { recursive: true });
	const outside = join(f.root, "outside");
	await mkdir(outside);
	await symlink(outside, dirname(file), "dir");
	await assert.rejects(readProjectWorkflowSettings(f.a, selected, f));
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, selected, saved, {}, f.options()),
	);
	assert.deepEqual(await readdir(outside), []);
});

test("recovery preserves literal BOM bytes and their raw digest", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f);
	const original = Buffer.concat([
		Buffer.from([0xef, 0xbb, 0xbf]),
		Buffer.from("{ broken"),
	]);
	await writePrivateFileAtomic(file, original);
	assert.equal(await readPrivateFileText(file), "{ broken");
	assert.equal(
		await readPrivateFileText(file, 100, { preserveBOM: true }),
		"\ufeff{ broken",
	);
	const inspected = await inspectProjectWorkflowSettingsRecovery(f.a, f);
	assert.equal(inspected.bytes, original.length);
	assert.equal(inspected.rawDigest, sha(original));
	assert.equal(inspected.malformed, true);
	const recovered = await recoverProjectWorkflowSettings(
		f.a,
		inspected.rawDigest,
		f,
	);
	assert.deepEqual(await readFile(recovered.backupPath), original);
});

test("valid POSIX definition path names remain readable and saveable without filename restrictions", async (t) => {
	const f = await fixture(t);
	for (const relative of [
		"workflows/ name.json",
		"workflows/back\\slash.json",
	]) {
		const file = await f.author(f.a, relative);
		assert.equal(
			await realpath((await resolveWorkflowRef(file, f.a)).specPath),
			await realpath(file),
		);
		const target = await f.target(file);
		assert.equal(
			(await readProjectWorkflowSettings(f.a, target, f)).present,
			false,
		);
		assert.deepEqual((await f.save(INTENT, file)).intent, INTENT);
	}
});

test("semantic hooks receive the validated draft but cannot mutate persisted intent", async (t) => {
	const f = await fixture(t);
	const saved = await f.save(),
		target = await f.target();
	const file = projectWorkflowSettingsPath(f.a, f),
		before = await readFile(file, "utf8");
	for (const phase of ["resolveTarget", "validateIntent"]) {
		const options = f.options();
		if (phase === "resolveTarget")
			options.resolveTarget = async (intent) => {
				assert.deepEqual(intent, INTENT);
				intent.defaults.executor = "claude";
				return { target, editableSlots: slots };
			};
		else
			options.validateIntent = (intent) => {
				intent.slots.unvalidated = { executor: "codex" };
			};
		await assert.rejects(
			saveProjectWorkflowSettings(f.a, target, saved, INTENT, options),
			/read only|not extensible|Cannot assign|Cannot add/,
		);
		assert.equal(await readFile(file, "utf8"), before);
	}
	// Server metadata fixture; definition enumeration is exercised by runtime/host tests.
	const draft = {
		defaults: { executor: "codex" },
		slots: { "controller.$planner": { executor: "codex", model: "m" } },
	};
	const options = {
		...f.options(),
		resolveTarget: async (intent) => {
			assert.deepEqual(intent, draft);
			return {
				target,
				editableSlots: [
					{
						id: "controller.$planner",
						kind: "dynamic-profile",
						parentExecutor: intent.defaults.executor,
					},
				],
			};
		},
	};
	assert.deepEqual(
		(await saveProjectWorkflowSettings(f.a, target, saved, draft, options))
			.intent,
		draft,
	);
});

test("name selection changing to another source conflicts even when the old definition remains", async (t) => {
	const f = await fixture(t);
	await f.author(f.home, "workflows/drift.json");
	const target = await f.target("drift"),
		expected = await readProjectWorkflowSettings(f.a, target, f);
	await f.author(f.a, "workflows/drift.json");
	assert.notEqual((await f.target("drift")).key, target.key);
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, target, expected, {}, f.options("drift")),
		ProjectWorkflowSettingsConflict,
	);
	assert.deepEqual((await listProjectWorkflowSettings(f.a, f)).workflows, {});
});

test("serialized size boundary accepts exactly one MiB and rejects one byte more", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f),
		target = await f.target();
	const store = JSON.parse(await readFile(file, "utf8"));
	const intent = { defaults: { executor: "codex", model: "" } };
	store.workflows[target.key].intent = intent;
	const overhead = Buffer.byteLength(`${JSON.stringify(store, null, 2)}\n`);
	intent.defaults.model = "x".repeat(1_048_576 - overhead);
	await f.save(intent);
	const before = await readFile(file);
	assert.equal(before.length, 1_048_576);
	intent.defaults.model += "x";
	await assert.rejects(f.save(intent), /size limit/);
	assert.deepEqual(await readFile(file), before);
});

test("unsafe bytes, owner permissions and recovery-size limits preserve the original", async (t) => {
	const f = await fixture(t),
		saved = await f.save(),
		target = await f.target();
	const file = projectWorkflowSettingsPath(f.a, f),
		original = await readFile(file);
	await chmod(file, 0o644);
	await assert.rejects(
		readProjectWorkflowSettings(f.a, target, f),
		/owner-only/,
	);
	await assert.rejects(
		saveProjectWorkflowSettings(f.a, target, saved, {}, f.options()),
		/owner-only/,
	);
	await assert.rejects(
		inspectProjectWorkflowSettingsRecovery(f.a, f),
		/owner-only/,
	);
	await assert.rejects(
		recoverProjectWorkflowSettings(f.a, sha(original), f),
		/owner-only/,
	);
	assert.deepEqual(await readFile(file), original);
	await chmod(file, 0o600);
	for (const [bytes, error] of [
		[Buffer.from([0xff]), /encoded data|encoding|UTF-8/],
		[Buffer.alloc(16_777_217, 0x78), /size limit/],
	]) {
		await writePrivateFileAtomic(file, bytes);
		await assert.rejects(inspectProjectWorkflowSettingsRecovery(f.a, f), error);
		await assert.rejects(
			recoverProjectWorkflowSettings(f.a, sha(bytes), f),
			error,
		);
		assert.deepEqual(await readFile(file), bytes);
	}
});

test("recovery refuses an edit made during backup and retains both original versions", async (t) => {
	const f = await fixture(t);
	await f.save();
	const file = projectWorkflowSettingsPath(f.a, f),
		original = "{ original",
		changed = "{ edited";
	await writePrivateFileAtomic(file, original);
	setSecureReadAfterOpenHookForTests(async (path) => {
		if (path.endsWith(".bak")) await writeFile(file, changed);
	});
	await assert.rejects(
		recoverProjectWorkflowSettings(f.a, sha(original), f),
		ProjectWorkflowSettingsConflict,
	);
	setSecureReadAfterOpenHookForTests(undefined);
	assert.equal(await readFile(file, "utf8"), changed);
	const backups = (await readdir(dirname(file))).filter((name) =>
		name.endsWith(".bak"),
	);
	assert.equal(backups.length, 1);
	assert.equal(
		await readFile(join(dirname(file), backups[0]), "utf8"),
		original,
	);
});

test("keyed binding deletion works undiscovered, preserves siblings and rejects stale snapshots", async (t) => {
	const f = await fixture(t);
	const target = await f.target();
	const intent = {
		...INTENT,
		slots: {
			...INTENT.slots,
			removed: { executor: "unknown-executor", model: "retained" },
		},
	};
	const saved = await saveProjectWorkflowSettings(
		f.a,
		target,
		await readProjectWorkflowSettings(f.a, target, f),
		intent,
		f.options("alpha", f.a, [...slots, { id: "removed", kind: "model" }]),
	);
	await f.author(f.a, "workflows/beta.json");
	await f.save(INTENT, "beta");
	await f.save(INTENT, "alpha", f.b);
	const before = await listProjectWorkflowSettings(f.a, f);
	const otherProject = await readFile(projectWorkflowSettingsPath(f.b, f));
	await rm(join(f.a, "workflows"), { recursive: true });
	const changed = await clearProjectWorkflowSettingsBinding(
		f.a,
		target.key,
		saved,
		{ kind: "slot", slot: "main" },
		f,
	);
	const after = await listProjectWorkflowSettings(f.a, f);
	assert.equal(changed.storeEpoch, saved.storeEpoch);
	assert.notEqual(changed.revision, saved.revision);
	assert.deepEqual(after.workflows[target.key].intent, {
		defaults: INTENT.defaults,
		slots: { removed: intent.slots.removed },
	});
	for (const [key, value] of Object.entries(before.workflows))
		if (key !== target.key) assert.deepEqual(after.workflows[key], value);
	assert.deepEqual(
		await readFile(projectWorkflowSettingsPath(f.b, f)),
		otherProject,
	);
	const bytes = await readFile(projectWorkflowSettingsPath(f.a, f));
	for (const expected of [saved, { ...changed, storeEpoch: "stale" }])
		await assert.rejects(
			clearProjectWorkflowSettingsBinding(
				f.a,
				target.key,
				expected,
				{ kind: "defaults" },
				f,
			),
			ProjectWorkflowSettingsConflict,
		);
	await assert.rejects(
		clearProjectWorkflowSettingsBinding(
			f.a,
			target.key,
			changed,
			{ kind: "slot", slot: "missing" },
			f,
		),
		/does not exist/,
	);
	await assert.rejects(
		clearProjectWorkflowSettingsBinding(
			f.a,
			target.key,
			changed,
			{ kind: "defaults", intent: {} },
			f,
		),
		/Unknown/,
	);
	assert.deepEqual(await readFile(projectWorkflowSettingsPath(f.a, f)), bytes);
	await clearProjectWorkflowSettingsBinding(
		f.a,
		target.key,
		changed,
		{ kind: "defaults" },
		f,
	);
	assert.deepEqual(
		(await readProjectWorkflowSettingsEntry(f.a, target.key, f)).entry.intent,
		{ slots: { removed: intent.slots.removed } },
	);
});

test("binding deletion snapshots the validated selection before yielding", async (t) => {
	const f = await fixture(t);
	const saved = await f.save();
	const target = await f.target();
	const selection = { kind: "slot", slot: "main" };
	const pending = clearProjectWorkflowSettingsBinding(
		f.a,
		target.key,
		saved,
		selection,
		f,
	);
	selection.kind = "defaults";
	selection.slot = "missing";
	await pending;
	assert.deepEqual(
		(await readProjectWorkflowSettingsEntry(f.a, target.key, f)).entry.intent,
		{ defaults: INTENT.defaults, slots: {} },
	);
});
