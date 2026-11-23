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
	rmSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
 * Throw unless `path` — or, when it does not exist yet, its nearest existing ancestor — resolves inside `root`.
 * The clone's own tracked symlinks (HEAD may differ from the working tree) must never steer a mkdir, removal or
 * copy outside the temporary clone (review 2026-11-23, B1).
 */
function assertInsideClone(root: string, path: string): void {
	const realRoot = realpathSync(root);
	let probe = path;
	for (;;) {
		try {
			lstatSync(probe);
			break;
		} catch {
			const parent = dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
	}
	let real: string;
	try {
		real = realpathSync(probe);
	} catch {
		real = "";
	}
	if (real !== realRoot && !real.startsWith(realRoot + sep))
		throw new Error(
			`rehearse: refusing to build the shadow project: ${path} resolves outside the temporary clone (a tracked symlink in HEAD)`,
		);
}

/** Replace a symlink at `path` (inside the clone) by nothing, so a real directory can be created there. */
function unlinkIfSymlink(path: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
	} catch {
		// absent
	}
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
	assertInsideClone(shadowRoot, shadowCwd);
	mkdirSync(shadowCwd, { recursive: true });
	assertInsideClone(shadowRoot, shadowCwd);
	const stateDir = join(shadowCwd, PROJECT_STATE_DIRECTORY);
	for (const name of ["agents", "workflows"]) {
		const source = join(realpathSync(cwd), PROJECT_STATE_DIRECTORY, name);
		const target = join(stateDir, name);
		if (!existsSync(source)) continue;
		if (!lstatSync(source).isDirectory()) continue;
		// A link in the clone (HEAD) is replaced, never followed: removing or writing through it would reach
		// whatever it points to.
		unlinkIfSymlink(stateDir);
		mkdirSync(stateDir, { recursive: true });
		assertInsideClone(shadowRoot, stateDir);
		unlinkIfSymlink(target);
		assertInsideClone(shadowRoot, target);
		// The working-tree copy wins over the clone's HEAD copy: uncommitted edits are what the user rehearses.
		rmSync(target, { recursive: true, force: true });
		// Copied, not linked: the agent loader refuses a symlinked project agents directory. Only regular
		// files and directories are copied (no symlinks), and these directories hold definitions, not data.
		cpSync(source, target, {
			recursive: true,
			filter: (path) => !lstatSync(path).isSymbolicLink(),
		});
	}
	return shadowCwd;
}
