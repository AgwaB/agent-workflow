// A rehearsal of a workflow that can write must not touch the user's git repository: the engine's managed
// worktrees register themselves in the repository (`.git/worktrees`) and create an `agent-workflow/<run>-<task>`
// branch there. Such a rehearsal therefore runs in a shadow project: a local clone of the repository (history
// and tracked files at HEAD) inside the rehearsal's temporary root, with the project's agents and workflows
// copied in. The worktrees and branches then live in the clone and go away with the root.
// The user's repository is only read (`rev-parse`, `clone`).
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { PROJECT_STATE_DIRECTORY } from "./home-dir.js";
import type { ArtifactGraphStageSpec } from "./types.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	}).trim();
}

/** True when any stage (nested ones included) is dynamic: its generated tasks may need a worktree at run time. */
export function hasDynamicStage(
	stages: readonly ArtifactGraphStageSpec[],
): boolean {
	return stages.some(
		(stage) =>
			stage.type === "dynamic" ||
			(stage.stages !== undefined && hasDynamicStage(stage.stages)),
	);
}

/**
 * Create the shadow project for `cwd` under `root` and return its directory (the counterpart of `cwd`), or
 * `undefined` when `cwd` is not in a git repository with a commit (the engine then reports its own error).
 */
export function createShadowProject(
	cwd: string,
	root: string,
): string | undefined {
	let gitRoot: string;
	let head: string;
	try {
		gitRoot = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
		head = git(gitRoot, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		return undefined;
	}
	const shadowRoot = join(root, "project");
	// The clone is private to the rehearsal: no hooks, no filters, no prompts, no system/global config
	// surprises beyond what git needs to run.
	git(root, [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"protocol.file.allow=always",
		"clone",
		"--quiet",
		"--no-checkout",
		gitRoot,
		shadowRoot,
	]);
	git(shadowRoot, [
		"-c",
		"core.hooksPath=/dev/null",
		"checkout",
		"--quiet",
		"--detach",
		head,
	]);
	// Keep the engine's own worktree/branch bookkeeping from ever being committed to or pushed anywhere.
	git(shadowRoot, ["remote", "remove", "origin"]);
	const rel = relative(gitRoot, realpathSync(cwd));
	const shadowCwd =
		rel === "" || rel.startsWith("..") ? shadowRoot : resolve(shadowRoot, rel);
	mkdirSync(shadowCwd, { recursive: true });
	for (const name of ["agents", "workflows"]) {
		const source = join(realpathSync(cwd), PROJECT_STATE_DIRECTORY, name);
		const target = join(shadowCwd, PROJECT_STATE_DIRECTORY, name);
		if (!existsSync(source) || existsSync(target)) continue;
		if (!lstatSync(source).isDirectory()) continue;
		mkdirSync(join(shadowCwd, PROJECT_STATE_DIRECTORY), { recursive: true });
		// Copied, not linked: the agent loader refuses a symlinked project agents directory. Only regular
		// files and directories are copied (no symlinks), and these directories hold definitions, not data.
		cpSync(source, target, {
			recursive: true,
			filter: (path) => !lstatSync(path).isSymbolicLink(),
		});
	}
	if (!shadowCwd.startsWith(shadowRoot + sep) && shadowCwd !== shadowRoot)
		return undefined;
	return shadowCwd;
}
