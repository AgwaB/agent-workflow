// Shared by the fix-loop engine baseline and generated test helper. A checked cwd
// is not a sandbox: only trusted project code belongs in the configured command.
import { execFile } from "node:child_process";
import { lstat, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

// Don't pass ambient credentials, Git redirections or NODE_TEST_CONTEXT to the command.
export function commandEnv() {
	const env = {};
	for (const name of [
		"PATH",
		"HOME",
		"USERPROFILE",
		"SYSTEMROOT",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
	]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
}

async function gitOutput(cwd, args, signal) {
	return (
		await exec("git", ["-C", cwd, ...args], {
			env: commandEnv(),
			signal,
			maxBuffer: MAX_BUFFER,
		})
	).stdout;
}

export async function verifyWorktree(
	path,
	branch,
	base,
	signal,
	expectedPhysical,
) {
	try {
		signal?.throwIfAborted();
		const physical = await realpath(path);
		if (expectedPhysical !== undefined && expectedPhysical !== physical)
			throw new Error("physical path changed");
		const [top, head, list] = await Promise.all([
			gitOutput(physical, ["rev-parse", "--show-toplevel"], signal),
			gitOutput(physical, ["symbolic-ref", "HEAD"], signal),
			gitOutput(base, ["worktree", "list", "--porcelain", "-z"], signal),
		]);
		const expectedRef = "refs/heads/" + branch;
		let registered = false;
		for (const record of list.split("\0\0")) {
			const [entry, ...fields] = record.split("\0");
			if (
				entry.startsWith("worktree ") &&
				fields.includes("branch " + expectedRef) &&
				(await realpath(entry.slice(9)).catch(() => null)) === physical
			)
				registered = true;
		}
		if (
			(await realpath(top.replace(/\r?\n$/, ""))) !== physical ||
			head.trimEnd() !== expectedRef ||
			!registered
		) {
			throw new Error("expected the registered checkout for " + branch);
		}
		return physical;
	} catch (error) {
		signal?.throwIfAborted();
		throw new Error("test: worktree identity mismatch: " + error.message, {
			cause: error,
		});
	}
}

function missingPath(error) {
	if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
}

export async function gitHead(worktree, signal) {
	return (
		await gitOutput(worktree, ["rev-parse", "--verify", "HEAD"], signal)
	).trim();
}

async function gitStatusEntries(worktree, signal) {
	const status = await gitOutput(
		worktree,
		["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
		signal,
	);
	return status.split("\0").filter(Boolean);
}

export async function gitDirtyPaths(worktree, signal) {
	return (await gitStatusEntries(worktree, signal))
		.map((entry) => entry.slice(3))
		.sort();
}

// Old generated bundles include the porcelain status in each fingerprint.
export async function gitLegacySnapshot(worktree, signal, snapshot) {
	const entries = (await gitStatusEntries(worktree, signal)).sort((a, b) =>
		a.slice(3) < b.slice(3) ? -1 : 1,
	);
	const byPath = new Map(snapshot.map((row) => [row.path, row.fingerprint]));
	const missing = [
		...new Set(
			entries
				.map((entry) => entry.slice(3))
				.filter((path) => !byPath.has(path)),
		),
	];
	for (const row of await fingerprintPaths(worktree, missing, signal)) {
		byPath.set(row.path, row.fingerprint);
	}
	return entries.map((entry) => ({
		path: entry.slice(3),
		fingerprint: entry.slice(0, 2) + ":" + byPath.get(entry.slice(3)),
	}));
}

// Compare every round to the same tree, not the tip of the managed branch.
// Fingerprint content and mode, so staging or committing alone does not change a fingerprint.
export async function gitSnapshot(worktree, head, signal) {
	const git = (args) => gitOutput(worktree, args, signal);
	const [tracked, untracked] = await Promise.all([
		git([
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			head,
			"--",
		]),
		git(["ls-files", "-z", "--others", "--exclude-standard", "--"]),
	]);
	const paths = [
		...new Set(
			[...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean),
		),
	].sort();
	return fingerprintPaths(worktree, paths, signal);
}

async function fingerprintPaths(worktree, paths, signal) {
	const git = (args) => gitOutput(worktree, args, signal);
	if (paths.length > 1000)
		throw new Error("test: more than 1000 paths changed in the loop worktree");
	const snapshot = [];
	for (const path of paths) {
		const absolute = join(worktree, path);
		// Never follow an ancestor symlink when fingerprinting a status path.
		let parent = worktree;
		let missing = false;
		for (const part of path.split("/").slice(0, -1)) {
			parent = join(parent, part);
			const ancestor = await lstat(parent).catch(missingPath);
			if (!ancestor || !ancestor.isDirectory()) {
				missing = true;
				break;
			}
		}
		const info = missing ? undefined : await lstat(absolute).catch(missingPath);
		const content = !info
			? "deleted"
			: info.isSymbolicLink()
				? await readlink(absolute)
				: info.isFile()
					? (await git(["hash-object", "--no-filters", "--", path])).trim()
					: info.isDirectory()
						? (await gitOutput(absolute, ["rev-parse", "HEAD"], signal)).trim()
						: "special";
		snapshot.push({
			path,
			fingerprint: (info?.mode ?? 0) + ":" + content,
		});
	}
	return snapshot;
}
