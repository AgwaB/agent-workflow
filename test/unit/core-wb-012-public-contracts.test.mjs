// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/wb-012-public-contracts.test.mjs. MIT, same author. Changes: imports from dist/core (subagent-backend names from their WP4c modules); harness from test/helpers/; setSubagentApiForTests→setTaskRuntimeApiForTests; paths .pi/{workflows,agents,workflow-subagents}→.agent-workflow/…, env PI_WORKFLOW_*→AGENT_WORKFLOW_*; WP10: the user/global root is $AGENT_WORKFLOW_HOME/workflows, the router names the agent-workflow CLI, the bundled README names ~/.agent-workflow/workflows/; WP38: the two docs tests and the docs/usage.md half of the root-order check are ported against agent-workflow's docs: the commands of the CLI help (`COMMAND_HELP`, src/hosts/help.ts) and its launch flags are documented in docs/cli.md (was: `/workflow …` lines of src/index.ts in docs/usage.md), troubleshooting lives in docs/usage.md and not in the README, the speed/quality note is the `low` effort trade-off in docs/usage.md "Profiles" (pi-workflow's "Speed and quality guardrails" section has no counterpart), the whole docs/ directory is packaged and every relative docs link resolves.
import assert from "node:assert/strict";
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveWorkflowRef } from "../../dist/core/workflow-specs.js";
import { COMMAND_HELP } from "../../dist/hosts/help.js";

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

test("public command and troubleshooting docs mirror runtime help", async () => {
	const [cli, usage, readme, help] = await Promise.all([
		readRoot("docs/cli.md"),
		readRoot("docs/usage.md"),
		readRoot("README.md"),
		readRoot("src/hosts/help.ts"),
	]);
	const commands = cli.slice(
		cli.indexOf("## Commands"),
		cli.indexOf("## Launch options"),
	);
	for (const command of Object.keys(COMMAND_HELP)) {
		assert.match(
			help,
			new RegExp(`Usage: agent-workflow ${escapeRegExp(command)}\\b`),
		);
		assert.match(
			commands,
			new RegExp(`\\| \`${escapeRegExp(command)}\\b`),
			`docs/cli.md misses command: ${command}`,
		);
	}
	assert.equal((commands.match(/\| `stop <run>` \|/g) ?? []).length, 1);
	const launchFlags = [...COMMAND_HELP.run.matchAll(/^\s+(--[a-z-]+)/gm)].map(
		(match) => match[1],
	);
	assert.ok(launchFlags.length >= 10, launchFlags.join(" "));
	for (const flag of launchFlags)
		assert.ok(
			cli.includes(`\`${flag}`),
			`docs/cli.md misses launch option: ${flag}`,
		);
	for (const movedDetail of [
		/## Troubleshooting/,
		/inspect <run> --failures --results/,
		/explicit speed\/cost-for-quality trade-off/,
		/required_reads_missing_exhausted/,
	]) {
		assert.match(usage, movedDetail);
		assert.doesNotMatch(readme, movedDetail);
	}
});

test("workflow-guide owns authoring detail while execution-router permits bounded discovery only", async () => {
	// WP38: the docs/usage.md half of the root-order check is back (WP12c shipped docs/usage.md).
	const [guide, router, usage, bundled] = await Promise.all([
		readRoot("skills/workflow-guide/SKILL.md"),
		readRoot("skills/execution-router/SKILL.md"),
		readRoot("docs/usage.md"),
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
	// `workflow_run`/`workflow_dynamic`/`/workflow …` (agent-workflow has no `auto`).
	assert.match(
		router,
		/Never invoke `aw_run`, `aw_dynamic`, `\/aw run`, `\/aw dynamic`, `\/aw resume`, `\/aw approve`, or the matching `agent-workflow` CLI commands/,
	);
	assert.doesNotMatch(router, /\/workflow\b|workflow_(list|run|dynamic)/);
	assert.match(router, /separate authoring needed/i);
	assert.doesNotMatch(router, /project-private/);
	assert.match(
		router,
		/Do not require a graph, schema, helper, storage layout, task packet, promotion criteria/i,
	);
	for (const text of [usage, bundled]) {
		const shared = text.indexOf("<cwd>/workflows/");
		const privateRoot = text.indexOf("<cwd>/.agent-workflow/workflows/");
		// WP10: the user/global root is ~/.agent-workflow/workflows/ (was ~/.pi/agent/workflows/).
		const globalRoot = text.indexOf("~/.agent-workflow/workflows/");
		assert.ok(shared >= 0 && shared < privateRoot && privateRoot < globalRoot);
		assert.match(text, /shadow/i);
	}
});

test("packaged docs have self-contained speed guardrails and no stale local links", async () => {
	const [usage, packageJson] = await Promise.all([
		readRoot("docs/usage.md"),
		readRoot("package.json").then(JSON.parse),
	]);
	assert.match(usage, /explicit speed\/cost-for-quality trade-off/);
	assert.ok(packageJson.files.includes("docs"));
	const docs = (await readdir(join(root, "docs"), { recursive: true })).filter(
		(name) => name.endsWith(".md"),
	);
	for (const name of docs) {
		const text = await readRoot(join("docs", name));
		for (const match of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
			const target = match[1];
			if (/^[a-z]+:/i.test(target)) continue;
			await assert.doesNotReject(
				access(join(root, "docs", dirname(name), target)),
				`docs/${name} links to a missing file: ${target}`,
			);
		}
	}
});

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
