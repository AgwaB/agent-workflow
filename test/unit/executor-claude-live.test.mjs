// Live tier for the Claude executor (WP8). Runs only with AGENT_WORKFLOW_LIVE=1 and the user's real
// HOME (the CLI owns its login, D1); `npm run test:unit` uses an isolated HOME and skips it.
// Model calls: smoke+MCP 1, concurrency 3, web 1, system prompt 2, conformance live checks 6
// (resume = 2 calls).
// Every run happens in a fresh /tmp/aw-live-claude-run-* directory; evidence is summarized in
// ROOT/summary.json for test/fixtures/executors/claude/live-calls.md.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { artifactMcpServerSpecWithOutputLimit } from "../../dist/mcp/artifact-server/index.js";
import { drain, runConformance } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	decideApproval,
	defaultApprovalPolicy,
	validateEventSequence,
} from "../../dist/sdk/index.js";
import {
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { createClaudeLiveHarness } from "../fixtures/executors/claude/harness.mjs";
import { createRunFixture } from "../fixtures/mcp/helpers.mjs";

const LIVE = process.env.AGENT_WORKFLOW_LIVE === "1";
const ISOLATED_HOME = /aw-unit-home-/u.test(homedir());
const skip = !LIVE
	? "live tier: set AGENT_WORKFLOW_LIVE=1"
	: ISOLATED_HOME
		? "live tier needs the real HOME (claude login); run it outside test/run-unit.mjs"
		: false;
const ROOT = skip ? null : mkdtempSync("/tmp/aw-live-claude-run-");
const MODEL = process.env.AGENT_WORKFLOW_LIVE_CLAUDE_MODEL ?? "haiku";
const summary = { root: ROOT, model: MODEL, runs: [] };
const save = () => {
	if (ROOT !== null)
		writeFileSync(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
};

let keyCounter = 0;
function request(overrides) {
	keyCounter += 1;
	const attemptKey = `wp8-live-${process.pid}-${keyCounter}`;
	const gate = createAuthorityGate({ attemptKey });
	return {
		attemptKey,
		authority: gate.authority,
		prompt: "Reply with the single word done.",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 300_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		model: MODEL,
		effort: "low",
		...overrides,
	};
}

async function run(executor, req, purpose) {
	const started = Date.now();
	const ref = await executor.submit(req);
	const drained = await drain(executor, ref, {
		timeoutMs: 300_000,
		onApproval: async (event) => {
			const decision = decideApproval(req.approvalPolicy, event, req);
			await executor.respond(
				ref,
				event.requestId,
				decision === "allow" ? "allow" : "deny",
			);
		},
	});
	const usage = drained.events.find((event) => event.type === "usage");
	summary.runs.push({
		purpose,
		attemptKey: req.attemptKey,
		ms: Date.now() - started,
		terminal: drained.terminal?.type ?? null,
		class: drained.terminal?.type === "failed" ? drained.terminal.class : null,
		usage: usage ?? null,
		tools: drained.events
			.filter(
				(event) => event.type === "tool_call" && event.status !== "running",
			)
			.map((event) => `${event.name}:${event.status}`),
	});
	save();
	return { ref, ...drained };
}

test("live smoke: haiku read-only run with the real artifact MCP server", {
	skip,
	timeout: 400_000,
}, async () => {
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = ROOT;
	const fixture = await createRunFixture().finally(() => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	});
	const executor = createClaudeExecutor({
		config: parseClaudeConfig({ stateDir: join(ROOT, "state-smoke") }),
	});
	const probe = await executor.probe();
	summary.probe = probe;
	assert.equal(probe.installed, true);
	assert.equal(probe.auth, "ok");
	const spec = artifactMcpServerSpecWithOutputLimit(
		fixture.config,
		probe.mcpOutputLimitChars,
	);
	const artifactsDir = join(ROOT, "smoke-artifacts");
	await mkdir(artifactsDir, { recursive: true });
	const result = await run(
		executor,
		request({
			cwd: fixture.cwd,
			artifactsDir,
			tools: ["read", "workflow_artifact"],
			mcpServers: [spec],
			prompt:
				'Call the workflow_artifact tool with {"action":"read","source":"producer","artifact":"analysis"}. Then reply with the first line of the artifact text only.',
		}),
		"smoke + artifact MCP (visible name, ledger)",
	);
	assert.deepEqual(validateEventSequence(result.events), []);
	assert.equal(
		result.terminal?.type,
		"completed",
		JSON.stringify(result.terminal),
	);
	const call = result.events.find(
		(event) =>
			event.type === "tool_call" &&
			event.name === "mcp__workflow_artifact__workflow_artifact" &&
			event.status === "completed",
	);
	assert.ok(call, "artifact tool called by its visible name");
	const ledger = (await readFile(fixture.ledgerPath, "utf8"))
		.trim()
		.split("\n");
	assert.ok(ledger.length >= 1, "read ledger row written");
	assert.equal(JSON.parse(ledger[0]).artifact, "analysis");
	const usage = result.events.find((event) => event.type === "usage");
	assert.equal(usage?.source, "reported");
	summary.smoke = {
		ledgerRows: ledger.length,
		finalText: result.terminal.finalText,
	};
	save();
});

test("live concurrency: three parallel claude -p runs", {
	skip,
	timeout: 400_000,
}, async () => {
	const executor = createClaudeExecutor({
		config: parseClaudeConfig({
			stateDir: join(ROOT, "state-concurrency"),
			listModels: false,
		}),
	});
	const words = ["alpha", "beta", "gamma"];
	const started = Date.now();
	const results = await Promise.all(
		words.map(async (word) => {
			const cwd = mkdtempSync(join(ROOT, `concurrency-${word}-`));
			return run(
				executor,
				request({ cwd, prompt: `Reply with the single word ${word}.` }),
				`concurrency ${word}`,
			);
		}),
	);
	summary.concurrency = {
		wallMs: Date.now() - started,
		finals: results.map((result) => result.terminal?.finalText ?? null),
		sessions: results.map((result) => result.ref.sessionId),
	};
	save();
	for (const [index, result] of results.entries()) {
		assert.equal(result.terminal?.type, "completed");
		assert.match(
			result.terminal.finalText.toLowerCase(),
			new RegExp(words[index]),
		);
	}
	assert.equal(new Set(summary.concurrency.sessions).size, 3);
});

test("live web: native WebSearch + WebFetch (one call)", {
	skip,
	timeout: 400_000,
}, async () => {
	const executor = createClaudeExecutor({
		config: parseClaudeConfig({
			stateDir: join(ROOT, "state-web"),
			listModels: false,
		}),
	});
	const cwd = mkdtempSync(join(ROOT, "web-"));
	const result = await run(
		executor,
		request({
			cwd,
			tools: ["web_search", "fetch_content"],
			prompt:
				"Use the WebSearch tool once to search for: nodejs.org previous releases. Then use the WebFetch tool once on https://nodejs.org/en/about/previous-releases and reply with one short line naming the newest Active LTS major version.",
		}),
		"web: WebSearch + WebFetch",
	);
	const used = (name) =>
		result.events.some(
			(event) =>
				event.type === "tool_call" &&
				event.name === name &&
				event.status === "completed",
		);
	summary.web = {
		search: used("WebSearch"),
		fetch: used("WebFetch"),
		finalText: result.terminal?.finalText ?? null,
	};
	save();
	assert.equal(result.terminal?.type, "completed");
	assert.ok(summary.web.search, "WebSearch completed");
});

test("live system prompt: append and replace", {
	skip,
	timeout: 400_000,
}, async () => {
	summary.systemPrompt = {};
	for (const mode of ["append", "replace"]) {
		const executor = createClaudeExecutor({
			config: parseClaudeConfig({
				stateDir: join(ROOT, `state-system-${mode}`),
				listModels: false,
				systemPromptMode: mode,
			}),
		});
		const cwd = mkdtempSync(join(ROOT, `system-${mode}-`));
		const marker = `KIWI${mode.toUpperCase()}`;
		const result = await run(
			executor,
			request({
				cwd,
				systemPrompt: `Whatever the user asks, reply with exactly the word ${marker} and nothing else.`,
				prompt: "What is two plus two?",
			}),
			`system prompt ${mode}`,
		);
		summary.systemPrompt[mode] = result.terminal?.finalText ?? null;
		save();
		assert.equal(result.terminal?.type, "completed");
		assert.match(result.terminal.finalText, new RegExp(marker));
	}
});

test("live conformance checks (kit live tier)", {
	skip,
	timeout: 1_500_000,
}, async () => {
	const harness = createClaudeLiveHarness({ model: MODEL, root: ROOT });
	const workDir = join(ROOT, "kit");
	await mkdir(workDir, { recursive: true });
	// runConformance makes its work dir under os.tmpdir(): keep live cwds under ROOT (/tmp/aw-live-claude-*).
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = workDir;
	const report = await runConformance(harness, {
		tiers: ["live"],
		only: ["live."],
		timeouts: {
			callMs: 30_000,
			streamMs: 300_000,
			liveStreamMs: 300_000,
			checkMs: 900_000,
		},
	}).finally(() => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	});
	summary.kit = report.results.map((result) => ({
		id: result.id,
		status: result.status,
		violations: result.violations,
		reason: result.reason ?? null,
		ms: result.durationMs,
	}));
	summary.sessionCleanup = await harness.cleanupSessions();
	save();
	assert.deepEqual(
		report.results
			.filter((result) => result.status === "fail")
			.map((result) => [result.id, result.violations]),
		[],
	);
	// session_ownership keeps one session; live.resume keeps one and its resume attempt records the
	// same session again (in its own state dir), so that second delete finds it already gone.
	const locators = new Set(
		summary.sessionCleanup.map((entry) => entry.locator),
	);
	assert.ok(locators.size >= 2, "kept sessions recorded");
	for (const locator of locators)
		assert.ok(
			summary.sessionCleanup.some(
				(entry) => entry.locator === locator && entry.result === "deleted",
			),
			`session ${locator} deleted`,
		);
	for (const entry of summary.sessionCleanup)
		assert.ok(["deleted", "absent"].includes(entry.result), entry.result);
});
