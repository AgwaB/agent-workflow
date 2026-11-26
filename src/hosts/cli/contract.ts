import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { controlContract } from "../../core/authoring-contract.js";
import type { JsonSchema } from "../../core/json-schema.js";
import { loadWorkflowSpec } from "../../core/schema.js";
import type { ArtifactGraphStageSpec } from "../../core/types.js";
import { HostUsageError } from "../args.js";
import { result } from "../types.js";

function stageAt(
	stages: readonly ArtifactGraphStageSpec[],
	segments: readonly string[],
): ArtifactGraphStageSpec | undefined {
	const stage = stages.find((entry) => entry.id === segments[0]);
	if (!stage || segments.length === 1) return stage;
	if (
		stage.type === "loop" &&
		segments.length === 2 &&
		segments[1] === "$onExhausted"
	)
		return stage.onExhausted;
	return stageAt(stage.stages ?? [], segments.slice(1));
}

/** Schema-only authoring command: no compile, helper execution, run state or model. */
export async function printStageContract(
	workflow: string,
	stageId: string,
	cwd: string,
) {
	const loaded = await loadWorkflowSpec(workflow, cwd);
	const stage = stageAt(loaded.spec.artifactGraph.stages, stageId.split("."));
	if (!stage)
		throw new HostUsageError(
			`Unknown stage "${stageId}". For nested stages use the dotted id (for example review.summary).`,
		);
	const path = stage.output?.controlSchema;
	if (!path)
		throw new HostUsageError(`Stage "${stageId}" has no output.controlSchema.`);
	try {
		const schema: JsonSchema = JSON.parse(
			await readFile(resolve(dirname(loaded.specPath), path), "utf8"),
		);
		if (!schema || typeof schema !== "object")
			throw new Error("expected a control object schema");
		const contract = controlContract(schema, {
			...(schema.additionalProperties !== false &&
			!Object.hasOwn(schema.properties ?? {}, "schema")
				? { schema: "stage-control-v1" }
				: {}),
			...(schema.additionalProperties !== false &&
			!Object.hasOwn(schema.properties ?? {}, "digest")
				? { digest: "Example digest." }
				: {}),
		});
		return result(
			"contract",
			"success",
			{ stage: stageId, contract },
			contract,
		);
	} catch (error) {
		throw new HostUsageError(
			`Cannot generate Contract for stage "${stageId}" (${path}): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
