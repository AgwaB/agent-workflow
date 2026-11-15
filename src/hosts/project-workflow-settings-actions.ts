// Trusted project-local actions. HTTP authorizes registered projects/discovered keys before entry.
import {
	collectWorkflowRoleSlots,
	workflowDefinitionFingerprint,
} from "../core/execution-profile.js";
import { loadWorkflowSpec } from "../core/schema.js";
import { resolveProjectWorkflowSettingsTarget } from "../core/workflow-specs.js";
import {
	assertProjectSettingsTargets,
	type WorkflowConfiguration,
} from "../core/project-settings-runtime.js";
import {
	validateProjectWorkflowSettingsIntent,
	validateProjectWorkflowSettingsSlots,
	type ProjectWorkflowSettingsEditableSlot,
	type ProjectWorkflowSettingsIntent,
} from "../core/project-workflow-settings.js";
import type { ArtifactGraphWorkflowSpec } from "../core/types.js";
import { HostUsageError } from "./args.js";
import {
	resolveExecutorModel,
	resolveExecutorEffort,
} from "../core/executor-model-id.js";
import { executorModelsAction } from "./executor-models.js";
import { checkWorkflowConfiguration } from "./launch.js";
import { assertActionAllowed, hostEnv, type HostApiContext } from "./types.js";
import {
	readProjectWorkflowSettings,
	saveProjectWorkflowSettings,
	ProjectWorkflowSettingsConflict,
	type ProjectWorkflowSettingsExpected,
} from "./project-workflow-settings.js";
export {
	listProjectWorkflowSettings,
	readProjectWorkflowSettingsEntry,
	clearProjectWorkflowSettingsEntry,
	clearProjectWorkflowSettings,
	inspectProjectWorkflowSettingsRecovery,
	recoverProjectWorkflowSettings,
} from "./project-workflow-settings.js";

export interface ProjectSettingsAuthoredNode {
	id: string;
	parentId?: string;
	kind: "model" | "template" | "controller" | "group" | "code";
	editable: boolean;
	dependsOn: string[];
}

/** Definition relationships, not runtime expansion or dotted-id inference. */
export function projectSettingsDefinition(
	spec: ArtifactGraphWorkflowSpec,
	configuration?: WorkflowConfiguration,
) {
	const slots = collectWorkflowRoleSlots(spec);
	const authored: ProjectSettingsAuthoredNode[] = [];
	const record = (value: unknown): Record<string, unknown> | undefined =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const visit = (
		stage: Record<string, unknown>,
		id: string,
		parentId?: string,
	) => {
		const kind: ProjectSettingsAuthoredNode["kind"] =
			stage.type === "dynamic"
				? "controller"
				: stage.type === "dag" || stage.type === "loop"
					? "group"
					: stage.support !== undefined
						? "code"
						: stage.type === "foreach"
							? "template"
							: "model";
		const refs = (value: unknown): string[] =>
			typeof value === "string"
				? [value]
				: Array.isArray(value)
					? value.filter((v): v is string => typeof v === "string")
					: typeof record(value)?.stage === "string"
						? [record(value)!.stage as string]
						: [];
		const from = [...new Set([...refs(stage.from), ...refs(stage.after)])];
		authored.push({
			id,
			...(parentId ? { parentId } : {}),
			kind,
			editable:
				(kind === "model" || kind === "template") &&
				slots.some((slot) => slot.id === id),
			dependsOn: from.map((dep) => (parentId ? `${parentId}.${dep}` : dep)),
		});
		if (
			(stage.type === "dag" || stage.type === "loop") &&
			Array.isArray(stage.stages)
		)
			for (const value of stage.stages) {
				const child = record(value);
				if (child && typeof child.id === "string")
					visit(child, `${id}.${child.id}`, id);
			}
		if (stage.type === "loop") {
			const child = record(stage.onExhausted);
			if (child) visit(child, `${id}.$onExhausted`, id);
		}
		if (stage.type === "dynamic")
			for (const slot of slots.filter((slot) => slot.parentId === id))
				authored.push({
					id: slot.id,
					parentId: id,
					kind: "template",
					editable: true,
					dependsOn: [],
				});
	};
	for (const stage of spec.artifactGraph.stages)
		visit(record(stage)!, stage.id);
	const editableSlots: ProjectWorkflowSettingsEditableSlot[] = authored
		.filter((node) => node.editable)
		.map((node) => {
			const slot = slots.find((slot) => slot.id === node.id)!;
			return slot.kind === "dynamic-profile"
				? {
						id: node.id,
						kind: "dynamic-profile",
						...(configuration?.slots[slot.parentId!]?.executor.value
							? {
									parentExecutor:
										configuration.slots[slot.parentId!]!.executor.value,
								}
							: {}),
					}
				: { id: node.id, kind: "model" };
		});
	return { authored, editableSlots };
}

function invalid(error: unknown): never {
	throw new HostUsageError(
		error instanceof Error ? error.message : String(error),
	);
}
async function checkDraft(
	ctx: HostApiContext,
	workflow: string,
	draft: ProjectWorkflowSettingsIntent,
) {
	try {
		const checked = await checkWorkflowConfiguration(ctx, { workflow }, draft);
		if (checked.data.refusal?.code === "WORKFLOW_DEFINITION_CHANGED")
			throw new ProjectWorkflowSettingsConflict(checked.text);
		return checked;
	} catch (error) {
		if (error instanceof ProjectWorkflowSettingsConflict) throw error;
		return invalid(error);
	}
}
/** Compatibility only: consume the actual compiler fields and existing core name validators.
 * Do not let an unrelated capability refusal conceal a known incompatible local binding. */
async function validateSavedConfiguration(
	ctx: HostApiContext,
	configuration: WorkflowConfiguration,
) {
	const local = (source: string) =>
		source === "project-default" || source === "project-slot";
	const affected = Object.entries(configuration.slots).filter(
		([, slot]) =>
			local(slot.executor.source) ||
			local(slot.model.source) ||
			local(slot.effort.source),
	);
	const inventories = (
		await executorModelsAction(ctx, {
			executors: [
				...new Set(
					affected.flatMap(([, slot]) =>
						slot.executor.value ? [slot.executor.value] : [],
					),
				),
			],
		})
	).data.executors;
	for (const [id, slot] of affected) {
		const executor = slot.executor.value;
		if (!executor) continue; // Unknown remains unknown, never an invented default.
		const inventory = inventories.find((entry) => entry.id === executor);
		const known = inventory?.usable === true;
		let model = slot.model.value;
		if (model !== undefined) {
			const resolved = resolveExecutorModel(
				executor,
				model,
				known ? inventory.models : null,
				known && inventory.modelListComplete,
			);
			if ("refused" in resolved)
				throw new HostUsageError(`${id}: ${resolved.refused}`);
			model = resolved.value;
		}
		const effort = slot.effort.resolved ?? slot.effort.requested;
		if (effort !== undefined) {
			const resolved = resolveExecutorEffort(
				executor,
				effort,
				model,
				known && model !== undefined
					? inventory.modelEfforts?.[model]
					: undefined,
			);
			if ("refused" in resolved)
				throw new HostUsageError(`${id}: ${resolved.refused}`);
		}
	}
}
function intent(value: unknown): ProjectWorkflowSettingsIntent {
	try {
		return validateProjectWorkflowSettingsIntent(value);
	} catch (error) {
		return invalid(error);
	}
}
export function projectSettingsExpected(
	value: unknown,
): ProjectWorkflowSettingsExpected {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HostUsageError("expected CAS tokens are required");
	const keys = [
		"storeEpoch",
		"revision",
		"definitionFingerprint",
		"resolutionToken",
	];
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).length !== keys.length ||
		keys.some((key) => typeof data[key] !== "string" || !data[key])
	)
		throw new HostUsageError("invalid expected CAS tokens");
	return {
		storeEpoch: data.storeEpoch as string,
		revision: data.revision as string,
		definitionFingerprint: data.definitionFingerprint as string,
		resolutionToken: data.resolutionToken as string,
	};
}

export async function readProjectWorkflowSettingsAction(
	ctx: HostApiContext,
	workflow: string,
) {
	assertActionAllowed(ctx, "list");
	const target = await resolveProjectWorkflowSettingsTarget(workflow, ctx.cwd);
	const loaded = await loadWorkflowSpec(target.specPath, ctx.cwd);
	if (
		target.definitionFingerprint !== workflowDefinitionFingerprint(loaded.spec)
	)
		throw new ProjectWorkflowSettingsConflict(
			"Workflow definition changed; reload settings.",
		);
	const settings = await readProjectWorkflowSettings(ctx.cwd, target, {
		env: hostEnv(ctx),
	});
	return { settings, ...projectSettingsDefinition(loaded.spec) };
}

function assertExpected(
	actual: ProjectWorkflowSettingsExpected,
	expected: ProjectWorkflowSettingsExpected,
) {
	for (const key of [
		"storeEpoch",
		"revision",
		"definitionFingerprint",
		"resolutionToken",
	] as const)
		if (actual[key] !== expected[key])
			throw new ProjectWorkflowSettingsConflict(
				`Project settings ${key} changed; reload and review the draft.`,
			);
}

export async function previewProjectWorkflowSettingsAction(
	ctx: HostApiContext,
	workflow: string,
	value: unknown,
	expectedValue: unknown,
) {
	assertActionAllowed(ctx, "validate");
	const draft = intent(value);
	const current = await readProjectWorkflowSettingsAction(ctx, workflow);
	assertExpected(current.settings, projectSettingsExpected(expectedValue));
	const baseline = await checkDraft(ctx, workflow, {});
	const check = await checkDraft(ctx, workflow, draft);
	const latest = await readProjectWorkflowSettingsAction(ctx, workflow);
	assertExpected(latest.settings, projectSettingsExpected(expectedValue));
	const loaded = await loadWorkflowSpec(workflow, ctx.cwd);
	// The engine's definition fence protects each compile; also reject edits between the two plans.
	if (
		workflowDefinitionFingerprint(loaded.spec) !==
		current.settings.definitionFingerprint
	)
		throw new ProjectWorkflowSettingsConflict(
			"Workflow definition changed during preview.",
		);
	return {
		...current,
		intent: draft,
		...projectSettingsDefinition(loaded.spec, check.data.configuration),
		baseline,
		check,
	};
}

export async function saveProjectWorkflowSettingsAction(
	ctx: HostApiContext,
	workflow: string,
	value: unknown,
	expectedValue: unknown,
) {
	assertActionAllowed(ctx, "profile");
	if (ctx.readonly) throw new HostUsageError("Project settings are readonly.");
	const draft = intent(value);
	const expected = projectSettingsExpected(expectedValue);
	const target = await resolveProjectWorkflowSettingsTarget(workflow, ctx.cwd);
	return saveProjectWorkflowSettings(ctx.cwd, target, expected, draft, {
		env: hostEnv(ctx),
		resolveTarget: async (frozenDraft) => {
			// Re-resolve the original trusted selection under A's lock, keeping explicit source selection.
			const fresh = await resolveProjectWorkflowSettingsTarget(
				workflow,
				ctx.cwd,
			);
			const loaded = await loadWorkflowSpec(fresh.specPath, ctx.cwd);
			if (
				fresh.definitionFingerprint !==
				workflowDefinitionFingerprint(loaded.spec)
			)
				throw new ProjectWorkflowSettingsConflict(
					"Workflow definition changed during save.",
				);
			try {
				assertProjectSettingsTargets(loaded.spec, frozenDraft);
			} catch (error) {
				return invalid(error);
			}
			// Clearing all local bindings needs no environment acceptance. Even an invalid baseline
			// must remain recoverable; no model/executor values are persisted in this case.
			const hasIntent =
				frozenDraft.defaults !== undefined ||
				Object.keys(frozenDraft.slots ?? {}).length > 0;
			const check = hasIntent
				? await checkDraft(ctx, workflow, frozenDraft)
				: undefined;
			// Capability refusal after compile is not a reason to forbid persistence. Compiler/planner
			// errors still throw; no static profile approximation replaces actual configuration.
			if (
				check &&
				(!check.data.configuration ||
					check.data.refusal?.code === "MODEL_UNKNOWN")
			)
				throw new HostUsageError(check.text);
			if (
				check?.data.configuration?.capture &&
				check.data.configuration.capture.definitionFingerprint !==
					fresh.definitionFingerprint
			)
				throw new ProjectWorkflowSettingsConflict(
					"Workflow definition changed during save validation.",
				);
			if (check?.data.configuration)
				await validateSavedConfiguration(ctx, check.data.configuration);
			const { editableSlots } = projectSettingsDefinition(
				loaded.spec,
				check?.data.configuration,
			);
			try {
				validateProjectWorkflowSettingsSlots(frozenDraft, editableSlots);
			} catch (error) {
				return invalid(error);
			}
			const finalTarget = await resolveProjectWorkflowSettingsTarget(
				workflow,
				ctx.cwd,
			);
			if (
				finalTarget.key !== fresh.key ||
				finalTarget.definitionFingerprint !== fresh.definitionFingerprint ||
				finalTarget.resolutionToken !== fresh.resolutionToken
			)
				throw new ProjectWorkflowSettingsConflict(
					"Workflow selection changed during save validation.",
				);
			return { target: finalTarget, editableSlots };
		},
	});
}
