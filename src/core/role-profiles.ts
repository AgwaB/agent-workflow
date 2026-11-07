// New in agent-workflow (WP31): role-level execution profiles (owner decisions B2, E4, Q4).
// A profile maps roles to `{executor?, model?, effort?}`. A role is how a model-backed stage is
// addressed without naming stage ids, so one profile fits every workflow:
//   - `agent:<name>`  the stage's agent (`each.agent` for foreach, else `agent`, else the spec default);
//   - a `profileRole` (planning, research-execution, synthesis, verification, final-judgment), the
//     semantic role a stage declares;
//   - `default`       every stage no other key matches.
// For one stage the most specific key wins inside one layer (agent > profileRole > default). Layers
// keep the B2 precedence field by field (WP37), extended to roles: run flag > saved per-workflow
// preference > workflow-declared profile > saved user profile > default. A layer that has any value
// for a field of a stage wins that field; a flat profile `executor` is the layer's value for every
// stage it has no role entry for. A role entry's model/effort apply only when the stage runs on the
// entry's executor (or the entry names none): a model id belongs to its executor.
import {
	EFFORT_LEVELS,
	WORKFLOW_PROFILE_ROLES,
	type EffortLevel,
	type WorkflowProfileRole,
	type WorkflowRoleAssignment,
	type WorkflowRoleMap,
	type WorkflowStageExecutorSource,
	type WorkflowStageRoleAssignment,
} from "./types.js";

export type { WorkflowRoleAssignment, WorkflowRoleMap };

export const ROLE_DEFAULT_KEY = "default";
export const AGENT_ROLE_PREFIX = "agent:";
const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ROLE_ENTRIES = 64;
const ASSIGNMENT_FIELDS = ["executor", "model", "effort"] as const;

/** Problem with a role key, or undefined when valid. */
export function roleKeyProblem(key: string): string | undefined {
	if (key === ROLE_DEFAULT_KEY) return undefined;
	if ((WORKFLOW_PROFILE_ROLES as readonly string[]).includes(key))
		return undefined;
	if (key.startsWith(AGENT_ROLE_PREFIX)) {
		const name = key.slice(AGENT_ROLE_PREFIX.length);
		return AGENT_NAME_PATTERN.test(name)
			? undefined
			: `role key ${JSON.stringify(key)} names an invalid agent`;
	}
	return `unknown role ${JSON.stringify(key)}; use ${ROLE_DEFAULT_KEY}, ${WORKFLOW_PROFILE_ROLES.join(", ")} or agent:<name>`;
}

/** Validate one assignment (throws Error naming `where`). */
export function parseRoleAssignment(
	value: unknown,
	where: string,
): WorkflowRoleAssignment {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${where} must be an object with executor, model, effort`);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record))
		if (!(ASSIGNMENT_FIELDS as readonly string[]).includes(key))
			throw new Error(
				`${where}: unknown field "${key}" (known: ${ASSIGNMENT_FIELDS.join(", ")})`,
			);
	const out: WorkflowRoleAssignment = {};
	const { executor, model, effort } = record;
	if (executor !== undefined) {
		if (typeof executor !== "string" || !EXECUTOR_ID_PATTERN.test(executor))
			throw new Error(
				`${where}: executor must be an executor id such as pi, codex or claude`,
			);
		out.executor = executor;
	}
	if (model !== undefined) {
		if (typeof model !== "string" || !model.trim() || /\s/.test(model))
			throw new Error(`${where}: model must be a non-empty id without spaces`);
		out.model = model;
	}
	if (effort !== undefined) {
		if (
			typeof effort !== "string" ||
			!(EFFORT_LEVELS as readonly string[]).includes(effort)
		)
			throw new Error(
				`${where}: effort must be one of ${EFFORT_LEVELS.join(", ")}`,
			);
		out.effort = effort as EffortLevel;
	}
	if (Object.keys(out).length === 0)
		throw new Error(`${where} sets none of executor, model, effort`);
	return out;
}

/** Validate a role map (throws Error naming `where`). Returns a normalized copy. */
export function parseWorkflowRoleMap(
	value: unknown,
	where: string,
): WorkflowRoleMap {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${where} must be an object of role → assignment`);
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_ROLE_ENTRIES)
		throw new Error(`${where} has more than ${MAX_ROLE_ENTRIES} roles`);
	const out: WorkflowRoleMap = {};
	for (const [key, assignment] of entries) {
		const problem = roleKeyProblem(key);
		if (problem !== undefined) throw new Error(`${where}: ${problem}`);
		out[key] = parseRoleAssignment(assignment, `${where}.${key}`);
	}
	return out;
}

/**
 * `<role>=<executor>[:<model>[:<effort>]]` (CLI `--role`). Empty segments are unset:
 * `verification=claude:haiku`, `synthesis=:sonnet` (model only), `default=codex::high`.
 */
export function parseRoleAssignmentText(
	text: string,
	where = "--role",
): [string, WorkflowRoleAssignment] {
	const equals = text.indexOf("=");
	if (equals <= 0)
		throw new Error(
			`${where} ${JSON.stringify(text)} must be <role>=<executor>[:<model>[:<effort>]]`,
		);
	const key = text.slice(0, equals).trim();
	const problem = roleKeyProblem(key);
	if (problem !== undefined) throw new Error(`${where}: ${problem}`);
	const parts = text.slice(equals + 1).split(":");
	if (parts.length > 3)
		throw new Error(
			`${where} ${JSON.stringify(text)} has more than executor:model:effort`,
		);
	const [executor, model, effort] = parts.map((part) => part.trim());
	return [
		key,
		parseRoleAssignment(
			{
				...(executor ? { executor } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
			},
			`${where} ${key}`,
		),
	];
}

/** `executor:model:effort` with `-` for unset fields (display). */
export function formatRoleAssignment(
	assignment: WorkflowRoleAssignment,
): string {
	return `${assignment.executor ?? "-"}:${assignment.model ?? "-"}:${assignment.effort ?? "-"}`;
}

/** Role keys in display order: default, the profileRoles, then agent keys. */
export function sortedRoleKeys(map: WorkflowRoleMap): string[] {
	const rank = (key: string): number =>
		key === ROLE_DEFAULT_KEY
			? -1
			: (WORKFLOW_PROFILE_ROLES as readonly string[]).includes(key)
				? (WORKFLOW_PROFILE_ROLES as readonly string[]).indexOf(key)
				: WORKFLOW_PROFILE_ROLES.length;
	return Object.keys(map).sort(
		(left, right) => rank(left) - rank(right) || left.localeCompare(right),
	);
}

/** Overlay `over` on `base` role by role (an entry of `over` replaces the whole base entry). */
export function mergeRoleMaps(
	base: WorkflowRoleMap | undefined,
	over: WorkflowRoleMap | undefined,
): WorkflowRoleMap {
	return { ...(base ?? {}), ...(over ?? {}) };
}

/** One model-backed stage slot as roles address it. */
export interface WorkflowRoleSlot {
	/** Canonical execution-profile slot id (`stage`, `dag.child`, `dyn.$planner`, …). */
	id: string;
	profileRole?: WorkflowProfileRole;
	agent?: string;
	kind: "stage" | "dynamic-profile";
	/** Dynamic decision-loop slots: the dynamic stage's slot id (they follow its executor). */
	parentId?: string;
}

/** Keys that address a slot, most specific first. */
export function roleKeysForSlot(slot: WorkflowRoleSlot): string[] {
	return [
		...(slot.agent ? [`${AGENT_ROLE_PREFIX}${slot.agent}`] : []),
		...(slot.profileRole ? [slot.profileRole] : []),
		ROLE_DEFAULT_KEY,
	];
}

export type WorkflowRoleLayerTier =
	| "workflow-preference"
	| "workflow-profile"
	| "user-profile";

/** One precedence layer (highest first in `resolveStageRoleAssignments`). */
export interface WorkflowRoleLayer {
	tier: WorkflowRoleLayerTier;
	name: string;
	/** Flat executor of the layer (every stage without a role entry). */
	executor?: string;
	roles?: WorkflowRoleMap;
	/** Declared profile only: its stage overrides win over its own and lower role entries. */
	stageOverrides?: Record<string, { model?: string; effort?: EffortLevel }>;
}

/** The layer's executor for every stage it has no role entry for (flat, else `default`). */
export function layerFlatExecutor(
	layer: WorkflowRoleLayer,
): string | undefined {
	return layer.executor ?? layer.roles?.[ROLE_DEFAULT_KEY]?.executor;
}

export interface ResolveStageRoleAssignmentsInput {
	slots: readonly WorkflowRoleSlot[];
	/** `--executor`: every stage runs on it. */
	runFlagExecutor?: string;
	/** The run's executor (`run.executor`), used where no layer decides. */
	primary: {
		id: string;
		source: WorkflowStageExecutorSource;
		profile?: string;
	};
	layers: readonly WorkflowRoleLayer[];
}

export interface ResolvedStageRoleAssignments {
	stages: Record<string, WorkflowStageRoleAssignment>;
	/** Model/effort overlays per slot id (applied like a saved profile's stage overrides). */
	overrides: Record<string, { model?: string; effort?: EffortLevel }>;
	/** Executor id per stage slot (dynamic-profile slots omitted: they follow their stage). */
	executorBySlot: Record<string, string>;
	executors: string[];
	mixed: boolean;
	warnings: string[];
}

function tierSource(tier: WorkflowRoleLayerTier): WorkflowStageExecutorSource {
	return tier;
}

/** Pure B2 role resolution for every slot (see the file header). */
export function resolveStageRoleAssignments(
	input: ResolveStageRoleAssignmentsInput,
): ResolvedStageRoleAssignments {
	const stages: Record<string, WorkflowStageRoleAssignment> = {};
	const overrides: ResolvedStageRoleAssignments["overrides"] = {};
	const executorBySlot: Record<string, string> = {};
	const warnings: string[] = [];
	const ordered = [
		...input.slots.filter((slot) => slot.kind === "stage"),
		...input.slots.filter((slot) => slot.kind !== "stage"),
	];
	for (const slot of ordered) {
		const keys = roleKeysForSlot(slot);
		let chosen:
			| {
					executor: string;
					source: WorkflowStageExecutorSource;
					profile?: string;
					role?: string;
			  }
			| undefined;
		if (input.runFlagExecutor)
			chosen = { executor: input.runFlagExecutor, source: "run-flag" };
		for (const layer of chosen ? [] : input.layers) {
			const key = keys.find((candidate) => layer.roles?.[candidate]?.executor);
			const executor =
				key === undefined ? layer.executor : layer.roles![key]!.executor;
			if (executor === undefined) continue;
			chosen = {
				executor,
				source: tierSource(layer.tier),
				profile: layer.name,
				...(key === undefined ? {} : { role: key }),
			};
			break;
		}
		chosen ??= {
			executor: input.primary.id,
			source: input.primary.source,
			...(input.primary.profile === undefined
				? {}
				: { profile: input.primary.profile }),
		};
		if (slot.kind === "dynamic-profile" && slot.parentId !== undefined) {
			const parent = executorBySlot[slot.parentId] ?? input.primary.id;
			if (chosen.executor !== parent)
				warnings.push(
					`${slot.id}: a dynamic decision-loop slot runs on its stage's executor ${parent}, not ${chosen.executor}`,
				);
			if (chosen.executor !== parent)
				chosen = { executor: parent, source: "parent-stage" };
		} else executorBySlot[slot.id] = chosen.executor;
		const executor = chosen.executor;
		const field = (
			name: "model" | "effort",
		): { value: string; role: string } | undefined => {
			const overrideKey = name === "model" ? "model" : "effort";
			for (const layer of input.layers) {
				if (layer.stageOverrides?.[slot.id]?.[overrideKey] !== undefined)
					return undefined;
				for (const key of keys) {
					const entry = layer.roles?.[key];
					const value = entry?.[name];
					if (value === undefined) continue;
					if (entry!.executor !== undefined && entry!.executor !== executor)
						continue;
					return { value, role: key };
				}
			}
			return undefined;
		};
		const model = field("model");
		const effort = field("effort");
		stages[slot.id] = {
			executor,
			source: chosen.source,
			...(chosen.profile === undefined ? {} : { profile: chosen.profile }),
			...(chosen.role === undefined ? {} : { role: chosen.role }),
			...(model === undefined ? {} : { model: model.value }),
			...(effort === undefined ? {} : { effort: effort.value as EffortLevel }),
		};
		if (model !== undefined || effort !== undefined)
			overrides[slot.id] = {
				...(model === undefined ? {} : { model: model.value }),
				...(effort === undefined
					? {}
					: { effort: effort.value as EffortLevel }),
			};
	}
	const executors = [
		...new Set([input.primary.id, ...Object.values(executorBySlot)]),
	];
	const used = new Set(Object.values(executorBySlot));
	return {
		stages,
		overrides,
		executorBySlot,
		executors,
		mixed: used.size > 1 || (used.size === 1 && !used.has(input.primary.id)),
		warnings,
	};
}

/**
 * Models an executor's probe lists (no model call): `probe.models` when the adapter reports a list,
 * else a `models: a, b` probe note. `null` when the probe cannot tell.
 */
export function probeModelList(probe: {
	notes?: readonly unknown[];
	models?: unknown;
}): string[] | null {
	if (Array.isArray(probe.models))
		return probe.models.filter(
			(model): model is string => typeof model === "string",
		);
	for (const note of probe.notes ?? []) {
		if (typeof note !== "string" || !note.startsWith("models: ")) continue;
		const rest = note.slice("models: ".length).trim();
		if (rest === "" || rest.startsWith("not listable")) return null;
		return rest
			.split(",")
			.map((model) => model.trim())
			.filter(Boolean);
	}
	return null;
}

/** True when `model` names one of `listed` (exact, or `provider/model` either way). */
export function modelListed(model: string, listed: readonly string[]): boolean {
	return listed.some(
		(entry) =>
			entry === model ||
			entry.endsWith(`/${model}`) ||
			model.endsWith(`/${entry}`),
	);
}
