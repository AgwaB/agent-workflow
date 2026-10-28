// New in agent-workflow (WP19, stage-2 review #9): the terminal/generic default executor is the
// first installed and *logged-in* one of pi → claude → codex. A positively verified login wins over
// an earlier unknown-auth candidate (Pi unknown + Claude logged in → Claude); Pi verified ready →
// Pi. The Pi adapter's non-secret readiness signal is `pi --list-models` (lists only models whose
// provider has configured auth; no credential read by the engine, no model call): a fake `pi`
// script stands in for the CLI. Fakes only; no real CLI or model call.
import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const api = await import("../../dist/hosts/api.js");
const { createPiExecutor } = await import("../../dist/executors/pi/index.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-default-")));
});
afterEach(() => {
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

const READY = { installed: true, cliVersion: "1.1.0", auth: "ok" };
const UNKNOWN = { installed: true, cliVersion: "1.1.0", auth: "unknown" };

function shadowBuiltins(probes) {
	counter += 1;
	for (const [id, probe] of Object.entries(probes))
		unregister.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					effectLog: join(root, `${id}-${counter}.jsonl`),
					probe,
				}),
			),
		);
}

test("review #9: Pi auth unknown + Claude logged in → Claude; Pi verified ready → Pi; explicit wins", async () => {
	shadowBuiltins({ pi: UNKNOWN, claude: READY, codex: READY });
	const selection = await core.resolveRunExecutorForHost({ host: "cli" });
	assert.equal(selection.id, "claude");
	assert.equal(selection.source, "installed-default");
	const generic = await core.resolveRunExecutorForHost({ host: "generic" });
	assert.equal(generic.id, "claude");
	assert.equal(
		(await core.resolveRunExecutorForHost({ host: "cli", runFlag: "pi" })).id,
		"pi",
	);
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
	shadowBuiltins({ pi: READY, claude: READY, codex: READY });
	assert.equal(
		(await core.resolveRunExecutorForHost({ host: "cli" })).id,
		"pi",
	);
});

test("review #9: doctor prefers the verified login and explains an unverified fallback", async () => {
	const cwd = join(root, "doctor");
	await mkdir(cwd, { recursive: true });
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	const prober = (probes) => async (descriptor) => ({
		probe: probes[descriptor.id],
		capabilities: {},
	});
	const verified = await api.doctorAction(
		{ cwd, env, host: "cli" },
		{ prober: prober({ pi: UNKNOWN, claude: READY, codex: READY }) },
	);
	assert.equal(verified.data.defaultExecutor.id, "claude");
	const fallback = await api.doctorAction(
		{ cwd, env, host: "cli" },
		{
			prober: prober({
				pi: UNKNOWN,
				claude: { installed: false, cliVersion: null, auth: "unknown" },
				codex: { installed: false, cliVersion: null, auth: "unknown" },
			}),
		},
	);
	assert.equal(fallback.data.defaultExecutor.id, "pi");
	assert.match(fallback.text, /login could not be verified/);
});

/** A fake `pi` CLI answering the probe commands only. */
async function fakePiCli(listModelsOutput) {
	counter += 1;
	const path = join(root, `fake-pi-${counter}.mjs`);
	await writeFile(
		path,
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			"if (args.includes('--version')) { console.log('1.1.0'); process.exit(0); }",
			`if (args.includes('--list-models')) { process.stdout.write(${JSON.stringify(listModelsOutput)}); process.exit(0); }`,
			"if (args[0] === 'list') { console.log('User packages:'); process.exit(0); }",
			"console.error('unexpected pi call: ' + args.join(' ')); process.exit(9);",
			"",
		].join("\n"),
	);
	await chmod(path, 0o755);
	return path;
}

test("review #9: Pi readiness from `pi --list-models` (models with configured auth), no auth-check model needed", async () => {
	const ready = createPiExecutor({
		piCommand: await fakePiCli(
			"provider  model                  context  max-out  thinking  images\ngoogle    gemini-2.5-flash-lite  1.0M     65.5K    yes       yes\n",
		),
		stateDir: join(root, "pi-state-ready"),
	});
	const readyProbe = await ready.probe();
	assert.equal(readyProbe.auth, "ok");
	assert.ok(readyProbe.notes.some((note) => /--list-models/.test(note)));

	const none = createPiExecutor({
		piCommand: await fakePiCli(
			"No models available. Use /login or set an API key environment variable.\n",
		),
		stateDir: join(root, "pi-state-none"),
	});
	const noneProbe = await none.probe();
	assert.equal(noneProbe.auth, "missing");
	assert.deepEqual(noneProbe.models, []);
});
