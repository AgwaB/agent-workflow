// WP43b: `/aw dashboard [<run>]` in the Pi host opens the local web dashboard through a one-time
// launch URL handed to the browser only; the note the user sees never carries the session token or
// the launch key. Uses a real dashboard server (discovery on) and a recorder in place of a browser.
import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ext = await import("../../dist/hosts/pi/extension.js");
const api = await import("../../dist/hosts/api.js");
const { startDashboardServer } = await import(
	"../../dist/hosts/dashboard/index.js"
);

let root;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-pi-dashboard-"));
});
after(() => rm(root, { recursive: true, force: true }));

function fakePi() {
	const commands = new Map();
	return {
		commands,
		tools: new Map(),
		registerCommand: (name, spec) => commands.set(name, spec),
		registerTool: () => {},
		on: () => {},
		events: { on: () => {}, emit: () => {} },
		getModelRegistry: () => ({ getAvailable: () => [] }),
		getThinkingLevel: () => "medium",
	};
}
function fakeCtx(cwd) {
	const notes = [];
	return {
		cwd,
		hasUI: true,
		mode: "rpc",
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: { getAvailable: () => [] },
		notes,
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			confirm: async () => true,
			select: async () => undefined,
		},
	};
}

test("/aw dashboard opens a launch URL in the browser (open mode: no credential; --auth: one-time token) and never shows secrets", {
	timeout: 20_000,
}, async (t) => {
	const cwd = join(root, "p1");
	await mkdir(join(cwd, ".agent-workflow"), { recursive: true });
	const log = join(root, "opened.log");
	const recorder = join(root, "browser.sh");
	await writeFile(recorder, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\n`);
	await chmod(recorder, 0o755);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(root, "home"),
		BROWSER: recorder,
	};
	// WP43d default (open): the opened URL carries only a launch id and sets no cookie.
	const open = await startDashboardServer({ cwd, env, discovery: true });
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ api, env })(pi);
	const command = pi.commands.get("aw");
	const ctx = fakeCtx(cwd);
	await command.handler("dashboard", ctx);
	let openRecorded = "";
	for (let i = 0; i < 30 && !openRecorded; i++) {
		await new Promise((r) => setTimeout(r, 100));
		openRecorded = await readFile(log, "utf8").catch(() => "");
	}
	assert.match(
		openRecorded.trim(),
		new RegExp(
			`^http://127\\.0\\.0\\.1:${open.port}/\\?launch=[A-Za-z0-9_-]{24}$`,
		),
	);
	const landed = await fetch(openRecorded.trim(), { redirect: "manual" });
	assert.equal(landed.status, 302);
	assert.equal(landed.headers.get("set-cookie"), null);
	assert.match(ctx.notes.at(-1)?.message ?? "", /Opened the dashboard/);
	await open.close();
	await rm(log, { force: true });
	const server = await startDashboardServer({
		cwd,
		env,
		discovery: true,
		auth: true,
	});
	t.after(() => server.close());
	await command.handler("dashboard", ctx);
	// The recorder is a detached shell; give it a moment to write.
	let recorded = "";
	for (let i = 0; i < 30 && !recorded; i++) {
		await new Promise((r) => setTimeout(r, 100));
		recorded = await readFile(log, "utf8").catch(() => "");
	}
	const note = ctx.notes.at(-1)?.message ?? "";
	assert.match(
		note,
		/Opened the dashboard in your browser \(127\.0\.0\.1:\d+\)\./,
		note,
	);
	assert.doesNotMatch(note, /token=|launchKey/);
	const opened = recorded.trim().split("\n");
	assert.equal(opened.length, 1);
	assert.match(
		opened[0],
		new RegExp(
			`^http://127\\.0\\.0\\.1:${server.port}/\\?token=[A-Za-z0-9_-]{43}$`,
		),
	);
	assert.notEqual(
		opened[0],
		server.url,
		"a one-time launch token, not the session token",
	);
	const first = await fetch(opened[0], { redirect: "manual" });
	assert.equal(first.status, 302);
	assert.equal(first.headers.get("location"), "/");
	assert.equal(
		(await fetch(opened[0], { redirect: "manual" })).status,
		401,
		"single use",
	);
	await command.handler("dashboard a b", ctx);
	assert.match(ctx.notes.at(-1).message, /Usage: \/aw dashboard/);
});
