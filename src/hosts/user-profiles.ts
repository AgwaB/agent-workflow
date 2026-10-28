// New in agent-workflow (WP11a): saved user profiles for every host. A saved user profile is a named,
// workflow-independent set of launch preferences (executor, model, effort, permissionMode,
// strictCapabilities) kept in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json`. It is the
// "saved user profile" tier of the B2 precedence (run flag > workflow-declared profile > saved user
// profile > default). pi-workflow's per-workflow Pi TUI preferences (workflow-profile-settings.ts)
// are a different store and stay with the Pi host (WP11b).
// WP31: a profile can map roles to `{executor?, model?, effort?}` (`roles`, role-profiles.ts) and can
// be created from a built-in preset (`--preset`, executor-presets.ts). An unknown executor id (flat or
// in a role) is refused when the profile is saved; role models are checked against the executor's
// probe when a run starts.
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { strictCapabilityKeysProblem } from "../core/artifact-graph-schema.js";
import { agentWorkflowHome } from "../core/home-dir.js";
import {
	ensurePrivateDirectory,
	readPrivateFileText,
	writePrivateFileAtomic,
} from "../core/secure-atomic-write.js";
import { executorPreset } from "../core/executor-presets.js";
import { workflowExecutorRegistration } from "../core/executor-registry.js";
import {
	formatRoleAssignment,
	parseWorkflowRoleMap,
	sortedRoleKeys,
} from "../core/role-profiles.js";
import {
	THINKING_LEVELS,
	type ThinkingLevel,
	type WorkflowRoleMap,
} from "../core/types.js";
import { HostUsageError } from "./args.js";
import { withStoreLock } from "./store-lock.js";

export const USER_PROFILES_SCHEMA = "agent-workflow-user-profiles-v1" as const;

/** Fields a saved user profile can set. Every field is optional. */
export interface UserProfileValues {
	executor?: string;
	model?: string;
	effort?: ThinkingLevel;
	permissionMode?: "free" | "safe";
	strictCapabilities?: string[];
	/** WP31: role → executor/model/effort (keys: a profileRole, `agent:<name>`, `default`). */
	roles?: WorkflowRoleMap;
}

export interface UserProfile extends UserProfileValues {
	name: string;
	updatedAt: string;
}

export interface UserProfilesFile {
	schema: typeof USER_PROFILES_SCHEMA;
	/** Profile applied when a launch names no profile. */
	default?: string;
	profiles: Record<string, Omit<UserProfile, "name">>;
}

export const USER_PROFILE_FIELDS = [
	"executor",
	"model",
	"effort",
	"permissionMode",
	"strictCapabilities",
	"roles",
] as const;
export type UserProfileField = (typeof USER_PROFILE_FIELDS)[number];

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_PROFILES = 256;

export function userProfilesPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentWorkflowHome(env), "user-profiles", "v1", "profiles.json");
}

export function assertUserProfileName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !PROFILE_NAME_PATTERN.test(name))
		throw new HostUsageError(
			`invalid profile name ${JSON.stringify(name)}: use 1-64 characters [A-Za-z0-9._-], starting with a letter or digit`,
		);
}

/** Validate (and normalize) profile values from any host. Throws HostUsageError. */
export function validateUserProfileValues(
	values: Record<string, unknown>,
	where = "profile",
): UserProfileValues {
	const out: UserProfileValues = {};
	for (const key of Object.keys(values))
		if (!(USER_PROFILE_FIELDS as readonly string[]).includes(key))
			throw new HostUsageError(
				`${where}: unknown field "${key}" (known: ${USER_PROFILE_FIELDS.join(", ")})`,
			);
	const { executor, model, effort, permissionMode, strictCapabilities, roles } =
		values;
	if (executor !== undefined) {
		if (typeof executor !== "string" || !EXECUTOR_ID_PATTERN.test(executor))
			throw new HostUsageError(
				`${where}: executor must be an executor id such as pi, codex or claude`,
			);
		out.executor = executor;
	}
	if (model !== undefined) {
		if (typeof model !== "string" || !model.trim() || /\s/.test(model))
			throw new HostUsageError(
				`${where}: model must be a non-empty id without spaces`,
			);
		out.model = model;
	}
	if (effort !== undefined) {
		if (
			typeof effort !== "string" ||
			!(THINKING_LEVELS as readonly string[]).includes(effort)
		)
			throw new HostUsageError(
				`${where}: effort must be one of ${THINKING_LEVELS.join(", ")}`,
			);
		out.effort = effort as ThinkingLevel;
	}
	if (permissionMode !== undefined) {
		if (permissionMode !== "free" && permissionMode !== "safe")
			throw new HostUsageError(
				`${where}: permissionMode must be "free" or "safe"`,
			);
		out.permissionMode = permissionMode;
	}
	if (strictCapabilities !== undefined) {
		const problem = strictCapabilityKeysProblem(strictCapabilities);
		if (problem !== undefined)
			throw new HostUsageError(`${where}: strictCapabilities ${problem}`);
		out.strictCapabilities = [...new Set(strictCapabilities as string[])];
	}
	if (roles !== undefined) {
		try {
			out.roles = parseWorkflowRoleMap(roles, `${where}: roles`);
		} catch (error) {
			throw new HostUsageError(
				error instanceof Error ? error.message : String(error),
			);
		}
		if (Object.keys(out.roles).length === 0) delete out.roles;
	}
	return out;
}

/**
 * WP31: refuse executor ids no adapter serves (flat and per role), naming where they came from.
 * Model ids are checked against the executor's probe when a run starts (probing here would run
 * the CLI on every save).
 */
export function assertKnownProfileExecutors(
	values: UserProfileValues,
	where = "profile",
): void {
	const check = (id: string | undefined, field: string) => {
		if (id === undefined) return;
		const registration = workflowExecutorRegistration(id);
		if (registration?.descriptor === undefined)
			throw new HostUsageError(
				`${where}: ${field} "${id}" is ${registration === undefined ? "an unknown executor" : `unavailable (${registration.unavailableReason ?? "no adapter"})`}; known executors include pi, codex and claude`,
			);
	};
	check(values.executor, "executor");
	for (const [role, assignment] of Object.entries(values.roles ?? {}))
		check(assignment.executor, `roles.${role}.executor`);
}

function emptyFile(): UserProfilesFile {
	return { schema: USER_PROFILES_SCHEMA, profiles: {} };
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Read the store; a missing file is an empty store, a malformed one is an error (never rewritten silently). */
export async function readUserProfiles(
	env: NodeJS.ProcessEnv = process.env,
): Promise<UserProfilesFile> {
	const path = userProfilesPath(env);
	if (!(await exists(path))) return emptyFile();
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readPrivateFileText(path));
	} catch (error) {
		throw new Error(
			`saved user profiles at ${path} are unreadable (${error instanceof Error ? error.message : String(error)}); fix or remove the file`,
		);
	}
	const record = parsed as Partial<UserProfilesFile> | null;
	if (
		!record ||
		typeof record !== "object" ||
		record.schema !== USER_PROFILES_SCHEMA ||
		!record.profiles ||
		typeof record.profiles !== "object" ||
		Array.isArray(record.profiles)
	)
		throw new Error(
			`saved user profiles at ${path} have an unknown format; fix or remove the file`,
		);
	const profiles: UserProfilesFile["profiles"] = {};
	for (const [name, value] of Object.entries(record.profiles)) {
		assertUserProfileName(name);
		const { updatedAt, ...rest } = (value ?? {}) as Record<string, unknown>;
		profiles[name] = {
			...validateUserProfileValues(rest, `saved profile "${name}"`),
			updatedAt: typeof updatedAt === "string" ? updatedAt : "",
		};
	}
	const defaultName =
		typeof record.default === "string" && record.default in profiles
			? record.default
			: undefined;
	return {
		schema: USER_PROFILES_SCHEMA,
		...(defaultName === undefined ? {} : { default: defaultName }),
		profiles,
	};
}

async function writeUserProfiles(
	file: UserProfilesFile,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const path = userProfilesPath(env);
	await ensurePrivateDirectory(dirname(path));
	await writePrivateFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function userProfileFromFile(
	file: UserProfilesFile,
	name: string,
): UserProfile | undefined {
	if (!Object.hasOwn(file.profiles, name)) return undefined;
	return { name, ...file.profiles[name]! };
}

export interface SetUserProfileInput {
	name: string;
	values?: Record<string, unknown>;
	/** Fields to remove from the saved profile. */
	unset?: readonly string[];
	/** Make this the default profile. */
	makeDefault?: boolean;
	/**
	 * WP31: start from a built-in preset (executor-presets.ts): its executor and roles replace the
	 * saved ones; `values` (and `values.roles`, role by role) still win over the preset.
	 */
	preset?: string;
}

/** Create or update a profile (merge); returns the saved profile and whether it is the default. */
export async function setUserProfile(
	input: SetUserProfileInput,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: UserProfile; isDefault: boolean; created: boolean }> {
	assertUserProfileName(input.name);
	const explicit = validateUserProfileValues(input.values ?? {});
	let preset: ReturnType<typeof executorPreset> | undefined;
	if (input.preset !== undefined) {
		try {
			preset = executorPreset(input.preset);
		} catch (error) {
			throw new HostUsageError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	const values: UserProfileValues = preset
		? {
				...explicit,
				executor: explicit.executor ?? preset.executor,
				roles: { ...preset.roles, ...(explicit.roles ?? {}) },
			}
		: explicit;
	assertKnownProfileExecutors(values);
	const unsetRoles = (input.unset ?? [])
		.filter((field) => field.startsWith("roles."))
		.map((field) => field.slice("roles.".length));
	for (const field of input.unset ?? [])
		if (field.startsWith("roles.")) continue;
		else if (!(USER_PROFILE_FIELDS as readonly string[]).includes(field))
			throw new HostUsageError(
				`profile: cannot unset unknown field "${field}" (known: ${USER_PROFILE_FIELDS.join(", ")})`,
			);
	// WP42 (review round 1, finding 3): the whole read–modify–write under the store lock.
	return withStoreLock(userProfilesPath(env), async () => {
		const file = await readUserProfiles(env);
		const created = !Object.hasOwn(file.profiles, input.name);
		if (created && Object.keys(file.profiles).length >= MAX_PROFILES)
			throw new HostUsageError(`at most ${MAX_PROFILES} saved profiles`);
		const previous: Record<string, unknown> = {
			...(file.profiles[input.name] ?? {}),
		};
		delete previous.updatedAt;
		if (preset) {
			// A preset replaces the saved executor and roles (it is a fresh role table).
			delete previous.executor;
			delete previous.roles;
		}
		for (const field of input.unset ?? []) delete previous[field];
		const kept = validateUserProfileValues(previous);
		// WP31: role entries merge role by role; `--unset roles.<role>` removes one.
		const roles = {
			...(kept.roles ?? {}),
			...(values.roles ?? {}),
		};
		for (const role of unsetRoles) delete roles[role];
		const merged = {
			...kept,
			...values,
			...(Object.keys(roles).length > 0 ? { roles } : {}),
			updatedAt: new Date().toISOString(),
		};
		if (Object.keys(roles).length === 0) delete merged.roles;
		file.profiles[input.name] = merged;
		if (input.makeDefault) file.default = input.name;
		await writeUserProfiles(file, env);
		return {
			profile: { name: input.name, ...merged },
			isDefault: file.default === input.name,
			created,
		};
	});
}

export async function deleteUserProfile(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ deleted: boolean; wasDefault: boolean }> {
	assertUserProfileName(name);
	return withStoreLock(userProfilesPath(env), async () => {
		const file = await readUserProfiles(env);
		if (!Object.hasOwn(file.profiles, name))
			return { deleted: false, wasDefault: false };
		delete file.profiles[name];
		const wasDefault = file.default === name;
		if (wasDefault) delete file.default;
		await writeUserProfiles(file, env);
		return { deleted: true, wasDefault };
	});
}

/** Set (or with `undefined`, clear) the default profile. */
export async function setDefaultUserProfile(
	name: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (name !== undefined) assertUserProfileName(name);
	await withStoreLock(userProfilesPath(env), async () => {
		const file = await readUserProfiles(env);
		if (name !== undefined) {
			if (!Object.hasOwn(file.profiles, name))
				throw new HostUsageError(`no saved profile named "${name}"`);
			file.default = name;
		} else delete file.default;
		await writeUserProfiles(file, env);
	});
}

export function formatUserProfile(
	profile: UserProfile,
	isDefault: boolean,
): string {
	const fields = USER_PROFILE_FIELDS.filter(
		(field) => profile[field] !== undefined,
	).flatMap((field) => {
		const value = profile[field];
		if (field === "roles")
			return [
				"  roles:",
				...formatRoleMapLines(profile.roles ?? {}).map((line) => `    ${line}`),
			];
		return [
			`  ${field}: ${Array.isArray(value) ? value.join(",") : String(value)}`,
		];
	});
	return [
		`${profile.name}${isDefault ? " (default)" : ""}`,
		...(fields.length > 0 ? fields : ["  (no fields set)"]),
	].join("\n");
}

/** WP31: `role  executor:model:effort` lines (default first, then the profile roles, then agents). */
export function formatRoleMapLines(roles: WorkflowRoleMap): string[] {
	const keys = sortedRoleKeys(roles);
	const width = Math.max(0, ...keys.map((key) => key.length));
	return keys.map(
		(key) => `${key.padEnd(width)}  ${formatRoleAssignment(roles[key]!)}`,
	);
}
