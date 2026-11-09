// test-tier: integration
// New in agent-workflow (WP35, feature-parity row 57): `pi-web-access` guidance. The package stays
// unbundled (C2: the CLIs' own web tools). The Pi executor's probe detects whether the user's Pi has
// it (`pi list`), and when a stage needs web tools and they are missing, the install instruction
// appears in the capability preview, the refusal message, the submit-time refusal and
// `agent-workflow doctor`. Stub Pi CLIs only; no model or agent-CLI calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import {
	piCapabilities,
	piWebAccessGuidance,
	PI_WEB_ACCESS_INSTALL,
} from "../../dist/executors/pi/executor.js";
import { createExecutor } from "../../dist/executors/pi/index.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
	formatNegotiationPreview,
	isSdkError,
	mergeProbedCapabilities,
	negotiateCapabilities,
} from "../../dist/sdk/index.js";
import { PROBE_SCRIPTS } from "../fixtures/executors/pi/harness.mjs";

const core = await import("../../dist/core/index.js");
const api = await import("../../dist/hosts/api.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const { negotiateWorkflowRun, WorkflowCapabilityError } = await import(
	"../../dist/core/capability-negotiation.js"
);

const roots = [];
const unregister = [];
async function scratch() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "aw-wp35-web-")));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	for (const dir of roots)
		await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const WITH_WEB_ACCESS = {
	name: "package-list",
	when: { argvIncludes: ["list"] },
	effect: false,
	steps: [
		{ stdout: "User packages:" },
		{ stdout: "  npm:pi-web-access@0.44.0" },
		{ stdout: "    /x/node_modules/pi-web-access" },
	],
};
const LIST_FAILS = {
	name: "package-list",
	when: { argvIncludes: ["list"] },
	effect: false,
	steps: [{ stderr: "boom" }, { exit: 2 }],
};

/** A stub `pi`: the standard probe answers, with `pi list` replaced when given. */
async function stubPi(dir, list) {
	const scripts = PROBE_SCRIPTS.filter(
		(script) => list === undefined || script.name !== "package-list",
	);
	return createStubCli({
		dir,
		name: "pi",
		scripts: list === undefined ? scripts : [...scripts, list],
	});
}

const INSTALL = `\`${PI_WEB_ACCESS_INSTALL}\``;

test("probe: missing pi-web-access → webTools none with the install instruction (note + warning)", async () => {
	const dir = await scratch();
	const cli = await stubPi(dir);
	const probe = await createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	}).probe();
	assert.equal(probe.webAccessExtension, null);
	assert.equal(probe.capabilities.webTools.level, "none");
	assert.ok(probe.capabilities.webTools.warning.includes(INSTALL));
	const note = probe.notes.find((entry) => entry.startsWith("web tools"));
	assert.ok(note.startsWith("web tools missing: "), note);
	assert.ok(note.includes(INSTALL));
	assert.match(note, /deep-research/u);
	assert.equal(await cli.effectCount(), 0);
});

test("probe: pi-web-access listed → webTools native/probed, note names the package path", async () => {
	const dir = await scratch();
	const cli = await stubPi(dir, WITH_WEB_ACCESS);
	const probe = await createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	}).probe();
	assert.equal(probe.webAccessExtension, "/x/node_modules/pi-web-access");
	assert.equal(probe.capabilities.webTools.level, "native");
	assert.equal(probe.capabilities.webTools.warning, undefined);
	assert.ok(
		probe.notes.includes(
			// 2026-11-02: the stub cannot run the registered-tools session, so registration is unknown.
			"web tools: pi-web-access /x/node_modules/pi-web-access (web_search, fetch_content; registration not checked)",
		),
	);
});

test("probe: `pi list` fails → presence unknown, still says how to install", async () => {
	const dir = await scratch();
	const cli = await stubPi(dir, LIST_FAILS);
	const probe = await createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	}).probe();
	assert.equal(probe.capabilities.webTools.level, "none");
	const note = probe.notes.find((entry) => entry.startsWith("web tools"));
	assert.match(note, /could not check for pi-web-access \(`pi list` failed\)/u);
	assert.ok(note.includes(INSTALL));
	assert.equal(
		piWebAccessGuidance(true),
		note.slice("web tools missing: ".length),
	);
});

test("preview and refusal: a web stage on a Pi without pi-web-access is refused with the install instruction", async () => {
	const dir = await scratch();
	const cli = await stubPi(dir);
	const executor = createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	});
	const probe = await executor.probe();
	const caps = mergeProbedCapabilities(piCapabilities(), probe.capabilities);
	const report = negotiateCapabilities({ id: "pi", version: "0.1.0" }, caps, {
		readOnly: true,
		hasRequiredReads: false,
		tools: ["read", "web_search"],
	});
	const web = report.entries.find((entry) => entry.key === "webTools");
	assert.equal(web.outcome, "refused");
	assert.equal(web.code, "CAPABILITY_MISSING:webTools");
	assert.ok(web.note.includes(INSTALL));
	assert.ok(
		formatNegotiationPreview(report, "research").join("\n").includes(INSTALL),
	);

	// Run-level negotiation (what every host launch does): the refusal names the install command.
	const cwd = join(dir, "project");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "researcher.md"),
		"---\nname: researcher\ndescription: researches\ntools: read, web_search\n---\nYou research and report.\n",
	);
	const compiled = await compileWorkflow(
		{
			schemaVersion: 1,
			name: "wp35-web",
			defaults: {
				agent: "researcher",
				readOnly: true,
				tools: ["read", "web_search"],
			},
			artifactGraph: {
				stages: [{ id: "research", type: "single", prompt: "Research." }],
			},
		},
		{ cwd, task: "t" },
	);
	await assert.rejects(
		negotiateWorkflowRun({
			descriptor: {
				id: "pi",
				version: "0.1.0",
				contractVersion: "0.1.0",
				module: "unused",
				config: null,
			},
			compiled,
			policy: {
				interactive: false,
				allowUnverified: [],
				strict: [],
				allowReadOnlyDowngrade: false,
			},
			prober: async () => ({ probe, capabilities: piCapabilities() }),
		}),
		(error) =>
			error instanceof WorkflowCapabilityError &&
			error.code === "CAPABILITY_REFUSED" &&
			error.message.includes("CAPABILITY_MISSING:webTools") &&
			error.message.includes(INSTALL) &&
			error.preview.includes(INSTALL),
	);
});

test("submit: web tools without pi-web-access are refused before consume, with the install instruction", async () => {
	const dir = await scratch();
	const cli = await stubPi(dir);
	const executor = createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	});
	const attemptKey = `wp35-web-${process.pid}`;
	const gate = createAuthorityGate({ attemptKey });
	await assert.rejects(
		executor.submit({
			attemptKey,
			authority: gate.authority,
			cwd: dir,
			prompt: "hello",
			tools: ["read", "web_search"],
			readOnly: true,
			mcpServers: [],
			deadlineMs: Date.now() + 60_000,
			env: {},
			isolation: { inherit: false },
			approvalPolicy: defaultApprovalPolicy(),
		}),
		(error) =>
			isSdkError(error, "CAPABILITY_MISSING") &&
			error.message.includes(INSTALL),
	);
	assert.equal(gate.state(), "pending");
	assert.equal(await cli.effectCount(), 0);
});

test("doctor: the Pi web-tools check is shown, and a missing pi-web-access is a warning", async () => {
	const dir = await scratch();
	const cli = await stubPi(dir);
	const descriptor = (config) => ({
		id: "pi",
		version: "0.1.0",
		contractVersion: "0.1.0",
		module: new URL("../../dist/executors/pi/index.js", import.meta.url).href,
		config,
	});
	unregister.push(
		core.registerWorkflowExecutor(
			descriptor({ piCommand: cli.path, stateDir: join(dir, "state") }),
		),
	);
	const cwd = join(dir, "doctor");
	await mkdir(cwd, { recursive: true });
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	const missing = await api.doctorAction({ cwd, env, host: "cli" });
	const pi = missing.data.executors.find((entry) => entry.id === "pi");
	assert.equal(pi.installed, true);
	assert.ok(
		missing.data.warnings.some(
			(warning) =>
				warning.startsWith("pi: web tools missing: ") &&
				warning.includes(INSTALL),
		),
		JSON.stringify(missing.data.warnings),
	);
	assert.match(
		missing.text,
		/^\s+web tools missing: .*pi install npm:pi-web-access/mu,
	);

	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
	await mkdir(join(dir, "with"), { recursive: true });
	const withWeb = await stubPi(join(dir, "with"), WITH_WEB_ACCESS);
	unregister.push(
		core.registerWorkflowExecutor(
			descriptor({ piCommand: withWeb.path, stateDir: join(dir, "state2") }),
		),
	);
	const present = await api.doctorAction({ cwd, env, host: "cli" });
	assert.equal(
		present.data.warnings.some((warning) => warning.includes("web tools")),
		false,
	);
	assert.match(
		present.text,
		/^\s+web tools: pi-web-access \/x\/node_modules\/pi-web-access/mu,
	);
});
