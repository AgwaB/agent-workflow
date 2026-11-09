// agent-workflow 2026-11-08 (context-quality backlog C1): isolated Codex workers get a private
// CODEX_HOME that links the user's auth.json, config.toml and rules/ and carries no global AGENTS.md.
// Credentials are never copied; the user's home is kept whenever a link could break authentication.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";

import {
	codexCredentialsStore,
	codexSessionHomeDir,
	decideCodexWorkerHome,
	prepareCodexWorkerHome,
	removeCodexSessionHome,
	acquireCodexSessionDeletion,
	codexSessionHomeDeleting,
	codexSessionHomeInUse,
	releaseCodexSessionLease,
	writeCodexSessionLease,
	removeCodexWorkerHome,
	reuseCodexWorkerHome,
	sweepOrphanCodexSessionHomes,
} from "../../dist/executors/codex/home.js";
import { processStartIdentity } from "../../dist/executors/codex/state.js";

let root;
let counter = 0;
before(async () => {
	root = realpathSync(await mkdtemp(join(tmpdir(), "aw-codex-home-")));
});
after(() => rm(root, { recursive: true, force: true }));

async function userHome({
	auth = true,
	config,
	agents = true,
	rules = true,
} = {}) {
	counter += 1;
	const home = join(root, `user-${counter}`);
	await mkdir(home, { recursive: true });
	if (auth) await writeFile(join(home, "auth.json"), '{"tokens":"not-read"}');
	if (config !== undefined) await writeFile(join(home, "config.toml"), config);
	if (agents)
		await writeFile(
			join(home, "AGENTS.md"),
			"# Global\nAlways answer in French.\n",
		);
	if (rules) {
		await mkdir(join(home, "rules"));
		await writeFile(
			join(home, "rules", "default.rules"),
			'prefix_rule(pattern=["ls"], decision="allow")\n',
		);
	}
	return home;
}
const noKeys = { PATH: process.env.PATH };

test("credentials store: codex's default is file; only the top-level key counts", async () => {
	assert.equal(codexCredentialsStore(await userHome()), "file");
	assert.equal(
		codexCredentialsStore(
			await userHome({ config: 'model = "gpt-5.6-luna"\n' }),
		),
		"file",
	);
	assert.equal(
		codexCredentialsStore(
			await userHome({
				config: 'cli_auth_credentials_store = "keyring" # secure\n',
			}),
		),
		"keyring",
	);
	assert.equal(
		codexCredentialsStore(
			await userHome({ config: 'cli_auth_credentials_store = "Auto"\n' }),
		),
		"auto",
	);
	assert.equal(
		codexCredentialsStore(
			await userHome({
				config: '[profiles.x]\ncli_auth_credentials_store = "keyring"\n',
			}),
		),
		"file",
	);
	assert.equal(
		codexCredentialsStore(
			await userHome({ config: 'cli_auth_credentials_store = "vault"\n' }),
		),
		"unknown",
	);
	assert.equal(codexCredentialsStore(join(root, "missing")), "file");
});

test("decision: relocate for file-store users with credentials; keep the user's home otherwise, with the reason", async () => {
	const home = await userHome();
	assert.deepEqual(decideCodexWorkerHome({ userHome: home, env: noKeys }), {
		relocate: true,
		credentialsStore: "file",
		authFile: "present",
	});
	assert.deepEqual(
		decideCodexWorkerHome({ userHome: home, env: noKeys, inherit: true }),
		{
			relocate: false,
			reason: "stage inherits user context",
			credentialsStore: "file",
			authFile: "present",
		},
	);
	for (const store of ["keyring", "auto", "ephemeral"]) {
		const decision = decideCodexWorkerHome({
			userHome: await userHome({
				config: `cli_auth_credentials_store = "${store}"\n`,
			}),
			env: noKeys,
		});
		assert.equal(decision.relocate, false, store);
		assert.match(
			decision.reason,
			new RegExp(
				`cli_auth_credentials_store="${store}" keys credentials by the home path`,
			),
		);
	}
	const noAuth = await userHome({ auth: false });
	const kept = decideCodexWorkerHome({ userHome: noAuth, env: noKeys });
	assert.equal(kept.relocate, false);
	assert.match(kept.reason, /no auth\.json in .* and no API-key variable/);
	assert.equal(kept.authFile, "absent");
	// An API key in the environment needs no auth.json.
	assert.equal(
		decideCodexWorkerHome({
			userHome: noAuth,
			env: { ...noKeys, OPENAI_API_KEY: "sk-test" },
		}).relocate,
		true,
	);
	assert.equal(
		decideCodexWorkerHome({
			userHome: noAuth,
			env: { ...noKeys, CODEX_API_KEY: " " },
		}).relocate,
		false,
	);
});

test("prepare links auth.json, config.toml and rules; no AGENTS.md, no copies; remove drops links only", async () => {
	const home = await userHome({ config: 'model = "gpt-5.6-luna"\n' });
	const dir = join(root, `attempt-${counter}.log`);
	await mkdir(dir, { recursive: true });
	const worker = prepareCodexWorkerHome({ userHome: home, dir, env: noKeys });
	assert.equal(worker.relocated, true);
	assert.equal(worker.path, join(dir, "home"));
	assert.deepEqual(worker.linked, ["auth.json", "config.toml", "rules"]);
	assert.deepEqual(readdirSync(worker.path).sort(), [
		"auth.json",
		"config.toml",
		"rules",
	]);
	for (const name of ["auth.json", "config.toml", "rules"]) {
		assert.ok(lstatSync(join(worker.path, name)).isSymbolicLink(), name);
		assert.equal(realpathSync(join(worker.path, name)), join(home, name));
	}
	assert.equal(existsSync(join(worker.path, "AGENTS.md")), false);
	assert.equal(existsSync(join(worker.path, "AGENTS.override.md")), false);
	// Through the link, a worker reads and writes the user's one credential file.
	assert.equal(
		readFileSync(join(worker.path, "auth.json"), "utf8"),
		'{"tokens":"not-read"}',
	);
	await writeFile(join(worker.path, "auth.json"), '{"tokens":"refreshed"}');
	assert.equal(
		readFileSync(join(home, "auth.json"), "utf8"),
		'{"tokens":"refreshed"}',
	);

	removeCodexWorkerHome(worker, {
		stateDir: root,
		keepDir: join(root, `kept-${++counter}`),
	});
	assert.equal(existsSync(worker.path), false);
	assert.equal(
		readFileSync(join(home, "auth.json"), "utf8"),
		'{"tokens":"refreshed"}',
	);
	assert.ok(
		existsSync(join(home, "rules", "default.rules")),
		"rules target survives",
	);
	assert.ok(existsSync(join(home, "AGENTS.md")));

	// Partial user homes link what exists; a kept home is never removed.
	const sparse = prepareCodexWorkerHome({
		userHome: await userHome({ rules: false, agents: false }),
		dir,
		env: noKeys,
	});
	assert.deepEqual(sparse.linked, ["auth.json"]);
	removeCodexWorkerHome(sparse, {
		stateDir: root,
		keepDir: join(root, `kept-${++counter}`),
	});
	const shared = prepareCodexWorkerHome({
		userHome: home,
		dir,
		env: noKeys,
		inherit: true,
	});
	assert.deepEqual(shared, {
		path: home,
		relocated: false,
		reason: "stage inherits user context",
		linked: [],
	});
	removeCodexWorkerHome(shared, {
		stateDir: root,
		keepDir: join(root, `kept-${++counter}`),
	});
	assert.ok(existsSync(join(home, "auth.json")));
});

test("a kept session's home lives outside the attempt, is reused with its links, and is removed with the session", async () => {
	// Re-review 2026-11-09 (gpt-6-astra, claude-fable-5-1): the first fix used the user's home for kept
	// sessions, dropping the isolation the probe advertised.
	const home = await userHome({ config: 'model = "x"\n' });
	const stateDir = join(root, `state-${++counter}`);
	const dir = codexSessionHomeDir(stateDir, "session-1\u0000attempt-1");
	assert.notEqual(
		dir,
		codexSessionHomeDir(stateDir, "session-1\u0000attempt-2"),
	);
	const prepared = prepareCodexWorkerHome({ userHome: home, dir, env: noKeys });
	assert.equal(prepared.relocated, true);
	assert.ok(prepared.path.startsWith(dir));
	// a link that went missing is restored on reuse; the directory is not wiped
	await rm(join(prepared.path, "config.toml"), { force: true });
	await writeFile(join(prepared.path, "thread-rollout.jsonl"), "{}\n");
	const reused = reuseCodexWorkerHome(prepared.path, home);
	assert.equal(reused.relocated, true);
	assert.equal(
		lstatSync(join(prepared.path, "config.toml")).isSymbolicLink(),
		true,
	);
	assert.equal(existsSync(join(prepared.path, "thread-rollout.jsonl")), true);
	removeCodexSessionHome(prepared.path, {
		stateDir: root,
		keepDir: join(root, `kept-${++counter}`),
	});
	assert.equal(existsSync(dir), false);
	assert.equal(
		existsSync(join(home, "auth.json")),
		true,
		"the user's files stay",
	);
});

test("removal never writes over the user's auth.json: a file that replaced the link is kept aside", async () => {
	// Review F, round 3 (gpt-6-astra): restoring by mtime overwrote a newer or another account's login and broke a
	// symlinked credential store. Linking is safe while Codex writes in place; otherwise the file is only kept.
	for (const age of [+60, -3600]) {
		const home = await userHome();
		const keepDir = join(root, `kept-${++counter}`);
		const prepared = prepareCodexWorkerHome({
			userHome: home,
			dir: join(root, `attempt-${++counter}`),
			env: noKeys,
		});
		const privateAuth = join(prepared.path, "auth.json");
		await unlink(privateAuth);
		await writeFile(privateAuth, '{"tokens":"rotated"}', { mode: 0o644 });
		const when = new Date(Date.now() + age * 1000);
		await utimes(privateAuth, when, when);
		const kept = removeCodexWorkerHome(prepared, { stateDir: root, keepDir });
		assert.equal(existsSync(prepared.path), false);
		assert.equal(
			readFileSync(join(home, "auth.json"), "utf8"),
			'{"tokens":"not-read"}',
		);
		assert.ok(kept?.startsWith(keepDir), `kept at ${kept}`);
		assert.equal(readFileSync(kept, "utf8"), '{"tokens":"rotated"}');
		assert.equal(statSync(kept).mode & 0o777, 0o600);
	}
	// an intact link: nothing is kept and the user's file stays a file
	const home = await userHome();
	const keepDir = join(root, `kept-${++counter}`);
	const prepared = prepareCodexWorkerHome({
		userHome: home,
		dir: join(root, `attempt-${++counter}`),
		env: noKeys,
	});
	assert.equal(
		removeCodexWorkerHome(prepared, { stateDir: root, keepDir }),
		undefined,
	);
	assert.equal(existsSync(keepDir), false);
	assert.equal(lstatSync(join(home, "auth.json")).isSymbolicLink(), false);
	// a file that cannot be kept: the home stays rather than deleting the only copy
	const stuck = prepareCodexWorkerHome({
		userHome: home,
		dir: join(root, `attempt-${++counter}`),
		env: noKeys,
	});
	await unlink(join(stuck.path, "auth.json"));
	await writeFile(join(stuck.path, "auth.json"), "rotated");
	const blocker = join(root, `blocker-${++counter}`);
	await writeFile(blocker, "not a directory");
	assert.equal(
		removeCodexWorkerHome(stuck, {
			stateDir: root,
			keepDir: join(blocker, "kept"),
		}),
		undefined,
	);
	assert.equal(readFileSync(join(stuck.path, "auth.json"), "utf8"), "rotated");
});

test("a kept session's home lease counts only while its process lives", () => {
	const dir = codexSessionHomeDir(join(root, `state-${++counter}`), "lease");
	const path = join(dir, "home");
	assert.equal(codexSessionHomeInUse(path), false);
	writeCodexSessionLease(path, "attempt-1", [process.pid]);
	const release = () => releaseCodexSessionLease(path, "attempt-1");
	assert.equal(codexSessionHomeInUse(path), true);
	release();
	assert.equal(codexSessionHomeInUse(path), false);
	writeCodexSessionLease(path, "attempt-2", [2 ** 22 + 12345]);
	assert.equal(
		codexSessionHomeInUse(path),
		false,
		"a dead process holds no lease",
	);
});

test("a lease names its process by start time, so a reused pid does not hold it", async () => {
	// 2026-11-09: a crashed attempt's pid reused by another process kept deletion failing.
	const dir = codexSessionHomeDir(join(root, `state-${++counter}`), "reuse");
	const path = join(dir, "home");
	assert.ok(processStartIdentity(process.pid), "start time readable here");
	writeCodexSessionLease(path, "attempt-1", [process.pid]);
	const release = () => releaseCodexSessionLease(path, "attempt-1");
	assert.equal(codexSessionHomeInUse(path), true);
	release();
	await mkdir(join(dir, "leases"), { recursive: true });
	const leaseFile = join(dir, "leases", "reused.json");
	await writeFile(
		leaseFile,
		JSON.stringify({
			pid: process.pid,
			attemptKey: "old",
			start: "another process",
		}),
	);
	assert.equal(
		codexSessionHomeInUse(path),
		false,
		"same pid, different start: not held",
	);
	await writeFile(
		leaseFile,
		JSON.stringify({ pid: process.pid, attemptKey: "old" }),
	);
	assert.equal(
		codexSessionHomeInUse(path),
		true,
		"a lease without a start time still counts",
	);
});

test("orphan kept-session homes are swept: old, unrecorded and unleased only", async () => {
	const home = await userHome({ config: 'model = "x"\n' });
	const stateDir = join(root, `state-${++counter}`);
	const keepDir = join(stateDir, "replaced-auth");
	const make = (key) =>
		prepareCodexWorkerHome({
			userHome: home,
			dir: codexSessionHomeDir(stateDir, key),
			env: noKeys,
		}).path;
	const orphan = make("orphan");
	const recorded = make("recorded");
	const young = make("young");
	const leased = make("leased");
	const replaced = make("replaced");
	writeCodexSessionLease(leased, "attempt-leased", [process.pid]);
	await unlink(join(replaced, "auth.json"));
	await writeFile(join(replaced, "auth.json"), "rotated");
	const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
	const recent = new Date(now - 60 * 60 * 1000);
	await utimes(join(young, ".."), recent, recent);
	const removed = sweepOrphanCodexSessionHomes({
		stateDir,
		recordedHomes: new Set([recorded]),
		keepDir,
		now,
	});
	assert.deepEqual(
		removed.map((dir) => join(dir, "home")).sort(),
		[orphan, replaced].sort(),
	);
	for (const kept of [recorded, young, leased])
		assert.equal(existsSync(kept), true, kept);
	assert.equal(existsSync(join(orphan, "..")), false);
	assert.deepEqual(
		readdirSync(keepDir).length,
		1,
		"the replaced auth.json is kept, not deleted",
	);
	assert.equal(
		readFileSync(join(home, "auth.json"), "utf8"),
		'{"tokens":"not-read"}',
	);
});

test("round 4: a private home replaced by a symlink is never used to move or delete a login", async () => {
	// gpt-6-astra: a session home pointing at the user's CODEX_HOME moved the user's auth.json away.
	const user = await userHome();
	const stateDir = join(root, `state-${++counter}`);
	const dir = codexSessionHomeDir(stateDir, "linked");
	await mkdir(dir, { recursive: true });
	await symlink(user, join(dir, "home"));
	const keepDir = join(stateDir, "replaced-auth");
	assert.equal(
		removeCodexSessionHome(join(dir, "home"), { stateDir, keepDir }),
		undefined,
	);
	assert.equal(
		readFileSync(join(user, "auth.json"), "utf8"),
		'{"tokens":"not-read"}',
	);
	assert.equal(existsSync(keepDir), false);
	assert.equal(
		lstatSync(join(dir, "home")).isSymbolicLink(),
		true,
		"left in place",
	);
	// a symlinked directory above the home, and a home outside the state directory, are refused too
	const above = join(stateDir, "session-homes", "linked-parent");
	await mkdir(join(root, `real-${++counter}`, "home"), { recursive: true });
	await writeFile(
		join(root, `real-${counter}`, "home", "auth.json"),
		"not-a-link",
	);
	await symlink(join(root, `real-${counter}`), above);
	assert.equal(
		removeCodexSessionHome(join(above, "home"), { stateDir, keepDir }),
		undefined,
	);
	assert.equal(
		existsSync(join(root, `real-${counter}`, "home", "auth.json")),
		true,
	);
	assert.equal(
		removeCodexSessionHome(join(user, "x", "home"), { stateDir, keepDir }),
		undefined,
	);
});

test("round 4: lease storage failures fail closed", async () => {
	const dir = codexSessionHomeDir(join(root, `state-${++counter}`), "broken");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "leases"), "not a directory");
	assert.throws(() =>
		writeCodexSessionLease(join(dir, "home"), "a", [process.pid]),
	);
	assert.equal(
		codexSessionHomeInUse(join(dir, "home")),
		true,
		"unreadable leases: in use",
	);
	const other = codexSessionHomeDir(
		join(root, `state-${++counter}`),
		"malformed",
	);
	await mkdir(join(other, "leases"), { recursive: true });
	await writeFile(join(other, "leases", "x.json"), "{not json");
	assert.equal(
		codexSessionHomeInUse(join(other, "home")),
		true,
		"malformed lease: in use",
	);
});

test("round 4: a process start time reads the same in every time zone", () => {
	const code = `import(${JSON.stringify(new URL("../../dist/executors/codex/state.js", import.meta.url).href)}).then((s) => process.stdout.write(String(s.processStartIdentity(${process.pid}))))`;
	const read = (TZ) =>
		execFileSync(process.execPath, ["-e", code], {
			env: { ...process.env, TZ },
			encoding: "utf8",
		});
	assert.equal(read("UTC"), read("Asia/Seoul"));
	assert.notEqual(read("UTC"), "undefined");
});

test("round 4: the sweep keeps a home whose record spelled its path differently", async () => {
	const home = await userHome({ config: 'model = "x"\n' });
	const stateDir = join(root, `state-${++counter}`);
	const prepared = prepareCodexWorkerHome({
		userHome: home,
		dir: codexSessionHomeDir(stateDir, "spelled"),
		env: noKeys,
	});
	const relativeRecord = relative(process.cwd(), prepared.path);
	const removed = sweepOrphanCodexSessionHomes({
		stateDir,
		recordedHomes: new Set([relativeRecord]),
		keepDir: join(stateDir, "replaced-auth"),
		now: Date.now() + 3 * 24 * 60 * 60 * 1000,
	});
	assert.deepEqual(removed, []);
	assert.equal(existsSync(prepared.path), true);
});

test("round 4: one live deletion holds a session; a stale marker does not", async () => {
	const dir = codexSessionHomeDir(join(root, `state-${++counter}`), "deleting");
	await mkdir(join(dir, "home"), { recursive: true });
	const path = join(dir, "home");
	const release = acquireCodexSessionDeletion(path);
	assert.equal(typeof release, "function");
	assert.equal(codexSessionHomeDeleting(path), true);
	assert.equal(
		acquireCodexSessionDeletion(path),
		undefined,
		"a second deletion waits",
	);
	release();
	assert.equal(codexSessionHomeDeleting(path), false);
	await writeFile(
		join(dir, "deleting.json"),
		JSON.stringify({ pid: 2 ** 22 + 4321 }),
	);
	assert.equal(codexSessionHomeDeleting(path), false, "dead holder");
	assert.equal(typeof acquireCodexSessionDeletion(path), "function");
});
