// 2026-11-02 (B6): the Pi probe lists the tools a worker-like Pi session registers, so a web tool
// that pi-web-access's own config turned off is reported unavailable (and refused before a run)
// instead of silently missing in the worker. A fake `pi` loads the `-e` extensions with a minimal
// extension API and fires `session_start`; the probe extension must exit there (no model request).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	createExecutor,
	listPiWebSessionTools,
} from "../../dist/executors/pi/index.js";

const roots = [];
after(async () => {
	for (const dir of roots)
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
});

const FAKE_PI = `
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("pi 1.1.0"); process.exit(0); }
if (argv.includes("--list-models")) { console.log("provider model\\nopenai-codex gpt-6.1-sol"); process.exit(0); }
if (argv[0] === "list") process.exit(1);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(argv) + "\\n");
const allowed = (argv[argv.indexOf("--tools") + 1] ?? "").split(",");
const tools = [];
const handlers = {};
const api = {
	registerTool: (tool) => { if (allowed.includes(tool.name)) tools.push(tool); },
	on: (event, fn) => { (handlers[event] ??= []).push(fn); },
	getAllTools: () => tools.map((tool) => ({ name: tool.name })),
};
for (let i = 0; i < argv.length; i++)
	if (argv[i] === "-e") (await import(argv[i + 1])).default(api);
for (const fn of handlers.session_start ?? []) await fn({}, {});
appendFileSync(process.env.FAKE_PI_LOG, "MODEL REQUEST\\n");
`;

async function setup(webTools) {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-web-tools-"));
	roots.push(dir);
	const log = join(dir, "pi.log");
	await writeFile(join(dir, "fake-pi.mjs"), FAKE_PI);
	const pi = join(dir, "pi");
	await writeFile(
		pi,
		`#!/bin/sh\nFAKE_PI_LOG=${JSON.stringify(log)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "fake-pi.mjs"))} "$@"\n`,
		{ mode: 0o755 },
	);
	const webAccess = join(dir, "web-access.mjs");
	await writeFile(
		webAccess,
		`export default function (pi) { for (const name of ${JSON.stringify(webTools)}) pi.registerTool({ name }); }\n`,
	);
	return {
		dir,
		pi,
		webAccess,
		log: () => readFile(log, "utf8").catch(() => ""),
	};
}

test("the tool-listing session reports what pi-web-access registers and exits before any model request", async () => {
	const off = await setup(["web_search"]);
	assert.deepEqual(
		await listPiWebSessionTools(off.pi, off.webAccess, { timeoutMs: 15_000 }),
		["web_search"],
	);
	const log = await off.log();
	assert.doesNotMatch(log, /MODEL REQUEST/);
	const argv = JSON.parse(log.split("\n")[0]);
	for (const flag of [
		"--no-session",
		"--no-extensions",
		"--no-context-files",
		"--no-skills",
	])
		assert.ok(argv.includes(flag), flag);
	assert.equal(argv[argv.indexOf("--tools") + 1], "web_search,fetch_content");
	// A Pi that cannot tell: unknown, not "missing".
	assert.equal(
		await listPiWebSessionTools(join(off.dir, "no-such-pi"), off.webAccess, {
			timeoutMs: 5_000,
		}),
		null,
	);
});

test("probe: a web tool turned off is unavailable with its fix, and webTools drops to search", async () => {
	const off = await setup(["web_search"]);
	const probe = await createExecutor({
		piCommand: off.pi,
		stateDir: join(off.dir, "state"),
		webAccessExtension: off.webAccess,
	}).probe();
	assert.deepEqual(Object.keys(probe.unavailableTools ?? {}), [
		"fetch_content",
	]);
	assert.match(
		probe.unavailableTools.fetch_content,
		/does not register fetch_content: its configuration turns it off \(`tools\.fetchContent\.enabled` in .*web-search\.json\)\. Turn it on with `agent-workflow doctor --fix`/,
	);
	assert.equal(probe.capabilities.webTools.detail, "search");
	assert.match(probe.capabilities.webTools.warning, /fetch_content/);
	assert.ok(
		probe.notes.some((note) =>
			note.startsWith("web tools missing: fetch_content: "),
		),
	);

	const on = await setup(["web_search", "fetch_content"]);
	const full = await createExecutor({
		piCommand: on.pi,
		stateDir: join(on.dir, "state"),
		webAccessExtension: on.webAccess,
	}).probe();
	assert.equal(full.unavailableTools, undefined);
	assert.equal(full.capabilities.webTools.detail, "search+fetch");
	assert.ok(
		full.notes.some((note) => note.endsWith("(web_search, fetch_content)")),
	);
});
