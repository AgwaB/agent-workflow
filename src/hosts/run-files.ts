// New in agent-workflow (WP19, stage-2 review #4): canonical containment of file paths taken from
// persisted run metadata (task `files.*`, attempt directories) before a host action reads them.
// Run records live in the workspace and can be tampered with, so a path from them is trusted only
// when it is a relative path without traversal and its canonical (symlink-resolved) target is
// inside the project's canonical artifact root, `<cwd>/.agent-workflow` (run dirs and the
// `workflow-subagents/` attempt dirs live there). Absolute paths, `..` segments and symlink
// escapes (a symlinked attempt dir or log file pointing elsewhere) are refused with a reason.
import { realpath } from "node:fs/promises";
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
	return join(resolve(cwd), PROJECT_STATE_DIRECTORY);
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
	const lexical = resolve(cwd, candidate);
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
