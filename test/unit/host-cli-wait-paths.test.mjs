// test-tier: integration
// 2026-11-04 (coverage after the CLI//aw refactor): CLI paths no test reached — `doctor --fix`
// (no terminal, declined, agreed, --yes) and the attached `resume` that wait for the
// resumed run to settle. Executor fixtures and a scratch pi-web-access config only: no model or
// agent-CLI calls.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-cli-wait-paths-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
afterEach(() => {
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

/** One in-process CLI call; `answers` script a terminal (undefined: no terminal). */
async function runCli(cwd, env, argv, answers) {
	const out = [];
	const err = [];
	const prompts = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: answers !== undefined,
		waitSliceMs: 2_000,
		...(answers === undefined
			? {}
			: {
					prompt: async (question) => {
						prompts.push(question);
						return answers.shift() ?? "";
					},
				}),
	});
	return { code, out: out.join(""), err: err.join(""), prompts };
}

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			name: "cli-wait-paths",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		})}\n`,
	);
	const piDir = join(cwd, "pi-agent");
	await mkdir(piDir, { recursive: true });
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		PI_CODING_AGENT_DIR: piDir,
	};
	return { cwd, env, webConfig: join(piDir, "web-search.json") };
}

function register(descriptor) {
	unregister.push(core.registerWorkflowExecutor(descriptor));
}

/** `pi` ready, but pi-web-access has fetch_content turned off; claude/codex not installed. */
function piWithWebToolOff(cwd, unavailable = true) {
	const missing = { installed: false, cliVersion: null, auth: "unknown" };
	for (const [id, probe] of Object.entries({
		pi: {
			installed: true,
			cliVersion: "1.1.0",
			auth: "ok",
			...(unavailable
				? { unavailableTools: { fetch_content: "turned off in pi-web-access" } }
				: {}),
		},
		claude: missing,
		codex: missing,
	}))
		register(
			workflowFixtureDescriptor({
				id,
				effectLog: join(cwd, `${id}-effects.jsonl`),
				probe,
			}),
		);
}

const OFF = { tools: { fetchContent: { enabled: false } }, keep: "untouched" };
const enabled = async (path) =>
	JSON.parse(await readFile(path, "utf8")).tools.fetchContent.enabled;

test("CLI doctor --fix: nothing to fix; no terminal changes nothing; n declines; y and --yes flip the key", async () => {
	const { cwd, env, webConfig } = await project();
	await writeFile(webConfig, JSON.stringify(OFF));

	piWithWebToolOff(cwd, false);
	const none = await runCli(cwd, env, ["doctor", "--fix"]);
	assert.equal(none.code, 0, none.out + none.err);
	assert.match(none.err, /doctor --fix: nothing to fix automatically\./);
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();

	piWithWebToolOff(cwd);
	const noTerminal = await runCli(cwd, env, ["doctor", "--fix"]);
	assert.match(
		noTerminal.err,
		/not changed \(no terminal to ask; add --yes to apply\): Turn on fetch_content in pi-web-access/,
	);
	assert.equal(await enabled(webConfig), false);

	const declined = await runCli(cwd, env, ["doctor", "--fix"], ["n"]);
	assert.deepEqual(declined.prompts, [
		`Turn on fetch_content in pi-web-access (set tools.fetchContent.enabled to true in ${webConfig})? [y/N] `,
	]);
	assert.match(declined.err, /not changed \(declined\): Turn on fetch_content/);
	assert.equal(await enabled(webConfig), false);

	const agreed = await runCli(cwd, env, ["doctor", "--fix"], ["y"]);
	assert.match(
		agreed.err,
		new RegExp(
			`changed tools\\.fetchContent\\.enabled in ${webConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
		),
	);
	assert.equal(await enabled(webConfig), true);
	assert.equal(JSON.parse(await readFile(webConfig, "utf8")).keep, "untouched");
	// The report is printed again after the fixes.
	assert.match(agreed.out, /agent-workflow doctor \(host: cli\)/);

	await writeFile(webConfig, JSON.stringify(OFF));
	const yes = await runCli(cwd, env, ["doctor", "--fix", "--yes"]);
	assert.deepEqual(yes.prompts, []);
	assert.match(yes.err, /changed tools\.fetchContent\.enabled/);
	assert.equal(await enabled(webConfig), true);
	// Nothing left to flip: reported, not an error.
	const again = await runCli(cwd, env, ["doctor", "--fix", "--yes"]);
	assert.match(
		again.err,
		/not changed: .*no `enabled: false` setting for fetch_content/,
	);
});

test("CLI resume (attached) of a stopped run waits until the run settles; --json carries the wait", async () => {
	const { cwd, env } = await project();
	const executor = `test-cli-resume-${counter}`;
	register(
		workflowFixtureDescriptor({
			id: executor,
			effectLog: join(cwd, "effects.jsonl"),
			stepDelayMs: 1_500,
		}),
	);
	const ctx = { cwd, env };
	for (const json of [false, true]) {
		const launched = await api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: `slow ${json}`,
			executor,
		});
		const runId = launched.data.runId;
		assert.equal(
			(await api.stopAction(ctx, { runId })).data.status,
			"interrupted",
		);
		const resumed = await runCli(cwd, env, [
			"resume",
			runId,
			...(json ? ["--json"] : []),
		]);
		assert.equal(resumed.code, 0, resumed.out + resumed.err);
		assert.equal((await store.readRunRecord(cwd, runId)).status, "completed");
		if (json) {
			const parsed = JSON.parse(resumed.out);
			assert.equal(parsed.action, "resume");
			assert.equal(parsed.data.runId, runId);
			assert.equal(parsed.data.wait.status, "completed");
			assert.ok(parsed.data.resetTaskIds.length >= 1);
		} else {
			// The resume text first, then the settled wait.
			assert.match(resumed.out, /resum/i);
			assert.match(resumed.out, /completed/);
		}
	}
});
