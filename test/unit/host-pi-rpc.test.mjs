// New in agent-workflow (WP11b): the Pi host in a real Pi 1.1 process, without a model turn. Pi's
// RPC mode runs extension slash commands locally: a `prompt` whose response has
// `data.disposition: "handled"` starts no agent run (Pi docs/rpc.md). The recorded, scrubbed
// transcript (test/fixtures/host-pi/rpc-aw-transcript.jsonl) is checked on every unit run; a live
// re-check runs only with AGENT_WORKFLOW_PI_BIN=<absolute path of the pi bin> (unit runs shadow
// `pi` on PATH), and AGENT_WORKFLOW_PI_RPC_RECORD=1 rewrites the fixture. With
// AGENT_WORKFLOW_PI_WORKFLOW_EXTENSION=<pi-workflow src/extension.ts> the live check also loads
// pi-workflow next to the Pi host and checks that both commands register.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
	"rpc-aw-transcript.jsonl",
);
const ENTRY = join(repo, "dist", "hosts", "pi", "index.js");
const PI_BIN = process.env.AGENT_WORKFLOW_PI_BIN;
const PI_WORKFLOW = process.env.AGENT_WORKFLOW_PI_WORKFLOW_EXTENSION;

const PROMPTS = [
	{ id: "aw-help", message: "/aw help" },
	{ id: "aw-list", message: "/aw list" },
	{ id: "aw-validate", message: "/aw validate deep-review" },
];

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

/** Send each command, wait for its response, and collect every stdout record in order. */
async function rpcSession(cwd, extensions, commands) {
	const child = spawn(
		PI_BIN,
		[...ISOLATION_FLAGS, ...extensions.flatMap((path) => ["-e", path])],
		{ cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const records = [];
	let buffer = "";
	let stderr = "";
	const waiters = new Map();
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
			const record = JSON.parse(line);
			records.push({ dir: "out", record });
			if (record.type === "response" && waiters.has(record.id)) {
				waiters.get(record.id)();
				waiters.delete(record.id);
			}
		}
	});
	const exited = new Promise((done) => child.on("close", done));
	try {
		for (const command of commands) {
			const responded = new Promise((done, fail) => {
				waiters.set(command.id, done);
				setTimeout(
					() =>
						fail(new Error(`no response to ${command.id}; stderr:\n${stderr}`)),
					60_000,
				).unref();
			});
			records.push({ dir: "in", record: command });
			child.stdin.write(`${JSON.stringify(command)}\n`);
			await responded;
		}
		// Let trailing fire-and-forget records arrive, then close stdin (orderly shutdown).
		await new Promise((done) => setTimeout(done, 300));
	} finally {
		child.stdin.end();
		await exited;
	}
	return records;
}

function scrub(records, cwd) {
	let text = JSON.stringify(records);
	const replace = (from, to) => {
		if (from) text = text.split(from).join(to);
	};
	replace(repo, "<repo>");
	replace(cwd, "<cwd>");
	replace(homedir(), "<home>");
	text = text.replace(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
		"<uuid>",
	);
	return JSON.parse(text);
}

function assertTranscript(records) {
	const out = records
		.filter((entry) => entry.dir === "out")
		.map((entry) => entry.record);
	// No model turn: nothing but responses and extension UI records.
	for (const record of out)
		assert.ok(
			record.type === "response" || record.type === "extension_ui_request",
			`unexpected record ${record.type}`,
		);
	const response = (id) =>
		out.find((record) => record.type === "response" && record.id === id);
	for (const { id } of PROMPTS) {
		const answer = response(id);
		assert.ok(answer, id);
		assert.equal(answer.success, true, id);
		assert.equal(answer.data.disposition, "handled", id);
	}
	const notes = out.filter(
		(record) =>
			record.type === "extension_ui_request" && record.method === "notify",
	);
	const noteBefore = (id) => {
		const index = out.indexOf(response(id));
		return out
			.slice(0, index)
			.filter((record) => notes.includes(record))
			.at(-1);
	};
	assert.match(noteBefore("aw-help").message, /^\/aw — agent-workflow in Pi\./);
	assert.match(
		noteBefore("aw-help").message,
		/aw_list, aw_run, aw_dynamic, aw_wait/,
	);
	assert.match(noteBefore("aw-list").message, /(^|\n)deep-review: /);
	assert.match(noteBefore("aw-list").message, /(^|\n)deep-research: /);
	assert.match(
		noteBefore("aw-validate").message,
		/^Workflow spec valid: deep-review\nSpec: .*workflows\/deep-review\/spec\.json/,
	);
	for (const note of notes) assert.equal(note.notifyType, "info");
	const commands = response("commands").data.commands;
	const aw = commands.find((command) => command.name === "aw");
	assert.equal(aw.source, "extension");
	assert.match(aw.sourceInfo.path, /dist\/hosts\/pi\/index\.js$/);
}

test("recorded real-Pi RPC transcript: /aw help, list, validate are handled without a model turn", async () => {
	const lines = (await readFile(FIXTURE, "utf8")).split("\n").filter(Boolean);
	const records = lines.map((line) => JSON.parse(line));
	assert.equal(records[0].dir, "meta");
	assert.match(records[0].pi, /^1\.1\./);
	assertTranscript(records.slice(1));
	assert.doesNotMatch(lines.join("\n"), /\/Users\/|\/home\/[a-z]/);
});

test("live real-Pi RPC check (AGENT_WORKFLOW_PI_BIN)", {
	skip: PI_BIN ? false : "set AGENT_WORKFLOW_PI_BIN to run against a real Pi",
}, async () => {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-host-pi-rpc-")));
	try {
		const commands = [
			...PROMPTS.map(({ id, message }) => ({ id, type: "prompt", message })),
			{ id: "commands", type: "get_commands" },
		];
		const records = await rpcSession(cwd, [ENTRY], commands);
		assertTranscript(records);
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
			};
			const scrubbed = scrub(records, cwd);
			await writeFile(
				FIXTURE,
				`${[meta, ...scrubbed].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
		}
		if (PI_WORKFLOW) {
			const both = await rpcSession(
				cwd,
				[ENTRY, PI_WORKFLOW],
				[
					{ id: "commands", type: "get_commands" },
					{ id: "aw-help", type: "prompt", message: "/aw help" },
					{ id: "workflow-help", type: "prompt", message: "/workflow help" },
				],
			);
			const out = both
				.filter((entry) => entry.dir === "out")
				.map((entry) => entry.record);
			const names = out
				.find((record) => record.id === "commands")
				.data.commands.map((command) => command.name);
			assert.ok(
				names.includes("aw") && names.includes("workflow"),
				names.join(","),
			);
			for (const id of ["aw-help", "workflow-help"])
				assert.equal(
					out.find((record) => record.type === "response" && record.id === id)
						.data.disposition,
					"handled",
				);
		}
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
