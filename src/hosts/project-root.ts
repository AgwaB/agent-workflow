// agent-workflow 2026-11-04 (owner: "do all the improvements"; edge-case test: `run todo-triage` from
// `src/` did not find the project's workflow and would have recorded the run in `src/.agent-workflow`).
// The terminal CLI takes the nearest enclosing project as its project, like Codex takes the nearest
// ancestor with `.git` (codex-rs/config/src/project_root_markers.rs, loader/mod.rs find_project_root):
// walking up from the current directory, the first directory with a `.agent-workflow/` or with `.git`
// wins (never the directory holding the user-level agent-workflow home); with neither, the current
// directory.
// A subdirectory becomes its own project by creating `.agent-workflow/` in it.
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	agentWorkflowHome,
	PROJECT_STATE_DIRECTORY,
} from "../core/home-dir.js";

function exists(path: string, kind?: "directory"): boolean {
	try {
		const stat = statSync(path);
		return kind === "directory" ? stat.isDirectory() : true;
	} catch {
		return false;
	}
}

export function findProjectRoot(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const start = resolve(cwd);
	const home = resolve(agentWorkflowHome(env));
	let dir = start;
	for (let depth = 0; depth < 64; depth++) {
		const state = join(dir, PROJECT_STATE_DIRECTORY);
		// The directory holding the user-level agent-workflow home (usually ~) is never a project:
		// its .agent-workflow is that home, so project state would mix with user state (also when
		// ~ is itself a git repository, e.g. for dotfiles).
		if (resolve(state) !== home) {
			if (exists(state, "directory")) return dir;
			if (exists(join(dir, ".git"))) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return start;
}
