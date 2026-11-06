// agent-workflow 2026-11-04 (owner: "do all the improvements"; edge-case test: `run todo-triage` from
// `src/` did not find the project's workflow and would have recorded the run in `src/.agent-workflow`).
// The terminal CLI takes the nearest enclosing project as its project, like Codex takes the nearest
// ancestor with `.git` (codex-rs/config/src/project_root_markers.rs, loader/mod.rs find_project_root):
// walking up from the current directory, the first directory with a `.agent-workflow/` or with `.git`
// wins (never the directory holding the user-level agent-workflow home); with neither, the current
// directory.
// A subdirectory becomes its own project by creating `.agent-workflow/` in it.
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	agentWorkflowHome,
	PROJECT_STATE_DIRECTORY,
} from "../core/home-dir.js";

function samePath(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return resolve(left) === resolve(right);
	}
}

/** `dir/.agent-workflow` is the user-level agent-workflow home (usually `dir` is ~). */
export function holdsUserHome(
	dir: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return samePath(join(dir, PROJECT_STATE_DIRECTORY), agentWorkflowHome(env));
}

/** The project of runs started where no other project applies but the home (see runProject). */
export const HOME_RUNS_DIRECTORY = "home-runs";

/**
 * agent-workflow 2026-11-04 (Claude desktop app: its MCP server starts in ~, so three deep-research
 * runs were recorded in ~/.agent-workflow/workflows, the user-level workflow folder). A directory
 * whose `.agent-workflow` is the user-level home is never used as a project; workers execute in
 * `<home>/home-runs` instead (created on first use), an ordinary project for state-location purposes. Codex does not load ~/.codex as a
 * project layer when started in ~ (codex-rs/core/src/config/config_loader_tests.rs
 * codex_home_is_not_loaded_as_project_layer_from_home_dir); Gemini CLI skips workspace settings in
 * the home (storage.ts isWorkspaceHomeDir) and keeps per-project data under its global directory.
 * Every host applies this to the directory it would use as the project (CLI, MCP server, Pi).
 */
export function runProject(
	dir: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (!holdsUserHome(dir, env)) return dir;
	const target = join(agentWorkflowHome(env), HOME_RUNS_DIRECTORY);
	mkdirSync(target, { recursive: true });
	return target;
}

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
	let dir = start;
	for (let depth = 0; depth < 64; depth++) {
		const state = join(dir, PROJECT_STATE_DIRECTORY);
		// The directory holding the user-level agent-workflow home (usually ~) is never a project:
		// its .agent-workflow is that home, so project state would mix with user state (also when
		// ~ is itself a git repository, e.g. for dotfiles).
		if (!holdsUserHome(dir, env)) {
			if (exists(state, "directory")) return dir;
			if (exists(join(dir, ".git"))) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return start;
}
