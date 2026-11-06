import { readFile } from "node:fs/promises";

import { discoverAgents } from "../core/agents.js";
import {
	EXECUTOR_PRESET_IDS,
	type ExecutorPreset,
	executorPreset,
} from "../core/executor-presets.js";
import { compileWorkflow } from "../core/compiler.js";
import { loadWorkflowSpec } from "../core/schema.js";
import type { WorkflowRoutingHints, CompiledWorkflow } from "../core/types.js";
import { listWorkflows, resolveWorkflowRef } from "../core/workflow-specs.js";
import { HostUsageError } from "./args.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	hostEnv,
	result,
	toDisplayPath,
} from "./types.js";
import {
	deleteUserProfile,
	formatRoleMapLines,
	formatUserProfile,
	readUserProfiles,
	setDefaultUserProfile,
	setUserProfile,
	type UserProfile,
	userProfileFromFile,
	userProfilesPath,
} from "./user-profiles.js";
import {
	clearWorkflowPreference,
	formatWorkflowPreference,
	readWorkflowPreferences,
	setWorkflowPreference,
	type WorkflowPreference,
	workflowPreferenceFrom,
	workflowPreferencesPath,
} from "./workflow-preferences.js";

export interface WorkflowListSummary {
	name: string;
	aliases: string[];
	specPath: string;
	description?: string;
	agent?: string;
	readOnly?: boolean;
	scope?: string;
	routing?: WorkflowRoutingHints;
}

export interface ListRequest {
	/** Case-insensitive name/alias substring filter. */
	query?: string;
	offset?: number;
	/** Page size 1-20 (paged, bounded to 50 KB / 2000 lines). Omitted: every workflow. */
	limit?: number;
}

export interface ListData {
	workflows: WorkflowListSummary[];
	total: number;
	nextOffset?: number;
	omitted: number;
}

function clipWorkflowMetadata(value: string, maxBytes: number): string {
	const text = value.replace(/\s+/g, " ");
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const data = Buffer.from(text);
	let end = maxBytes - 16;
	while ((data[end]! & 0xc0) === 0x80) end--;
	return `${data.subarray(0, end).toString("utf8")} [truncated]`;
}

async function listWorkflowSummaries(
	cwd: string,
	workflows: Awaited<ReturnType<typeof listWorkflows>>,
): Promise<WorkflowListSummary[]> {
	const summaries: WorkflowListSummary[] = [];
	// Keep metadata IO bounded independently from catalog discovery.
	for (let offset = 0; offset < workflows.length; offset += 4) {
		summaries.push(
			...(await Promise.all(
				workflows.slice(offset, offset + 4).map(async (workflow) => {
					let description: string | undefined;
					let agent: string | undefined;
					let readOnly: boolean | undefined;
					let routing: WorkflowRoutingHints | undefined;
					try {
						const loaded = await loadWorkflowSpec(workflow.specPath, cwd);
						description = loaded.spec.description;
						agent = (loaded.spec.defaults as { agent?: string } | undefined)
							?.agent;
						readOnly = loaded.spec.defaults?.readOnly;
						routing = loaded.spec.routing;
					} catch {
						// listWorkflows already filters runnable specs; omit optional metadata if a
						// workflow disappears between discovery and summary formatting.
					}
					return {
						name: workflow.name,
						aliases: workflow.aliases,
						...(workflow.scope ? { scope: workflow.scope } : {}),
						...(routing ? { routing } : {}),
						specPath: toDisplayPath(workflow.specPath, cwd),
						...(description
							? { description: clipWorkflowMetadata(description, 512) }
							: {}),
						...(agent ? { agent: clipWorkflowMetadata(agent, 128) } : {}),
						...(readOnly !== undefined ? { readOnly } : {}),
					};
				}),
			)),
		);
	}
	return summaries;
}

function formatWorkflowList(workflows: WorkflowListSummary[]): string {
	if (workflows.length === 0) return "No workflows found.";
	return workflows
		.map((workflow) => {
			const aliases = clipWorkflowMetadata(
				workflow.aliases.filter((alias) => alias !== workflow.name).join(", "),
				256,
			);
			const metadata = [
				workflow.agent ? `agent=${workflow.agent}` : undefined,
				workflow.readOnly !== undefined
					? `readOnly=${workflow.readOnly}`
					: undefined,
			]
				.filter((item): item is string => item !== undefined)
				.join(", ");
			return [
				`${clipWorkflowMetadata(workflow.name, 256)}${aliases ? ` (aliases: ${aliases})` : ""}: ${workflow.description ?? "No description."}`,
				`  spec: ${clipWorkflowMetadata(workflow.specPath, 1024)}${metadata ? `; ${metadata}` : ""}`,
			].join("\n");
		})
		.join("\n");
}

function makeListPage(
	rows: WorkflowListSummary[],
	total: number,
	offset: number,
	query: string | undefined,
): HostResult<ListData> {
	const nextOffset =
		offset + rows.length < total ? offset + rows.length : undefined;
	const omitted = Math.max(0, total - offset - rows.length);
	const notice =
		nextOffset !== undefined
			? `\n[${omitted} workflows omitted. Continue with offset=${nextOffset}${query ? " and the same query" : ""}, or narrow the query.]`
			: "";
	return result(
		"list",
		"success",
		{
			workflows: rows,
			total,
			...(nextOffset === undefined ? {} : { nextOffset }),
			omitted,
		},
		formatWorkflowList(rows) + notice,
	);
}

/** Bounded page: serialized text and data each stay within 50 KB and 2000 lines. */
function boundedListPage(
	rows: WorkflowListSummary[],
	total: number,
	offset: number,
	query: string | undefined,
): HostResult<ListData> {
	const fits = (page: HostResult<ListData>): boolean =>
		[
			JSON.stringify(page.text),
			JSON.stringify(page.data, null, 2),
			page.text,
		].every(
			(text) =>
				Buffer.byteLength(text) <= 50 * 1024 &&
				text.split("\n").length <= 2_000,
		);
	const included: WorkflowListSummary[] = [];
	for (let row of rows) {
		if (!fits(makeListPage([...included, row], total, offset, query))) {
			if (included.length > 0) break;
			// Even pathological names/alias metadata must not cause a zero-progress
			// continuation. Preserve the complete path; optional metadata can go.
			row = {
				name: clipWorkflowMetadata(row.name, 256),
				aliases: [],
				specPath: row.specPath,
			};
			if (!fits(makeListPage([row], total, offset, query)))
				throw new Error(
					"workflow list spec path exceeds the response budget; narrow the catalog at its source",
				);
		}
		included.push(row);
	}
	return makeListPage(included, total, offset, query);
}

/** `list`: discoverable workflows (project, user, bundled). */
export async function listWorkflowsAction(
	ctx: HostApiContext,
	request: ListRequest = {},
): Promise<HostResult<ListData>> {
	assertActionAllowed(ctx, "list");
	const offset = request.offset === undefined ? 0 : request.offset;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
		throw new HostUsageError("list offset must be a non-negative integer");
	if (
		request.limit !== undefined &&
		(!Number.isInteger(request.limit) ||
			request.limit < 1 ||
			request.limit > 20)
	)
		throw new HostUsageError("list limit must be an integer from 1 to 20");
	if (request.query !== undefined && typeof request.query !== "string")
		throw new HostUsageError("list query must be a string");
	const query = request.query?.trim().toLowerCase() || undefined;
	const catalog = (await listWorkflows(ctx.cwd)).filter(
		(workflow) =>
			!query ||
			[workflow.name, ...workflow.aliases].some((name) =>
				name.toLowerCase().includes(query),
			),
	);
	if (request.limit === undefined) {
		const rows = await listWorkflowSummaries(ctx.cwd, catalog.slice(offset));
		return makeListPage(rows, catalog.length, offset, query);
	}
	const rows = await listWorkflowSummaries(
		ctx.cwd,
		catalog.slice(offset, offset + request.limit),
	);
	return boundedListPage(rows, catalog.length, offset, query);
}

async function loadAndCompile(
	workflow: string,
	cwd: string,
): Promise<{
	loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>;
	compiled: CompiledWorkflow;
}> {
	if (typeof workflow !== "string" || !workflow.trim())
		throw new HostUsageError("a workflow name or spec path is required");
	const loaded = await loadWorkflowSpec(workflow, cwd);
	return {
		loaded,
		compiled: await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
		}),
	};
}

function formatResolvedSpec(
	loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>,
	cwd: string,
): string {
	const workflow = loaded.workflowName
		? ` (workflow: ${loaded.workflowName})`
		: "";
	return `Spec: ${toDisplayPath(loaded.specPath, cwd)}${workflow}`;
}

export interface ValidateData {
	valid: true;
	name?: string;
	specPath: string;
	workflowName?: string;
	type: CompiledWorkflow["type"];
	tasks: number;
	roles: number;
	maxConcurrency: number;
	blockedPermissionPreviews: Array<{
		taskId: string;
		statusDetail: string;
		reason?: string;
	}>;
	warnings: string[];
}

/** `validate`: load and compile a spec. Invalid specs throw WorkflowValidationError. */
export async function validateWorkflowAction(
	ctx: HostApiContext,
	request: { workflow: string },
): Promise<HostResult<ValidateData>> {
	assertActionAllowed(ctx, "validate");
	const { loaded, compiled } = await loadAndCompile(request.workflow, ctx.cwd);
	const blocked = compiled.tasks.filter(
		(task) => task.safety.permission.status === "blocked",
	);
	const lines = [
		`Workflow spec valid: ${compiled.name ?? "(unnamed)"}`,
		formatResolvedSpec(loaded, ctx.cwd),
		`Type: ${compiled.type}`,
		`Tasks: ${compiled.tasks.length}`,
		`Roles: ${compiled.roles.length}`,
		`Max concurrency: ${compiled.maxConcurrency}`,
	];
	if (blocked.length > 0) {
		lines.push("Blocked permission previews:");
		for (const task of blocked)
			lines.push(
				`- ${task.id}: blocked/${task.safety.permission.statusDetail} — ${task.safety.permission.reason ?? "needs attention"}`,
			);
	}
	if (compiled.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of compiled.warnings) lines.push(`- ${warning}`);
	}
	return result(
		"validate",
		"success",
		{
			valid: true,
			...(compiled.name === undefined ? {} : { name: compiled.name }),
			specPath: toDisplayPath(loaded.specPath, ctx.cwd),
			...(loaded.workflowName ? { workflowName: loaded.workflowName } : {}),
			type: compiled.type,
			tasks: compiled.tasks.length,
			roles: compiled.roles.length,
			maxConcurrency: compiled.maxConcurrency,
			blockedPermissionPreviews: blocked.map((task) => ({
				taskId: task.id,
				statusDetail: String(task.safety.permission.statusDetail),
				...(task.safety.permission.reason
					? { reason: task.safety.permission.reason }
					: {}),
			})),
			warnings: [...compiled.warnings],
		},
		lines.join("\n"),
	);
}

export interface RolesData {
	specPath: string;
	roles: CompiledWorkflow["roles"];
}

/** `roles`: compiled role context exactly as injected into task prompts. */
export async function workflowRolesAction(
	ctx: HostApiContext,
	request: { workflow: string },
): Promise<HostResult<RolesData>> {
	assertActionAllowed(ctx, "roles");
	const { loaded, compiled } = await loadAndCompile(request.workflow, ctx.cwd);
	const rolesText =
		compiled.roles.length === 0
			? "No roles compiled."
			: compiled.roles
					.map((role) =>
						[
							`Role: ${role.name}`,
							role.fromAgent ? `fromAgent: ${role.fromAgent}` : undefined,
							role.sourcePath ? `sourcePath: ${role.sourcePath}` : undefined,
							`includedSections: ${role.includedSections.join(", ")}`,
							`excludedSections: ${role.excludedSections.join(", ")}`,
							`truncated: ${role.truncated} (maxChars=${role.maxChars})`,
							"",
							"# Role Context",
							"",
							`## Role: ${role.name}`,
							role.content || "(empty role content)",
						]
							.filter((line): line is string => line !== undefined)
							.join("\n"),
					)
					.join("\n\n---\n\n");
	return result(
		"roles",
		"success",
		{
			specPath: toDisplayPath(loaded.specPath, ctx.cwd),
			roles: compiled.roles,
		},
		`${formatResolvedSpec(loaded, ctx.cwd)}\n\n${rolesText}`,
	);
}

export interface AgentSummary {
	name: string;
	displayName: string;
	description?: string;
	scope: string;
	model?: string;
	effort?: string;
	tools?: string[];
	readOnly?: boolean;
	sourcePath: string;
}

/** `agents`: discoverable agent definitions (project, user, bundled). */
export async function listAgentsAction(
	ctx: HostApiContext,
): Promise<HostResult<{ agents: AgentSummary[] }>> {
	assertActionAllowed(ctx, "agents");
	const registry = await discoverAgents(ctx.cwd);
	const agents: AgentSummary[] = registry.agents.map((agent) => ({
		name: agent.name,
		displayName: agent.displayName,
		...(agent.description ? { description: agent.description } : {}),
		scope: agent.scope,
		...(agent.model ? { model: agent.model } : {}),
		...(agent.thinking ? { effort: agent.thinking } : {}),
		...(agent.tools ? { tools: [...agent.tools] } : {}),
		...(agent.readOnly === undefined ? {} : { readOnly: agent.readOnly }),
		sourcePath: agent.sourcePath,
	}));
	const text =
		agents.length === 0
			? "No agents found."
			: agents
					.map((agent) =>
						[
							agent.displayName,
							agent.description ? `  ${agent.description}` : undefined,
							`  ${
								[
									agent.model ? `model=${agent.model}` : undefined,
									agent.effort ? `effort=${agent.effort}` : undefined,
								]
									.filter(Boolean)
									.join(" ") || "runtime=(executor default)"
							}`,
							`  tools=${agent.tools?.join(",") ?? "(executor default)"}`,
							`  source=${agent.sourcePath}`,
						]
							.filter((line): line is string => line !== undefined)
							.join("\n"),
					)
					.join("\n\n");
	return result("agents", "success", { agents }, text);
}

/** `show <workflow>`: the resolved spec file text. */
export async function showWorkflowSpecAction(
	ctx: HostApiContext,
	request: { workflow: string },
): Promise<HostResult<{ kind: "workflow"; specPath: string; spec: string }>> {
	assertActionAllowed(ctx, "show");
	const resolved = await resolveWorkflowRef(request.workflow, ctx.cwd);
	const spec = await readFile(resolved.specPath, "utf8");
	return result(
		"show",
		"success",
		{
			kind: "workflow",
			specPath: toDisplayPath(resolved.specPath, ctx.cwd),
			spec,
		},
		spec,
	);
}

export type ProfileRequest =
	| { op: "list" }
	| { op: "show"; name?: string }
	| {
			op: "set";
			name: string;
			values?: Record<string, unknown>;
			unset?: string[];
			makeDefault?: boolean;
			/** WP31: start from a built-in preset (codex, claude, pi, mixed). */
			preset?: string;
	  }
	/** WP31: the built-in executor presets and their role tables. */
	| { op: "presets" }
	| { op: "delete"; name: string }
	| { op: "default"; name: string | null };

export interface ProfileData {
	op: ProfileRequest["op"];
	path: string;
	default?: string;
	profiles?: UserProfile[];
	profile?: UserProfile;
	deleted?: boolean;
	/** WP31: op presets. */
	presets?: ExecutorPreset[];
}

/** `profile list|show|set|delete|default`: saved user profiles (B2 "saved user profile" tier). */
export async function profileAction(
	ctx: HostApiContext,
	request: ProfileRequest,
): Promise<HostResult<ProfileData>> {
	assertActionAllowed(ctx, "profile");
	const env = hostEnv(ctx);
	const path = userProfilesPath(env);
	if (request.op === "list") {
		const file = await readUserProfiles(env);
		const profiles = Object.keys(file.profiles)
			.sort((a, b) => a.localeCompare(b))
			.map((name) => userProfileFromFile(file, name)!);
		return result(
			"profile",
			"success",
			{
				op: "list",
				path,
				...(file.default ? { default: file.default } : {}),
				profiles,
			},
			profiles.length === 0
				? "No saved profiles. Create one with: agent-workflow profile set <name> --executor <id>"
				: profiles
						.map((profile) =>
							formatUserProfile(profile, profile.name === file.default),
						)
						.join("\n\n"),
		);
	}
	if (request.op === "show") {
		const file = await readUserProfiles(env);
		const name = request.name ?? file.default;
		if (name === undefined)
			return result(
				"profile",
				"success",
				{ op: "show", path },
				"No default profile is set.",
			);
		const profile = userProfileFromFile(file, name);
		if (!profile) throw new HostUsageError(`no saved profile named "${name}"`);
		return result(
			"profile",
			"success",
			{
				op: "show",
				path,
				...(file.default ? { default: file.default } : {}),
				profile,
			},
			formatUserProfile(profile, name === file.default),
		);
	}
	if (request.op === "set") {
		const saved = await setUserProfile(
			{
				name: request.name,
				...(request.values === undefined ? {} : { values: request.values }),
				...(request.unset === undefined ? {} : { unset: request.unset }),
				...(request.makeDefault ? { makeDefault: true } : {}),
				...(request.preset === undefined ? {} : { preset: request.preset }),
			},
			env,
		);
		return result(
			"profile",
			"success",
			{
				op: "set",
				path,
				...(saved.isDefault ? { default: saved.profile.name } : {}),
				profile: saved.profile,
			},
			`${saved.created ? "Saved" : "Updated"} profile:\n${formatUserProfile(saved.profile, saved.isDefault)}`,
		);
	}
	if (request.op === "presets") {
		const presets = EXECUTOR_PRESET_IDS.map((id) => executorPreset(id));
		return result(
			"profile",
			"success",
			{ op: "presets", path, presets },
			[
				...presets.map((preset) =>
					[
						`${preset.id} — ${preset.description}`,
						...formatRoleMapLines(preset.roles).map((line) => `  ${line}`),
					].join("\n"),
				),
				"Save one with: agent-workflow profile set <name> --preset <id> [--default]; or run with --profile <id>.",
			].join("\n\n"),
		);
	}
	if (request.op === "delete") {
		const deleted = await deleteUserProfile(request.name, env);
		if (!deleted.deleted)
			throw new HostUsageError(`no saved profile named "${request.name}"`);
		return result(
			"profile",
			"success",
			{ op: "delete", path, deleted: true },
			`Deleted profile ${request.name}${deleted.wasDefault ? " (it was the default; no default is set now)" : ""}.`,
		);
	}
	if (request.op === "default") {
		await setDefaultUserProfile(request.name ?? undefined, env);
		return result(
			"profile",
			"success",
			{
				op: "default",
				path,
				...(request.name ? { default: request.name } : {}),
			},
			request.name
				? `Default profile: ${request.name}`
				: "Default profile cleared.",
		);
	}
	throw new HostUsageError(
		`unknown profile operation ${JSON.stringify((request as { op?: unknown }).op)}`,
	);
}

export type WorkflowPreferenceRequest =
	| { op: "list" }
	| { op: "show"; workflow: string }
	| {
			op: "set";
			workflow: string;
			/** Declared profile, saved user profile or built-in preset used when a launch names none. */
			profile?: string;
			/** Role → {executor?, model?, effort?}; merged role by role. */
			roles?: Record<string, unknown>;
			/** `profile`, `roles` or `roles.<role>`. */
			unset?: string[];
	  }
	| { op: "clear"; workflow: string };

export interface WorkflowPreferenceData {
	op: WorkflowPreferenceRequest["op"];
	path: string;
	preferences?: WorkflowPreference[];
	preference?: WorkflowPreference;
	/** Workflow name the preference belongs to (show/set/clear). */
	workflow?: string;
	cleared?: boolean;
}

/** WP31: the workflow name a preference is keyed by (`spec.name`). */
async function preferenceWorkflowName(
	ctx: HostApiContext,
	ref: string,
	allowUnresolved: boolean,
): Promise<{ name: string; spec?: { executionProfiles?: object } }> {
	if (typeof ref !== "string" || !ref.trim())
		throw new HostUsageError("a workflow name or spec path is required");
	try {
		const loaded = await loadWorkflowSpec(ref.trim(), ctx.cwd);
		const name = loaded.spec.name?.trim();
		if (!name)
			throw new HostUsageError(
				`workflow ${ref} has no name; saved preferences are keyed by the workflow name`,
			);
		return { name, spec: loaded.spec };
	} catch (error) {
		if (allowUnresolved && !(error instanceof HostUsageError))
			return { name: ref.trim() };
		throw error;
	}
}

/**
 * WP31 (`profile workflow list|show|set|clear`): saved per-workflow preferences
 * (workflow-preferences.ts). `set` checks that the profile exists (declared by the workflow, a saved
 * user profile or a built-in preset) and that role executors are known.
 */
export async function workflowPreferenceAction(
	ctx: HostApiContext,
	request: WorkflowPreferenceRequest,
): Promise<HostResult<WorkflowPreferenceData>> {
	assertActionAllowed(ctx, "profile");
	const env = hostEnv(ctx);
	const path = workflowPreferencesPath(env);
	if (request.op === "list") {
		const file = await readWorkflowPreferences(env);
		const preferences = Object.keys(file.workflows)
			.sort((a, b) => a.localeCompare(b))
			.map((name) => workflowPreferenceFrom(file, name)!);
		return result(
			"profile",
			"success",
			{ op: "list", path, preferences },
			preferences.length === 0
				? "No saved workflow preferences. Create one with: agent-workflow profile workflow set <workflow> --profile <name> [--role <role>=<executor>[:<model>[:<effort>]]]"
				: preferences.map(formatWorkflowPreference).join("\n\n"),
		);
	}
	if (request.op === "show") {
		const { name } = await preferenceWorkflowName(ctx, request.workflow, true);
		const preference = workflowPreferenceFrom(
			await readWorkflowPreferences(env),
			name,
		);
		return result(
			"profile",
			"success",
			{
				op: "show",
				path,
				workflow: name,
				...(preference ? { preference } : {}),
			},
			preference
				? formatWorkflowPreference(preference)
				: `No saved preference for workflow ${name}.`,
		);
	}
	if (request.op === "set") {
		const { name, spec } = await preferenceWorkflowName(
			ctx,
			request.workflow,
			false,
		);
		if (request.profile !== undefined) {
			const declared = Object.keys(
				(spec as { executionProfiles?: Record<string, unknown> } | undefined)
					?.executionProfiles ?? {},
			);
			const saved = Object.keys((await readUserProfiles(env)).profiles);
			if (
				!declared.includes(request.profile) &&
				!saved.includes(request.profile) &&
				!(EXECUTOR_PRESET_IDS as readonly string[]).includes(request.profile)
			)
				throw new HostUsageError(
					`unknown profile "${request.profile}" for workflow ${name}: it declares ${declared.length ? declared.sort().join(", ") : "no execution profiles"}; saved user profiles: ${saved.length ? saved.sort().join(", ") : "none"}; built-in presets: ${EXECUTOR_PRESET_IDS.join(", ")}`,
				);
		}
		const saved = await setWorkflowPreference(
			{
				workflow: name,
				...(request.profile === undefined ? {} : { profile: request.profile }),
				...(request.roles === undefined ? {} : { roles: request.roles }),
				...(request.unset === undefined ? {} : { unset: request.unset }),
			},
			env,
		);
		return result(
			"profile",
			"success",
			{ op: "set", path, workflow: name, preference: saved.preference },
			`${saved.created ? "Saved" : "Updated"} workflow preference (applies to every launch of ${name} from the CLI, MCP hosts and Pi):\n${formatWorkflowPreference(saved.preference)}`,
		);
	}
	if (request.op === "clear") {
		const { name } = await preferenceWorkflowName(ctx, request.workflow, true);
		const cleared = await clearWorkflowPreference(name, env);
		return result(
			"profile",
			"success",
			{ op: "clear", path, workflow: name, cleared },
			cleared
				? `Cleared the saved preference of workflow ${name}.`
				: `No saved preference for workflow ${name}.`,
		);
	}
	throw new HostUsageError(
		`unknown workflow preference operation ${JSON.stringify((request as { op?: unknown }).op)}`,
	);
}
