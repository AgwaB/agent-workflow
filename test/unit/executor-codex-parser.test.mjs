// WP7: codex app-server notifications → normalized events, per event type, over the scrubbed live
// recordings (test/fixtures/executors/codex/recorded/) and small synthetic cases.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateExecEvent } from "../../dist/sdk/index.js";
import {
	CodexTurnNormalizer,
	TOOL_OUTPUT_EVENT_LIMIT,
	commandKind,
	toolCallFromItem,
} from "../../dist/executors/codex/index.js";
import { AppServerConnection } from "../../dist/executors/codex/rpc.js";
import { readTranscript } from "../fixtures/executors/codex/replay.mjs";

const recorded = (name) =>
	readTranscript(
		fileURLToPath(
			new URL(
				`../fixtures/executors/codex/recorded/${name}.jsonl`,
				import.meta.url,
			),
		),
	);

/** Feed the server notifications of a transcript through the normalizer like the executor does. */
function normalize(entries, options = {}) {
	const normalizer = new CodexTurnNormalizer(options.kinds ?? {});
	const events = [];
	const flat = [];
	for (const entry of entries) {
		if (entry.branches !== undefined) {
			flat.push(...entry.branches[0].entries);
			break;
		}
		flat.push(entry);
	}
	for (const { dir, msg } of flat) {
		if (dir !== "in" || typeof msg.method !== "string" || msg.id !== undefined)
			continue;
		if (msg.method === "turn/completed")
			events.push(...normalizer.finish(msg.params.turn, options.finish ?? {}));
		else events.push(...normalizer.push(msg.method, msg.params));
	}
	for (const event of events)
		assert.deepEqual(validateExecEvent(event), [], JSON.stringify(event));
	return events;
}

test("recorded complete: read tool, deltas, per-turn usage without cost, final text", () => {
	const events = normalize(recorded("complete"));
	const tools = events.filter((event) => event.type === "tool_call");
	assert.deepEqual(
		tools.map((event) => [event.name, event.kind, event.status]),
		[
			["shell", "read", "running"],
			["shell", "read", "completed"],
		],
	);
	assert.match(JSON.stringify(tools[0].input), /cat a\.txt/);
	assert.ok(events.some((event) => event.type === "message_delta"));
	// WP12a: SDK input excludes cache reads (Codex reports 22076 including 17664 cached).
	assert.deepEqual(events.at(-2), {
		type: "usage",
		input: 22076 - 17664,
		output: 110,
		cached: 17664,
		cacheWrite: 0,
		cost: null,
		source: "unknown",
	});
	assert.deepEqual(events.at(-1), {
		type: "completed",
		finalText: "hello from aw",
	});
});

test("recorded MCP call: visible name, read kind, nonce input, clipped output", () => {
	const events = normalize(recorded("parser-mcp-output-limit"), {
		kinds: { mcp__workflow_artifact__workflow_artifact: "read" },
	});
	const done = events.find(
		(event) => event.type === "tool_call" && event.status === "completed",
	);
	assert.equal(done.name, "mcp__workflow_artifact__workflow_artifact");
	assert.equal(done.kind, "read");
	assert.deepEqual(done.input, { text: "N0NCE42" });
	assert.ok(done.output.length <= TOOL_OUTPUT_EVENT_LIMIT + 120);
	assert.match(done.output, /chars clipped in the normalized event/);
	const final = events.at(-1);
	assert.equal(final.type, "completed");
	assert.match(
		final.finalText,
		/TOOL=mcp__workflow_artifact__workflow_artifact/,
	);
	assert.match(
		final.finalText,
		/truncated output \(original token count: 15002\)/,
	);
});

test("recorded write: apply_patch is an edit tool call", () => {
	const events = normalize(recorded("parser-write"));
	const patch = events.filter(
		(event) => event.type === "tool_call" && event.name === "apply_patch",
	);
	assert.deepEqual(
		patch.map((event) => [event.kind, event.status]),
		[
			["edit", "running"],
			["edit", "completed"],
		],
	);
	assert.match(JSON.stringify(patch[0].input), /out\.txt/);
});

test("recorded resume: replayed usage of the earlier turn is not billed to the new turn", () => {
	const events = normalize(recorded("parser-resume"));
	const usage = events.find((event) => event.type === "usage");
	// WP12a: input + cached (+ cacheWrite) is Codex's input delta of the new turn.
	assert.equal(
		usage.input + usage.cached + (usage.cacheWrite ?? 0),
		22244 - 11019,
	);
	assert.equal(events.at(-1).type, "completed");
});

test("recorded interrupt, invalid model and missing login map to their failure classes", () => {
	assert.deepEqual(normalize(recorded("slow")).at(-1).class, "cancelled");
	const config = normalize(recorded("fail_config")).at(-1);
	assert.equal(config.class, "config");
	assert.match(config.message, /model_not_found/);
	const auth = normalize(recorded("fail_auth")).at(-1);
	assert.equal(auth.class, "auth");
	assert.match(auth.message, /401 Unauthorized/);
});

test("recorded approval (declined branch): the command is reported denied, never completed", () => {
	const events = normalize(recorded("approval"));
	const shell = events.filter(
		(event) => event.type === "tool_call" && event.name === "shell",
	);
	assert.deepEqual(
		shell.map((event) => [event.kind, event.status]),
		[
			["execute", "running"],
			["execute", "denied"],
		],
	);
});

test("command kinds follow commandActions; non-zero exit fails; declined is denied", () => {
	assert.equal(commandKind([{ type: "read" }, { type: "listFiles" }]), "read");
	assert.equal(commandKind([{ type: "search" }]), "search");
	assert.equal(commandKind([{ type: "read" }, { type: "search" }]), "search");
	assert.equal(commandKind([{ type: "unknown" }]), "execute");
	assert.equal(commandKind([]), "execute");
	const item = {
		type: "commandExecution",
		id: "c1",
		command: "false",
		commandActions: [],
		status: "completed",
		exitCode: 1,
		aggregatedOutput: "",
	};
	assert.equal(toolCallFromItem(item, "completed").status, "failed");
	assert.equal(
		toolCallFromItem({ ...item, status: "declined" }, "completed").status,
		"denied",
	);
	assert.equal(
		toolCallFromItem({ type: "reasoning", id: "r" }, "completed"),
		undefined,
	);
});

test("web search, file deletes, MCP errors and dynamic tools", () => {
	const web = toolCallFromItem(
		{
			type: "webSearch",
			id: "w",
			query: "rust",
			action: { type: "search", query: "rust" },
		},
		"completed",
	);
	assert.deepEqual(
		[web.name, web.kind, web.status],
		["web_search", "fetch", "completed"],
	);
	const del = toolCallFromItem(
		{
			type: "fileChange",
			id: "f",
			changes: [{ path: "x", kind: { type: "delete" }, diff: "" }],
			status: "completed",
		},
		"completed",
	);
	assert.equal(del.kind, "delete");
	const mcp = toolCallFromItem(
		{
			type: "mcpToolCall",
			id: "m",
			server: "s-1",
			tool: "t",
			status: "failed",
			arguments: {},
			result: null,
			error: { message: "timed out" },
			readOnlyHint: null,
		},
		"completed",
	);
	assert.deepEqual(
		[mcp.name, mcp.kind, mcp.status, mcp.output],
		["mcp__s_1__t", "other", "failed", { error: "timed out" }],
	);
	assert.equal(
		toolCallFromItem(
			{ type: "dynamicToolCall", id: "d", tool: "x", status: "inProgress" },
			"started",
		).status,
		"running",
	);
});

test("retried errors are ignored; a failed turn uses the last error; no usage means no usage event", () => {
	const normalizer = new CodexTurnNormalizer();
	normalizer.push("error", {
		error: { message: "Reconnecting... 1/5", codexErrorInfo: null },
		willRetry: true,
	});
	assert.equal(normalizer.pendingError, undefined);
	normalizer.push("error", {
		error: {
			message: "Rate limit reached",
			codexErrorInfo: "rateLimitExceeded",
		},
		willRetry: false,
	});
	const events = normalizer.finish({ id: "t", status: "failed", error: null });
	assert.equal(events.length, 1);
	assert.deepEqual(
		[events[0].type, events[0].class, events[0].message],
		["failed", "rate_limit", "Rate limit reached"],
	);
	assert.equal(
		new CodexTurnNormalizer().finish({ status: "completed" }).at(-1).finalText,
		"",
	);
});

test("a requested session is reported as ownedSession on every terminal event", () => {
	const owned = { kind: "codex-thread", locator: "019a" };
	for (const status of ["completed", "failed", "interrupted"]) {
		const terminal = new CodexTurnNormalizer()
			.finish({ status }, { ownedSession: owned })
			.at(-1);
		assert.deepEqual(terminal.ownedSession, owned, status);
	}
});

test("JSON-RPC lines split on \\n only (U+2028/U+2029 inside strings, seen in live web results)", async () => {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new PassThrough();
	const notes = [];
	new AppServerConnection(child, {
		onNotification: (method, params) => notes.push([method, params]),
		onServerRequest: () => {},
		onClose: () => {},
	});
	child.stdout.write(
		`${JSON.stringify({ method: "x/y", params: { text: "a\u2028b\u2029c" } })}\n{"method":"z",`,
	);
	child.stdout.write(`"params":{}}\n`);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(notes, [
		["x/y", { text: "a\u2028b\u2029c" }],
		["z", {}],
	]);
});
