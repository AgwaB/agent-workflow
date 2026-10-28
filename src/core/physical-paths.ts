// New in agent-workflow (WP42, WP39b review findings 1/2): physical containment for retention
// deleters. A path is deleted only when every directory from the canonical project root down to it
// is a real directory (no symlink anywhere in the chain), so no lexical project path can lead a
// recursive removal or a git mutation outside the project.
import { lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface PhysicalDirectoryChain {
	/** The checked path (equal to its physical path when it exists). */
	path: string;
	/** False when a component is missing (everything below it is missing too). */
	exists: boolean;
}

/**
 * Validate `base` (a canonical, real directory) and each `segments` component below it: each one
 * that exists must be a real directory, not a symlink, and the final path's `realpath` must equal
 * its lexical path. A missing component ends the walk with `exists: false`. Throws when a component
 * is a symlink or not a directory, `base` is not canonical, a segment is not a single plain name, or
 * the file system reports anything but ENOENT.
 */
export async function physicalDirectoryChain(
	base: string,
	segments: readonly string[],
): Promise<PhysicalDirectoryChain> {
	const root = resolve(base);
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
		throw new Error(`unsafe path chain: ${root} is not a real directory`);
	if ((await realpath(root)) !== root)
		throw new Error(`unsafe path chain: ${root} is not canonical`);
	let path = root;
	for (const [index, segment] of segments.entries()) {
		if (
			!segment ||
			segment === "." ||
			segment === ".." ||
			segment.includes("/") ||
			segment.includes(sep) ||
			segment.includes("\0")
		)
			throw new Error(`unsafe path chain: invalid component ${segment}`);
		path = join(path, segment);
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return {
					path: join(path, ...segments.slice(index + 1)),
					exists: false,
				};
			throw error;
		}
		if (info.isSymbolicLink())
			throw new Error(`unsafe path chain: ${path} is a symlink`);
		if (!info.isDirectory())
			throw new Error(`unsafe path chain: ${path} is not a directory`);
	}
	if ((await realpath(path)) !== path)
		throw new Error(`unsafe path chain: ${path} changed while checked`);
	return { path, exists: true };
}
