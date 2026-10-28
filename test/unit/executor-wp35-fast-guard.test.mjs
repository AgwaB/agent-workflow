// New in agent-workflow (WP35, feature-parity row 39): the Pi executor's fast-tier provider-stream
// guard, ported from pi-workflow `workflow-fast-mode-extension.ts`. Fake provider streams and a fake
// Pi extension API stand in for Pi; the executor runs against a stub CLI. Covers: the guard forces
// `serviceTier: priority` on the re-registered OpenAI stream and stamps the payload, the binding
// check aborts and reports `failed`, the degrade path (`payload-only`), the generated wrapper hands
// in Pi's stream functions, the attempt outcome on a guard failure, and the per-task descriptor
// config (fast only when negotiation accepted fastTier). No model or agent-CLI calls.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	createFastProviderStream,
	PI_FAST_TIER_STATE_FILE,
	piRunExtensionSource,
	registerFastTierGuard,
	registerPiRun,
} from "../../dist/executors/pi/run-extension.js";
import {
	piFastTierOutcome,
	readPiFastTierState,
} from "../../dist/executors/pi/executor.js";
import { createExecutor } from "../../dist/executors/pi/index.js";
import { classifyPiFailure } from "../../dist/executors/pi/errors.js";
import { piCapabilities } from "../../dist/executors/pi/executor.js";
import { workflowTaskExecutorDescriptor } from "../../dist/core/task-backend.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import {
	loadTranscript,
	PROBE_SCRIPTS,
	replaySteps,
} from "../fixtures/executors/pi/harness.mjs";

const dirs = [];
async function scratch() {
	const dir = await mkdtemp(join(tmpdir(), "aw-wp35-fast-"));
	dirs.push(dir);
	return dir;
}
after(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const FAST = {
	provider: "openai",
	model: "gpt-5.5",
	api: "openai-responses",
	serviceTier: "priority",
};
const MODEL = { provider: "openai", id: "gpt-5.5", api: "openai-responses" };

/** Fake pi-ai streams: record the options each provider stream was called with. */
function fakeStreams() {
	const calls = [];
	return {
		calls,
		streams: {
			openaiResponses: (model, context, options) => {
				calls.push({ api: "openai-responses", model, context, options });
				return { stream: "responses" };
			},
			openaiCodexResponses: (model, context, options) => {
				calls.push({ api: "openai-codex-responses", model, context, options });
				return { stream: "codex" };
			},
			clampThinkingLevel: (_model, level) => (level === "max" ? "high" : level),
		},
	};
}

function fakePi() {
	const handlers = {};
	return {
		handlers,
		on: (event, handler) => {
			handlers[event] = handler;
		},
	};
}

function fakeCtx(model = MODEL) {
	const providers = [];
	let aborted = 0;
	return {
		providers,
		aborts: () => aborted,
		ctx: {
			model,
			abort: () => {
				aborted += 1;
			},
			modelRegistry: {
				registerProvider: (name, config) => providers.push([name, config]),
			},
		},
	};
}

test("provider stream: forces serviceTier priority, guards the payload, clamps reasoning (fake stream)", async () => {
	const { calls, streams } = fakeStreams();
	let requests = 0;
	const failures = [];
	const stream = createFastProviderStream(FAST, streams, {
		onRequest: () => {
			requests += 1;
		},
		onFailure: (error) => failures.push(error),
	});
	const upstream = [];
	assert.deepEqual(
		stream(
			MODEL,
			{ messages: [] },
			{
				reasoning: "max",
				onPayload: (payload) => {
					upstream.push(payload);
					return { ...payload, extra: 1 };
				},
			},
		),
		{ stream: "responses" },
	);
	assert.equal(requests, 1);
	const [call] = calls;
	assert.equal(call.options.serviceTier, "priority");
	assert.equal(call.options.reasoningEffort, "high");
	// The guarded onPayload chains the upstream hook, then stamps the tier.
	assert.deepEqual(await call.options.onPayload({ model: "gpt-5.5" }, MODEL), {
		model: "gpt-5.5",
		extra: 1,
		service_tier: "priority",
	});
	assert.deepEqual(upstream, [{ model: "gpt-5.5" }]);
	// A payload for another model fails the guard (reported) and rejects.
	await assert.rejects(
		call.options.onPayload({ model: "gpt-x" }, MODEL),
		/payload binding mismatch/u,
	);
	assert.equal(failures.length, 1);
	// A request for another model never reaches the provider.
	assert.throws(
		() => stream({ ...MODEL, id: "gpt-x" }, { messages: [] }, {}),
		/launch binding mismatch/u,
	);
	assert.equal(calls.length, 1);
	assert.equal(failures.length, 2);
	// openai-codex binding → the codex stream; "off" reasoning → no effort.
	const codex = createFastProviderStream(
		{ ...FAST, provider: "openai-codex", api: "openai-codex-responses" },
		streams,
	);
	codex(
		{ provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" },
		{},
		{ reasoning: "off" },
	);
	assert.equal(calls.at(-1).api, "openai-codex-responses");
	assert.equal(calls.at(-1).options.reasoningEffort, undefined);
});

test("guard: session_start re-registers the bound provider (guarded); counts and state are reported", async () => {
	const dir = await scratch();
	const statePath = join(dir, PI_FAST_TIER_STATE_FILE);
	const { streams } = fakeStreams();
	const pi = fakePi();
	const lines = [];
	registerFastTierGuard(pi, { ...FAST, statePath }, streams, {
		stderr: (line) => lines.push(line),
	});
	assert.equal((await readPiFastTierState(dir)).status, "pending");
	const { ctx, providers } = fakeCtx();
	pi.handlers.session_start({}, ctx);
	assert.equal(providers.length, 1);
	assert.equal(providers[0][0], "openai");
	assert.equal(providers[0][1].api, "openai-responses");
	providers[0][1].streamSimple(MODEL, {}, {});
	assert.deepEqual(
		pi.handlers.before_provider_request({ payload: { model: "gpt-5.5" } }, ctx),
		{ model: "gpt-5.5", service_tier: "priority" },
	);
	const state = await readPiFastTierState(dir);
	assert.equal(state.status, "guarded");
	assert.equal(state.guardedRequests, 1);
	assert.equal(state.payloadRequests, 1);
	assert.deepEqual(lines, []);
});

test("guard failure: a binding mismatch aborts, reports failed once, and the attempt fails as config", async () => {
	const dir = await scratch();
	const statePath = join(dir, PI_FAST_TIER_STATE_FILE);
	const { streams } = fakeStreams();
	const pi = fakePi();
	const lines = [];
	registerFastTierGuard(pi, { ...FAST, statePath }, streams, {
		stderr: (line) => lines.push(line),
	});
	const { ctx, aborts } = fakeCtx({ ...MODEL, id: "gpt-other" });
	pi.handlers.session_start({}, ctx);
	assert.throws(
		() =>
			pi.handlers.before_provider_request(
				{ payload: { model: "gpt-5.5" } },
				ctx,
			),
		/launch binding mismatch/u,
	);
	assert.equal(aborts(), 1);
	const state = await readPiFastTierState(dir);
	assert.equal(state.status, "failed");
	assert.match(state.reason, /expected openai\/gpt-5\.5/u);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^agent-workflow: fast tier failed:/u);
	// Pi reports the aborted turn as `unknown`; the guard's report makes it a config failure.
	const aborted = {
		type: "failed",
		class: "unknown",
		message: "pi aborted the run",
		raw: { stopReason: "aborted" },
	};
	const outcome = piFastTierOutcome(aborted, state);
	assert.equal(outcome.class, "config");
	assert.match(
		outcome.message,
		/^fast tier failed: workflow fast mode launch binding mismatch/u,
	);
	assert.equal(outcome.raw.stopReason, "aborted");
	assert.equal(
		piFastTierOutcome({ type: "completed", finalText: "x" }, state).class,
		"config",
	);
	const cancelled = { ...aborted, class: "cancelled" };
	assert.equal(piFastTierOutcome(cancelled, state), cancelled);
	assert.equal(
		piFastTierOutcome(aborted, { ...state, status: "guarded" }),
		aborted,
	);
	assert.equal(classifyPiFailure(state.reason, 0), "config");
});

test("degrade: no provider registry or no stream functions → payload-only, still stamps the tier, reported", async () => {
	for (const [streams, ctxExtra, reason] of [
		[undefined, {}, /no provider stream functions/u],
		[fakeStreams().streams, { modelRegistry: {} }, /no provider registry/u],
	]) {
		const dir = await scratch();
		const pi = fakePi();
		const lines = [];
		registerFastTierGuard(
			pi,
			{ ...FAST, statePath: join(dir, PI_FAST_TIER_STATE_FILE) },
			streams,
			{ stderr: (line) => lines.push(line) },
		);
		const ctx = { model: MODEL, abort() {}, ...ctxExtra };
		pi.handlers.session_start({}, ctx);
		assert.deepEqual(
			pi.handlers.before_provider_request(
				{ payload: { model: "gpt-5.5" } },
				ctx,
			),
			{ model: "gpt-5.5", service_tier: "priority" },
		);
		const state = await readPiFastTierState(dir);
		assert.equal(state.status, "payload-only");
		assert.match(state.reason, reason);
		assert.equal(state.payloadRequests, 1);
		assert.match(lines[0], /fast tier degraded to the payload hook/u);
		// A degraded guard does not change the attempt outcome.
		const done = { type: "completed", finalText: "ok" };
		assert.equal(piFastTierOutcome(done, state), done);
	}
});

test("registerPiRun + wrapper: Pi's stream functions are handed in; the wrapper imports them only for fast", async () => {
	const { streams } = fakeStreams();
	const pi = fakePi();
	await registerPiRun(
		pi,
		{
			schema: "agent-workflow-pi-run-v1",
			privateMcp: false,
			mcpServers: [],
			fastTier: FAST,
			parentWatch: false,
		},
		{ fastStreams: streams },
	);
	const { ctx, providers } = fakeCtx();
	pi.handlers.session_start({}, ctx);
	assert.equal(providers.length, 1);
	const scope = ["@earendil", "works"].join("-");
	const fast = piRunExtensionSource({
		runExtensionUrl: "file:///x/run-extension.js",
		config: {
			schema: "agent-workflow-pi-run-v1",
			privateMcp: true,
			mcpServers: [{ name: "s", command: "n", args: [], envKeys: [] }],
			fastTier: FAST,
			parentWatch: true,
		},
	});
	assert.ok(
		fast.includes(
			`import { clampThinkingLevel, streamOpenAICodexResponses, streamOpenAIResponses } from "${scope}/pi-ai/compat";`,
		),
	);
	assert.match(
		fast,
		/await registerPiRun\(pi, config, \{ createMcpExtension, fastStreams: \{ openaiResponses: streamOpenAIResponses, openaiCodexResponses: streamOpenAICodexResponses, clampThinkingLevel \} \}\);/u,
	);
	const plain = piRunExtensionSource({
		runExtensionUrl: "file:///x/run-extension.js",
		config: {
			schema: "agent-workflow-pi-run-v1",
			privateMcp: false,
			mcpServers: [],
			parentWatch: true,
		},
	});
	assert.equal(plain.includes("pi-ai"), false);
	assert.match(plain, /await registerPiRun\(pi, config\);/u);
});

test("executor: fast config puts the guard state path in the attempt dir; fastTier stays unverified", async () => {
	assert.deepEqual(
		{
			level: piCapabilities().fastTier.level,
			source: piCapabilities().fastTier.source,
		},
		{ level: "native", source: "unverified" },
	);
	const dir = await scratch();
	const cli = await createStubCli({
		dir,
		name: "pi",
		scripts: [
			...PROBE_SCRIPTS,
			{
				name: "run",
				when: { argvIncludes: ["--mode", "json"] },
				steps: replaySteps(await loadTranscript("complete-read")),
			},
		],
	});
	const executor = createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
		fast: "on",
		fastApi: "openai-responses",
	});
	const attemptKey = `wp35-fast-${process.pid}`;
	const gate = createAuthorityGate({ attemptKey });
	const artifactsDir = join(dir, "attempt");
	const ref = await executor.submit({
		attemptKey,
		authority: gate.authority,
		cwd: dir,
		prompt: "hello",
		model: "openai/gpt-5.5",
		tools: ["read"],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		artifactsDir,
	});
	const events = [];
	for await (const event of executor.observe(ref)) events.push(event);
	// The stub Pi never loads the extension: no state file, the outcome is the stream's.
	assert.equal(events.at(-1).type, "completed");
	const source = await readFile(join(artifactsDir, "pi-extension.mjs"), "utf8");
	const config = JSON.parse(/^const config = (.*);$/mu.exec(source)[1]);
	assert.deepEqual(config.fastTier, {
		...FAST,
		statePath: join(artifactsDir, PI_FAST_TIER_STATE_FILE),
	});
	assert.match(source, /pi-ai\/compat/u);
});

test("per-task descriptor: fast/fastApi only when the task asks and negotiation accepted fastTier", () => {
	const pi = {
		id: "pi",
		version: "0.1.0",
		contractVersion: "0.1.0",
		module: "m",
		config: null,
	};
	const task = {
		runtime: {
			fast: "on",
			api: "openai-responses",
			approvalMode: "non-interactive",
		},
	};
	const report = (outcome) => ({
		report: { entries: [{ key: "fastTier", outcome }] },
	});
	assert.deepEqual(
		workflowTaskExecutorDescriptor(pi, task, {}, report("native")).config,
		{ fast: "on", fastApi: "openai-responses" },
	);
	// Unverified without opt-in → degraded "runs without fast tier": no fast config.
	assert.equal(
		workflowTaskExecutorDescriptor(pi, task, {}, report("degraded")),
		pi,
	);
	// No negotiation record (pre-WP4d run): no fast tier.
	assert.equal(workflowTaskExecutorDescriptor(pi, task, {}), pi);
	// fast off: nothing.
	assert.equal(
		workflowTaskExecutorDescriptor(
			pi,
			{ runtime: { fast: "off" } },
			{},
			report("native"),
		),
		pi,
	);
	// Other executors never get Pi-only config.
	const codex = { ...pi, id: "codex" };
	assert.equal(
		workflowTaskExecutorDescriptor(
			codex,
			task,
			{ hostContext: {} },
			report("native"),
		),
		codex,
	);
	// Existing descriptor config is kept.
	assert.deepEqual(
		workflowTaskExecutorDescriptor(
			{ ...pi, config: { piCommand: "/x/pi" } },
			task,
			{ hostContext: {} },
			report("native"),
		).config,
		{
			piCommand: "/x/pi",
			inheritHostTools: true,
			fast: "on",
			fastApi: "openai-responses",
		},
	);
});
