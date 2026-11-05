// New in agent-workflow (WP31 item 4, feature-parity row 25): saved per-workflow preferences for every
// host. A preference is a remembered launch choice for one workflow (by its `name`): the profile a
// launch uses when it names none (a declared profile, a saved user profile or a built-in preset), and
// role overrides (role → executor/model/effort) applied on every launch of that workflow just below
// the run flags. Stored in `$AGENT_WORKFLOW_HOME/workflow-preferences/v1/preferences.json`; the CLI
// (`agent-workflow profile workflow …`), the host MCP tool `workflow_profile` (writes after an
// elicitation confirmation) and the Pi host share it, and every launch (CLI, MCP, Pi) applies it
// (launch.ts). Keyed by workflow name rather than definition fingerprint: role overrides address roles,
// not stage ids, so they stay valid when the definition changes. Pi configuration
// directories are never read.
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agentWorkflowHome } from "../core/home-dir.js";
import { parseWorkflowRoleMap } from "../core/role-profiles.js";
import {
	ensurePrivateDirectory,
	readPrivateFileText,
	writePrivateFileAtomic,
} from "../core/secure-atomic-write.js";
import type { WorkflowRoleMap } from "../core/types.js";
import { HostUsageError } from "./args.js";
import { withStoreLock } from "./store-lock.js";
import {
	assertKnownProfileExecutors,
	assertUserProfileName,
	formatRoleMapLines,
} from "./user-profiles.js";

export const WORKFLOW_PREFERENCES_SCHEMA =
	"agent-workflow-workflow-preferences-v1" as const;

export interface WorkflowPreference {
	/** Workflow name (`spec.name`). */
	workflow: string;
	/** Profile used when a launch names none: declared, saved user profile or preset. */
	profile?: string;
	/** Role overrides above the selected profile (below run flags). */
	roles?: WorkflowRoleMap;
	updatedAt: string;
}

export interface WorkflowPreferencesFile {
	schema: typeof WORKFLOW_PREFERENCES_SCHEMA;
	workflows: Record<string, Omit<WorkflowPreference, "workflow">>;
}

const WORKFLOW_NAME_PATTERN = /^(?=.*\S)[^\u0000-\u001f\u007f]{1,200}$/;
const MAX_WORKFLOWS = 512;

export function workflowPreferencesPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(
		agentWorkflowHome(env),
		"workflow-preferences",
		"v1",
		"preferences.json",
	);
}

function assertWorkflowName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !WORKFLOW_NAME_PATTERN.test(name))
		throw new HostUsageError(
			`invalid workflow name ${JSON.stringify(name)} for a saved preference`,
		);
}

function parseEntry(
	value: unknown,
	where: string,
): Omit<WorkflowPreference, "workflow"> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${where} must be an object`);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record))
		if (!["profile", "roles", "updatedAt"].includes(key))
			throw new Error(`${where}: unknown field "${key}"`);
	if (record.profile !== undefined) assertUserProfileName(record.profile);
	const roles =
		record.roles === undefined
			? undefined
			: parseWorkflowRoleMap(record.roles, `${where}.roles`);
	return {
		...(record.profile === undefined
			? {}
			: { profile: record.profile as string }),
		...(roles && Object.keys(roles).length > 0 ? { roles } : {}),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
	};
}

/** Read the store; a missing file is empty, a malformed one is an error (never rewritten silently). */
export async function readWorkflowPreferences(
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowPreferencesFile> {
	const path = workflowPreferencesPath(env);
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { schema: WORKFLOW_PREFERENCES_SCHEMA, workflows: {} };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readPrivateFileText(path));
	} catch (error) {
		throw new Error(
			`saved workflow preferences at ${path} are unreadable (${error instanceof Error ? error.message : String(error)}); fix or remove the file`,
		);
	}
	const record = parsed as Partial<WorkflowPreferencesFile> | null;
	if (
		!record ||
		typeof record !== "object" ||
		record.schema !== WORKFLOW_PREFERENCES_SCHEMA ||
		!record.workflows ||
		typeof record.workflows !== "object" ||
		Array.isArray(record.workflows)
	)
		throw new Error(
			`saved workflow preferences at ${path} have an unknown format; fix or remove the file`,
		);
	const workflows: WorkflowPreferencesFile["workflows"] = {};
	for (const [name, value] of Object.entries(record.workflows)) {
		try {
			assertWorkflowName(name);
			workflows[name] = parseEntry(value, `workflow "${name}"`);
		} catch (error) {
			throw new Error(
				`saved workflow preferences at ${path} are invalid: ${error instanceof Error ? error.message : String(error)}; fix or remove the file`,
			);
		}
	}
	return { schema: WORKFLOW_PREFERENCES_SCHEMA, workflows };
}

export function workflowPreferenceFrom(
	file: WorkflowPreferencesFile,
	workflow: string,
): WorkflowPreference | undefined {
	if (!Object.hasOwn(file.workflows, workflow)) return undefined;
	return { workflow, ...file.workflows[workflow]! };
}

async function writeWorkflowPreferences(
	file: WorkflowPreferencesFile,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const path = workflowPreferencesPath(env);
	await ensurePrivateDirectory(dirname(path));
	await writePrivateFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
}

export interface SetWorkflowPreferenceInput {
	workflow: string;
	profile?: string;
	roles?: unknown;
	/** `profile`, `roles` or `roles.<role>`. */
	unset?: readonly string[];
}

/** Create or update a preference (roles merge role by role). */
export async function setWorkflowPreference(
	input: SetWorkflowPreferenceInput,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ preference: WorkflowPreference; created: boolean }> {
	assertWorkflowName(input.workflow);
	if (input.profile !== undefined) assertUserProfileName(input.profile);
	let roles: WorkflowRoleMap | undefined;
	try {
		roles =
			input.roles === undefined
				? undefined
				: parseWorkflowRoleMap(input.roles, "roles");
	} catch (error) {
		throw new HostUsageError(
			error instanceof Error ? error.message : String(error),
		);
	}
	if (roles) assertKnownProfileExecutors({ roles }, "workflow preference");
	for (const field of input.unset ?? [])
		if (field !== "profile" && field !== "roles" && !field.startsWith("roles."))
			throw new HostUsageError(
				`workflow preference: cannot unset "${field}" (known: profile, roles, roles.<role>)`,
			);
	// WP42 (review round 1, finding 3): the whole read–modify–write under the store lock.
	return withStoreLock(workflowPreferencesPath(env), async () => {
		const file = await readWorkflowPreferences(env);
		const created = !Object.hasOwn(file.workflows, input.workflow);
		if (created && Object.keys(file.workflows).length >= MAX_WORKFLOWS)
			throw new HostUsageError(
				`at most ${MAX_WORKFLOWS} saved workflow preferences`,
			);
		const previous = file.workflows[input.workflow];
		const unset = new Set(input.unset ?? []);
		const mergedRoles: WorkflowRoleMap = {
			...(unset.has("roles") ? {} : (previous?.roles ?? {})),
			...(roles ?? {}),
		};
		for (const field of unset)
			if (field.startsWith("roles."))
				delete mergedRoles[field.slice("roles.".length)];
		const profile =
			input.profile ?? (unset.has("profile") ? undefined : previous?.profile);
		const entry = {
			...(profile === undefined ? {} : { profile }),
			...(Object.keys(mergedRoles).length > 0 ? { roles: mergedRoles } : {}),
			updatedAt: new Date().toISOString(),
		};
		if (entry.profile === undefined && entry.roles === undefined)
			throw new HostUsageError(
				`a workflow preference needs a profile or at least one role (to remove it use: profile workflow clear ${input.workflow})`,
			);
		file.workflows[input.workflow] = entry;
		await writeWorkflowPreferences(file, env);
		return { preference: { workflow: input.workflow, ...entry }, created };
	});
}

export async function clearWorkflowPreference(
	workflow: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	assertWorkflowName(workflow);
	return withStoreLock(workflowPreferencesPath(env), async () => {
		const file = await readWorkflowPreferences(env);
		if (!Object.hasOwn(file.workflows, workflow)) return false;
		delete file.workflows[workflow];
		await writeWorkflowPreferences(file, env);
		return true;
	});
}

export function formatWorkflowPreference(
	preference: WorkflowPreference,
): string {
	return [
		preference.workflow,
		...(preference.profile ? [`  profile: ${preference.profile}`] : []),
		...(preference.roles
			? [
					"  roles:",
					...formatRoleMapLines(preference.roles).map((line) => `    ${line}`),
				]
			: []),
	].join("\n");
}
