import { stateDir } from "../helpers/state-dir.mjs";
import { drainWorkflowProject } from "../helpers/workflow-fixture-lifecycle.mjs";
// New in agent-workflow (WP37 item 1, stage-1 open problem 8): task prompts are rendered per executor
// with the tool mapping the system prompt uses (M17). Claude gets its own tool names inline
// (WebSearch, WebFetch, Read/Grep/Glob, the artifact tool's visible name); Codex keeps the logical
// names and gets the M17 mapping note (shell, hosted web_search) plus the code-mode form of the
// artifact tool (live 4b); Pi is unchanged. The canonical task.md keeps the compiled text.
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
import { after, before, test } from "node:test";

import {
	renderWorkerPromptToolNames,
	renderWorkerTaskPromptToolNames,
	workerToolMappingNote,
} from "../../dist/core/artifact-tool-names.js";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

const VISIBLE = "mcp__workflow_artifact__workflow_artifact";

// Shortened from the bundled deep-research `research-questions` and `verify-claims` prompts.
const PROMPT = [
	"Search budget: use at most 3 web_search calls; prefer one web_search call.",
	"Use web_search to discover sources and fetch_content to read promising URLs.",
	"For public web research, do not use filesystem read/grep/find/ls; those tools are only for local tasks.",
	"Do not call workflow_artifact, filesystem read, grep, find, or ls for external web claims.",
	"Read the upstream artifacts first and find the gaps; refs: workflow_artifact:task-3.control.",
].join("\n");

test("Pi task prompts are unchanged apart from the artifact tool name", () => {
	const rendered = renderWorkerTaskPromptToolNames(PROMPT, "pi");
	assert.equal(rendered, renderWorkerPromptToolNames(PROMPT, "pi"));
	assert.equal(
		rendered,
		PROMPT.replace("call workflow_artifact,", `call ${VISIBLE},`),
	);
	// Unknown executors keep the logical names too (no mapping known).
	assert.equal(
		renderWorkerTaskPromptToolNames(PROMPT, "my-cli"),
		renderWorkerPromptToolNames(PROMPT, "my-cli"),
	);
});

test("Claude task prompts name Claude's tools", () => {
	const rendered = renderWorkerTaskPromptToolNames(PROMPT, "claude");
	assert.equal(
		rendered,
		[
			"Search budget: use at most 3 WebSearch calls; prefer one WebSearch call.",
			"Use WebSearch to discover sources and WebFetch to read promising URLs.",
			"For public web research, do not use filesystem Read/Grep/Glob; those tools are only for local tasks.",
			`Do not call ${VISIBLE}, filesystem Read, Grep, or Glob for external web claims.`,
			"Read the upstream artifacts first and find the gaps; refs: workflow_artifact:task-3.control.",
		].join("\n"),
	);
	// Idempotent; prose "read"/"find" outside a tool list is not a tool name.
	assert.equal(renderWorkerTaskPromptToolNames(rendered, "claude"), rendered);
	assert.equal(
		renderWorkerTaskPromptToolNames(
			"Read the brief and find the bug.",
			"claude",
		),
		"Read the brief and find the bug.",
	);
	// A tool named outside a list (grep, ls, bash) is mapped by the note instead.
	assert.equal(
		renderWorkerTaskPromptToolNames("Run grep over src.", "claude"),
		`Run grep over src.\n\n${workerToolMappingNote(["grep"], "claude")}`,
	);
});

test("Codex task prompts keep the logical names and carry the M17 mapping note", () => {
	const rendered = renderWorkerTaskPromptToolNames(PROMPT, "codex");
	const body = renderWorkerPromptToolNames(PROMPT, "codex");
	assert.ok(rendered.startsWith(`${body}\n\n`), rendered);
	const note = rendered.slice(body.length + 2);
	assert.equal(
		note,
		[
			workerToolMappingNote(
				["web_search", "fetch_content", "read", "grep", "find", "ls"],
				"codex",
			),
			`In Codex code mode an MCP tool is a function inside the exec cell: call ${VISIBLE} as tools.${VISIBLE}(…).`,
		].join(" "),
	);
	assert.match(note, /read → the shell tool with a read-only command/u);
	assert.match(note, /fetch_content → the web_search tool \(open a page\)/u);
	assert.equal(renderWorkerTaskPromptToolNames(rendered, "codex"), rendered);
	// No tool mention: no note.
	assert.equal(
		renderWorkerTaskPromptToolNames("Summarize the brief.", "codex"),
		"Summarize the brief.",
	);
});

let root;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp37-prompts-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	slots.setWorkerLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

for (const id of ["pi", "claude", "codex"]) {
	test(`the task runner sends the ${id} rendering of the task prompt; task.md stays canonical`, async () => {
		const cwd = join(root, id);
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".agent-workflow", "agents", "reader.md"),
			"---\nname: reader\ndescription: reads\ntools: read, grep, find, ls\n---\nRead.\n",
		);
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				name: `wp37-${id}`,
				defaults: {
					agent: "reader",
					readOnly: true,
					tools: ["read", "grep", "find", "ls"],
				},
				artifactGraph: {
					stages: [
						{
							id: "a",
							type: "single",
							prompt:
								"Use read/grep/find/ls on the repository and report web_search needs.",
						},
					],
				},
			}),
		);
		const effectLog = join(root, `${id}-effects.jsonl`);
		const undo = core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id, effectLog, logPrompt: true }),
		);
		try {
			const started = await engine.runWorkflowSpec(specPath, cwd, {
				task: "per-executor prompt",
				executor: id,
			});
			const run = await engine.waitForRun(cwd, started.runId, 60_000);
			assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
			const [submit] = readFixtureLog(effectLog).filter(
				(entry) => entry.type === "submit",
			);
			const task = run.tasks.find((item) => item.files?.taskPrompt);
			const canonical = await readFile(
				join(stateDir(cwd), task.files.taskPrompt),
				"utf8",
			);
			assert.match(canonical, /Use read\/grep\/find\/ls on the repository/u);
			assert.equal(
				submit.prompt,
				renderWorkerTaskPromptToolNames(canonical, id),
			);
			if (id === "pi")
				assert.equal(
					submit.prompt,
					renderWorkerPromptToolNames(canonical, "pi"),
				);
			if (id === "claude") {
				assert.match(
					submit.prompt,
					/Use Read\/Grep\/Glob on the repository and report WebSearch needs\./u,
				);
				assert.doesNotMatch(submit.prompt, /On this executor/u);
			}
			if (id === "codex") {
				assert.match(
					submit.prompt,
					/Use read\/grep\/find\/ls on the repository/u,
				);
				assert.match(
					submit.prompt,
					/On this executor \(codex\) these tool names are provided as: read → the shell tool/u,
				);
			}
		} finally {
			await drainWorkflowProject(cwd);
			undo();
		}
	});
}
