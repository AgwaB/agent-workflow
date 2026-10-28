// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/wb-012-public-contracts.test.mjs. MIT, same author. Changes: imports from dist/core (subagent-backend names from their WP4c modules); harness from test/helpers/; setSubagentApiForTests→setTaskRuntimeApiForTests; paths .pi/{workflows,agents,workflow-subagents}→.agent-workflow/…, env PI_WORKFLOW_*→AGENT_WORKFLOW_*; WP10: the user/global root is $AGENT_WORKFLOW_HOME/workflows, the router names the agent-workflow CLI, the bundled README names ~/.agent-workflow/workflows/; 2 of 4 tests and the docs/usage.md half of a third not ported (deferred-WP11, docs/usage.md).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveWorkflowRef } from "../../dist/core/workflow-specs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRoot = (path) => readFile(join(root, path), "utf8");

test("workflow name resolution follows documented priority and same-root ambiguity", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resolution-contract-"));
	const home = join(cwd, "home");
	const previousHome = process.env.HOME;
	const previousAwHome = process.env.AGENT_WORKFLOW_HOME;
	process.env.HOME = home;
	// agent-workflow: the user/global root is $AGENT_WORKFLOW_HOME/workflows (default
	// ~/.agent-workflow); the unit runner pins AGENT_WORKFLOW_HOME, so point it into this home.
	process.env.AGENT_WORKFLOW_HOME = join(home, ".agent-workflow");
	try {
		const validSpec = `${JSON.stringify({ schemaVersion: 1, defaults: { agent: "scout", readOnly: true, tools: ["read"] }, artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Check." }] } })}\n`;
		const shared = join(cwd, "workflows", "deep-review", "spec.json");
		const privateSpec = join(
			cwd,
			".agent-workflow",
			"workflows",
			"deep-review",
			"spec.json",
		);
		// Was ~/.pi/agent/workflows (now a read-only legacy root below the user root).
		const globalSpec = join(
			home,
			".agent-workflow",
			"workflows",
			"deep-review",
			"spec.json",
		);
		for (const spec of [shared, privateSpec, globalSpec]) {
			await mkdir(dirname(spec), { recursive: true });
			await writeFile(spec, validSpec);
		}
		assert.equal(
			(await resolveWorkflowRef("deep-review", cwd)).specPath,
			shared,
		);
		await rm(dirname(shared), { recursive: true });
		assert.equal(
			(await resolveWorkflowRef("deep-review", cwd)).specPath,
			privateSpec,
		);
		await rm(dirname(privateSpec), { recursive: true });
		assert.equal(
			(await resolveWorkflowRef("deep-review", cwd)).specPath,
			globalSpec,
		);
		await rm(dirname(globalSpec), { recursive: true });
		assert.match(
			(await resolveWorkflowRef("deep-review", cwd)).specPath,
			/[/\\]workflows[/\\]deep-review[/\\]spec\.json$/,
		);

		const flat = join(cwd, "workflows", "ambiguous.json");
		const bundle = join(cwd, "workflows", "ambiguous", "spec.json");
		await mkdir(dirname(bundle), { recursive: true });
		await writeFile(flat, validSpec);
		await writeFile(bundle, validSpec);
		await assert.rejects(
			resolveWorkflowRef("ambiguous", cwd),
			/ambiguous workflow name/,
		);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAwHome === undefined) delete process.env.AGENT_WORKFLOW_HOME;
		else process.env.AGENT_WORKFLOW_HOME = previousAwHome;
		await rm(cwd, { recursive: true, force: true });
	}
});

// Not ported (deferred-WP11: docs/usage.md and the Pi host /workflow command help do not exist yet; see docs/core-port.md WP10): test("public command and troubleshooting docs mirror runtime help").

test("workflow-guide owns authoring detail while execution-router permits bounded discovery only", async () => {
	// WP10: docs/usage.md is not ported yet (deferred-WP11); its half of the root-order check is
	// dropped, the bundled README half is kept.
	const [guide, router, bundled] = await Promise.all([
		readRoot("skills/workflow-guide/SKILL.md"),
		readRoot("skills/execution-router/SKILL.md"),
		readRoot("workflows/README.md"),
	]);
	for (const text of [guide]) {
		assert.match(text, /project-private/);
		assert.match(text, /project-shared/);
		assert.match(text, /user\/global/);
	}
	assert.match(guide, /`single\.from`/);
	assert.match(guide, /`after` is order-only/);
	assert.match(router, /bounded read-only discovery/i);
	// WP12c: agent-workflow's own names (Pi `aw_list`, `/aw …`). Was: `workflow_list`.
	assert.match(router, /`aw_list`/);
	// WP10: the router also names the agent-workflow CLI. Was: "…, `/workflow dynamic`, or
	// `/workflow auto`". WP12c: `aw_run`/`aw_dynamic`/`/aw …` instead of pi-workflow's
	// `workflow_run`/`workflow_dynamic`/`/workflow …`. WP32: `auto` is back (`/aw auto`, consent-gated).
	assert.match(
		router,
		/Never invoke `aw_run`, `aw_dynamic`, `\/aw run`, `\/aw dynamic`, `\/aw auto`, `\/aw resume`, `\/aw approve`, or the matching `agent-workflow` CLI commands/,
	);
	assert.doesNotMatch(router, /\/workflow\b|workflow_(list|run|dynamic)/);
	assert.match(router, /separate authoring needed/i);
	assert.doesNotMatch(router, /project-private/);
	assert.match(
		router,
		/Do not require a graph, schema, helper, storage layout, task packet, promotion criteria/i,
	);
	for (const text of [bundled]) {
		const shared = text.indexOf("<cwd>/workflows/");
		const privateRoot = text.indexOf("<cwd>/.agent-workflow/workflows/");
		// WP10: the user/global root is ~/.agent-workflow/workflows/ (was ~/.pi/agent/workflows/).
		const globalRoot = text.indexOf("~/.agent-workflow/workflows/");
		assert.ok(shared >= 0 && shared < privateRoot && privateRoot < globalRoot);
		assert.match(text, /shadow/i);
	}
});

// Not ported (deferred-WP11: docs/usage.md is not shipped yet; see docs/core-port.md WP10): test("packaged docs have self-contained speed guardrails and no stale local links").

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
