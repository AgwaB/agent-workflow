// agent-workflow 2026-11-04: the terminal CLI takes the nearest enclosing project (a directory with
// `.agent-workflow/` or `.git`, never the one holding the user-level home) as its project, like Codex's
// project-root markers. Before, `run <project workflow>` from a subdirectory said "not found".
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { findProjectRoot } = await import("../../dist/hosts/project-root.js");
const cli = await import("../../dist/hosts/cli/index.js");

function layout(t) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "aw-project-root-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const home = join(base, "home");
	mkdirSync(join(home, ".agent-workflow"), { recursive: true });
	mkdirSync(join(home, ".git"));
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(home, ".agent-workflow"),
	};
	mkdirSync(join(home, "proj", ".git"), { recursive: true });
	mkdirSync(join(home, "proj", "src", "deep"), { recursive: true });
	mkdirSync(join(home, "proj", "pkg", ".agent-workflow"), { recursive: true });
	mkdirSync(join(home, "proj", "pkg", "lib"), { recursive: true });
	mkdirSync(join(home, "loose", "a"), { recursive: true });
	return { home, env };
}

test("findProjectRoot: nearest .agent-workflow or .git; never the directory of the user-level home", (t) => {
	const { home, env } = layout(t);
	assert.equal(
		findProjectRoot(join(home, "proj", "src", "deep"), env),
		join(home, "proj"),
	);
	assert.equal(findProjectRoot(join(home, "proj"), env), join(home, "proj"));
	assert.equal(
		findProjectRoot(join(home, "proj", "pkg", "lib"), env),
		join(home, "proj", "pkg"),
	);
	assert.equal(
		findProjectRoot(join(home, "loose", "a"), env),
		join(home, "loose", "a"),
	);
});

test("the CLI from a subdirectory lists the project's workflows and says which project it uses", async (t) => {
	const { home, env } = layout(t);
	const project = join(home, "proj");
	mkdirSync(join(project, ".agent-workflow", "workflows", "local-check"), {
		recursive: true,
	});
	writeFileSync(
		join(project, ".agent-workflow", "workflows", "local-check", "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "local-check",
			description: "Local check workflow.",
			defaults: { agent: "scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Check." }],
			},
		}),
	);
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(
		["list", "--query", "local-check"],
		{
			cwd: join(project, "src", "deep"),
			env,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			isTTY: false,
		},
	);
	assert.equal(code, 0, err.join(""));
	assert.match(out.join(""), /local-check/u);
	assert.match(
		err.join(""),
		new RegExp(
			`project ${project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(the current directory is inside it`,
			"u",
		),
	);
	// At the project root itself: no notice.
	const err2 = [];
	await cli.runAgentWorkflowCli(["list", "--query", "local-check"], {
		cwd: project,
		env,
		stdout: () => {},
		stderr: (text) => err2.push(text),
		isTTY: false,
	});
	assert.doesNotMatch(err2.join(""), /the current directory is inside it/u);
});
