// New in agent-workflow (WP31): applies role-level profiles (role-profiles.ts) to one new run.
// Builds the precedence layers (saved per-workflow preference > workflow-declared profile > saved
// user profile), resolves every model-backed stage slot to an executor/model/effort, overlays the
// model/effort entries on the spec like a saved profile's stage overrides, and — when more than one
// executor runs stages (owner decision Q4) — marks every stage with its executor so the compiler
// records `runtime.executor` on its tasks. The result is frozen as `run.roleExecution`. Runs without
// any role map take none of these paths (single-executor behavior unchanged).
import {
	applyExecutionProfileStageOverrides,
	collectWorkflowRoleSlots,
	EXECUTION_PROFILE_EXECUTOR,
	type ExecutionProfileStageOverlay,
} from "./execution-profile.js";
import {
	resolveRunExecutorSelection,
	workflowDeclaredProfileExecutor,
} from "./executor-registry.js";
import {
	layerFlatExecutor,
	resolveStageRoleAssignments,
	type WorkflowRoleLayer,
} from "./role-profiles.js";
import type {
	ArtifactGraphWorkflowSpec,
	ExecutionProfileStageOverride,
	WorkflowRoleMap,
	WorkflowRunExecutorSelection,
	WorkflowRunExecutorSource,
	WorkflowRunRoleExecution,
} from "./types.js";

/** Saved profile fields the role layers read (a captured or layered saved user profile). */
export interface RoleLayerProfile {
	name: string;
	executor?: string;
	roles?: WorkflowRoleMap;
}

export interface RoleLayersInput {
	spec: unknown;
	/** Selected workflow-declared profile. */
	executionProfile?: string;
	/** Saved user profile used alone (captured) or layered under the declared profile. */
	userProfile?: RoleLayerProfile;
	/** WP31: saved per-workflow preference (role overrides). */
	workflowPreference?: { name: string; roles?: WorkflowRoleMap };
}

/** Precedence layers, highest first. */
export function workflowRoleLayers(
	input: RoleLayersInput,
): WorkflowRoleLayer[] {
	const layers: WorkflowRoleLayer[] = [];
	if (input.workflowPreference?.roles)
		layers.push({
			tier: "workflow-preference",
			name: input.workflowPreference.name,
			roles: input.workflowPreference.roles,
		});
	if (input.executionProfile !== undefined) {
		const spec = input.spec as {
			executionProfiles?: Record<
				string,
				Record<string, ExecutionProfileStageOverride>
			>;
			executionProfileRoles?: Record<string, WorkflowRoleMap>;
		};
		const executor = workflowDeclaredProfileExecutor(
			input.spec,
			input.executionProfile,
		);
		const roles = spec.executionProfileRoles?.[input.executionProfile];
		layers.push({
			tier: "workflow-profile",
			name: input.executionProfile,
			...(executor === undefined ? {} : { executor }),
			...(roles === undefined ? {} : { roles }),
			stageOverrides: spec.executionProfiles?.[input.executionProfile] ?? {},
		});
	}
	if (input.userProfile)
		layers.push({
			tier: "user-profile",
			name: input.userProfile.name,
			...(input.userProfile.executor === undefined
				? {}
				: { executor: input.userProfile.executor }),
			...(input.userProfile.roles === undefined
				? {}
				: { roles: input.userProfile.roles }),
		});
	return layers;
}

/** True when any layer maps roles (only then does a run get a role plan). */
export function roleLayersActive(
	layers: readonly WorkflowRoleLayer[],
): boolean {
	return layers.some(
		(layer) => layer.roles !== undefined && Object.keys(layer.roles).length > 0,
	);
}

/** The layer's flat executor for the B2 run-executor chain (role `default` counts). */
export function roleLayerExecutor(
	layers: readonly WorkflowRoleLayer[],
	tier: WorkflowRoleLayer["tier"],
): { name: string; executor: string } | undefined {
	const layer = layers.find((candidate) => candidate.tier === tier);
	const executor = layer === undefined ? undefined : layerFlatExecutor(layer);
	return layer === undefined || executor === undefined
		? undefined
		: { name: layer.name, executor };
}

export interface PlannedRoleExecution<Spec> {
	spec: Spec;
	/** The run's executor (moved to a used executor when no stage uses the B2 default). */
	executor: WorkflowRunExecutorSelection;
	roleExecution: WorkflowRunRoleExecution;
	/** Descriptors of the other executors (mixed runs), for negotiation. */
	otherExecutors: WorkflowRunExecutorSelection[];
	modelChecks: Array<{ slot: string; executor: string; model: string }>;
}

function selectionFor(
	id: string,
	source: string,
	profile: string | undefined,
): WorkflowRunExecutorSelection {
	// Unknown/unavailable ids fail here, naming the tier that chose them (never a fallback).
	if (source === "run-flag")
		return resolveRunExecutorSelection({ runFlag: id });
	if (source === "workflow-preference")
		return resolveRunExecutorSelection({
			workflowPreferenceExecutor: id,
			...(profile === undefined ? {} : { workflowPreferenceName: profile }),
		});
	if (source === "workflow-profile")
		return resolveRunExecutorSelection({
			workflowProfileExecutor: id,
			...(profile === undefined ? {} : { workflowProfileName: profile }),
		});
	if (source === "user-profile")
		return resolveRunExecutorSelection({
			userProfileExecutor: id,
			...(profile === undefined ? {} : { userProfileName: profile }),
		});
	return resolveRunExecutorSelection({
		defaultExecutor: id,
		defaultSource: (["host-default", "installed-default"].includes(source)
			? source
			: "default") as Extract<
			WorkflowRunExecutorSource,
			"default" | "host-default" | "installed-default"
		>,
	});
}

/** Resolve and apply the role layers to a run's spec (see the file header). */
export function planRoleExecution<
	Spec extends ArtifactGraphWorkflowSpec,
>(input: {
	spec: Spec;
	layers: readonly WorkflowRoleLayer[];
	executor: WorkflowRunExecutorSelection;
	runFlagExecutor?: string;
	/** `--model`: role models are then not checked (the flag wins). */
	runFlagModel?: string;
}): PlannedRoleExecution<Spec> {
	let executor = input.executor;
	const slots = collectWorkflowRoleSlots(input.spec);
	const resolve = (primary: WorkflowRunExecutorSelection) =>
		resolveStageRoleAssignments({
			slots,
			...(input.runFlagExecutor
				? { runFlagExecutor: input.runFlagExecutor }
				: {}),
			primary: {
				id: primary.id,
				source: primary.source,
				...(primary.profile === undefined ? {} : { profile: primary.profile }),
			},
			layers: input.layers,
		});
	let resolved = resolve(executor);
	const used = [...new Set(Object.values(resolved.executorBySlot))];
	if (used.length > 0 && !used.includes(executor.id)) {
		// No stage runs on the B2 default: the run's executor becomes the first stage's executor,
		// so only executors that run stages are probed and recorded.
		const first = slots.find((slot) => slot.kind === "stage");
		const assignment = first ? resolved.stages[first.id] : undefined;
		if (assignment)
			executor = selectionFor(
				assignment.executor,
				assignment.source,
				assignment.profile,
			);
		resolved = resolve(executor);
	}
	const executors: Record<string, WorkflowRunExecutorSelection> = {
		[executor.id]: executor,
	};
	for (const slot of slots) {
		const assignment = resolved.stages[slot.id];
		if (!assignment || Object.hasOwn(executors, assignment.executor)) continue;
		executors[assignment.executor] = selectionFor(
			assignment.executor,
			assignment.source,
			assignment.profile,
		);
	}
	const overlay: Record<string, ExecutionProfileStageOverlay> = {};
	for (const [slot, override] of Object.entries(resolved.overrides))
		overlay[slot] = { ...override };
	if (resolved.mixed)
		for (const [slot, id] of Object.entries(resolved.executorBySlot))
			overlay[slot] = {
				...(overlay[slot] ?? {}),
				[EXECUTION_PROFILE_EXECUTOR]: id,
			};
	const spec =
		Object.keys(overlay).length === 0
			? input.spec
			: applyExecutionProfileStageOverrides(input.spec, overlay, {
					foreachRuntimeTarget: "each",
				});
	const modelChecks = input.runFlagModel
		? []
		: Object.entries(resolved.stages).flatMap(([slot, assignment]) =>
				assignment.model === undefined
					? []
					: [{ slot, executor: assignment.executor, model: assignment.model }],
			);
	return {
		spec,
		executor,
		roleExecution: {
			schema: "agent-workflow-role-execution-v1",
			mixed: resolved.mixed,
			executors,
			stages: resolved.stages,
			layers: input.layers.map((layer) => ({
				tier: layer.tier,
				name: layer.name,
			})),
			...(resolved.warnings.length === 0
				? {}
				: { warnings: resolved.warnings }),
		},
		otherExecutors: Object.values(executors).filter(
			(selection) => selection.id !== executor.id,
		),
		modelChecks,
	};
}
