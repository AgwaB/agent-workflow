// New in agent-workflow (WP19, stage-2 reviews #4 and #7).
// #4: `logs` (and `inspect --results`) read only files whose canonical path is inside the
// project's artifact root. Tampered run metadata (an absolute output path, `..` traversal) and a
// symlinked attempt dir pointing outside the project never return the outside sentinel; the
// stream says why it was not read.
// #7: structured credentials (quoted header values with whitespace, JSON fields with secret-like
// keys, escaped JSON inside event lines) and Linux/Windows home paths are redacted in logs and in
// every host text that carries worker output (wait/status/inspect, Pi completion message).
// Temp dirs only; the workflow executor fixture makes no model or agent-CLI calls.
import assert from "node:assert/strict";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");
const sensitive = await import("../../dist/core/workflow-sensitive-query.js");
const feedback = await import("../../dist/hosts/pi/feedback.js");

let root;
let counter = 0;
const unregister = [];
const SENTINEL = "WP19-OUTSIDE-SENTINEL-7f3a";

const SPEC = {
	schemaVersion: 1,
	name: "wp19-logs",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-logs-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function completedRun() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp19-logs-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	const ctx = { cwd, env };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "logs task",
		executor: id,
	});
	let waited;
	do
		waited = await api.waitAction(ctx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	assert.equal(waited.data.status, "completed");
	return { cwd, env, ctx, runId: launched.data.runId };
}

async function outsideSentinel(name) {
	const dir = join(root, `outside-${name}-${counter}`);
	await mkdir(dir, { recursive: true });
	const file = join(dir, "secret.txt");
	await writeFile(file, `${SENTINEL}\n`);
	return { dir, file };
}

async function tamperTaskFiles(cwd, runId, files) {
	const path = join(cwd, ".agent-workflow", "workflows", runId, "run.json");
	const record = JSON.parse(await readFile(path, "utf8"));
	record.tasks[0].files = { ...record.tasks[0].files, ...files };
	await writeFile(path, JSON.stringify(record, null, 2));
}

async function attemptDir(cwd, runId) {
	const taskRoot = join(
		cwd,
		".agent-workflow",
		"workflow-subagents",
		runId,
		"task-1",
	);
	const [backendRun] = (await readdir(taskRoot)).filter((name) =>
		name.startsWith("run_"),
	);
	const attempts = join(taskRoot, backendRun, "attempts");
	const [attempt] = (await readdir(attempts)).filter((name) =>
		name.startsWith("attempt_"),
	);
	return join(attempts, attempt);
}

test("review #4: tampered absolute output path does not leak the outside file", async () => {
	const { cwd, ctx, runId } = await completedRun();
	const { file } = await outsideSentinel("abs");
	await tamperTaskFiles(cwd, runId, { output: file, result: file });
	const logs = await api.logsAction(ctx, { runId, stream: "output" });
	assert.doesNotMatch(logs.text, new RegExp(SENTINEL));
	const stream = logs.data.tasks[0].streams[0];
	assert.match(stream.refused ?? "", /absolute path/);
	assert.match(logs.text, /not read: absolute path/);
	const inspect = await api.inspectAction(ctx, { runId, results: true });
	assert.doesNotMatch(inspect.text, new RegExp(SENTINEL));
	assert.match(inspect.text, /result not read/);
});

test("review #4: `..` traversal in metadata is refused", async () => {
	const { cwd, ctx, runId } = await completedRun();
	const { file } = await outsideSentinel("dots");
	const rel = join("..", "..", file.slice(root.length + 1));
	await tamperTaskFiles(cwd, runId, { output: join(".agent-workflow", rel) });
	const logs = await api.logsAction(ctx, { runId, stream: "output" });
	assert.doesNotMatch(logs.text, new RegExp(SENTINEL));
	assert.match(logs.data.tasks[0].streams[0].refused ?? "", /traversal/);
});

test("review #4: a symlinked attempt dir pointing outside the project is refused", async () => {
	const { cwd, ctx, runId } = await completedRun();
	const attempt = await attemptDir(cwd, runId);
	const { dir } = await outsideSentinel("attempt");
	await writeFile(join(dir, "stderr.log"), `${SENTINEL} stderr\n`);
	await writeFile(join(dir, "exec-events.jsonl"), `{"x":"${SENTINEL}"}\n`);
	await rename(attempt, `${attempt}.moved`);
	await symlink(dir, attempt);
	const logs = await api.logsAction(ctx, { runId });
	assert.doesNotMatch(logs.text, new RegExp(SENTINEL));
	const events = logs.data.tasks[0].streams.find(
		(stream) => stream.kind === "events",
	);
	assert.match(events?.refused ?? "", /symlink escape/);
});

// --- #7: structured credentials and home paths ---

const b64 = Buffer.from(["us", "er:pa", "ssword"].join("")).toString("base64");
const LINUX_HOME = ["", "home", "someone", "proj", "f.txt"].join("/");
const WINDOWS_HOME = ["C:", "Users", "someone", "proj"].join("\\");
const WINDOWS_HOME_ESCAPED = ["C:", "Users", "someone", "proj"].join("\\\\");
const CASES = [
	`{"Authorization":"Basic ${b64}"}`,
	`{"authorization": "Bearer abc.def.ghi-jkl"}`,
	`{"Proxy-Authorization":"Basic ${b64}"}`,
	`{"Cookie":"sid=s3cr3tcookie; theme=dark"}`,
	`{"Set-Cookie":"session=s3cr3tcookie; Path=/; HttpOnly"}`,
	`{"x-api-key":"key with space s3cr3tkey"}`,
	`{"token":"tok s3cr3ttok"}`,
	`{"access_token":"at s3cr3tat","refresh_token":"rt s3cr3trt"}`,
	`{"api_key":"ak s3cr3tak","apiKey":"ak2 s3cr3tak2"}`,
	`{"secret":"s s3cr3ts","password":"pw s3cr3tpw","client_secret":"cs s3cr3tcs"}`,
	`{"type":"tool","input":"{\\"headers\\":{\\"Authorization\\":\\"Basic ${b64}\\"}}"}`,
	`read ${LINUX_HOME} and ${WINDOWS_HOME} and ${WINDOWS_HOME_ESCAPED}`,
];
const LEAKS = [b64, "abc.def.ghi", "s3cr3t", "someone"];

test("review #7: the shared redactor covers structured credentials and home paths", () => {
	for (const line of CASES) {
		const out = sensitive.redactSensitiveWorkflowText(line);
		for (const leak of LEAKS)
			assert.ok(!out.includes(leak), `${line} → ${out} still has ${leak}`);
	}
	// Non-secret structure stays readable.
	assert.equal(
		sensitive.redactSensitiveWorkflowText(
			'{"type":"completed","text":"ok fine"}',
		),
		'{"type":"completed","text":"ok fine"}',
	);
});

test("review #7: logs, wait, status and inspect redact structured credentials in worker output", async () => {
	const { cwd, ctx, runId } = await completedRun();
	const attempt = await attemptDir(cwd, runId);
	await appendFile(join(attempt, "stderr.log"), `${CASES.join("\n")}\n`);
	await appendFile(
		join(attempt, "exec-events.jsonl"),
		`${CASES.slice(0, 3).join("\n")}\n`,
	);
	const run = JSON.parse(
		await readFile(
			join(cwd, ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
	await appendFile(
		join(cwd, run.tasks[0].files.output),
		`${CASES.join("\n")}\n`,
	);
	await writeFile(join(cwd, run.tasks[0].files.result), CASES.join("\n"));
	const logs = await api.logsAction(ctx, { runId, lines: 50 });
	const inspect = await api.inspectAction(ctx, { runId, results: true });
	const waited = await api.waitAction(ctx, { runId, timeoutMs: 1_000 });
	const status = await api.statusAction(ctx, { runId });
	const pi = await feedback.completionMessage(
		cwd,
		JSON.parse(
			await readFile(
				join(cwd, ".agent-workflow", "workflows", runId, "run.json"),
				"utf8",
			),
		),
		{ instruct: true, env: ctx.env },
	);
	assert.ok(waited.text.includes("REDACTED"), waited.text);
	for (const [label, text] of [
		["logs", logs.text],
		["inspect", inspect.text],
		["wait", waited.text],
		["wait preview", waited.data.preview ?? ""],
		["status", status.text],
		["pi completion", pi.content],
	])
		for (const leak of LEAKS)
			assert.ok(!text.includes(leak), `${label} leaks ${leak}`);
	assert.match(logs.text, /"Authorization":"REDACTED"/);
});
