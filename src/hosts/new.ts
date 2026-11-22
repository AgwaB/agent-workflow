// `new`: write a generated workflow bundle for a pattern (src/core/authoring-patterns.ts) into the project
// (private or shared) or the user's global workflow directory. Never overwrites without `force`; never
// follows a symlink. No model call, no run. Terminal CLI only.
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
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

	for (const file of files) {
		const target = join(directory, ...file.path.split("/"));
		await mkdir(dirname(target), { recursive: true });
		if (existing.includes(file.path))
			await writeFile(target, file.content, "utf8");
		else {
			const handle = await open(target, "wx", 0o644);
			try {
				await handle.writeFile(file.content, "utf8");
			} finally {
				await handle.close();
			}
		}
	}

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
