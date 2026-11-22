// `new`: write a generated workflow bundle for a pattern (src/core/authoring-patterns.ts) into the project
// (private or shared) or the user's global workflow directory. Never overwrites without `force`; never
// follows a symlink. No model call, no run. Terminal CLI only.
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	rename,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	AUTHORING_PATTERNS,
	type AuthoringPatternId,
	type GeneratedFile,
	generatePatternFiles,
	isAuthoringPattern,
} from "../core/authoring-patterns.js";
import {
	agentWorkflowHome,
	PROJECT_STATE_DIRECTORY,
} from "../core/home-dir.js";
import { isValidWorkflowName } from "../core/workflow-specs.js";
import { HostUsageError } from "./args.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	hostEnv,
	result,
	toDisplayPath,
} from "./types.js";

export const NEW_SCOPES = ["private", "shared", "global"] as const;
export type NewScope = (typeof NEW_SCOPES)[number];

export interface NewRequest {
	pattern?: string;
	name?: string;
	scope?: NewScope;
	force?: boolean;
	list?: boolean;
}

export interface NewListData {
	patterns: Array<{ id: string; description: string; stages: string }>;
}

export interface NewCreatedData {
	pattern: AuthoringPatternId;
	name: string;
	scope: NewScope;
	directory: string;
	/** Paths relative to `directory`. */
	files: string[];
	overwritten: string[];
	notes: string[];
	nextSteps: string[];
}

export type NewData = NewListData | NewCreatedData;

function roots(
	ctx: HostApiContext,
): Record<NewScope, { workflows: string; label: string }> {
	return {
		private: {
			workflows: join(ctx.cwd, PROJECT_STATE_DIRECTORY, "workflows"),
			label: "project-private",
		},
		shared: {
			workflows: join(ctx.cwd, "workflows"),
			label: "project-shared",
		},
		global: {
			workflows: join(agentWorkflowHome(hostEnv(ctx)), "workflows"),
			label: "global",
		},
	};
}

async function entry(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Device names Windows refuses as a file or directory name, with or without an extension. */
const WINDOWS_RESERVED_NAME =
	/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * Writes the bundle all-or-nothing. Every file is first written into a staging directory next to the
 * target (so a full disk or an I/O error fails before the target is touched), then moved into place:
 * new files with `link` (fails if the path appeared meanwhile), replaced files after moving the original
 * aside. If a move fails, everything this call placed is removed, replaced files are restored and the
 * directories this call created are removed.
 */
async function writeBundle(
	root: string,
	directory: string,
	files: GeneratedFile[],
	existing: readonly string[],
): Promise<void> {
	const createdDirs: string[] = [];
	const mkdirTracked = async (path: string): Promise<void> => {
		const missing: string[] = [];
		for (let cursor = path; ; cursor = dirname(cursor)) {
			if ((await entry(cursor)) !== undefined) break;
			missing.push(cursor);
			if (dirname(cursor) === cursor) break;
		}
		for (const dir of missing.reverse()) {
			await mkdir(dir);
			createdDirs.push(dir);
		}
	};
	const placed: string[] = [];
	const moved: Array<{ original: string; backup: string }> = [];
	let staging: string | undefined;
	try {
		await mkdirTracked(root);
		staging = await mkdtemp(join(root, ".new-staging-"));
		const staged = join(staging, "files");
		const backups = join(staging, "backup");
		await mkdir(backups);
		for (const file of files) {
			const path = join(staged, ...file.path.split("/"));
			await mkdir(dirname(path), { recursive: true });
			const handle = await open(path, "wx", 0o644);
			try {
				await handle.writeFile(file.content, "utf8");
			} finally {
				await handle.close();
			}
		}
		await mkdirTracked(directory);
		let index = 0;
		for (const file of files) {
			const source = join(staged, ...file.path.split("/"));
			const target = join(directory, ...file.path.split("/"));
			await mkdirTracked(dirname(target));
			if (existing.includes(file.path)) {
				const backup = join(backups, String(index++));
				await rename(target, backup);
				moved.push({ original: target, backup });
				await rename(source, target);
			} else {
				try {
					await link(source, target);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "EEXIST") throw error;
					// A filesystem without hard links: fall back to a move (the path was checked above).
					await rename(source, target);
					placed.push(target);
					continue;
				}
			}
			placed.push(target);
		}
	} catch (error) {
		for (const target of placed.reverse()) await unlink(target).catch(() => {});
		for (const { original, backup } of moved.reverse())
			await rename(backup, original).catch(() => {});
		// Staging holds the backups: remove it only after they are restored, and before the directories
		// this call created (they can only be removed once empty).
		if (staging !== undefined)
			await rm(staging, { recursive: true, force: true }).catch(() => {});
		staging = undefined;
		for (const dir of createdDirs.reverse()) await rmdir(dir).catch(() => {});
		throw error;
	} finally {
		if (staging !== undefined)
			await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

export function formatPatternList(data: NewListData): string {
	const width = Math.max(...data.patterns.map((pattern) => pattern.id.length));
	return [
		"Patterns for `agent-workflow new <pattern> <name>`:",
		...data.patterns.map(
			(pattern) =>
				`  ${pattern.id.padEnd(width)}  ${pattern.description}\n  ${"".padEnd(width)}  stages: ${pattern.stages}`,
		),
	].join("\n");
}

function listAction(ctx: HostApiContext): HostResult<NewData> {
	assertActionAllowed(ctx, "new");
	const data: NewListData = {
		patterns: AUTHORING_PATTERNS.map((pattern) => ({ ...pattern })),
	};
	return result("new", "success", data, formatPatternList(data));
}

export function formatCreated(data: NewCreatedData, cwd: string): string {
	return [
		`Created workflow "${data.name}" from the ${data.pattern} pattern (scope ${data.scope}) in ${toDisplayPath(data.directory, cwd)}:`,
		...data.files.map(
			(file) =>
				`  ${file}${data.overwritten.includes(file) ? " (overwritten)" : ""}`,
		),
		...data.notes.map((note) => `Note: ${note}`),
		"Next:",
		...data.nextSteps.map((step, index) => `  ${index + 1}. ${step}`),
	].join("\n");
}

export async function newAction(
	ctx: HostApiContext,
	request: NewRequest,
): Promise<HostResult<NewData>> {
	if (request.list === true) return listAction(ctx);
	assertActionAllowed(ctx, "new");
	const usage =
		"Usage: agent-workflow new <pattern> <name> [--scope private|shared|global] [--force]  (patterns: agent-workflow new --list)";
	const { pattern, name } = request;
	if (!pattern || !name) throw new HostUsageError(usage);
	if (!isAuthoringPattern(pattern))
		throw new HostUsageError(
			`Unknown pattern "${pattern}". Patterns: ${AUTHORING_PATTERNS.map((entry) => entry.id).join(", ")}`,
		);
	if (!isValidWorkflowName(name))
		throw new HostUsageError(
			`Invalid workflow name "${name}": use letters, numbers, dot, underscore and dash, not starting with a dot`,
		);
	if (WINDOWS_RESERVED_NAME.test(name))
		throw new HostUsageError(
			`Invalid workflow name "${name}": it is a reserved device name on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension)`,
		);
	const scope = request.scope ?? "private";
	if (!(NEW_SCOPES as readonly string[]).includes(scope))
		throw new HostUsageError("--scope must be private, shared or global");

	const all = roots(ctx);
	const root = all[scope].workflows;
	const directory = join(root, name);
	const files: GeneratedFile[] = generatePatternFiles(pattern, name);

	// Refuse before writing anything: symlinks, a flat <name>.json beside the bundle, existing files.
	const dirEntry = await entry(directory);
	if (dirEntry?.isSymbolicLink())
		throw new HostUsageError(
			`${toDisplayPath(directory, ctx.cwd)} is a symlink; refusing to write through it`,
		);
	if (dirEntry !== undefined && !dirEntry.isDirectory())
		throw new HostUsageError(
			`${toDisplayPath(directory, ctx.cwd)} exists and is not a directory`,
		);
	if ((await entry(join(root, `${name}.json`))) !== undefined)
		throw new HostUsageError(
			`${toDisplayPath(join(root, `${name}.json`), ctx.cwd)} already exists; a flat ${name}.json beside ${name}/ makes the name ambiguous. Choose another name.`,
		);
	const existing: string[] = [];
	for (const file of files) {
		const target = join(directory, ...file.path.split("/"));
		for (const part of ["schemas", "helpers"]) {
			const sub = await entry(join(directory, part));
			if (file.path.startsWith(`${part}/`) && sub?.isSymbolicLink())
				throw new HostUsageError(
					`${toDisplayPath(join(directory, part), ctx.cwd)} is a symlink; refusing to write through it`,
				);
		}
		const found = await entry(target);
		if (found === undefined) continue;
		if (found.isSymbolicLink() || !found.isFile())
			throw new HostUsageError(
				`${toDisplayPath(target, ctx.cwd)} is not a regular file; refusing to overwrite it`,
			);
		existing.push(file.path);
	}
	if (existing.length > 0 && request.force !== true)
		throw new HostUsageError(
			`Refusing to overwrite existing files in ${toDisplayPath(directory, ctx.cwd)}: ${existing.join(", ")}. Pass --force to replace them.`,
		);

	await writeBundle(root, directory, files, existing);

	const notes: string[] = [];
	const higher: NewScope[] =
		scope === "private"
			? ["shared"]
			: scope === "global"
				? ["shared", "private"]
				: [];
	for (const other of higher) {
		const candidates = [
			join(all[other].workflows, name),
			join(all[other].workflows, `${name}.json`),
		];
		for (const candidate of candidates)
			if ((await entry(candidate)) !== undefined)
				notes.push(
					`${toDisplayPath(candidate, ctx.cwd)} (${all[other].label}) has the same name and takes priority over this ${all[scope].label} workflow`,
				);
	}
	const data: NewCreatedData = {
		pattern,
		name,
		scope,
		directory,
		files: files.map((file) => file.path),
		overwritten: existing,
		notes,
		nextSteps: [
			"Edit the TODO: paragraph of every prompt in spec.json (and the description); prompts are the only edit you must make. If you change a schema, change its stage's Contract sentences and example to match.",
			`agent-workflow validate ${name}   (fix every warning)`,
			`agent-workflow check ${name}   (executor, tools, models; no run)`,
			`agent-workflow rehearse ${name}   (wiring with a synthetic worker; no model call)`,
			`agent-workflow run ${name} "<a small task>" --model <cheapest model>   (smoke run)`,
		],
	};
	return result("new", "success", data, formatCreated(data, ctx.cwd));
}
