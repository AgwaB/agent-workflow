// 2026-11-23: an agent's normalized executor events become readable activity entries.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ACTIVITY_MAX_MESSAGE_CHARS,
	ACTIVITY_OUTPUT_LINES,
	compactActivity,
	readActivityFeed,
} from "../../dist/hosts/task-activity-feed.js";

const line = (event) => JSON.stringify(event);

test("tokens join into messages; a call's start and end join into one line", () => {
	const entries = compactActivity(
		[
			line({ type: "started", sessionId: "s" }),
			line({ type: "message_delta", text: "Checking " }),
			line({ type: "message_delta", text: "the tests." }),
			line({
				type: "tool_call",
				name: "shell",
				kind: "execute",
				status: "running",
				callId: "c1",
				input: { command: "npm test" },
			}),
			"{not json",
			line({
				type: "tool_call",
				name: "web_search",
				kind: "fetch",
				status: "running",
				callId: "c2",
				input: {},
			}),
			line({
				type: "tool_call",
				name: "shell",
				kind: "execute",
				status: "completed",
				callId: "c1",
				input: { command: "npm test" },
				output: { exitCode: 0, output: "ok 1\nok 2\n" },
			}),
			line({
				type: "tool_call",
				name: "web_search",
				kind: "fetch",
				status: "completed",
				callId: "c2",
				input: { query: "retry jitter" },
			}),
			line({ type: "message_delta", text: "   " }),
			line({
				type: "usage",
				input: 1,
				output: 1,
				cached: 0,
				cost: null,
				source: "unknown",
			}),
			line({ type: "failed", class: "unknown", message: "boom", raw: null }),
		],
		"/tmp/project",
	);
	assert.deepEqual(entries, [
		{ kind: "message", text: "Checking the tests." },
		{
			kind: "tool",
			label: "Running npm test",
			status: "completed",
			output: "ok 1\nok 2",
		},
		{ kind: "tool", label: 'Searching "retry jitter"', status: "completed" },
		{ kind: "failed", text: "boom" },
	]);
});

test("long output and messages are clipped; a long file shows its latest part", async (t) => {
	const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const [tool, message] = compactActivity(
		[
			line({
				type: "tool_call",
				name: "read",
				kind: "read",
				status: "completed",
				input: { path: "a.ts" },
				output,
			}),
			line({
				type: "message_delta",
				text: `${"x".repeat(ACTIVITY_MAX_MESSAGE_CHARS)}END`,
			}),
		],
		"/tmp/project",
	);
	assert.equal(tool.output.split("\n").length, ACTIVITY_OUTPUT_LINES);
	assert.equal(tool.outputClipped, true);
	assert.equal(message.clipped, true);
	assert.ok(message.text.endsWith("END"));
	assert.equal(message.text.length, ACTIVITY_MAX_MESSAGE_CHARS);

	const dir = await mkdtemp(join(tmpdir(), "aw-activity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "exec-events.jsonl");
	const calls = Array.from({ length: 400 }, (_, i) =>
		line({
			type: "tool_call",
			name: "read",
			kind: "read",
			status: "completed",
			callId: `c${i}`,
			input: { path: `f${i}.ts` },
		}),
	);
	await writeFile(path, `${calls.join("\n")}\n`);
	const feed = await readActivityFeed(path, dir, 300);
	assert.equal(feed.entries.length, 300);
	assert.equal(feed.truncated, true);
	assert.equal(feed.entries.at(-1).label, "Reading f399.ts");
	assert.equal(
		await readActivityFeed(join(dir, "missing.jsonl"), dir),
		undefined,
	);
});
