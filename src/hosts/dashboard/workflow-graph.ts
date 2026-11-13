import { compileWorkflow } from "../../core/compiler.js";
import {
	collectWorkflowRoleSlots,
	type WorkflowRoleProfileSlot,
} from "../../core/execution-profile.js";
import { roleKeysForSlot } from "../../core/role-profiles.js";
import { loadWorkflowSpec } from "../../core/schema.js";
import type { CompiledWorkflow } from "../../core/types.js";
import type { HostApiContext } from "../types.js";

export interface WorkflowSettingsGraphData {
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
	const compiled: CompiledWorkflow = await compileWorkflow(loaded.spec, {
		cwd: ctx.cwd,
		specPath: loaded.specPath,
	});
	// Never truncate into a different graph or send an unbounded interactive SVG.
	if (compiled.tasks.length > 2000)
		return {
			error:
				"This workflow is too large for the settings diagram (2000 tasks maximum).",
		};
	const graph = {
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
