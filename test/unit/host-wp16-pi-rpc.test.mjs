// New in agent-workflow (WP16): the Pi host's WP16 surfaces in a real Pi 1.1 process without a model
// turn (RPC slash commands only, like host-pi-rpc.test.mjs). A run started with `/aw run` on the
// guarded test executor shows the footer status entry (`setStatus` "agent-workflow"), an identical
// `/aw run` returns the existing run, the completion is delivered once into the session as a custom
// message without starting a turn, the status entry is cleared, and `/aw logs` / `/aw status` answer.
// The recorded, scrubbed transcript (test/fixtures/host-pi/rpc-wp16-transcript.jsonl) is checked on
// every run; the live check runs only with AGENT_WORKFLOW_PI_BIN=<absolute path of the pi bin> (unit
// runs shadow `pi` on PATH and isolate HOME / PI_CODING_AGENT_DIR), and
// AGENT_WORKFLOW_PI_RPC_RECORD=1 rewrites the fixture. The Pi child is killed in `finally`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(
	/\/$/,
	"",
);
const FIXTURE = join(
	repo,
	"test",
	"fixtures",
	"host-pi",
	"rpc-wp16-transcript.jsonl",
);
const ENTRY = join(repo, "dist", "hosts", "pi", "index.js");
const HOOK_MODULE = join(repo, "test", "helpers", "host-test-executor.mjs");
const PI_BIN = process.env.AGENT_WORKFLOW_PI_BIN;
const EXECUTOR = "test-wp16-rpc";

const ISOLATION_FLAGS = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-mcp",
	"--no-context-files",
	"--offline",
	"--no-approve",
];

const SPEC = {
	schemaVersion: 1,
	name: "wp16-rpc",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

function piSession(cwd, env) {
	const child = spawn(PI_BIN, [...ISOLATION_FLAGS, "-e", ENTRY], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const records = [];
	const watchers = new Set();
	let buffer = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			records.push({ dir: "out", record: JSON.parse(line) });
			for (const watcher of [...watchers]) watcher();
		}
	});
	const exited = new Promise((done) => child.on("close", done));
	const until = (predicate, what, timeoutMs = 60_000) =>
		new Promise((done, fail) => {
			const check = () => {
				const found = records.find(
					(entry) => entry.dir === "out" && predicate(entry.record),
				);
				if (!found) return;
				watchers.delete(check);
				clearTimeout(timer);
				done(found.record);
			};
			const timer = setTimeout(() => {
				watchers.delete(check);
				fail(new Error(`timed out waiting for ${what}; stderr:\n${stderr}`));
			}, timeoutMs);
			watchers.add(check);
			check();
		});
	return {
		records,
		until,
		async prompt(id, message) {
			const command = { id, type: "prompt", message };
			records.push({ dir: "in", record: command });
			child.stdin.write(`${JSON.stringify(command)}\n`);
			return until(
				(record) => record.type === "response" && record.id === id,
				`the response to ${id}`,
			);
		},
		async close() {
			child.stdin.end();
			const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			await exited;
			clearTimeout(killer);
		},
		kill() {
			if (child.exitCode === null) child.kill("SIGKILL");
		},
	};
}

const outRecords = (records) =>
	records.filter((entry) => entry.dir === "out").map((entry) => entry.record);

function notifyBefore(records, id) {
	const out = outRecords(records);
	const index = out.findIndex(
		(record) => record.type === "response" && record.id === id,
	);
	return out
		.slice(0, index)
		.filter(
			(record) =>
				record.type === "extension_ui_request" && record.method === "notify",
		)
		.at(-1);
}

function assertTranscript(records) {
	const out = outRecords(records);
	// No model turn: responses, extension UI records and the delivered custom message only.
	for (const record of out) {
		assert.ok(
			record.type === "response" ||
				record.type === "extension_ui_request" ||
				((record.type === "message_start" || record.type === "message_end") &&
					record.message?.role === "custom"),
			`unexpected record ${record.type}`,
		);
	}
	for (const id of ["run", "dup", "logs", "status"]) {
		const response = out.find(
			(record) => record.type === "response" && record.id === id,
		);
		assert.ok(response, id);
		assert.equal(response.success, true, id);
		assert.equal(response.data.disposition, "handled", id);
	}
	assert.match(
		notifyBefore(records, "run").message,
		/Workflow started: wp16-rpc/,
	);
	assert.match(
		notifyBefore(records, "dup").message,
		/^Duplicate launch guard: run \S+ is already active/,
	);
	assert.equal(notifyBefore(records, "dup").notifyType, "warning");
	const statuses = out.filter(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "setStatus" &&
			record.statusKey === "agent-workflow",
	);
	assert.match(statuses[0].statusText, /^aw: wp16-rpc \d\/1 running$/);
	assert.equal(statuses.at(-1).statusText, undefined, "cleared when done");
	const delivered = out.filter(
		(record) =>
			record.type === "message_end" &&
			record.message.customType === "agent-workflow-completion",
	);
	assert.equal(delivered.length, 1, "exactly one completion message");
	assert.match(
		delivered[0].message.content,
		/^\*\*Workflow completed: wp16-rpc\*\*/,
	);
	assert.match(delivered[0].message.content, /Verdict: /);
	assert.equal(delivered[0].message.display, true);
	assert.equal(delivered[0].message.details.status, "completed");
	const logs = notifyBefore(records, "logs");
	assert.match(logs.message, /^Logs: wp16-rpc \(completed\)/);
	assert.match(logs.message, /-- events: .*exec-events\.jsonl/);
	assert.equal(logs.notifyType, "info");
	assert.match(notifyBefore(records, "status").message, /Status: completed/);
}

function scrub(records, cwd) {
	let text = JSON.stringify(records);
	const replace = (from, to) => {
		if (from) text = text.split(from).join(to);
	};
	replace(repo, "<repo>");
	replace(cwd, "<cwd>");
	replace(homedir(), "<home>");
	text = text
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			"<uuid>",
		)
		.replace(/workflow_[a-z0-9]+_[a-f0-9]+/g, "<run>")
		.replace(/(run|attempt)_[a-z0-9]+_[a-f0-9]+/g, "<$1>")
		.replace(/"timestamp":\d+/g, '"timestamp":0')
		.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>")
		.replace(/"pid\\?":\s*\d+/g, '"pid":0')
		.replace(/started [^)]* ago/g, "started <age> ago");
	return JSON.parse(text);
}

test("recorded real-Pi RPC transcript: WP16 status line, duplicate guard, completion delivery, /aw logs", async () => {
	const lines = (await readFile(FIXTURE, "utf8")).split("\n").filter(Boolean);
	const records = lines.map((line) => JSON.parse(line));
	assert.equal(records[0].dir, "meta");
	assert.match(records[0].pi, /^1\.1\./);
	assertTranscript(records.slice(1));
	assert.doesNotMatch(lines.join("\n"), /\/Users\/|\/home\/[a-z]/);
});

test("live real-Pi RPC check (AGENT_WORKFLOW_PI_BIN): WP16 surfaces without a model turn", {
	skip: PI_BIN ? false : "set AGENT_WORKFLOW_PI_BIN to run against a real Pi",
}, async () => {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-wp16-rpc-")));
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "aw-home"),
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
		AW_HOST_TEST_EFFECT_LOG: join(cwd, "effects.jsonl"),
		AW_HOST_TEST_EXECUTOR_ID: EXECUTOR,
		AW_HOST_TEST_EXECUTOR_CONFIG: JSON.stringify({ stepDelayMs: 600 }),
	};
	const session = piSession(cwd, env);
	try {
		const runMessage = `/aw run wf.json "rpc task" --executor ${EXECUTOR}`;
		await session.prompt("run", runMessage);
		const started = notifyBefore(session.records, "run");
		const runId = /Run: (workflow_\S+)/.exec(started.message)?.[1];
		assert.ok(runId, started.message);
		await session.prompt("dup", runMessage);
		await session.until(
			(record) =>
				record.type === "message_end" &&
				record.message?.customType === "agent-workflow-completion",
			"the completion message",
		);
		await session.until(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "setStatus" &&
				record.statusText === undefined,
			"the status entry to clear",
		);
		await session.prompt("logs", `/aw logs ${runId} --lines 3`);
		await session.prompt("status", `/aw status ${runId}`);
		// Trailing fire-and-forget records, then an orderly shutdown.
		await new Promise((done) => setTimeout(done, 500));
		await session.close();
		assertTranscript(session.records);
		if (process.env.AGENT_WORKFLOW_PI_RPC_RECORD === "1") {
			const version = await new Promise((done) => {
				const child = spawn(PI_BIN, ["--version"], { env: process.env });
				let text = "";
				child.stdout.on("data", (chunk) => {
					text += chunk;
				});
				child.on("close", () => done(text.trim()));
			});
			const meta = {
				dir: "meta",
				pi: version,
				flags: ISOLATION_FLAGS,
				extension: "<repo>/dist/hosts/pi/index.js",
				executor: EXECUTOR,
			};
			await writeFile(
				FIXTURE,
				`${[meta, ...scrub(session.records, cwd)].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
		}
	} finally {
		session.kill();
		await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
	}
});
