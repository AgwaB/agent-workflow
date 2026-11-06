import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	inspectCodexEnvironment,
	codexEnvironmentCapabilities,
	codexPolicyWarnings,
	countCodexRules,
} from "../../dist/executors/codex/environment.js";
import {
	inspectClaudeEnvironment,
	claudeEnvironmentCapabilities,
	claudeEnvironmentWarnings,
} from "../../dist/executors/claude/environment.js";
import { codexCapabilities } from "../../dist/executors/codex/capabilities.js";
import { claudeCapabilities } from "../../dist/executors/claude/capabilities.js";
import { createExecutor as claudeExecutor } from "../../dist/executors/claude/index.js";
import { createExecutor as codexExecutor } from "../../dist/executors/codex/index.js";
import {
	mergeProbedCapabilities,
	negotiateCapabilities,
} from "../../dist/sdk/index.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";
import { doctorAction } from "../../dist/hosts/doctor.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "aw-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = {
		...process.env,
		CODEX_HOME: join(root, "codex"),
		AGENT_WORKFLOW_HOME: join(root, "workflow"),
		AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH: join(root, "requirements.toml"),
		AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH: join(
			root,
			"managed-settings.json",
		),
	};
	await mkdir(join(env.CODEX_HOME, "rules"), { recursive: true });
	return { root, env };
}
const inspect = (env, uid = 1000) =>
	inspectClaudeEnvironment(env, { uid, platform: "linux" });

test("Codex counts all decisions without interpreting comments, strings, patterns or unknown decisions", () => {
	assert.deepEqual(
		countCodexRules(`
# decision="forbidden"
prefix_rule(pattern=["secret decision=\\\"forbidden\\\""], decision="allow")
prefix_rule(pattern=['b'], decision = 'forbidden')
prefix_rule(pattern=['c'], decision = r'prompt')
x = decision == "prompt"
justification = '''decision="forbidden"'''
decision="unknown"
`),
		{ allow: 1, forbidden: 1, prompt: 1 },
	);
});

test("Codex managed requirements: root arrays, comments, trailing commas, literal strings, absent keys and table isolation", async (t) => {
	const { env } = await fixture(t);
	for (const [text, expected] of [
		[
			'allowed_sandbox_modes = ["read-only", "workspace-write"]\nallowed_approval_policies = ["on-request"]',
			["danger-full-access", "never"],
		],
		[
			"allowed_sandbox_modes = [\n 'read-only', # danger-full-access is not allowed\n]\nallowed_approval_policies = ['never',]\n",
			["danger-full-access"],
		],
		["allowed_approval_policies = []", ["never"]],
		[
			'allowed_sandbox_modes = ["danger-full-access"]\nallowed_approval_policies = ["never"]',
			[],
		],
		["# allowed_sandbox_modes = []\n[other]\nallowed_sandbox_modes = []", []],
		['unrelated = "allowed_sandbox_modes=[]"', []],
	]) {
		await writeFile(env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH, text);
		const findings = inspectCodexEnvironment(env);
		assert.deepEqual(findings.disallowedFreeModes, expected, text);
		assert.deepEqual(findings.problems, []);
	}
});

test("Codex uninspectable requirements warn rather than pretending the mode is permitted", async (t) => {
	const { env } = await fixture(t);
	for (const text of [
		"allowed_sandbox_modes = false",
		'allowed_approval_policies = ["never"',
		"allowed_sandbox_modes = [123]",
	]) {
		await writeFile(env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH, text);
		assert.match(
			codexPolicyWarnings(inspectCodexEnvironment(env)).join("; "),
			/cannot fully inspect.*administrator/,
		);
	}
	await rm(env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH);
	await mkdir(env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH);
	assert.match(
		codexPolicyWarnings(inspectCodexEnvironment(env)).join("; "),
		/cannot read.*administrator/,
	);
});

test("Claude managed settings: bypass disabled and deny/ask counts, but no patterns or account data", async (t) => {
	const { env } = await fixture(t);
	await writeFile(
		env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH,
		JSON.stringify({
			account: "private-account",
			permissions: {
				disableBypassPermissionsMode: "disable",
				deny: ["Bash(secret-command:*)", "Read(private-path)"],
				ask: ["Bash(mkdir:*)"],
			},
		}),
	);
	const findings = inspect(env);
	assert.equal(findings.bypassDisabled, true);
	assert.equal(findings.denyRules, 2);
	assert.equal(findings.askRules, 1);
	const warnings = claudeEnvironmentWarnings(findings);
	assert.equal(warnings.length, 3);
	assert.match(warnings[0], /cannot use bypassPermissions.*administrator/);
	assert.match(
		warnings[1],
		/2 managed permissions.deny.*even in bypassPermissions/,
	);
	assert.match(
		warnings[2],
		/answers supported requests automatically.*provider-only interaction may be denied/,
	);
	for (const secret of [
		"secret-command",
		"private-path",
		"private-account",
		"mkdir",
	])
		assert.equal(
			JSON.stringify({ findings, warnings }).includes(secret),
			false,
		);
});

test("Claude absent/empty policy is quiet; invalid/unreadable settings and root have actionable warnings", async (t) => {
	const { env } = await fixture(t);
	assert.deepEqual(claudeEnvironmentWarnings(inspect(env)), []);
	for (const settings of [
		{},
		{ permissions: {} },
		{
			permissions: { disableBypassPermissionsMode: "allow", deny: [], ask: [] },
		},
	]) {
		await writeFile(
			env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH,
			JSON.stringify(settings),
		);
		assert.deepEqual(claudeEnvironmentWarnings(inspect(env)), []);
	}
	for (const text of [
		"{invalid secret",
		"null",
		'{"permissions":[]}',
		'{"permissions":{"deny":"private-rule"}}',
	]) {
		await writeFile(env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH, text);
		const warnings = claudeEnvironmentWarnings(inspect(env));
		assert.match(
			warnings.join("; "),
			/cannot inspect.*policy may block.*administrator/,
		);
		assert.equal(warnings.join("; ").includes("private-rule"), false);
	}
	await rm(env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH);
	await mkdir(env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH);
	assert.match(
		claudeEnvironmentWarnings(inspect(env)).join("; "),
		/cannot inspect/,
	);
	assert.match(
		claudeEnvironmentWarnings(inspect(env, 0)).join("; "),
		/running as root.*refuses bypassPermissions.*non-root/,
	);
});

async function blocked(t) {
	const fixtureData = await fixture(t);
	const { env } = fixtureData;
	await writeFile(
		join(env.CODEX_HOME, "rules", "policy.rules"),
		'prefix_rule(pattern=["private-command"], decision="forbidden")\nprefix_rule(pattern=["private-command"], decision="prompt")',
	);
	await writeFile(
		env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH,
		'allowed_sandbox_modes=["read-only"]\nallowed_approval_policies=["on-request"]',
	);
	await writeFile(
		env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH,
		'{"permissions":{"disableBypassPermissionsMode":"disable","deny":["private-rule"],"ask":["private-rule"]}}',
	);
	return fixtureData;
}

test("both probes return policy notes/capability warnings without any model call", async (t) => {
	const { root, env } = await blocked(t);
	const previous = { ...process.env };
	Object.assign(process.env, env);
	t.after(() => {
		for (const key of Object.keys(env)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	});
	const cli = await createStubCli({
		dir: root,
		scripts: [
			{
				when: { argvIncludes: ["--version"] },
				effect: false,
				steps: [{ stdout: "CLI 2.1.318" }],
			},
			{
				when: { argvIncludes: ["auth", "status"] },
				effect: false,
				steps: [{ stdout: { loggedIn: true } }],
			},
			{
				when: { argvIncludes: ["login", "status"] },
				effect: false,
				steps: [{ stderr: "Logged in using ChatGPT" }],
			},
			{
				when: { argvIncludes: ["debug", "models"] },
				effect: false,
				steps: [{ stdout: { models: [] } }],
			},
		],
	});
	for (const [id, executor] of [
		[
			"codex",
			codexExecutor({ codexPath: cli.path, stateDir: join(root, "cstate") }),
		],
		[
			"claude",
			claudeExecutor({
				claudePath: cli.path,
				stateDir: join(root, "clstate"),
				listModels: false,
			}),
		],
	]) {
		const probe = await executor.probe();
		assert.equal(probe.installed, true);
		assert.equal(probe.auth, "ok");
		assert.equal(probe.capabilities.contextIsolation.level, "emulated");
		assert.match(
			probe.capabilities.contextIsolation.warning,
			id === "codex" ? /forbidden exec-policy/ : /disableBypassPermissionsMode/,
		);
		assert.equal(JSON.stringify(probe).includes("private-rule"), false);
		assert.equal(JSON.stringify(probe).includes("private-command"), false);
	}
	assert.equal(await cli.effectCount(), 0);
});

test("check/run capability negotiation records provider warnings in free mode without confirmation or refusal", async (t) => {
	const { env } = await blocked(t);
	for (const [id, base, rows] of [
		[
			"codex",
			codexCapabilities(),
			codexEnvironmentCapabilities(inspectCodexEnvironment(env)),
		],
		[
			"claude",
			claudeCapabilities("append"),
			claudeEnvironmentCapabilities(inspect(env)),
		],
	]) {
		const report = negotiateCapabilities(
			{ id, version: "0.1.0" },
			mergeProbedCapabilities(base, rows),
			{
				permissionMode: "free",
				strict: ["contextIsolation"],
				hasRequiredReads: false,
			},
		);
		assert.equal(report.accepted, true);
		assert.equal(report.needsConfirmation, false);
		assert.deepEqual(report.refusals, []);
		assert.ok(
			report.degradations.includes("CAPABILITY_WARNING:contextIsolation"),
		);
		assert.match(
			report.entries.find(
				(entry) => entry.code === "CAPABILITY_WARNING:contextIsolation",
			).note,
			/administrator/,
		);
	}
});

test("doctor includes both providers' policy warnings and root warning, counts/paths only", async (t) => {
	const { root, env } = await blocked(t);
	const result = await doctorAction(
		{ cwd: root, host: "cli", env },
		{
			nodeVersion: "24.0.0",
			claudeEnvironment: { uid: 0, platform: "linux" },
			prober: async () => ({
				probe: { installed: true, cliVersion: "2.1.318", auth: "ok" },
				capabilities: {},
			}),
		},
	);
	const warnings = result.data.warnings;
	for (const pattern of [
		/codex: 1 forbidden/,
		/codex: 1 prompt/,
		/codex: managed requirements.*disallow danger-full-access and never/,
		/claude: managed settings.*disableBypassPermissionsMode/,
		/claude: 1 managed permissions.deny/,
		/claude: 1 managed permissions.ask/,
		/claude: running as root/,
	])
		assert.ok(
			warnings.some((warning) => pattern.test(warning)),
			pattern.toString(),
		);
	assert.equal(JSON.stringify(result).includes("private-command"), false);
	assert.equal(JSON.stringify(result).includes("private-rule"), false);
});
