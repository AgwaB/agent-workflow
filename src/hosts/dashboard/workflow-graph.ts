import { compileWorkflow } from "../../core/compiler.js";
import {
	collectWorkflowRoleSlots,
	type WorkflowRoleProfileSlot,
} from "../../core/execution-profile.js";
import { roleKeysForSlot } from "../../core/role-profiles.js";
import { loadWorkflowSpec } from "../../core/schema.js";
import type {
	CompiledWorkflow,
	CompiledLoopStageRecord,
} from "../../core/types.js";
import type { HostApiContext } from "../types.js";
import { projectSettingsDefinition } from "../project-workflow-settings-actions.js";

export interface WorkflowSettingsGraphData {
	authored: ReturnType<typeof projectSettingsDefinition>["authored"];
	editableSlots: ReturnType<typeof projectSettingsDefinition>["editableSlots"];
	error?: string;
	/** Actual compiled authored loop templates; canonical slot dependencies, no rounds/workers. */
	templateTasks: Array<{
		containerId: string;
		stageId: string;
		kind: string;
		dependsOn: string[];
	}>;
	name: string;
	tasks: Array<{
		specId: string;
		stageId: string;
		kind: string;
		dependsOn: string[];
	}>;
	slots: Array<WorkflowRoleProfileSlot & { roleKeys: string[] }>;
}

/** Declared/startup structure only. No run, generated workers, prompts or executor probes. */
export async function workflowSettingsGraph(
	ctx: HostApiContext,
	workflow: string,
): Promise<WorkflowSettingsGraphData | { error: string }> {
	const loaded = await loadWorkflowSpec(workflow, ctx.cwd);
	let compiled: CompiledWorkflow;
	try {
		compiled = await compileWorkflow(loaded.spec, {
			cwd: ctx.cwd,
			specPath: loaded.specPath,
		});
	} catch (error) {
		return {
			name: loaded.spec.name || loaded.workflowName || "Workflow",
			tasks: [],
			templateTasks: [],
			slots: collectWorkflowRoleSlots(loaded.spec).map((slot) => ({
				...slot,
				roleKeys: roleKeysForSlot(slot),
			})),
			...projectSettingsDefinition(loaded.spec),
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const templateTasks: WorkflowSettingsGraphData["templateTasks"] = [];
	for (const record of compiled.stages ?? []) {
		if (record.type !== "loop" || !Array.isArray(record.childTemplates))
			continue;
		// Compiler-owned loop records, not browser-supplied metadata.
		const loop = record as CompiledLoopStageRecord;
		const canonical = new Map(
			loop.childTemplates.map((task) => [
				task.id,
				`${loop.id}.${task.stageId}`,
			]),
		);
		for (const task of loop.childTemplates)
			templateTasks.push({
				containerId: loop.id,
				stageId: canonical.get(task.id)!,
				kind: task.kind ?? "single",
				dependsOn: (task.dependsOn ?? []).flatMap((id) =>
					canonical.has(id) ? [canonical.get(id)!] : [],
				),
			});
		if (loop.onExhausted)
			templateTasks.push({
				containerId: loop.id,
				stageId: `${loop.id}.$onExhausted`,
				kind: loop.onExhausted.template.kind ?? "single",
				dependsOn: [],
			});
	}
	// Never truncate into a different graph or send an unbounded interactive SVG.
	if (compiled.tasks.length + templateTasks.length > 2000)
		return {
			error:
				"This workflow is too large for the settings diagram (2000 tasks maximum).",
		};
	const graph = {
		...projectSettingsDefinition(loaded.spec),
		templateTasks,
		name: compiled.name || loaded.workflowName || "Workflow",
		tasks: compiled.tasks.map((task) => ({
			specId: task.id,
			stageId: task.stageId ?? task.id.split(".")[0]!,
			kind: task.kind ?? "single",
			dependsOn: [...(task.dependsOn ?? [])],
		})),
		slots: collectWorkflowRoleSlots(loaded.spec).map((slot) => ({
			...slot,
			roleKeys: roleKeysForSlot(slot),
		})),
	};
	return Buffer.byteLength(JSON.stringify(graph)) > 1024 * 1024
		? {
				error:
					"This workflow's settings diagram exceeds the preview size limit.",
			}
		: graph;
}
