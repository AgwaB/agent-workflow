// New in agent-workflow (WP42 review round 1, finding 3): the saved workflow preferences and the
// saved user profiles are read–modify–write stores shared by CLI, MCP and Pi callers. Each
// mutation holds a cross-process directory lock for the whole transaction, so concurrent saves
// never lose an acknowledged change and a set/clear race never resurrects a cleared entry. The
// interleaving is deterministic: the first writer pauses right before its atomic rename.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

const pref = await import("../../dist/hosts/workflow-preferences.js");
const profiles = await import("../../dist/hosts/user-profiles.js");
const atomic = await import("../../dist/core/secure-atomic-write.js");

let root;
let counter = 0;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp42-prefs-lock-")));
});
afterEach(() => atomic.setSecureAtomicBeforeRenameHookForTests(undefined));
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

function freshEnv() {
	counter += 1;
	return {
		...process.env,
		AGENT_WORKFLOW_HOME: join(root, `home${counter}`),
	};
}

/** Pause the first atomic write to `path` before its rename until `release()`. */
function pauseFirstWrite(path) {
	let entered;
	let release;
	const firstEntered = new Promise((resolve) => {
		entered = resolve;
	});
	const firstMayCommit = new Promise((resolve) => {
		release = resolve;
	});
	let writes = 0;
	atomic.setSecureAtomicBeforeRenameHookForTests(async (target) => {
		if (target === path && writes++ === 0) {
			entered();
			await firstMayCommit;
		}
	});
	return { firstEntered, release: () => release() };
}

/** Let the second operation run as far as it can while the first is paused. */
async function settleWhilePaused(second) {
	let done = false;
	second.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 150));
	return done;
}

test("two concurrent workflow-preference saves to different workflows keep both", async () => {
	const env = freshEnv();
	await pref.setWorkflowPreference({ workflow: "initial", profile: "p" }, env);
	const gate = pauseFirstWrite(pref.workflowPreferencesPath(env));
	try {
		const first = pref.setWorkflowPreference(
			{ workflow: "first", profile: "p" },
			env,
		);
		await gate.firstEntered;
		const second = pref.setWorkflowPreference(
			{ workflow: "second", profile: "p" },
			env,
		);
		await settleWhilePaused(second);
		gate.release();
		await Promise.all([first, second]);
	} finally {
		gate.release();
	}
	const saved = Object.keys(
		(await pref.readWorkflowPreferences(env)).workflows,
	);
	assert.deepEqual(saved.sort(), ["first", "initial", "second"]);
});

test("a workflow-preference set/clear race does not resurrect the cleared entry", async () => {
	const env = freshEnv();
	await pref.setWorkflowPreference({ workflow: "doomed", profile: "p" }, env);
	const gate = pauseFirstWrite(pref.workflowPreferencesPath(env));
	try {
		const set = pref.setWorkflowPreference(
			{ workflow: "other", profile: "p" },
			env,
		);
		await gate.firstEntered;
		const clear = pref.clearWorkflowPreference("doomed", env);
		await settleWhilePaused(clear);
		gate.release();
		const [, cleared] = await Promise.all([set, clear]);
		assert.equal(cleared, true);
	} finally {
		gate.release();
	}
	const saved = (await pref.readWorkflowPreferences(env)).workflows;
	assert.ok(
		!Object.hasOwn(saved, "doomed"),
		"the cleared preference stays cleared",
	);
	assert.ok(Object.hasOwn(saved, "other"));
});

test("two concurrent saved-user-profile saves keep both", async () => {
	const env = freshEnv();
	await profiles.setUserProfile(
		{ name: "initial", values: { effort: "low" } },
		env,
	);
	const gate = pauseFirstWrite(profiles.userProfilesPath(env));
	try {
		const first = profiles.setUserProfile(
			{ name: "first", values: { effort: "low" } },
			env,
		);
		await gate.firstEntered;
		const second = profiles.setUserProfile(
			{ name: "second", values: { effort: "high" } },
			env,
		);
		await settleWhilePaused(second);
		gate.release();
		await Promise.all([first, second]);
	} finally {
		gate.release();
	}
	const saved = Object.keys((await profiles.readUserProfiles(env)).profiles);
	assert.deepEqual(saved.sort(), ["first", "initial", "second"]);
});

test("saved-user-profile delete and default races neither resurrect nor drop entries", async () => {
	const env = freshEnv();
	await profiles.setUserProfile(
		{ name: "doomed", values: { effort: "low" } },
		env,
	);
	await profiles.setUserProfile(
		{ name: "kept", values: { effort: "low" } },
		env,
	);
	const gate = pauseFirstWrite(profiles.userProfilesPath(env));
	try {
		const makeDefault = profiles.setDefaultUserProfile("kept", env);
		await gate.firstEntered;
		const deleted = profiles.deleteUserProfile("doomed", env);
		await settleWhilePaused(deleted);
		gate.release();
		await Promise.all([makeDefault, deleted]);
	} finally {
		gate.release();
	}
	const file = await profiles.readUserProfiles(env);
	assert.ok(!Object.hasOwn(file.profiles, "doomed"), "deleted stays deleted");
	assert.equal(file.default, "kept", "the default is kept");
});
