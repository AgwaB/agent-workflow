import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolCallFromItem } from "../../dist/executors/codex/normalize.js";
import { ClaudeStreamParser } from "../../dist/executors/claude/stream.js";
import { PiEventNormalizer } from "../../dist/executors/pi/parse.js";
import {
	activityFromExecEvent,
	ActivityHeartbeat,
} from "../../dist/runtime/telemetry/task-activity.js";
import {
	runSubagent,
	getSubagentStatus,
	waitForSubagent,
	readRunRecord,
} from "../../dist/runtime/index.js";
import { runSubagentTask } from "../../dist/runtime/orchestrate/run.js";
import { fixtureDescriptor } from "../fixtures/runtime/fake-executor-module.mjs";

const AT = "2026-11-01T10:00:00.000Z";
const CWD = "/tmp/project";
function activity(event) {
	return activityFromExecEvent(event, CWD, AT);
}
function claude(name, input) {
	const events = [];
	const parser = new ClaudeStreamParser((event) => events.push(event));
	parser.line(
		JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "call-1", name, input }] },
		}),
	);
	return events.find((event) => event.type === "tool_call");
}
function pi(name, args) {
	return new PiEventNormalizer({ sessionId: null }).line(
		JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: name,
			args,
		}),
	)[0];
}
function expect(event, kind, label) {
	assert.deepEqual(activity(event), { kind, label, at: AT });
}

test("Codex fixture items map command actions, changes, web, MCP and agents", () => {
	const codex = (item) => toolCallFromItem({ id: "c", ...item }, "started");
	expect(
		codex({ type: "commandExecution", command: "npm test" }),
		"shell",
		"Running npm test",
	);
	expect(
		codex({
			type: "commandExecution",
			command: "cat /tmp/project/src/core/store.ts",
			commandActions: [
				{ type: "read", path: "/tmp/project/src/core/store.ts" },
			],
		}),
		"read",
		"Reading src/core/store.ts",
	);
	expect(
		codex({
			type: "commandExecution",
			command: "rg MINJA",
			commandActions: [{ type: "search", query: "MINJA ISR" }],
		}),
		"search",
		'Searching "MINJA ISR"',
	);
	expect(
		codex({
			type: "fileChange",
			changes: [
				{ path: "/elsewhere/private/README.md", kind: { type: "update" } },
			],
		}),
		"edit",
		"Editing README.md",
	);
	expect(
		codex({ type: "webSearch", query: "MINJA ISR" }),
		"search",
		'Searching "MINJA ISR"',
	);
	expect(
		codex({
			type: "webSearch",
			action: {
				type: "open_page",
				url: "https://user:pass@arxiv.org/abs/2503.03704?token=never-show#fragment",
			},
		}),
		"web",
		"Opening arxiv.org/abs/2503.03704",
	);
	expect(
		codex({
			type: "mcpToolCall",
			server: "server",
			tool: "custom",
			arguments: { password: "never-show" },
		}),
		"tool",
		"Using mcp__server__custom",
	);
	expect(
		codex({ type: "collabAgentToolCall", tool: "spawnAgent" }),
		"agent",
		"Delegating to agent",
	);
});

test("Claude fixture tool_use names map without exposing content or prompts", () => {
	for (const name of [
		"Read",
		"Glob",
		"Grep",
		"WebFetch",
		"WebSearch",
		"Bash",
		"Edit",
		"Write",
		"MultiEdit",
		"Task",
		"Custom",
	]) {
		const [kind, label] = {
			Read: ["read", "Reading src/core/store.ts"],
			Glob: ["search", 'Searching "*.ts"'],
			Grep: ["search", 'Searching "*.ts"'],
			WebFetch: ["web", "Opening example.org/docs"],
			WebSearch: ["search", 'Searching "MINJA ISR"'],
			Bash: ["shell", "Running npm test"],
			Edit: ["edit", "Editing src/core/store.ts"],
			Write: ["edit", "Writing src/core/store.ts"],
			MultiEdit: ["edit", "Editing src/core/store.ts"],
			Task: ["agent", "Delegating to agent"],
			Custom: ["tool", "Using Custom"],
		}[name];
		const input = {
			file_path: "/tmp/project/src/core/store.ts",
			pattern: "*.ts",
			url: "https://user:pass@example.org/docs?api_key=never-show#fragment",
			command: "npm test",
			content: "never-show",
			prompt: "never-show",
			...(name === "WebSearch" ? { query: "MINJA ISR" } : {}),
		};
		expect(claude(name, input), kind, label);
	}
});

test("Pi fixture events map file, shell, query, web and fallback tools", () => {
	for (const [name, input, kind, label] of [
		[
			"read",
			{ path: "/tmp/project/src/core/store.ts" },
			"read",
			"Reading src/core/store.ts",
		],
		["ls", { path: "/outside/home" }, "read", "Reading home"],
		["grep", { pattern: "MINJA ISR" }, "search", 'Searching "MINJA ISR"'],
		["find", { pattern: "*.ts" }, "search", 'Searching "*.ts"'],
		["bash", { command: "npm test" }, "shell", "Running npm test"],
		[
			"edit",
			{ path: "README.md", newText: "never-show" },
			"edit",
			"Editing README.md",
		],
		[
			"write",
			{ path: "README.md", content: "never-show" },
			"edit",
			"Writing README.md",
		],
		[
			"web_fetch",
			{ url: "https://user:pass@example.org/docs?token=never-show#x" },
			"web",
			"Opening example.org/docs",
		],
		["web_search", { query: "MINJA ISR" }, "search", 'Searching "MINJA ISR"'],
		["other", { token: "never-show" }, "tool", "Using other"],
	])
		expect(pi(name, input), kind, label);
});

test("adversarial inputs are bounded and secret-free for every executor", () => {
	const shell =
		"API_KEY='env-secret' OTHER=private npm  test\n --password short-secret";
	for (const event of [
		pi("bash", { command: shell }),
		claude("Bash", { command: shell }),
		toolCallFromItem(
			{ id: "c", type: "commandExecution", command: shell },
			"started",
		),
	])
		expect(event, "shell", "Running npm test [redacted]");
	expect(
		pi("bash", { command: 'KEY="env secret" npm test' }),
		"shell",
		"Running npm test",
	);
	expect(
		pi("read", { path: "../project-other/private/file.ts" }),
		"read",
		"Reading file.ts",
	);
	expect(
		claude("Read", { file_path: "/tmp/project/src/\u001b[31mfile.ts\u202e" }),
		"read",
		"Reading src/ [31mfile.ts",
	);
	for (const token of [
		"sk-super-secret",
		"ghp_privatevalue",
		"a".repeat(64),
		"0123456789abcdef".repeat(4),
		"Bearer short-secret",
		"password short-secret",
		"--headers short-secret",
	]) {
		for (const event of [
			pi("bash", { command: `echo ${token}` }),
			claude("Grep", { pattern: token }),
		]) {
			assert.ok(!activity(event).label.includes("short-secret"));
			assert.ok(!activity(event).label.includes(token));
		}
	}
	for (const name of ["bash", "read", "grep", "other"]) {
		const result = activity(
			pi(name, {
				command: "x".repeat(100_000),
				path: "x".repeat(100_000),
				pattern: "x".repeat(100_000),
			}),
		);
		assert.ok(result.label.length <= 120);
		assert.doesNotMatch(result.label, /[\u0000-\u001f\u007f]/);
	}
	const query = activity(pi("grep", { pattern: "word ".repeat(300) })).label;
	assert.ok(query.startsWith('Searching "') && query.endsWith('"'));
	assert.ok(query.length <= 120);
	const command = activity(
		pi("bash", { command: "echo " + "word ".repeat(100) }),
	).label;
	assert.ok(command.length <= 68);
	expect(
		pi("bash", { command: "cat /outside/private/file.ts" }),
		"shell",
		"Running cat file.ts",
	);
});

test("quoted/outside shell paths and malformed web URLs fail closed", () => {
	expect(
		pi("bash", { command: "cat src/core/store.ts" }),
		"shell",
		"Running cat src/core/store.ts",
	);
	expect(
		pi("bash", { command: "cat src/../../../private/file.ts" }),
		"shell",
		"Running cat file.ts",
	);
	expect(
		pi("bash", { command: 'cat "/outside/private dir/file.ts"' }),
		"shell",
		'Running cat "file.ts"',
	);
	expect(
		pi("bash", { command: "cat ../outside/private/file.ts" }),
		"shell",
		"Running cat file.ts",
	);
	expect(
		pi("web_fetch", { url: "not a URL with user:private@host" }),
		"web",
		"Opening [url]",
	);
});

test("tool completion/output cannot replace the latest running activity", () => {
	assert.equal(
		activity({ type: "message_delta", text: "never-show" }),
		undefined,
	);
	assert.equal(
		activity({
			...pi("read", { path: "README.md" }),
			status: "completed",
			output: "never-show",
		}),
		undefined,
	);
});

test("activity heartbeat coalesces bursts, throttles, and never overlaps a blocked write", async () => {
	const writes = [];
	let release;
	const pulse = new ActivityHeartbeat((value) => {
		writes.push(value);
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	pulse.update({ kind: "read", label: "Reading first", at: AT });
	pulse.update({ kind: "read", label: "Reading latest", at: AT });
	const pending = pulse.tick(0);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].label, "Reading latest");
	pulse.update({ kind: "edit", label: "Editing next", at: AT });
	pulse.tick(2000, true);
	assert.equal(writes.length, 1);
	release();
	await pending;
	const next = pulse.tick(2000);
	assert.equal(writes.length, 2);
	assert.equal(writes[1].label, "Editing next");
	release();
	await next;
	pulse.update({ kind: "shell", label: "Running next", at: AT });
	assert.equal(pulse.tick(2500), undefined);
	assert.equal(writes.length, 2);
	const last = pulse.tick(3000);
	release();
	await last;
	assert.equal(pulse.tick(4000), undefined);
	const heartbeat = pulse.tick(5000, true);
	release();
	await heartbeat;
	await pulse.drain();
	assert.equal(writes.length, 4);
});

for (const async of [false, true]) {
	test(`${async ? "durable worker" : "foreground"} persists activity with captureToolCalls off`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "aw-activity-"));
		try {
			const request = {
				cwd,
				task: "Fixture only",
				async,
				readOnly: true,
				executor: fixtureDescriptor({
					effectLog: join(cwd, "effects.jsonl"),
					stepDelayMs: 800,
					script: [
						{ type: "started", sessionId: null },
						{
							type: "tool_call",
							name: "read",
							kind: "read",
							status: "running",
							input: { path: join(cwd, "README.md") },
						},
						{ type: "message_delta", text: "fixture" },
						{ type: "message_delta", text: "fixture" },
						{ type: "completed", finalText: "done" },
					],
				}),
			};
			// Foreground's run id is supplied so its live registry can also be polled.
			const running = async
				? await runSubagent(request)
				: runSubagentTask({
						input: request,
						cwd,
						runId: "activity-foreground",
					});
			const runId = async ? running.runId : "activity-foreground";
			let seen;
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				const snapshot = await getSubagentStatus({ cwd, runId });
				seen = snapshot?.attempts?.find(
					(attempt) => attempt.activity,
				)?.activity;
				if (seen) break;
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			assert.equal(seen?.label, "Reading README.md");
			assert.equal(seen?.kind, "read");
			assert.ok(Number.isFinite(Date.parse(seen.at)));
			if (!async) await running;
			const terminal = await waitForSubagent({
				cwd,
				runId,
				timeoutMs: 20_000,
				pollIntervalMs: 30,
			});
			assert.equal(terminal.snapshot.status, "completed");
			assert.ok(
				terminal.snapshot.attempts.every((attempt) => !attempt.activity),
			);
			const record = await readRunRecord({ cwd, runId });
			await assert.rejects(
				access(
					join(
						cwd,
						".agent-workflow/runs",
						runId,
						"attempts",
						record.attempts[0].attemptId,
						"tool-calls.jsonl",
					),
				),
				{ code: "ENOENT" },
			);
		} finally {
			await rm(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	});
}
