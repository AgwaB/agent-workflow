import { stateBase, ensureStateBase } from "../core/state-location.js";
// New in agent-workflow (WP19, stage-2 review #4): canonical containment of file paths taken from
// persisted run metadata (task `files.*`, attempt directories) before a host action reads them.
// Run records live in the workspace and can be tampered with, so a path from them is trusted only
// when it is a relative path without traversal and its canonical (symlink-resolved) target is
// inside the project's canonical artifact root, `<cwd>/.agent-workflow` (run dirs and the
// `workflow-subagents/` attempt dirs live there). Absolute paths, `..` segments and symlink
// escapes (a symlinked attempt dir or log file pointing elsewhere) are refused with a reason.
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { PROJECT_STATE_DIRECTORY } from "../core/home-dir.js";

export type ContainedRunFile =
	| { kind: "ok"; path: string }
	| { kind: "missing" }
	| { kind: "refused"; reason: string };

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

/** The project's artifact root (`<cwd>/.agent-workflow`). */
export function projectArtifactRoot(cwd: string): string {
	return join(stateBase(cwd), PROJECT_STATE_DIRECTORY);
}

/** WP42: `path` is a real directory (not a symlink); `create` makes it (one level) when missing. */
async function realDirectory(path: string, create: boolean): Promise<boolean> {
	if (create) {
		try {
			// Not recursive: mkdir never follows a symlink at `path` (EEXIST) and creates nothing
			// below an ancestor that was not checked first.
			await mkdir(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const info = await lstat(path);
	return !info.isSymbolicLink() && info.isDirectory();
}

/**
 * WP19 round 6: a host-owned state directory `<cwd>/.agent-workflow/<name>` that is physically
 * where it claims to be — `.agent-workflow` and `<name>` are real directories (not symlinks) and
 * the real path equals `<real cwd>/.agent-workflow/<name>`. Returns the directory, or `undefined`
 * when it is missing (and `create` is off) or not contained; callers then neither write nor prune
 * there. `create` makes missing directories first; an existing symlinked component still fails.
 * WP42 (review round 1, finding 4): `create` checks each level before creating the next one
 * (`.agent-workflow` is a real directory, or is created as one, before `<name>` is created in it),
 * so nothing is ever created through a symlinked ancestor; the leaf is re-checked afterwards.
 */
export async function containedProjectStateDir(
	cwd: string,
	name: string,
	create = false,
): Promise<string | undefined> {
	if (create) await ensureStateBase(cwd);
	const stateDir = projectArtifactRoot(cwd);
	const dir = join(stateDir, name);
	try {
		if (create) {
			if (!(await realDirectory(stateDir, true))) return undefined;
			const cwdReal = await realpath(stateBase(cwd));
			if ((await realpath(stateDir)) !== join(cwdReal, PROJECT_STATE_DIRECTORY))
				return undefined;
			if (!(await realDirectory(dir, true))) return undefined;
		}
		for (const component of [stateDir, dir]) {
			const info = await lstat(component);
			if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
		}
		const [cwdReal, dirReal] = await Promise.all([
			realpath(stateBase(cwd)),
			realpath(dir),
		]);
		return dirReal === join(cwdReal, PROJECT_STATE_DIRECTORY, name)
			? dir
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a metadata path (project-relative, as run records store it) for reading. `ok.path` is
 * the canonical target to open.
 */
export async function resolveContainedRunFile(
	cwd: string,
	candidate: unknown,
): Promise<ContainedRunFile> {
	if (typeof candidate !== "string" || !candidate)
		return { kind: "refused", reason: "no path in the run metadata" };
	if (/[\u0000]/u.test(candidate))
		return { kind: "refused", reason: "path contains a NUL byte" };
	if (isAbsolute(candidate) || win32.isAbsolute(candidate))
		return {
			kind: "refused",
			reason:
				"absolute path in the run metadata (run files are project-relative)",
		};
	if (candidate.split(/[\\/]/u).some((part) => part === ".."))
		return {
			kind: "refused",
			reason: "path traversal (`..`) in the run metadata",
		};
	const root = projectArtifactRoot(cwd);
	const lexical = resolve(stateBase(cwd), candidate);
	if (!inside(root, lexical))
		return {
			kind: "refused",
			reason: `path is outside the project's artifact root (${PROJECT_STATE_DIRECTORY}/)`,
		};
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(root);
	} catch {
		return { kind: "missing" };
	}
	let target: string;
	try {
		target = await realpath(lexical);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "missing" };
		return {
			kind: "refused",
			reason: `path cannot be resolved (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
		};
	}
	if (!inside(canonicalRoot, target))
		return {
			kind: "refused",
			reason: `symlink escape: the path resolves outside the project's artifact root (${PROJECT_STATE_DIRECTORY}/)`,
		};
	return { kind: "ok", path: target };
}
