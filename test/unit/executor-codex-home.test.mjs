// agent-workflow 2026-11-08 (context-quality backlog C1): isolated Codex workers get a private
// CODEX_HOME that links the user's auth.json, config.toml and rules/ and carries no global AGENTS.md.
// Credentials are never copied; the user's home is kept whenever a link could break authentication.
import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import {
	mkdir,
	mkdtemp,
	rm,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	codexCredentialsStore,
	codexSessionHomeDir,
	decideCodexWorkerHome,
	prepareCodexWorkerHome,
	removeCodexSessionHome,
	removeCodexWorkerHome,
	restoreReplacedAuth,
	reuseCodexWorkerHome,
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

	removeCodexWorkerHome(worker);
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
	removeCodexWorkerHome(sparse);
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
	removeCodexWorkerHome(shared);
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
	removeCodexSessionHome(prepared.path);
	assert.equal(existsSync(dir), false);
	assert.equal(
		existsSync(join(home, "auth.json")),
		true,
		"the user's files stay",
	);
});

test("removal moves a refreshed auth.json back when Codex replaced the link with a newer file", async () => {
	// Review F (2026-11-09): only safe while Codex writes auth.json in place; a write by rename would turn
	// the link into a file holding the rotated token, which removal would otherwise delete.
	const scenario = async (privateAgeSeconds) => {
		const home = await userHome();
		const prepared = prepareCodexWorkerHome({
			userHome: home,
			dir: join(root, `attempt-${++counter}`),
			env: noKeys,
		});
		const privateAuth = join(prepared.path, "auth.json");
		await unlink(privateAuth);
		await writeFile(privateAuth, '{"tokens":"rotated"}');
		const when = new Date(Date.now() + privateAgeSeconds * 1000);
		await utimes(privateAuth, when, when);
		removeCodexWorkerHome(prepared);
		assert.equal(existsSync(prepared.path), false);
		return readFileSync(join(home, "auth.json"), "utf8");
	};
	assert.equal(
		await scenario(+60),
		'{"tokens":"rotated"}',
		"newer replacement is restored",
	);
	assert.equal(
		await scenario(-3600),
		'{"tokens":"not-read"}',
		"older replacement leaves the user's file",
	);
	// an intact link: nothing moves
	const home = await userHome();
	const prepared = prepareCodexWorkerHome({
		userHome: home,
		dir: join(root, `attempt-${++counter}`),
		env: noKeys,
	});
	assert.equal(restoreReplacedAuth(prepared.path, home), "linked");
	removeCodexWorkerHome(prepared);
	assert.equal(
		readFileSync(join(home, "auth.json"), "utf8"),
		'{"tokens":"not-read"}',
	);
	assert.equal(lstatSync(join(home, "auth.json")).isSymbolicLink(), false);
});
