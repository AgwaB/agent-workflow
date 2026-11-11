// test-tier: integration
// 2026-11-11: hosts run the plugin's hook and monitor commands with the user's shell. Under zsh (the macOS default)
// the project lookup `set -- "$P"/projects/*-"$h"` aborted with "no matches found" in every project without runs,
// so the completion monitor reported a failure at each Claude Code start. Both commands run here under sh and zsh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	claudeCompletionMonitor,
	notifyHookCommand,
} from "../../tools/release/plugins.mjs";

const shells = ["sh", "zsh"].filter(
	(shell) => spawnSync(shell, ["-c", "exit 0"]).status === 0,
);
// A CLI that only reports how it was called, instead of npx.
const cli = { command: "echo", args: ["CLI"] };
const hashOf = (path) =>
	spawnSync(
		"sh",
		[
			"-c",
			'printf %s "$(realpath "$1")" | (shasum -a 256 || sha256sum) | cut -c1-12',
			"_",
			path,
		],
		{
			encoding: "utf8",
		},
	).stdout.trim();

for (const shell of shells)
	test(`hook and monitor commands work under ${shell}, with and without the project's runs`, () => {
		const root = mkdtempSync(join(tmpdir(), "aw-hook-shell-"));
		try {
			const project = join(root, "project");
			const home = join(root, "home");
			mkdirSync(project);
			mkdirSync(join(home, "projects"), { recursive: true });
			const env = {
				...process.env,
				CLAUDE_PROJECT_DIR: project,
				AGENT_WORKFLOW_HOME: home,
				CLAUDE_CODE_SESSION_ID: "s1",
			};
			const run = (command) =>
				spawnSync(shell, ["-c", command], {
					env,
					encoding: "utf8",
					timeout: 20_000,
				});

			// No runs yet: the hook does nothing and fails nothing.
			let hook = run(notifyHookCommand(cli, "claude-code"));
			assert.equal(hook.status, 0, hook.stderr);
			assert.equal(hook.stderr, "");
			assert.equal(hook.stdout, "");

			// The project has runs: the hook calls the CLI, and the monitor's wait ends and hands over to it.
			const state = join(home, "projects", `project-${hashOf(project)}`);
			mkdirSync(join(state, ".agent-workflow", "workflows", "workflow_x"), {
				recursive: true,
			});
			writeFileSync(
				join(state, ".agent-workflow", "workflows", "workflow_x", "run.json"),
				"{}",
			);
			hook = run(notifyHookCommand(cli, "claude-code"));
			assert.equal(hook.status, 0, hook.stderr);
			assert.match(
				hook.stdout,
				/^CLI notify-check --host claude-code --stamp hook-claude-code$/m,
			);
			const monitor = run(claudeCompletionMonitor(cli).command);
			assert.equal(monitor.status, 0, monitor.stderr);
			assert.equal(monitor.stderr, "");
			assert.match(
				monitor.stdout,
				/^CLI notify-check --follow --host claude-code --session s1$/m,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

test("the monitor waits without an error while the project has no runs (zsh)", {
	skip: !shells.includes("zsh") && "no zsh",
}, () => {
	const root = mkdtempSync(join(tmpdir(), "aw-hook-shell-"));
	try {
		mkdirSync(join(root, "home", "projects"), { recursive: true });
		mkdirSync(join(root, "project"));
		// The monitor's parent exits after one poll, so its wait loop ends (kill -0 $PPID).
		const command = claudeCompletionMonitor(cli).command;
		const result = spawnSync(
			"zsh",
			[
				"-c",
				`zsh -c ${JSON.stringify(command).replace(/\$/g, "\\$")} & sleep 0.5; exit 0`,
			],
			{
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: join(root, "project"),
					AGENT_WORKFLOW_HOME: join(root, "home"),
					CLAUDE_CODE_SESSION_ID: "s1",
				},
				encoding: "utf8",
				timeout: 20_000,
			},
		);
		assert.equal(result.stderr, "", "no 'no matches found'");
	} finally {
		rmSync(join(root), { recursive: true, force: true });
	}
});
