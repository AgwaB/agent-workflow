import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";

const started = { type: "started", sessionId: "s-1" };
const completed = { type: "completed", finalText: "done" };

test("events: each normalized type validates; unknown types and bad vocab are rejected", () => {
	const valid = [
		started,
		{ type: "message_delta", text: "hi" },
		{
			type: "tool_call",
			name: "Read",
			kind: "read",
			status: "completed",
			input: { path: "a" },
			output: "ok",
		},
		{
			type: "usage",
			input: 1,
			output: 2,
			cached: 0,
			cost: 0.01,
			source: "reported",
		},
		{
			type: "approval_request",
			requestId: "r1",
			kind: "execute",
			detail: "rm -rf build",
		},
		{ ...completed, ownedSession: { kind: "claude-session", locator: "abc" } },
		{ type: "failed", class: "rate_limit", message: "429", raw: { line: "x" } },
	];
	for (const event of valid)
		assert.deepEqual(sdk.validateExecEvent(event), [], JSON.stringify(event));
	assert.match(
		sdk
			.validateExecEvent({
				type: "tool_call",
				name: "x",
				kind: "write",
				status: "completed",
			})
			.join(),
		/ACP tool kind/,
	);
	assert.match(
		sdk
			.validateExecEvent({
				type: "tool_call",
				name: "x",
				kind: "edit",
				status: "done",
			})
			.join(),
		/status/,
	);
	assert.match(
		sdk
			.validateExecEvent({
				type: "failed",
				class: "flaky",
				message: "x",
				raw: null,
			})
			.join(),
		/class/,
	);
	assert.match(
		sdk
			.validateExecEvent({ type: "failed", class: "unknown", message: "x" })
			.join(),
		/raw/,
	);
	assert.match(
		sdk
			.validateExecEvent({
				type: "completed",
				finalText: "",
				ownedSession: { kind: "", locator: "x" },
			})
			.join(),
		/ownedSession/,
	);
	assert.match(
		sdk.validateExecEvent({ type: "telemetry" }).join(),
		/unknown event type/,
	);
	assert.throws(
		() => sdk.assertExecEvent({ type: "message_delta" }),
		(error) => sdk.isSdkError(error, "INVALID_EVENT"),
	);
});

test("usage: unknown is null, never 0; tokens may be unknown independently", () => {
	assert.deepEqual(
		sdk.validateExecEvent({
			type: "usage",
			input: 10,
			output: 5,
			cached: null,
			cost: null,
			source: "unknown",
		}),
		[],
	);
	assert.deepEqual(
		sdk.validateExecEvent({
			type: "usage",
			input: null,
			output: null,
			cached: null,
			cost: 0.2,
			source: "estimated",
		}),
		[],
	);
	assert.match(
		sdk
			.validateExecEvent({
				type: "usage",
				input: 1,
				output: 1,
				cached: 0,
				cost: 0,
				source: "unknown",
			})
			.join(),
		/cost must be null/,
	);
	assert.match(
		sdk
			.validateExecEvent({
				type: "usage",
				input: 1,
				output: 1,
				cached: 0,
				cost: null,
				source: "reported",
			})
			.join(),
		/must be unknown/,
	);
	assert.match(
		sdk
			.validateExecEvent({
				type: "usage",
				input: -1,
				output: 1.5,
				cached: 0,
				cost: null,
				source: "unknown",
			})
			.join(),
		/usage\.input.*usage\.output/,
	);
});

test("event sequence: started first, one terminal last, unique approval ids", () => {
	assert.deepEqual(
		sdk.validateEventSequence([
			started,
			{ type: "message_delta", text: "x" },
			completed,
		]),
		[],
	);
	assert.deepEqual(
		sdk.validateEventSequence([started, { type: "message_delta", text: "x" }], {
			complete: false,
		}),
		[],
	);
	assert.match(
		sdk.validateEventSequence([started]).join(),
		/without a terminal/,
	);
	assert.match(
		sdk
			.validateEventSequence([{ type: "message_delta", text: "x" }, completed])
			.join(),
		/first event must be started/,
	);
	assert.match(
		sdk
			.validateEventSequence([
				started,
				completed,
				{ type: "message_delta", text: "late" },
			])
			.join(),
		/after terminal/,
	);
	assert.match(
		sdk.validateEventSequence([started, started, completed]).join(),
		/more than once/,
	);
	const approval = {
		type: "approval_request",
		requestId: "r",
		kind: "read",
		detail: "",
	};
	assert.match(
		sdk.validateEventSequence([started, approval, approval, completed]).join(),
		/duplicate approval/,
	);
	assert.throws(
		() => sdk.assertEventSequence([completed]),
		(error) => sdk.isSdkError(error, "INVALID_EVENT_SEQUENCE"),
	);
	assert.ok(sdk.isTerminalEvent(completed) && !sdk.isTerminalEvent(started));
});

test("tool mapping: fine, coarse (sandbox), MCP, and unmapped tools", () => {
	const claudeLike = {
		executorId: "claude-like",
		entries: {
			read: { type: "tool", names: ["Read"] },
			grep: { type: "tool", names: ["Grep"] },
			bash: { type: "tool", names: ["Bash"] },
			workflow_artifact: {
				type: "mcp",
				server: "agent_workflow",
				tool: "workflow_artifact",
			},
		},
	};
	const fine = sdk.mapTools(
		["read", "grep", "read", "workflow_artifact", "find"],
		claudeLike,
	);
	assert.deepEqual(fine.executorTools, ["Read", "Grep"]);
	assert.deepEqual(fine.mcpTools, [
		{ server: "agent_workflow", tool: "workflow_artifact" },
	]);
	assert.deepEqual(fine.unmapped, ["find"]);
	assert.equal(fine.mutating, false);
	assert.equal(fine.sandbox, null);

	const codexLike = {
		executorId: "codex-like",
		entries: {
			read: { type: "sandbox", mode: "read-only" },
			grep: { type: "sandbox", mode: "read-only" },
			edit: { type: "sandbox", mode: "workspace-write" },
			web_search: { type: "tool", names: ["web_search"] },
		},
	};
	assert.equal(sdk.mapTools(["read", "grep"], codexLike).sandbox, "read-only");
	const write = sdk.mapTools(["read", "edit"], codexLike);
	assert.equal(write.sandbox, "workspace-write");
	assert.equal(write.mutating, true);
	assert.equal(write.kinds.edit, "edit");

	const identity = sdk.identityToolMapping("pi");
	assert.deepEqual(
		sdk.mapTools([...sdk.WORKFLOW_TOOL_NAMES], identity).unmapped,
		[],
	);
	assert.equal(sdk.toolKind("bash"), "execute");
	assert.equal(sdk.toolKind("custom_tool"), "other");
	assert.equal(
		sdk.toolKind("custom_tool", {
			executorId: "x",
			entries: {},
			kinds: { custom_tool: "fetch" },
		}),
		"fetch",
	);
	assert.ok(sdk.isMutatingKind("execute") && !sdk.isMutatingKind("read"));
});
