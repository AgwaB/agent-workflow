import { collectWorkflowRoleSlots } from "./execution-profile.js";
import {
	validateProjectWorkflowSettingsIntent,
	type ProjectWorkflowSettingsCapture,
	type ProjectWorkflowSettingsIntent,
} from "./project-workflow-settings.js";
import type {
	ArtifactGraphWorkflowSpec,
	ArtifactGraphStageSpec,
	EffortLevel,
	WorkflowStageRoleAssignment,
} from "./types.js";
import type { WorkflowRuntimeResolutionInput } from "./workflow-runtime.js";

export interface ConfigurationSource {
	source: string;
	originSlot?: string;
	inheritedFrom?: string;
	originScope?: "workflow-default" | "slot";
	inheritedVia?: string[];
}
export interface RuntimeProvenance {
	model?: ConfigurationSource;
	effort?: ConfigurationSource;
}
export interface WorkflowConfigurationSlot {
	executor: { value?: string; source: string };
	model: {
		value?: string;
		source: string;
		originSlot?: string;
		inheritedFrom?: string;
		originScope?: "workflow-default" | "slot";
		inheritedVia?: string[];
	};
	effort: {
		requested?: EffortLevel;
		resolved?: EffortLevel;
		source: string;
		originSlot?: string;
		inheritedFrom?: string;
		originScope?: "workflow-default" | "slot";
		inheritedVia?: string[];
		reason?: string;
	};
}
export interface WorkflowConfiguration {
	schema: "agent-workflow-configuration-v1";
	capture?: ProjectWorkflowSettingsCapture;
	slots: Record<string, WorkflowConfigurationSlot>;
	shadowed: Array<{
		scope: "workflow-default" | "slot";
		slot: string;
		field: string;
		reason: string;
	}>;
}

/** Detached immutable JSON snapshot. Never reads a store. */
export function freezeProjectSettingsCapture(
	capture: ProjectWorkflowSettingsCapture,
): ProjectWorkflowSettingsCapture {
	const copy = structuredClone(capture);
	copy.intent = validateProjectWorkflowSettingsIntent(copy.intent);
	return freezeConfiguration(copy);
}
export function freezeConfiguration<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeConfiguration(child);
		Object.freeze(value);
	}
	return value;
}

/** Controllers may receive common defaults but are never individually editable. */
export function assertProjectSettingsTargets(
	spec: ArtifactGraphWorkflowSpec,
	intent: ProjectWorkflowSettingsIntent,
): void {
	const slots = collectWorkflowRoleSlots(spec);
	const controllers = new Set<string>();
	const visit = (
		stages: readonly ArtifactGraphStageSpec[],
		namespace?: string,
	): void => {
		for (const stage of stages) {
			const id = namespace ? `${namespace}.${stage.id}` : stage.id;
			if (stage.type === "dynamic") controllers.add(id);
			if (stage.stages) visit(stage.stages, id);
			if (stage.onExhausted)
				visit([{ ...stage.onExhausted, id: "$onExhausted" }], id);
		}
	};
	visit(spec.artifactGraph.stages);
	const editable = new Set(
		slots.filter((slot) => !controllers.has(slot.id)).map((slot) => slot.id),
	);
	for (const id of Object.keys(intent.slots ?? {}))
		if (!editable.has(id))
			throw new Error(`project settings: unknown or non-editable slot ${id}`);
}

/** Snapshot values from the actual compiler/runtime selections, not a UI precedence implementation. */
export function configurationSlot(
	runtime: WorkflowRuntimeResolutionInput,
	executor: string | undefined,
	assignment?: WorkflowStageRoleAssignment,
): WorkflowConfigurationSlot {
	return {
		executor: {
			...(executor === undefined ? {} : { value: executor }),
			source: assignment?.source ?? "unresolved",
		},
		model: {
			...(runtime.model === undefined ? {} : { value: runtime.model }),
			source: runtime.provenance?.model?.source ?? "unresolved",
			...runtime.provenance?.model,
		},
		effort: {
			...((runtime.effortResolution?.requested ?? runtime.effort)
				? { requested: runtime.effortResolution?.requested ?? runtime.effort }
				: {}),
			...(runtime.effort === undefined ? {} : { resolved: runtime.effort }),
			source: runtime.provenance?.effort?.source ?? "unresolved",
			...runtime.provenance?.effort,
			...(runtime.effortResolution?.reason
				? { reason: runtime.effortResolution.reason }
				: {}),
		},
	};
}
