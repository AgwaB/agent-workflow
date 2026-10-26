// WP8: stream-json parser per event type, over scrubbed live transcripts (claude-code 2.1.310).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	ClaudeStreamParser,
	parseClaudeStream,
} from "../../dist/executors/claude/index.js";
import {
	validateEventSequence,
	validateExecEvent,
} from "../../dist/sdk/index.js";

const dir = fileURLToPath(
	new URL("../fixtures/executors/claude/transcripts/", import.meta.url),
);
const lines = (name) =>
	readFileSync(join(dir, `${name}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean);
const meta = (name) =>
	JSON.parse(readFileSync(join(dir, `${name}.meta.json`), "utf8"));
const exitOf = (name) => {
	const info = meta(name);
	return {
		exitCode: info.exit?.code ?? 0,
		signal: info.exit?.signal ?? null,
		stderr: info.stderr ?? "",
	};
};
const parse = (name, options = {}) =>
	parseClaudeStream(lines(name), { exit: exitOf(name), ...options });
const ofType = (events, type) => events.filter((event) => event.type === type);

test("every recorded transcript parses into a valid event sequence", () => {
	const names = readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => file.slice(0, -".jsonl".length));
	assert.ok(names.length >= 15);
	for (const name of names) {
		const events = parse(name);
		for (const event of events)
			assert.deepEqual(
				validateExecEvent(event),
				[],
				`${name}: ${JSON.stringify(event)}`,
			);
		assert.deepEqual(validateEventSequence(events), [], name);
	}
});

test("system/init → started with the session id", () => {
	const events = parse("complete-tools-mcp");
	assert.equal(events[0].type, "started");
	assert.equal(
		events[0].sessionId,
		JSON.parse(lines("complete-tools-mcp")[0]).session_id,
	);
});

test("partial text deltas → message_delta, without duplicating the assistant text", () => {
	const events = parse("complete-tools-mcp");
	const text = ofType(events, "message_delta")
		.map((event) => event.text)
		.join("");
	const completed = events.at(-1);
	assert.equal(completed.type, "completed");
	assert.equal(text, completed.finalText);
});

test("assistant text is used when the message was not streamed", () => {
	const events = parse("approval-allow-deny"); // recorded without --include-partial-messages
	assert.ok(ofType(events, "message_delta").length >= 1);
});

test("tool_use / tool_result → tool_call with ACP kind and status", () => {
	const events = parse("complete-tools-mcp");
	const calls = ofType(events, "tool_call");
	const byName = (name, status) =>
		calls.find((call) => call.name === name && call.status === status);
	assert.equal(byName("Read", "running").kind, "read");
	assert.match(byName("Read", "completed").output, /alpha-content-91/);
	const mcp = byName("mcp__workflow_artifact__echo", "completed");
	assert.equal(mcp.kind, "other");
	assert.equal(mcp.output, "echo:nonce-7f3");
	assert.equal(byName("Bash", "completed").kind, "execute");
	for (const call of calls) assert.equal(typeof call.callId, "string");
	const artifact = parse("adapter-smoke-artifact-mcp");
	const read = ofType(artifact, "tool_call").find(
		(call) => call.name === "mcp__workflow_artifact__workflow_artifact",
	);
	assert.equal(read.kind, "read");
});

test("web tools are client tool calls of kind fetch", () => {
	const calls = ofType(parse("adapter-web-search-fetch"), "tool_call");
	for (const name of ["WebSearch", "WebFetch"]) {
		const call = calls.find(
			(entry) => entry.name === name && entry.status === "completed",
		);
		assert.ok(call, name);
		assert.equal(call.kind, "fetch");
	}
});

test("can_use_tool control request → approval_request (+ adapter action)", () => {
	const events = [];
	const parser = new ClaudeStreamParser((event) => events.push(event));
	const actions = [];
	for (const line of lines("approval-allow-deny")) {
		const out = parser.line(line);
		actions.push(...out);
		for (const action of out)
			if (
				action.type === "approval" &&
				action.request.input.command.includes("deny")
			)
				parser.markDenied(action.request.toolUseId);
	}
	const approvals = ofType(events, "approval_request");
	assert.equal(approvals.length, 2);
	assert.equal(approvals[0].kind, "execute");
	assert.match(approvals[0].detail, /^Bash: touch e3-allow\.txt/);
	assert.deepEqual(
		actions
			.filter((action) => action.type === "approval")
			.map((action) => action.request.toolName),
		["Bash", "Bash"],
	);
	const results = ofType(events, "tool_call").filter(
		(call) => call.status !== "running",
	);
	assert.deepEqual(
		results.map((call) => call.status),
		["completed", "denied"],
	);
	assert.deepEqual(actions.at(-1), { type: "result" });
});

test("system/permission_denied marks the tool call denied", () => {
	const events = parse("permission-denied-no-prompt-tool");
	const result = ofType(events, "tool_call").find(
		(call) => call.status !== "running",
	);
	assert.equal(result.status, "denied");
});

test("result → usage with reported cost, then completed", () => {
	const events = parse("complete-tools-mcp");
	const usage = ofType(events, "usage")[0];
	assert.equal(usage.source, "reported");
	assert.equal(usage.cost, 0.0018570600000000002);
	assert.equal(usage.input, 4 + 8258 + 7906);
	assert.equal(usage.output, 252);
	assert.equal(usage.cached, 7906);
	assert.equal(events.at(-2).type, "usage");
});

test("result without total_cost_usd → cost null, source unknown (never 0)", () => {
	const raw = lines("complete-tools-mcp").map((line) => {
		const value = JSON.parse(line);
		if (value.type === "result") delete value.total_cost_usd;
		return JSON.stringify(value);
	});
	const usage = ofType(parseClaudeStream(raw), "usage")[0];
	assert.equal(usage.cost, null);
	assert.equal(usage.source, "unknown");
});

test("interrupt: cancelled when we asked, unknown otherwise; usage unknown (CLI reports 0)", () => {
	const ours = parse("interrupt", { cancelRequested: () => true });
	assert.equal(ours.at(-1).type, "failed");
	assert.equal(ours.at(-1).class, "cancelled");
	const usage = ofType(ours, "usage")[0];
	assert.deepEqual(
		[usage.input, usage.output, usage.cost, usage.source],
		[null, null, null, "unknown"],
	);
	const foreign = parse("interrupt");
	assert.equal(foreign.at(-1).class, "unknown");
	assert.equal(foreign.at(-1).raw.terminal_reason, "aborted_streaming");
});

test("errors: invalid model → config, not logged in → auth; synthetic text is not output", () => {
	const model = parse("invalid-model");
	assert.equal(model.at(-1).type, "failed");
	assert.equal(model.at(-1).class, "config");
	assert.equal(model.at(-1).raw.api_error_status, 404);
	assert.equal(ofType(model, "message_delta").length, 0);
	const auth = parse("bare-not-logged-in");
	assert.equal(auth.at(-1).class, "auth");
	assert.equal(auth.at(-1).message, "Not logged in · Please run /login");
});

test("a result is terminal even when the process is killed afterwards (exit 143)", () => {
	const events = parse("sigterm-after-result");
	assert.equal(events.at(-1).type, "completed");
	assert.equal(meta("sigterm-after-result").exit.code, 143);
});

test("MCP spill and MCP tool timeout are tool results, not stream failures", () => {
	const calls = ofType(parse("mcp-limit-2000-tokens"), "tool_call").filter(
		(call) => call.status !== "running",
	);
	assert.match(calls[1].output, /exceeds maximum allowed tokens/);
	assert.equal(calls[2].status, "failed");
	assert.match(calls[2].output, /timed out after 3s/);
	const intact = ofType(parse("mcp-limit-default"), "tool_call").find(
		(call) => call.status === "completed",
	);
	assert.ok(intact.output.length > 0);
});

test("process exit without a result: classified from stderr, cancelled after our stop", () => {
	const init = lines("complete-tools-mcp")[0];
	const crashed = parseClaudeStream([init], {
		exit: { exitCode: 139, signal: null, stderr: "segmentation fault" },
	});
	assert.equal(crashed.at(-1).class, "unknown");
	const stopped = parseClaudeStream([init], {
		cancelRequested: () => true,
		exit: { exitCode: null, signal: "SIGTERM", stderr: "" },
	});
	assert.equal(stopped.at(-1).class, "cancelled");
	const missing = parseClaudeStream([], {
		exit: {
			exitCode: null,
			signal: null,
			stderr: "",
			spawnError: "spawn claude ENOENT",
		},
	});
	assert.deepEqual(
		missing.map((event) => event.type),
		["started", "failed"],
	);
	assert.equal(missing[1].class, "config");
});

test("a failed injected MCP server at init fails the attempt (config)", () => {
	const init = JSON.parse(lines("complete-tools-mcp")[0]);
	init.mcp_servers = [{ name: "workflow_artifact", status: "failed" }];
	const events = parseClaudeStream([JSON.stringify(init)], {
		mcpServers: ["workflow_artifact"],
	});
	assert.equal(events.at(-1).type, "failed");
	assert.equal(events.at(-1).class, "config");
});

test("ownedSession is reported on the terminal event of a kept session", () => {
	const events = parse("adapter-kit-session-keep", {
		ownedSession: { kind: "claude-session", locator: "x" },
	});
	assert.deepEqual(events.at(-1).ownedSession, {
		kind: "claude-session",
		locator: "x",
	});
});

test("unknown control requests are answered, unknown lines ignored", () => {
	const parser = new ClaudeStreamParser(() => {});
	assert.deepEqual(parser.line("not json"), []);
	assert.deepEqual(
		parser.line(
			JSON.stringify({
				type: "control_request",
				request_id: "r1",
				request: { subtype: "hook_callback" },
			}),
		),
		[
			{
				type: "unsupported_control",
				requestId: "r1",
				subtype: "hook_callback",
			},
		],
	);
});
