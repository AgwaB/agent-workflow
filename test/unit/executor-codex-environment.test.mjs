// New in agent-workflow (WP4d): Codex environment probe — `$CODEX_HOME/rules/*.rules` allow rules
// weaken readOnly, a non-empty global `$CODEX_HOME/AGENTS.md` weakens isolation. Temp CODEX_HOME
// only; the stub `codex` answers the version/login/models probe commands (no real CLI).
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createStubCli } from "../../dist/sdk/conformance/index.js";
import * as sdk from "../../dist/sdk/index.js";
import {
	codexCapabilities,
	codexEnvironmentCapabilities,
	codexEnvironmentNotes,
	codexHomeDir,
	countCodexAllowRules,
	createExecutor,
	inspectCodexEnvironment,
} from "../../dist/executors/codex/index.js";

const core = await import("../../dist/core/index.js");

let root;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-codex-env-"));
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

let counter = 0;
async function codexHome({ rules = {}, agents, auth = true, config } = {}) {
	counter += 1;
	const home = join(root, `home-${counter}`);
	await mkdir(join(home, "rules"), { recursive: true });
	for (const [name, text] of Object.entries(rules))
		await writeFile(join(home, "rules", name), text);
	if (agents !== undefined) await writeFile(join(home, "AGENTS.md"), agents);
	if (config !== undefined) await writeFile(join(home, "config.toml"), config);
	if (auth) {
		// Credentials are never read: an unreadable auth.json must not matter.
		await writeFile(join(home, "auth.json"), '{"secret":"do-not-read"}');
		await chmod(join(home, "auth.json"), 0o000);
	}
	return home;
}

test("allow-rule counting: decisions, comments, strings, quoting and layout", () => {
	const text = [
		'prefix_rule(pattern=["git", "status"], decision="allow")',
		"prefix_rule(pattern = ['ls'], decision = 'allow')",
		'prefix_rule(pattern=["rm"], decision="forbidden")',
		'prefix_rule(pattern=["curl"], decision="prompt")',
		'# prefix_rule(pattern=["x"], decision="allow")',
		'prefix_rule(pattern=["echo", "decision=\\"allow\\""], decision="prompt")  # decision="allow"',
		"prefix_rule(",
		'    pattern=["make"],',
		'    decision="allow",',
		'    justification="""multi',
		'line decision="allow" text""",',
		")",
		'prefix_rule(pattern=["npm"], decision=r"allow")',
		'x = decision == "allow"',
	].join("\n");
	assert.equal(countCodexAllowRules(text), 4);
	assert.equal(countCodexAllowRules(""), 0);
	assert.equal(countCodexAllowRules('decision="allow'), 1);
});

test("CODEX_HOME defaults to ~/.codex and honors the environment", () => {
	assert.equal(codexHomeDir({ CODEX_HOME: "/tmp/x" }), "/tmp/x");
	assert.match(codexHomeDir({}), /\.codex$/);
	assert.match(codexHomeDir({ CODEX_HOME: "" }), /\.codex$/);
});

// C1 (2026-11-08): with a file-store login the workers get a private home without the global
// AGENTS.md, so its presence no longer weakens isolation; the rules warning is unchanged.
test("allow rules > 0 → readOnly emulated with a count-only warning; global AGENTS.md present → native when workers get a private home", async () => {
	const home = await codexHome({
		rules: {
			"default.rules":
				'prefix_rule(pattern=["secret-cmd"], decision="allow")\nprefix_rule(pattern=["b"], decision="allow")\n',
			"extra.rules": 'prefix_rule(pattern=["c"], decision="allow")\n',
			"notes.md": 'prefix_rule(pattern=["d"], decision="allow")\n',
		},
		agents: "# Global instructions\nAlways answer in French.\n",
	});
	const findings = inspectCodexEnvironment({
		...process.env,
		CODEX_HOME: home,
	});
	assert.deepEqual(
		{ ...findings, problems: [...findings.problems] },
		{
			codexHome: home,
			rulesPath: join(home, "rules"),
			rulesFiles: 2,
			allowRules: 3,
			forbiddenRules: 0,
			promptRules: 0,
			requirementsPath: process.env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH,
			disallowedFreeModes: [],
			agentsPath: join(home, "AGENTS.md"),
			globalAgentsMd: "present",
			workerHome: {
				relocate: true,
				credentialsStore: "file",
				authFile: "present",
			},
			problems: [],
		},
	);
	const caps = codexEnvironmentCapabilities(findings);
	assert.deepEqual(caps.readOnly, {
		level: "emulated",
		source: "probed",
		warning: `3 allow rules in ${join(home, "rules")} let matching commands run without approval`,
	});
	assert.deepEqual(caps.contextIsolation, {
		level: "native",
		source: "probed",
	});
	assert.ok(
		codexEnvironmentNotes(findings).some((note) =>
			note.startsWith("worker home: private CODEX_HOME per attempt"),
		),
	);
	assert.equal(JSON.stringify(caps).includes("secret-cmd"), false);
	assert.equal(JSON.stringify(caps).includes("French"), false);

	// Without a file-store login the home stays shared and the global AGENTS.md still weakens isolation.
	const keyring = inspectCodexEnvironment({
		...process.env,
		CODEX_HOME: await codexHome({
			agents: "# Global instructions\nAlways answer in French.\n",
			config: 'cli_auth_credentials_store = "keyring"\n',
		}),
	});
	assert.deepEqual(keyring.workerHome, {
		relocate: false,
		reason:
			'cli_auth_credentials_store="keyring" keys credentials by the home path',
		credentialsStore: "keyring",
		authFile: "present",
	});
	assert.deepEqual(codexEnvironmentCapabilities(keyring).contextIsolation, {
		level: "emulated",
		source: "probed",
		warning: `global ${keyring.agentsPath} is loaded into every Codex worker (private worker home not used: cli_auth_credentials_store="keyring" keys credentials by the home path)`,
	});
	const noAuth = inspectCodexEnvironment({
		...process.env,
		CODEX_HOME: await codexHome({ agents: "# Global\nrule\n", auth: false }),
	});
	assert.equal(noAuth.workerHome.relocate, false);
	assert.equal(
		codexEnvironmentCapabilities(noAuth).contextIsolation.level,
		"emulated",
	);
});

test("no allow rules, AGENTS.md absent or empty → readOnly untouched, isolation native", async () => {
	const absent = inspectCodexEnvironment({
		...process.env,
		CODEX_HOME: await codexHome({
			rules: {
				"default.rules": 'prefix_rule(pattern=["rm"], decision="forbidden")\n',
			},
		}),
	});
	assert.equal(absent.allowRules, 0);
	assert.equal(absent.globalAgentsMd, "absent");
	assert.deepEqual(codexEnvironmentCapabilities(absent), {
		contextIsolation: {
			level: "emulated",
			source: "probed",
			warning: `1 forbidden exec-policy rule(s) in ${absent.rulesPath} will deny matching commands even in free mode; review the rules with your administrator or use a compatible executor`,
		},
	});
	assert.equal(codexEnvironmentCapabilities(absent).readOnly, undefined);
	const empty = inspectCodexEnvironment({
		...process.env,
		CODEX_HOME: await codexHome({ agents: "  \n" }),
	});
	assert.equal(empty.globalAgentsMd, "empty");
	assert.deepEqual(codexEnvironmentCapabilities(empty).contextIsolation, {
		level: "native",
		source: "probed",
	});
	// A missing CODEX_HOME entirely is the same as "nothing found".
	const missing = inspectCodexEnvironment({
		...process.env,
		CODEX_HOME: join(root, "does-not-exist"),
	});
	assert.equal(missing.allowRules, 0);
	assert.equal(missing.globalAgentsMd, "absent");
	assert.deepEqual(missing.problems, []);
});

async function stubCodex() {
	counter += 1;
	const dir = join(root, `stub-${counter}`);
	await mkdir(dir, { recursive: true });
	const cli = await createStubCli({
		dir,
		name: "codex",
		scripts: [
			{
				name: "version",
				when: { argvIncludes: ["--version"] },
				effect: false,
				steps: [{ stdout: "codex-cli 0.159.2" }],
			},
			{
				name: "login",
				when: { argvIncludes: ["login", "status"] },
				effect: false,
				steps: [{ stderr: "Logged in using ChatGPT" }],
			},
			{
				name: "models",
				when: { argvIncludes: ["debug", "models"] },
				effect: false,
				steps: [{ stdout: { models: [{ slug: "m", visibility: "list" }] } }],
			},
		],
	});
	return { cli, dir };
}

test("probe() reports the environment rows and B4 negotiation degrades (or refuses under strict)", async () => {
	// C1: a keyring login keeps the shared home, so the global AGENTS.md still weakens isolation.
	const home = await codexHome({
		rules: {
			"default.rules": 'prefix_rule(pattern=["a"], decision="allow")\n'.repeat(
				5,
			),
		},
		agents: "global\n",
		config: 'cli_auth_credentials_store = "keyring"\n',
	});
	const { cli, dir } = await stubCodex();
	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = home;
	let probe;
	try {
		const executor = createExecutor({
			codexPath: cli.path,
			stateDir: join(dir, "state"),
		});
		probe = await executor.probe();
	} finally {
		if (previous === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previous;
	}
	assert.equal(probe.installed, true);
	assert.equal(probe.auth, "ok");
	assert.match(probe.capabilities.readOnly.warning, /^5 allow rules in /);
	assert.match(
		probe.capabilities.contextIsolation.warning,
		/AGENTS\.md is loaded/,
	);
	assert.ok(
		probe.notes.some((note) =>
			/^exec-policy rules: 5 allow rules in 1 file under /.test(note),
		),
	);
	assert.ok(probe.notes.some((note) => /AGENTS\.md present$/.test(note)));
	const merged = sdk.mergeProbedCapabilities(
		codexCapabilities(),
		probe.capabilities,
	);
	const report = sdk.negotiateCapabilities(
		{ id: "codex", version: "0.1.0" },
		merged,
		{ readOnly: true, hasRequiredReads: false, interactive: true },
	);
	assert.equal(report.accepted, true);
	// WP12a: Codex reports no cost; it is recorded as unknown (record-only, no confirmation).
	assert.deepEqual(report.degradations, [
		"CAPABILITY_WARNING:readOnly",
		"CAPABILITY_MISSING:usage.cost",
		"CAPABILITY_WARNING:contextIsolation",
	]);
	assert.equal(report.needsConfirmation, undefined);
	const strict = sdk.negotiateCapabilities(
		{ id: "codex", version: "0.1.0" },
		merged,
		{
			readOnly: true,
			hasRequiredReads: false,
			strict: ["readOnly", "contextIsolation"],
		},
	);
	assert.deepEqual(strict.refusals, [
		"CAPABILITY_STRICT:readOnly",
		"CAPABILITY_STRICT:contextIsolation",
	]);
});

test("engine probe of the codex adapter (stub CLI, clean CODEX_HOME): isolation probed native, readOnly declared", async () => {
	const home = await codexHome();
	const { cli, dir } = await stubCodex();
	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = home;
	try {
		const { summary, capabilities } = await core.probeWorkflowExecutor({
			id: "codex",
			version: "0.1.0",
			contractVersion: "0.1.0",
			module: new URL("../../dist/executors/codex/index.js", import.meta.url)
				.pathname,
			config: { codexPath: cli.path, stateDir: join(dir, "state") },
		});
		assert.equal(summary.installed, true);
		assert.equal(summary.cliVersion, "0.159.2");
		assert.equal(summary.auth, "ok");
		assert.deepEqual(capabilities.contextIsolation, {
			source: "probed",
			level: "native",
		});
		assert.equal(capabilities.readOnly.level, "native");
		assert.equal(capabilities.readOnly.warning, undefined);
	} finally {
		if (previous === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previous;
	}
});
