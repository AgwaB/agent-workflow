// A rehearsal of a workflow that can write must not touch the user's git repository: the engine's managed
// worktrees register themselves in the repository (`.git/worktrees`) and create an `agent-workflow/<run>-<task>`
// branch there. Such a rehearsal therefore runs in a shadow project: a local clone of the repository (history
// and tracked files at HEAD) inside the rehearsal's temporary root, with the project's agents and workflows
// copied in. The worktrees and branches then live in the clone and go away with the root.
// The user's repository is only read (`rev-parse`, `clone`).
//
// Everything that runs git during a rehearsal (the clone here, the engine's `worktree add` later) runs with the
// sanitized environment of `rehearsalGitEnv`: no system or global git configuration (filters, hooks path,
// credential helpers), no prompts, no ambient GIT_DIR-style redirection.
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PROJECT_STATE_DIRECTORY } from "./home-dir.js";
import type { ArtifactGraphStageSpec } from "./types.js";

/**
 * Set to the rehearsal's temporary root while a rehearsal runs. The engine's single worktree-creating place
 * refuses (`assertRehearsalGitRoot`) any git root that is not physically inside it.
 */
export const REHEARSAL_ROOT_ENV = "AGENT_WORKFLOW_REHEARSAL_ROOT";

/** Variables that redirect git to another repository, object store or extra configuration. */
const AMBIENT_GIT_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
];

/**
 * The sanitized git environment of a rehearsal rooted at `root` (a full environment: the process's own with the
 * git variables replaced). An empty global configuration file, no system configuration, no terminal prompts and an
 * empty hooks directory: a user's global filters (LFS smudge), `core.hooksPath` hooks and credential helpers never
 * run. Creates the empty configuration file and hooks directory under `<root>/git-isolation`.
 */
export function rehearsalGitEnv(root: string): NodeJS.ProcessEnv {
	const dir = join(root, "git-isolation");
	const hooks = join(dir, "hooks");
	const config = join(dir, "config");
	mkdirSync(hooks, { recursive: true });
	if (!existsSync(config)) writeFileSync(config, "");
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of Object.keys(env))
		if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name)) delete env[name];
	for (const name of AMBIENT_GIT_ENV) delete env[name];
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: config,
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: hooks,
	};
}

/** Put `rehearsalGitEnv(root)` (and the root itself) into the process environment; returns the restore function. */
export function applyRehearsalGitEnv(root: string): () => void {
	const next = rehearsalGitEnv(root);
	next[REHEARSAL_ROOT_ENV] = root;
	const saved = new Map<string, string | undefined>();
	for (const name of new Set([
		...Object.keys(process.env),
		...Object.keys(next),
	]))
		if (next[name] !== process.env[name]) saved.set(name, process.env[name]);
	for (const name of saved.keys()) {
		const value = next[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return () => {
		for (const [name, value] of saved)
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	};
}

/**
 * During a rehearsal, throw unless `gitRoot` (where a managed worktree and its branch would be created) is
 * physically inside the rehearsal's temporary root. Called at the one place worktrees are created, so a writer
 * the shadow decision missed, or one whose cwd names the real project, is refused instead of touching the user's
 * repository. A no-op outside a rehearsal.
 */
export function assertRehearsalGitRoot(gitRoot: string, taskId: string): void {
	if (process.env.AGENT_WORKFLOW_REHEARSAL !== "1") return;
	const root = process.env[REHEARSAL_ROOT_ENV];
	let inside = false;
	if (root !== undefined && root !== "") {
		try {
			const realRoot = realpathSync(root);
			const real = realpathSync(gitRoot);
			inside = real === realRoot || real.startsWith(realRoot + sep);
		} catch {
			inside = false;
		}
	}
	if (!inside)
		throw new Error(
			`rehearse: refusing to create a managed worktree for ${taskId}: its git root ${gitRoot} is outside the rehearsal's temporary root (a task cwd naming the real project?); a rehearsal never writes into a real repository`,
		);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
	return execFileSync("git", args, {
		cwd,
		env,
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
			(stage.onExhausted !== undefined &&
				hasDynamicStage([stage.onExhausted])) ||
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
	const env = rehearsalGitEnv(root);
	let gitRoot: string;
	let head: string;
	try {
		gitRoot = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"], env));
		head = git(gitRoot, ["rev-parse", "--verify", "HEAD"], env);
	} catch {
		return undefined;
	}
	const shadowRoot = join(root, "project");
	// An empty template directory: the user's ambient template (init.templateDir, GIT_TEMPLATE_DIR) would
	// copy its hooks and info files into the clone.
	const template = join(root, "git-isolation", "template");
	mkdirSync(template, { recursive: true });
	// The clone is private to the rehearsal: no hooks, no filters, no prompts, no system/global config
	// (`env`, see rehearsalGitEnv); the empty hooks path is also persisted in the clone's own configuration.
	git(
		root,
		[
			"-c",
			"protocol.file.allow=always",
			"clone",
			"--quiet",
			"--no-checkout",
			`--template=${template}`,
			gitRoot,
			shadowRoot,
		],
		env,
	);
	git(
		shadowRoot,
		["config", "core.hooksPath", join(root, "git-isolation", "hooks")],
		env,
	);
	git(shadowRoot, ["checkout", "--quiet", "--detach", head], env);
	// Keep the engine's own worktree/branch bookkeeping from ever being committed to or pushed anywhere.
	git(shadowRoot, ["remote", "remove", "origin"], env);
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
