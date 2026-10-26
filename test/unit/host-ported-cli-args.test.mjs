// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) tests that were deferred until WP11a because they
// needed src/extension.ts (the `/workflow` argument parsers and launch-profile resolution) or
// src/cli.mjs (inspect, prune, supervise). MIT, same author. The command behavior now lives in the
// host API (src/hosts/api.ts) and the `agent-workflow` CLI (src/hosts/cli). Sources and changes:
//   surface-regressions.test.mjs: "slash options fail closed and command whitespace is consistent"
//     (changed: `dynamic --profile` is accepted now, saved user profiles apply to dynamic runs),
//     "actual CLI rejects invalid numeric and unknown options before store access" (exit 2, was 1),
//     "actual scheduler failed supervise --all is nonzero", "actual scheduler blocked supervise --all
//     exits 2; mixed failure takes precedence" (changed: blocked exits 1 under the unified exit-code
//     contract; the structured supervise result keeps blocked vs failed and the precedence),
//     "supervise completed/empty batches succeed and historical failures do not contaminate later
//     batches".
//   review-core-fixes.test.mjs: "IR1-08 duplicate selectors and retired routing flags reject in every
//     position, literals remain literal"; "IR1-08 actual RPC command and terminal CLI reject
//     malformed/duplicate prune and launch controls" (CLI half; the RPC half calls the host parser);
//     "IR1-08 actual slash and CLI prune share safe integers and duplicate scalar rejection" (slash
//     half → host API pruneAction; CLI usage errors exit 2, was 1); "IR1-09 actual long-path catalog
//     pages bound serialized content AND details and recover all rows" (workflow_list tool → host
//     listWorkflowsAction with limit 20; checks text and data).
//   surface-regressions.test.mjs "workflow_list execution bounds huge metadata and provides
//     actionable continuation" (workflow_list tool → listWorkflowsAction with limit 20; the typed
//     request has no unknown-key check, MCP hosts validate their input schema).
//   unlimited-supervisor.test.mjs: all 4 cases, through superviseAction with an injected clock and
//     scheduler instead of a copied cli.mjs over fake dist modules.
//   workflow-authoring-gates.test.mjs: the 2 "inspect --failures --results" tests (paths
//     .agent-workflow/workflows).
//   review-runtime-retention-depth.test.mjs: "RR-02 actual CLI rejects mirror validation failure and
//     preserves primary and mirror evidence" (--json output is {action, ok, outcome, data}).
//   execution-profiles.test.mjs: "--profile parses from leading, trailing, and equals forms; quoted
//     stays literal", "profile selection is explicit-first, default-aware, and supports base
//     selection".
//   workflow-router.test.mjs: "explicit run and dynamic reject retired routing flags while preserving
//     quoted task text".
//   workflow-user-profiles.test.mjs: "invalid, corrupt, and simultaneous writes preserve complete
//     unrelated settings", "launch precedence is explicit, then saved, then the legacy declared
//     selector" (settings under AGENT_WORKFLOW_HOME).
// Not ported here (Pi host / TUI, WP11b or dropped): see docs/host-api.md "Ported pi-workflow tests".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { parseWorkflow } from "../../dist/core/schema.js";
import * as store from "../../dist/core/store.js";
import {
	createCustomProfileFromBuiltin,
	loadWorkflowProfilePreference,
	resolveSavedWorkflowExecutionProfile,
	saveWorkflowProfilePreference,
	workflowProfileIdentity,
} from "../../dist/core/workflow-profile-settings.js";
import {
	listWorkflowsAction,
	parseWorkflowDynamicArgs,
	parseWorkflowPruneArgs,
	parseWorkflowRunArgs,
	pruneAction,
	resolveWorkflowExecutionProfileForLaunch,
	selectWorkflowExecutionProfile,
	superviseAction,
} from "../../dist/hosts/api.js";

const CLI = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);
const ROOT = mkdtempSync(join(tmpdir(), "aw-host-ported-"));
const previousHome = process.env.AGENT_WORKFLOW_HOME;
after(() => {
	if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME;
	else process.env.AGENT_WORKFLOW_HOME = previousHome;
	rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let counter = 0;
function scratch(prefix) {
	counter += 1;
	const dir = join(ROOT, `${prefix}-${counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
const cli = (cwd, args) =>
	spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
	});

// ---- argument parsers (surface-regressions, review-core-fixes, execution-profiles, router) ----

test("slash options fail closed and command whitespace is consistent", () => {
	for (const option of [
		"--model",
		"--profile",
		"--thinking",
		"--reasoning",
		"--model=",
		"--profile=",
		"--typo",
	])
		assert.throws(
			() => parseWorkflowRunArgs(`run deep-research "task" ${option}`),
			/option|value|Unsupported|Unknown/i,
			option,
		);
	assert.throws(
		() => parseWorkflowRunArgs('run deep-research "task" --model --detach'),
		/value/i,
	);
	// Changed (WP11a): dynamic runs accept --profile (saved user profiles); was rejected.
	assert.equal(
		parseWorkflowDynamicArgs('dynamic --profile high "task"').profile,
		"high",
	);
	for (const space of ["\t", "\n", " "]) {
		assert.equal(
			parseWorkflowRunArgs(`run${space}deep-research "task"`).specPath,
			"deep-research",
		);
		assert.equal(
			parseWorkflowDynamicArgs(`dynamic${space}"task"`).task,
			"task",
		);
	}
	assert.equal(
		parseWorkflowRunArgs('run deep-research "literal --unknown text"').task,
		"literal --unknown text",
	);
	assert.throws(
		() => parseWorkflowRunArgs('run deep-research "unterminated'),
		/Unterminated/,
	);
});

const conflicts = [
	"--model A --model B",
	"--profile low --profile high",
	"--thinking low --reasoning high",
	"--route --no-route",
];

test("IR1-08 duplicate selectors and retired routing flags reject in every position, literals remain literal", () => {
	for (const opts of conflicts)
		for (const input of [
			`run ${opts} deep-review "task"`,
			`run deep-review "task" ${opts}`,
		])
			assert.throws(
				() => parseWorkflowRunArgs(input),
				/duplicate|conflict|no longer supported/i,
				input,
			);
	for (const input of [
		'run --model A deep-review "task" --model B',
		'run --route deep-review "task" --no-route',
		'dynamic --model A "task" --model B',
	])
		assert.throws(
			() =>
				input.startsWith("run")
					? parseWorkflowRunArgs(input)
					: parseWorkflowDynamicArgs(input),
			/duplicate|conflict|no longer supported/i,
		);
	assert.equal(
		parseWorkflowRunArgs(
			'run deep-review "--route --no-route --model A --model B"',
		).task,
		"--route --no-route --model A --model B",
	);
});

test("--profile parses from leading, trailing, and equals forms; quoted stays literal", () => {
	assert.equal(
		parseWorkflowRunArgs('run --profile eco profile-target "Task"').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run --profile=eco profile-target "Task"').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Task" --profile eco').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Keep --profile eco inside"')
			.profile,
		undefined,
	);
});

test("explicit run and dynamic reject retired routing flags while preserving quoted task text", () => {
	assert.throws(
		() => parseWorkflowRunArgs('run --route target "task"'),
		/use \/workflow auto/i,
	);
	assert.throws(
		() => parseWorkflowDynamicArgs('dynamic --no-route "task"'),
		/use \/workflow auto/i,
	);
	assert.equal(
		parseWorkflowRunArgs('run target "literal --route is task text"').task,
		"literal --route is task text",
	);
	assert.equal(
		parseWorkflowDynamicArgs('dynamic "literal --no-route is task text"').task,
		"literal --no-route is task text",
	);
});

// ---- launch profile resolution (execution-profiles, workflow-user-profiles) ----

function output() {
	return { analysis: { required: true }, refs: { required: true } };
}

function profileSpec(overrides = {}) {
	return {
		schemaVersion: 1,
		name: "profile-target",
		defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
		executionProfiles: {
			"cost conscious": {
				one: { model: "profile/model", thinking: "low" },
				two: { thinking: "high" },
			},
			identity: {},
		},
		artifactGraph: {
			stages: [
				{
					id: "one",
					type: "single",
					thinking: "high",
					output: output(),
					prompt: "Step one.",
				},
				{
					id: "two",
					type: "single",
					thinking: "xhigh",
					output: output(),
					prompt: "Step two.",
				},
			],
		},
		...overrides,
	};
}

function writeProfileSpec(cwd, spec) {
	const dir = join(cwd, ".agent-workflow", "workflows", "profile-target");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
}

test("profile selection is explicit-first, default-aware, and supports base selection", async () => {
	const cwd = scratch("execution-profiles");
	writeProfileSpec(
		cwd,
		profileSpec({
			defaultExecutionProfile: "cost conscious",
			executionProfiles: { "cost conscious": {}, zebra: {}, alpha: {} },
		}),
	);
	assert.equal(
		await selectWorkflowExecutionProfile("profile-target", cwd, undefined),
		"cost conscious",
	);
	assert.equal(
		await selectWorkflowExecutionProfile(
			"profile-target",
			cwd,
			"zebra",
			async () => {
				throw new Error("must not prompt");
			},
		),
		"zebra",
	);
	let options;
	assert.equal(
		await selectWorkflowExecutionProfile(
			"profile-target",
			cwd,
			undefined,
			async (_title, choices) => {
				options = choices;
				return choices[1];
			},
		),
		"alpha",
	);
	assert.deepEqual(options, [
		"Profile: cost conscious",
		"Profile: alpha",
		"Profile: zebra",
		"Base (no profile)",
	]);
	assert.equal(
		await selectWorkflowExecutionProfile(
			"profile-target",
			cwd,
			undefined,
			async (_title, choices) => choices.at(-1),
		),
		undefined,
		"interactive callers can explicitly run the base spec despite a default",
	);
	writeProfileSpec(
		cwd,
		profileSpec({ executionProfiles: { zebra: {}, alpha: {} } }),
	);
	assert.equal(
		await selectWorkflowExecutionProfile("profile-target", cwd, undefined),
		undefined,
	);
	assert.equal(
		await selectWorkflowExecutionProfile(
			"profile-target",
			cwd,
			undefined,
			async (_title, choices) => {
				assert.deepEqual(choices, [
					"Profile: alpha",
					"Profile: zebra",
					"Base (no profile)",
				]);
				return "Base (no profile)";
			},
		),
		undefined,
	);
	writeProfileSpec(cwd, profileSpec({ executionProfiles: undefined }));
	assert.equal(
		await selectWorkflowExecutionProfile("profile-target", cwd, undefined),
		undefined,
	);
});

const OTHER = "local/other";
const MODELS = [
	{
		provider: "openai-codex",
		id: "gpt-6.1-sol",
		fullId: "openai-codex/gpt-6.1-sol",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	},
	{
		provider: "openai-codex",
		id: "gpt-6-luna",
		fullId: "openai-codex/gpt-6-luna",
		reasoning: true,
	},
	{
		provider: "anthropic",
		id: "claude-opus-5-5",
		fullId: "anthropic/claude-opus-5-5",
		reasoning: true,
	},
	{
		provider: "local",
		id: "other",
		fullId: OTHER,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
];

function roleStage(id, profileRole) {
	return { id, type: "single", profileRole, prompt: id, output: output() };
}

function roleSpec(name = "role-profile") {
	return {
		schemaVersion: 1,
		name,
		defaults: { agent: "scout", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				roleStage("plan", "planning"),
				roleStage("research", "research-execution"),
				roleStage("synthesize", "synthesis"),
				roleStage("verify", "verification"),
				roleStage("judge", "final-judgment"),
			],
		},
	};
}

function setup(name) {
	const root = scratch(name);
	const agentDir = join(root, "agent-home");
	const workflowPath = join(root, "workflow", "spec.json");
	mkdirSync(dirname(workflowPath), { recursive: true });
	process.env.AGENT_WORKFLOW_HOME = agentDir;
	return { root, agentDir, workflowPath };
}

function writeSpec(path, spec) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
}

function context(spec, specPath, overrides = {}) {
	return {
		spec,
		specPath,
		availableModels: MODELS,
		currentRuntime: { model: OTHER, thinking: "medium" },
		...overrides,
	};
}

test("invalid, corrupt, and simultaneous writes preserve complete unrelated settings", async () => {
	const { agentDir, workflowPath } = setup("settings-failures");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "codex" },
	);
	const identity = await workflowProfileIdentity(spec, workflowPath);
	const before = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{
					selectedProfile: "custom",
					custom: { baseProfile: "current", stages: {} },
				},
			),
		/Custom workflow profile stage settings do not match/,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), before);
	const malformedCustom = createCustomProfileFromBuiltin(spec, "codex");
	malformedCustom.stages.plan.model = {
		kind: "inherit",
		unexpected: true,
	};
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{ selectedProfile: "custom", custom: malformedCustom },
			),
		/unknown field unexpected/,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), before);

	const unrelatedFile = join(agentDir, "unrelated.json");
	writeFileSync(unrelatedFile, "keep-me\n");
	const concurrentCustom = createCustomProfileFromBuiltin(spec, "claude");
	concurrentCustom.stages.plan.model = { kind: "fixed", value: OTHER };
	await Promise.all([
		saveWorkflowProfilePreference(
			{ spec, specPath: workflowPath },
			{ selectedProfile: "custom", custom: concurrentCustom },
		),
		saveWorkflowProfilePreference(
			{ spec, specPath: workflowPath },
			{ selectedProfile: "mixed" },
		),
	]);
	const complete = JSON.parse(readFileSync(identity.settingsFile, "utf8"));
	assert.ok(["custom", "mixed"].includes(complete.selectedProfile));
	assert.equal(complete.stages.length, 5);
	assert.equal(complete.custom.stages.plan.model.value, OTHER);
	assert.equal(readFileSync(unrelatedFile, "utf8"), "keep-me\n");

	const mismatched = structuredClone(complete);
	mismatched.stages[0].profileRole = "verification";
	writeFileSync(identity.settingsFile, JSON.stringify(mismatched));
	const mismatchedBytes = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/settings are corrupt.*stage metadata does not match.*file was not changed/s,
	);
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{ selectedProfile: "mixed" },
			),
		/settings are corrupt.*file was not changed/s,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), mismatchedBytes);

	const unknownField = { ...complete, unexpected: true };
	writeFileSync(identity.settingsFile, JSON.stringify(unknownField));
	const unknownBytes = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/unknown field unexpected.*file was not changed/s,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), unknownBytes);

	const wrongFingerprint =
		identity.definitionFingerprint === "0".repeat(64)
			? "1".repeat(64)
			: "0".repeat(64);
	writeFileSync(
		identity.settingsFile,
		JSON.stringify({ ...complete, definitionFingerprint: wrongFingerprint }),
	);
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/definitionFingerprint does not match the settings filename.*file was not changed/s,
	);

	writeFileSync(identity.settingsFile, Buffer.from([0xff]));
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/unreadable or invalid.*utf-8.*file was not changed/s,
	);

	writeFileSync(identity.settingsFile, "x".repeat(1_048_577));
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/exceeds size limit.*file was not changed/s,
	);
	rmSync(identity.settingsFile);
	mkdirSync(identity.settingsFile);
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/not a stable regular file.*file was not changed/s,
	);
	rmSync(identity.settingsFile, { recursive: true });
	symlinkSync(unrelatedFile, identity.settingsFile);
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/ELOOP|symbolic|too many symbolic links/i,
	);
	assert.equal(readFileSync(unrelatedFile, "utf8"), "keep-me\n");
	rmSync(identity.settingsFile);

	writeFileSync(identity.settingsFile, "{ definitely broken");
	const corruptBytes = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/unreadable or invalid.*file was not changed/s,
	);
	assert.deepEqual(
		await resolveWorkflowExecutionProfileForLaunch(
			workflowPath,
			dirname(workflowPath),
			"declared-recovery",
		),
		{ executionProfile: "declared-recovery" },
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), corruptBytes);
});

test("launch precedence is explicit, then saved, then the legacy declared selector", async () => {
	const { workflowPath } = setup("launch-precedence");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	let selected = 0;
	const explicit = await resolveWorkflowExecutionProfileForLaunch(
		workflowPath,
		dirname(workflowPath),
		"declared-fast",
		{
			select: async () => {
				selected += 1;
				return undefined;
			},
		},
	);
	assert.deepEqual(explicit, { executionProfile: "declared-fast" });
	assert.equal(selected, 0);

	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "claude" },
	);
	const loadedWorkflow = { spec, specPath: workflowPath };
	const saved = await resolveWorkflowExecutionProfileForLaunch(
		workflowPath,
		dirname(workflowPath),
		undefined,
		{
			loadedWorkflow,
			availableModels: MODELS,
			currentRuntime: { model: OTHER, thinking: "medium" },
			select: async () => {
				selected += 1;
				return undefined;
			},
		},
	);
	assert.equal(saved.executionProfileOverride.name, "Claude");
	assert.equal(saved.executionProfile, undefined);
	assert.equal(selected, 0);

	const resolved = await resolveSavedWorkflowExecutionProfile(
		context(spec, workflowPath),
	);
	assert.equal(
		resolved.definitionFingerprint,
		(await workflowProfileIdentity(spec, workflowPath)).definitionFingerprint,
	);
	assert.deepEqual(saved.executionProfileOverride, resolved);
});

// ---- inspect (workflow-authoring-gates) ----

test("inspect --failures --results falls back to every task result on a clean run", async () => {
	const cwd = scratch("inspect-flags");
	const runDir = join(cwd, ".agent-workflow", "workflows", "workflow_gate");
	await mkdir(join(runDir, "tasks", "task-1"), { recursive: true });
	await writeFile(
		join(runDir, "tasks", "task-1", "result.md"),
		"FINAL RESULT BODY\n",
	);
	await writeFile(
		join(runDir, "run.json"),
		`${JSON.stringify({
			runId: "workflow_gate",
			name: "unit",
			type: "artifact-graph",
			status: "completed",
			tasks: [
				{
					taskId: "task-1",
					status: "completed",
					statusDetail: "completed",
					files: {
						result:
							".agent-workflow/workflows/workflow_gate/tasks/task-1/result.md",
					},
				},
			],
		})}\n`,
	);
	const combined = cli(cwd, [
		"inspect",
		"workflow_gate",
		"--failures",
		"--results",
	]);
	assert.equal(combined.status, 0, combined.stderr);
	assert.match(combined.stdout, /failures: none \(showing every task result\)/);
	assert.match(combined.stdout, /FINAL RESULT BODY/);
	const failuresOnly = cli(cwd, ["inspect", "workflow_gate", "--failures"]);
	assert.equal(failuresOnly.status, 0, failuresOnly.stderr);
	assert.doesNotMatch(failuresOnly.stdout, /task-1/);
	assert.doesNotMatch(failuresOnly.stdout, /showing every task result/);
});

test("inspect --failures --results keeps failure-only listing when a task failed", async () => {
	const cwd = scratch("inspect-failures");
	const runDir = join(cwd, ".agent-workflow", "workflows", "workflow_fail");
	await mkdir(join(runDir, "tasks", "task-2"), { recursive: true });
	await writeFile(
		join(runDir, "tasks", "task-2", "result.md"),
		"FAILED BODY\n",
	);
	await writeFile(
		join(runDir, "run.json"),
		`${JSON.stringify({
			runId: "workflow_fail",
			name: "unit",
			type: "artifact-graph",
			status: "failed",
			tasks: [
				{ taskId: "task-1", status: "completed", statusDetail: "completed" },
				{
					taskId: "task-2",
					status: "failed",
					statusDetail: "failed",
					files: {
						result:
							".agent-workflow/workflows/workflow_fail/tasks/task-2/result.md",
					},
				},
			],
		})}\n`,
	);
	const result = cli(cwd, [
		"inspect",
		"workflow_fail",
		"--failures",
		"--results",
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /task-2: failed/);
	assert.match(result.stdout, /FAILED BODY/);
	assert.doesNotMatch(result.stdout, /task-1/);
	assert.doesNotMatch(result.stdout, /showing every task result/);
});

// ---- prune (review-runtime-retention-depth, review-core-fixes) ----

const exists = (path) =>
	stat(path).then(
		() => true,
		() => false,
	);

test("RR-02 actual CLI rejects mirror validation failure and preserves primary and mirror evidence", async () => {
	const cwd = scratch("rr02");
	const parent = "workflow_parent";
	const timestamp = "2026-01-01T00:00:00.000Z";
	const dir = join(cwd, ".agent-workflow", "workflows", parent);
	await mkdir(join(dir, "dynamic"), { recursive: true });
	await writeFile(
		join(dir, "run.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId: parent,
			createdAt: timestamp,
			updatedAt: timestamp,
			tasks: [
				{
					taskId: `${parent}-task`,
					specId: "adaptive.controller",
					status: "completed",
				},
			],
		}),
	);
	const outside = join(cwd, "mirror-evidence");
	await mkdir(outside);
	await writeFile(join(outside, "evidence"), "recover me");
	const mirror = join(cwd, ".agent-workflow", "workflow-subagents", parent);
	await mkdir(join(mirror, ".."), { recursive: true });
	await symlink(outside, mirror);
	await store.updateIndex(cwd);
	const result = cli(cwd, ["prune", "--keep", "0", "--yes", "--json"]);
	assert.notEqual(result.status, 0, result.stdout + result.stderr);
	const summary = JSON.parse(result.stdout).data;
	assert.ok(summary.error);
	assert.equal(summary.runs[0].detached, false);
	assert.equal(await exists(dir), true);
	assert.equal(await readFile(join(mirror, "evidence"), "utf8"), "recover me");
	assert.equal((await store.readIndex(cwd)).runs[0].runId, parent);
});

test("IR1-08 actual host and CLI prune share safe integers and duplicate scalar rejection", async () => {
	const cwd = scratch("ir108-prune");
	for (const args of [
		["--keep", "9007199254740992"],
		["--keep", ""],
		["--keep", "1.5"],
		["--keep", "1", "--keep", "2"],
		["--older-than", "1", "--older-than", "2"],
		["--older-than", " "],
	]) {
		assert.throws(() => parseWorkflowPruneArgs(args), JSON.stringify(args));
		await assert.rejects(
			pruneAction({ cwd }, { argv: args }),
			JSON.stringify(args),
		);
		const result = cli(cwd, ["prune", ...args]);
		assert.equal(result.status, 2, JSON.stringify(args) + result.stdout);
	}
	for (const value of ["9007199254740991", "0"])
		assert.equal(
			(await pruneAction({ cwd }, { argv: ["--keep", value] })).outcome,
			"success",
		);
	const positive = cli(cwd, ["prune", "--keep", "9007199254740991"]);
	assert.equal(positive.status, 0, positive.stderr);
});

// ---- supervise (surface-regressions, review-core-fixes, unlimited-supervisor) ----

test("actual CLI rejects invalid numeric and unknown options before store access", () => {
	const cwd = scratch("cli-options");
	for (const args of [
		["supervise", "--all", "--poll-ms"],
		["supervise", "--all", "--max-runtime-ms", "garbage"],
		["supervise", "--all", "--max-runtime-ms", "Infinity"],
		["supervise", "--all", "--poll-ms", "1.5"],
		["supervise", "--all", "--poll-ms", "-1"],
		["supervise", "--all", "--poll-ms", ""],
		["supervise", "--all", "workflow_x"],
		["supervise", "--all", "--poll-ms", "250", "--poll-ms", "300"],
		[
			"supervise",
			"--all",
			"--max-runtime-ms",
			"1000",
			"--max-runtime-ms",
			"2000",
		],
		["inspect", "workflow_x", "--typo"],
		["prune", "--keep", ""],
		["prune", "--older-than", " "],
		["prune", "--keep", "9007199254740992"],
	]) {
		const result = cli(cwd, args);
		// Changed (WP11a): usage errors exit 2 (was 1).
		assert.equal(result.status, 2, args.join(" "));
		assert.match(
			result.stderr,
			/requires|argument|option|cannot|exclusive|Duplicate/i,
			result.stderr,
		);
	}
});

async function localRun(
	cwd,
	behavior = 'throw new Error("local failure")',
	dynamic = false,
) {
	const specPath = join(cwd, "spec.json");
	await writeFile(
		join(cwd, "helper.mjs"),
		`export default async()=>{${behavior}}`,
	);
	const spec = parseWorkflow({
		schemaVersion: 1,
		name: "local-only",
		artifactGraph: {
			stages: [
				dynamic
					? {
							id: "fixture",
							type: "dynamic",
							dynamic: {
								uses: "./helper.mjs",
								permissions: { approval: "ask" },
							},
						}
					: { id: "fixture", support: { uses: "./helper.mjs" } },
			],
		},
	});
	await writeFile(specPath, JSON.stringify(spec));
	const compiled = await compileWorkflow(spec, {
		cwd,
		specPath,
		task: "local support only",
	});
	const { run } = await store.createWorkflowRunRecord(cwd, compiled, specPath);
	await store.writeStaticRunArtifacts(cwd, run, compiled, spec);
	await store.writeRunRecord(cwd, run);
	return run;
}

test("actual scheduler failed supervise --all is nonzero", async () => {
	const cwd = scratch("supervise-failed");
	const run = await localRun(cwd);
	const result = cli(cwd, ["supervise", "--all", "--max-runtime-ms", "5000"]);
	assert.equal((await store.readRunRecord(cwd, run.runId)).status, "failed");
	assert.equal(result.status, 1, result.stdout + result.stderr);
});

test("actual scheduler blocked supervise --all is nonzero; mixed failure takes precedence", async () => {
	const cwd = scratch("supervise-blocked");
	const run = await localRun(
		cwd,
		'throw new Error("must not run without approval")',
		true,
	);
	const result = cli(cwd, ["supervise", "--all", "--max-runtime-ms", "5000"]);
	assert.equal((await store.readRunRecord(cwd, run.runId)).status, "blocked");
	// Changed (WP11a): blocked exits 1 (was 2); the structured result keeps "blocked".
	assert.equal(result.status, 1, result.stdout + result.stderr);
	const blockedAgain = scratch("supervise-blocked-api");
	await localRun(
		blockedAgain,
		'throw new Error("must not run without approval")',
		true,
	);
	assert.equal(
		(
			await superviseAction(
				{ cwd: blockedAgain },
				{ all: true, maxRuntimeMs: 5000 },
			)
		).data.result,
		"blocked",
	);
	const mixed = scratch("supervise-mixed");
	await localRun(
		mixed,
		'throw new Error("must not run without approval")',
		true,
	);
	await localRun(mixed);
	assert.equal(
		cli(mixed, ["supervise", "--all", "--max-runtime-ms", "5000"]).status,
		1,
	);
	const mixedApi = scratch("supervise-mixed-api");
	await localRun(
		mixedApi,
		'throw new Error("must not run without approval")',
		true,
	);
	await localRun(mixedApi);
	assert.equal(
		(
			await superviseAction(
				{ cwd: mixedApi },
				{ all: true, maxRuntimeMs: 5000 },
			)
		).data.result,
		"failed",
	);
});

test("supervise completed/empty batches succeed and historical failures do not contaminate later batches", async () => {
	const cwd = scratch("supervise-batches");
	assert.equal(cli(cwd, ["supervise", "--all"]).status, 0);
	await localRun(cwd);
	assert.equal(cli(cwd, ["supervise", "--all"]).status, 1);
	await localRun(cwd, 'return {control:{},analysis:"done",refs:[]}');
	const result = cli(cwd, ["supervise", "--all", "--max-runtime-ms", "5000"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [name, rounds, maxRuntimeMs, expected] of [
	["finite default retains supervisor deadline", 2, undefined, "timeout"],
	[
		"unlimited loop removes implicit supervisor deadline",
		null,
		undefined,
		"completed",
	],
	[
		"explicit zero removes finite workflow supervisor deadline",
		2,
		0,
		"completed",
	],
	[
		"explicit finite supervisor override still applies to unlimited loop",
		null,
		1000,
		"timeout",
	],
])
	test(name, async () => {
		const cwd = scratch("unlimited-supervisor");
		const run = await localRun(
			cwd,
			'return {control:{},analysis:"done",refs:[]}',
		);
		await writeFile(
			store.compiledWorkflowPath(cwd, run.runId),
			JSON.stringify({
				stages: [{ id: "trials", type: "loop", maxRounds: rounds }],
			}),
		);
		// Advance only this supervisor's clock beyond the former four-hour cutoff per reading.
		let clock = 0;
		let calls = 0;
		const lines = [];
		const result = await superviseAction(
			{ cwd },
			{
				runId: run.runId,
				pollMs: 250,
				...(maxRuntimeMs === undefined ? {} : { maxRuntimeMs }),
				onLog: (line) => lines.push(line),
				testHooks: {
					now: () => ++clock * 18_000_000,
					sleep: async () => undefined,
					schedule: async () => {
						if (++calls !== 2) return;
						const file = store.workflowRunPath(cwd, run.runId);
						const record = JSON.parse(readFileSync(file, "utf8"));
						for (const task of record.tasks) {
							task.status = "completed";
							task.statusDetail = "completed";
						}
						record.status = "completed";
						writeFileSync(file, JSON.stringify(record));
					},
				},
			},
		);
		assert.equal(result.data.result, expected, lines.join("\n"));
		if (expected === "completed") {
			assert.match(lines[0], /runtime unlimited/);
			assert.match(lines.at(-1), new RegExp(`done: ${run.runId} completed`));
		} else assert.match(lines.at(-1), /giving up after --max-runtime-ms/);
	});

// ---- list paging (review-core-fixes IR1-09) ----

test("IR1-09 actual long-path catalog pages bound serialized content AND details and recover all rows", async (t) => {
	const cwd = scratch("ir109");
	let agentRoot = scratch("ir109-agent");
	// Linux supports paths >3KB; Darwin has a smaller PATH_MAX. The same test runs on both.
	for (let i = 0; i < (process.platform === "linux" ? 30 : 5); i++)
		agentRoot = join(agentRoot, `${i}-${"d".repeat(96)}`);
	const workflows = join(agentRoot, "workflows");
	await mkdir(workflows, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentRoot;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const paths = new Set();
	for (let i = 0; i < 35; i++) {
		const stem = `longcatalog-${String(i).padStart(3, "0")}-${"x".repeat(230)}`;
		const path = join(workflows, `${stem}.json`);
		paths.add(path);
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				name: stem,
				description: "D".repeat(100000),
				defaults: {
					agent: `agent-${"a".repeat(120)}`,
					readOnly: true,
					tools: ["read"],
				},
				artifactGraph: {
					stages: [{ id: "one", type: "single", prompt: "Work." }],
				},
			}),
		);
	}
	let offset = 0;
	const seen = new Set();
	do {
		const result = await listWorkflowsAction(
			{ cwd },
			{ query: "longcatalog-", offset, limit: 20 },
		);
		for (const value of [result.text, result.data]) {
			const serialized = JSON.stringify(value);
			assert.ok(
				Buffer.byteLength(serialized) <= 50 * 1024,
				`${Buffer.byteLength(serialized)} bytes`,
			);
			assert.ok(serialized.split("\n").length <= 2000);
		}
		assert.ok(result.text.split("\n").length <= 2000);
		assert.ok(result.data.workflows.length > 0);
		assert.equal(result.data.total, 35);
		for (const row of result.data.workflows) {
			assert.ok(paths.has(row.specPath));
			assert.ok(!seen.has(row.specPath));
			seen.add(row.specPath);
		}
		if (result.data.nextOffset !== undefined)
			assert.equal(
				result.data.nextOffset,
				offset + result.data.workflows.length,
			);
		offset = result.data.nextOffset;
	} while (offset !== undefined);
	assert.equal(seen.size, 35);
});

test("workflow_list execution bounds huge metadata and provides actionable continuation", async (t) => {
	const cwd = scratch("list-bounds");
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	t.after(() => {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
	});
	await mkdir(join(cwd, "workflows"), { recursive: true });
	for (let i = 0; i < 80; i++)
		await writeFile(
			join(cwd, "workflows", `catalog-${i}.json`),
			JSON.stringify({
				schemaVersion: 1,
				name: `catalog-${i}`,
				description: "X".repeat(100000),
				artifactGraph: {
					stages: [{ id: "fixture", support: { uses: "./helper.mjs" } }],
				},
			}),
		);
	for (const params of [
		{ offset: -1, limit: 20 },
		{ offset: null, limit: 20 },
		{ limit: Number.POSITIVE_INFINITY },
		{ limit: 0 },
		{ limit: 21 },
		{ query: 42, limit: 20 },
	])
		await assert.rejects(() => listWorkflowsAction({ cwd }, params), /list/);
	const result = await listWorkflowsAction({ cwd }, { limit: 20 });
	const text = result.text;
	assert.match(text, /catalog-/);
	assert.ok(result.data.workflows.length > 0);
	assert.ok(Buffer.byteLength(text) <= 50 * 1024);
	assert.ok(text.split("\n").length <= 2000);
	assert.match(text, /omitted/i);
	assert.match(text, /offset|query|read .*spec/i);
	const next = await listWorkflowsAction(
		{ cwd },
		{ offset: result.data.nextOffset, query: "catalog-", limit: 20 },
	);
	assert.ok(next.data.workflows.length > 0);
	assert.notEqual(next.data.workflows[0].name, result.data.workflows[0].name);
});
