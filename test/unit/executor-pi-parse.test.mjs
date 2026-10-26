// WP6: Pi JSON stream parsing, event normalization per event type and the error table, driven by
// the recorded (scrubbed) Pi 1.1.0 transcripts in test/fixtures/executors/pi/transcripts/.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyPiFailure,
	PI_ERROR_RULES,
	PiEventNormalizer,
	PiJsonlSplitter,
	usageFromPi,
} from "../../dist/executors/pi/index.js";
import {
	validateEventSequence,
	validateExecEvent,
} from "../../dist/sdk/index.js";
import { loadTranscript } from "../fixtures/executors/pi/harness.mjs";

/** Normalize a whole transcript the way the adapter does for a live process. */
async function normalize(name, { cancelled = false, ownedSession } = {}) {
	const transcript = await loadTranscript(name);
	const normalizer = new PiEventNormalizer({
		sessionId: null,
		...(ownedSession ? { ownedSession } : {}),
	});
	const events = [normalizer.started()];
	for (const line of transcript.stdout) events.push(...normalizer.line(line));
	events.push(
		normalizer.finish({
			exitCode: transcript.exitCode,
			signal: transcript.signal,
			cancelled,
			stderr: transcript.stderr,
		}),
	);
	for (const event of events) assert.deepEqual(validateExecEvent(event), []);
	assert.deepEqual(validateEventSequence(events), []);
	return { events, normalizer, terminal: events.at(-1) };
}

test("splitter: LF framing, CRLF, Unicode separators stay inside records, UTF-8 across chunks", () => {
	const splitter = new PiJsonlSplitter();
	const record = JSON.stringify({ text: "a\u2028b\u2029c" });
	const bytes = Buffer.from(`${record}\r\n{"x":"é"}\n{"tail":1}`, "utf8");
	const cut = bytes.indexOf(Buffer.from("é")) + 1; // split inside the 2-byte é
	const lines = [
		...splitter.push(bytes.subarray(0, cut)),
		...splitter.push(bytes.subarray(cut)),
		...splitter.finish(),
	];
	assert.deepEqual(lines, [record, '{"x":"é"}', '{"tail":1}']);
	assert.equal(JSON.parse(lines[0]).text, "a\u2028b\u2029c");
});

test("complete-read (live): started → usage → read tool_call → deltas → usage → completed", async () => {
	const { events, terminal, normalizer } = await normalize("complete-read");
	assert.deepEqual(
		events.map((event) => event.type),
		[
			"started",
			"usage",
			"tool_call",
			"tool_call",
			"message_delta",
			"message_delta",
			"usage",
			"completed",
		],
	);
	const [running, done] = events.filter((event) => event.type === "tool_call");
	assert.deepEqual(
		[running.name, running.kind, running.status, running.input],
		["read", "read", "running", { path: "notes.txt" }],
	);
	assert.equal(done.status, "completed");
	assert.equal(done.callId, running.callId);
	assert.equal(done.output, "alpha bravo charlie\n");
	assert.match(terminal.finalText, /bravo/u);
	assert.equal(
		events
			.filter((event) => event.type === "message_delta")
			.map((event) => event.text)
			.join(""),
		terminal.finalText,
	);
	// Pi computes cost from its catalog: estimated, never "reported".
	for (const usage of events.filter((event) => event.type === "usage")) {
		assert.equal(usage.source, "estimated");
		assert.ok(usage.cost > 0);
	}
	assert.equal(normalizer.provider, "google");
	assert.equal(normalizer.model, "gemini-2.5-flash-lite");
});

test("usage: zero cost is unknown (null, never 0); zero-token requests emit no usage", async () => {
	const { events } = await normalize("usage-unknown-faux");
	const usage = events.filter((event) => event.type === "usage");
	assert.equal(usage.length, 1);
	assert.equal(usage[0].cost, null);
	assert.equal(usage[0].source, "unknown");
	assert.ok(usage[0].input > 0);
	assert.equal(
		usageFromPi({
			input: 0,
			output: 0,
			cacheRead: 0,
			totalTokens: 0,
			cost: { total: 0 },
		}),
		undefined,
	);
	assert.deepEqual(
		usageFromPi({
			input: 5,
			output: 2,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 11,
			cost: { total: 0.25 },
		}),
		{
			type: "usage",
			input: 5,
			output: 2,
			cached: 3,
			cost: 0.25,
			source: "estimated",
		},
	);
});

test("MCP artifact tool (live): visible name, kind read, 20480-char delivery untouched by Pi", async () => {
	const { events, terminal } = await normalize("mcp-artifact-read");
	const done = events.find(
		(event) => event.type === "tool_call" && event.status === "completed",
	);
	assert.equal(done.name, "mcp__workflow_artifact__workflow_artifact");
	assert.equal(done.kind, "read");
	assert.equal(done.output.length, 20480);
	assert.doesNotMatch(done.output, /Warning: truncated output/u);
	assert.match(done.output, /deliveryUnverified|truncated/u);
	assert.equal(terminal.type, "completed");
});

test("web_search (live, pi-web-access): kind fetch, completed", async () => {
	const { events, terminal } = await normalize("web-search-live");
	const done = events.find(
		(event) => event.type === "tool_call" && event.status === "completed",
	);
	assert.equal(done.name, "web_search");
	assert.equal(done.kind, "fetch");
	assert.equal(terminal.type, "completed");
});

test("error table from real transcripts → failed.class", async () => {
	const cases = [
		["fail-auth-openai-401", "auth"],
		["fail-auth-no-api-key", "auth"],
		["fail-transient-google-500", "transient"],
		["fail-rate-limit-google-429", "rate_limit"],
		["fail-config-model-not-found", "config"],
		["fail-unknown-flag-conflict", "unknown"],
	];
	for (const [name, expected] of cases) {
		const { terminal } = await normalize(name);
		assert.equal(terminal.type, "failed", name);
		assert.equal(terminal.class, expected, `${name}: ${terminal.message}`);
		assert.equal(
			typeof terminal.raw.exitCode === "number" ||
				terminal.raw.exitCode === null,
			true,
		);
	}
	// Exit 0 with stopReason "error" is a failure (Pi exits 0 after a provider error).
	const auth = await loadTranscript("fail-auth-openai-401");
	assert.equal(auth.exitCode, 0);
});

test("interrupted runs: cancelled by request → class cancelled; unrequested SIGTERM exit → unknown", async () => {
	for (const name of ["interrupted-live-sigterm", "interrupted-faux-sigterm"]) {
		const requested = await normalize(name, { cancelled: true });
		assert.equal(requested.terminal.type, "failed");
		assert.equal(requested.terminal.class, "cancelled");
		const foreign = await normalize(name);
		assert.equal(foreign.terminal.class, "unknown");
	}
	const live = await normalize("interrupted-live-sigterm", { cancelled: true });
	assert.ok(live.events.some((event) => event.type === "message_delta"));
});

test("ownedSession rides on the terminal event; non-JSON lines are counted, never fatal", () => {
	const owned = { kind: "pi-session-dir", locator: "/tmp/x/sessions/s1" };
	const normalizer = new PiEventNormalizer({
		sessionId: "s1",
		ownedSession: owned,
	});
	assert.deepEqual(normalizer.started(), { type: "started", sessionId: "s1" });
	assert.deepEqual(normalizer.line("not json"), []);
	normalizer.line(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		}),
	);
	assert.deepEqual(
		normalizer.finish({
			exitCode: 0,
			signal: null,
			cancelled: false,
			stderr: "",
		}),
		{ type: "completed", finalText: "ok", ownedSession: owned },
	);
	assert.equal(normalizer.parseErrors, 1);
	const failing = new PiEventNormalizer({
		sessionId: null,
		ownedSession: owned,
	});
	const terminal = failing.finish({
		exitCode: 1,
		signal: null,
		cancelled: false,
		stderr: "boom",
	});
	assert.equal(terminal.type, "failed");
	assert.deepEqual(terminal.ownedSession, owned);
});

test("tool errors map to status failed; tool kinds follow the Pi mapping", () => {
	const normalizer = new PiEventNormalizer({ sessionId: null });
	const [event] = normalizer.line(
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "exit 1" }] },
			isError: true,
		}),
	);
	assert.deepEqual(event, {
		type: "tool_call",
		name: "bash",
		kind: "execute",
		status: "failed",
		callId: "c1",
		output: "exit 1",
	});
	const kinds = Object.fromEntries(
		[
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"codemode",
			"tool_search",
			"mcp__x__y",
		].map((name) => [
			name,
			normalizer.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: name,
					toolCallId: name,
				}),
			)[0].kind,
		]),
	);
	assert.deepEqual(kinds, {
		edit: "edit",
		write: "edit",
		grep: "search",
		find: "search",
		ls: "read",
		codemode: "execute",
		tool_search: "search",
		mcp__x__y: "other",
	});
});

test("error rules: every row classifies its own sample; unmatched text is unknown", () => {
	const samples = {
		context_length_exceeded: "permanent",
		'Model "x" not found. Use --list-models': "config",
		"Unknown option --foo": "config",
		"No API key found for mistral.": "auth",
		"OpenAI API error (401): bad key": "auth",
		'{"code":429,"status":"RESOURCE_EXHAUSTED"}': "rate_limit",
		'{"code":500,"status":"Internal Server Error"}': "transient",
		"fetch failed": "transient",
		"segmentation fault in flux module": "unknown",
	};
	for (const [message, expected] of Object.entries(samples))
		assert.equal(classifyPiFailure(message, 1), expected, message);
	assert.ok(
		PI_ERROR_RULES.every((rule) =>
			["live", "offline", "source"].includes(rule.evidence),
		),
	);
	assert.ok(
		PI_ERROR_RULES.filter((rule) => rule.evidence === "live").length >= 4,
	);
});
