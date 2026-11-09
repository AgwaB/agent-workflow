// agent-workflow 2026-11-08 (context-quality backlog C1): isolated Codex workers get a private
// CODEX_HOME that links the user's auth.json, config.toml and rules/ and carries no global AGENTS.md.
// Credentials are never copied; the user's home is kept whenever a link could break authentication.
import assert from "node:assert/strict";
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	openSync,
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
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	codexCredentialsStore,
	decideCodexWorkerHome,
	prepareCodexWorkerHome,
	removeCodexWorkerHome,
} from "../../dist/executors/codex/home.js";

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
	assert.deepEqual(worker.linked, [
		"auth.json",
		"config.toml",
		"rules",
		"auth.lock",
	]);
	assert.deepEqual(readdirSync(worker.path).sort(), [
		"auth.json",
		"auth.lock",
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
	assert.deepEqual(sparse.linked, ["auth.json", "auth.lock"]);
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

test("a private home under a symlink is never used to move, delete or prepare through", async () => {
	// Round 4/5 reviews (gpt-6-astra): a home (or a directory above it) replaced by a symlink to the user's CODEX_HOME
	// moved the user's auth.json away; preparing through a symlinked directory deleted files at its target.
	const user = await userHome();
	const stateDir = join(root, `state-${++counter}`);
	const keepDir = join(stateDir, "replaced-auth");
	const attempt = join(stateDir, "attempts", "a.log");
	await mkdir(attempt, { recursive: true });
	await symlink(user, join(attempt, "home"));
	const linked = { path: join(attempt, "home"), relocated: true, linked: [] };
	assert.equal(removeCodexWorkerHome(linked, { stateDir, keepDir }), undefined);
	assert.equal(
		readFileSync(join(user, "auth.json"), "utf8"),
		'{"tokens":"not-read"}',
	);
	assert.equal(existsSync(keepDir), false);
	assert.equal(
		lstatSync(join(attempt, "home")).isSymbolicLink(),
		true,
		"left in place",
	);
	// preparing through a symlinked attempt directory leaves the target alone
	const victim = join(root, `victim-${++counter}`);
	await mkdir(join(victim, "home"), { recursive: true });
	await writeFile(join(victim, "home", "auth.json"), "dummy-login");
	await symlink(victim, join(stateDir, "attempts", "b.log"));
	const prepared = prepareCodexWorkerHome({
		userHome: user,
		dir: join(stateDir, "attempts", "b.log"),
		env: noKeys,
		stateDir,
	});
	assert.equal(prepared.relocated, false);
	assert.match(prepared.reason, /not a plain directory/);
	assert.equal(
		readFileSync(join(victim, "home", "auth.json"), "utf8"),
		"dummy-login",
	);
	// a home outside the state directory is refused too
	assert.equal(
		removeCodexWorkerHome(
			{ path: join(user, "x"), relocated: true, linked: [] },
			{ stateDir, keepDir },
		),
		undefined,
	);
});

test("a private home shares the user's auth.lock, so Codex serializes refreshes with the user's own Codex", async () => {
	// Codex 0.166 locks <CODEX_HOME>/auth.lock around every auth.json read/modify/write (storage.rs lock_for_write,
	// manager.rs persist_tokens). The link may dangle: opening it with O_CREAT creates the target in the user's home.
	const home = await userHome();
	const prepared = prepareCodexWorkerHome({
		userHome: home,
		dir: join(root, `attempt-${++counter}`),
		env: noKeys,
	});
	assert.equal(
		lstatSync(join(prepared.path, "auth.lock")).isSymbolicLink(),
		true,
	);
	assert.equal(
		existsSync(join(home, "auth.lock")),
		false,
		"nothing written in the user's home",
	);
	const fd = openSync(
		join(prepared.path, "auth.lock"),
		constants.O_RDWR | constants.O_CREAT,
		0o600,
	);
	closeSync(fd);
	assert.equal(
		statSync(join(prepared.path, "auth.lock")).ino,
		statSync(join(home, "auth.lock")).ino,
		"one lock file",
	);
	// an API-key-only home (no auth.json) gets none
	const keyOnly = prepareCodexWorkerHome({
		userHome: await userHome({ auth: false }),
		dir: join(root, `attempt-${++counter}`),
		env: { ...noKeys, OPENAI_API_KEY: "sk-test" },
	});
	assert.equal(keyOnly.linked.includes("auth.lock"), false);
});
