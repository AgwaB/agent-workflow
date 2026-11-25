import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { parseArtifactGraphWorkflowSpec } from "./artifact-graph-schema.js";
import { lookupControlSchemaPath } from "./control-schema-path.js";
import { validateJsonSchemaSubset } from "./json-schema.js";
import {
	type ArtifactGraphWorkflowSpec,
	WorkflowValidationError,
	type ValidationIssue,
} from "./types.js";
import {
	type ResolvedWorkflowSpecRef,
	resolveWorkflowRef,
} from "./workflow-specs.js";
import { isInsidePath } from "./physical-paths.js";

export interface LoadedWorkflowSpec extends ResolvedWorkflowSpecRef {
	spec: ArtifactGraphWorkflowSpec;
}

export async function loadWorkflowSpec(
	specRef: string,
	cwd: string,
): Promise<LoadedWorkflowSpec> {
	const resolved = await resolveWorkflowRef(specRef, cwd);
	let parsed: unknown;

	try {
		parsed = parseSpecText(
			await readFile(resolved.specPath, "utf8"),
			resolved.specPath,
		);
	} catch (error) {
		if (error instanceof WorkflowValidationError) throw error;
		throw new WorkflowValidationError([
			{
				path: specRef,
				message: error instanceof Error ? error.message : String(error),
			},
		]);
	}

	const spec = parseWorkflow(parsed);
	await validateArtifactGraphControlSchemaFiles(spec, resolved.specPath);
	return {
		...resolved,
		spec,
	};
}

async function validateArtifactGraphControlSchemaFiles(
	spec: ArtifactGraphWorkflowSpec,
	specPath: string,
): Promise<void> {
	const issues: ValidationIssue[] = [];
	const specDir = dirname(specPath);
	const seen = new Set<string>();
	const parsedSchemas = new Map<string, unknown>();
	for (const stage of flattenArtifactGraphStages(spec.artifactGraph.stages)) {
		const controlSchema = stage.output?.controlSchema;
		if (!controlSchema || seen.has(controlSchema)) continue;
		seen.add(controlSchema);
		const schemaPath = resolve(specDir, controlSchema);
		try {
			const [realSpecDir, realSchemaPath] = await Promise.all([
				realpath(specDir),
				realpath(schemaPath),
			]);
			if (!isInsidePath(realSpecDir, realSchemaPath)) {
				issues.push({
					path: `${stage.id}.output.controlSchema`,
					message: `controlSchema must stay inside the workflow bundle: ${controlSchema}`,
				});
				continue;
			}
			const schema = JSON.parse(await readFile(realSchemaPath, "utf8"));
			parsedSchemas.set(controlSchema, schema);
			const validation = validateJsonSchemaSubset(schema);
			for (const issue of validation.issues) {
				issues.push({
					path: `${stage.id}.output.controlSchema${issue.path.slice(1)}`,
					message: issue.message,
				});
			}
			const forbidden = forbiddenControlEnvelopeKeys(schema);
			if (forbidden.length > 0) {
				issues.push({
					path: `${stage.id}.output.controlSchema`,
					message: `${controlSchema} sets additionalProperties: false without ${forbidden.map((key) => `"${key}"`).join(", ")}, but every stage control carries "schema", "digest"; add them to its properties`,
				});
			}
		} catch (error) {
			issues.push({
				path: `${stage.id}.output.controlSchema`,
				message: `controlSchema not readable JSON: ${controlSchema} (${error instanceof Error ? error.message : String(error)})`,
			});
		}
	}
	issues.push(...loopUntilSchemaIssues(spec, parsedSchemas));
	if (issues.length > 0) throw new WorkflowValidationError(issues);
}

// A loop ends when its `until` reads a field of the final child's control. When that child's control
// schema is closed (additionalProperties: false) and does not declare the field, the model can never
// emit it and the loop can only end exhausted (a guaranteed outcome, so an error). An open schema
// only gets a warning (compiler authoring-rule warnings). `exists: false` wants the field absent.
function loopUntilSchemaIssues(
	spec: ArtifactGraphWorkflowSpec,
	parsedSchemas: ReadonlyMap<string, unknown>,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const stage of flattenArtifactGraphStages(spec.artifactGraph.stages)) {
		if (stage.type !== "loop" || !Array.isArray(stage.stages)) continue;
		const finalChild = stage.stages.at(-1);
		const controlSchema = finalChild?.output?.controlSchema;
		if (typeof controlSchema !== "string") continue;
		const schema = parsedSchemas.get(controlSchema);
		if (schema === undefined) continue;
		// Missing paths read as undefined, which only `exists: false` accepts (loop-runtime.ts
		// evaluateLoopUntil): report only when no combination of the leaves can ever be true.
		const missing: Array<{ path: string; property: string }> = [];
		const canPass = (node: any): boolean => {
			if (!node || typeof node !== "object") return true;
			for (const key of ["all", "any"]) {
				if (Array.isArray(node[key])) {
					const results = node[key].map(canPass);
					return key === "all" ? results.every(Boolean) : results.some(Boolean);
				}
			}
			if (typeof node.path !== "string") return true;
			const lookup = lookupControlSchemaPath(schema, node.path);
			if (lookup.status !== "missing" || !lookup.closed) return true;
			missing.push({ path: node.path, property: String(lookup.property) });
			return node.exists === false;
		};
		if (canPass(stage.until)) continue;
		for (const leaf of missing)
			issues.push({
				path: `${stage.id}.until`,
				message: `loop "${stage.id}" until path "${leaf.path}" is not in ${controlSchema}, the control schema of its final child "${finalChild.id}", which sets additionalProperties: false; ${finalChild.support ? "the helper cannot return" : "the model can never emit"} "${leaf.property}", so the loop could only end exhausted. Add it to that schema's properties${finalChild.support ? "" : " (and show it in the child's prompt)"}, or point until at a declared field`,
			});
	}
	return issues;
}

// Every control object carries the envelope keys: models must emit them (workflow-output-artifacts.ts
// validateBaseControl) and support/dynamic results get them filled in. A closed root schema that omits
// them can never validate, so the run would fail every attempt.
const CONTROL_ENVELOPE_KEYS = ["schema", "digest"] as const;

function forbiddenControlEnvelopeKeys(schema: unknown): string[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
	const record = schema as Record<string, unknown>;
	if (record.additionalProperties !== false) return [];
	const properties =
		record.properties &&
		typeof record.properties === "object" &&
		!Array.isArray(record.properties)
			? (record.properties as Record<string, unknown>)
			: {};
	return CONTROL_ENVELOPE_KEYS.filter((key) => !Object.hasOwn(properties, key));
}

function flattenArtifactGraphStages(stages: readonly any[]): any[] {
	return stages.flatMap((stage) => [
		stage,
		...(Array.isArray(stage.stages)
			? flattenArtifactGraphStages(stage.stages)
			: []),
		...(stage.onExhausted
			? flattenArtifactGraphStages([stage.onExhausted])
			: []),
	]);
}

function parseSpecText(text: string, specPath: string): unknown {
	const extension = extname(specPath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml")
		throw new Error("YAML workflow specs are not supported; use JSON (.json).");
	return JSON.parse(text);
}

export const loadWorkflow = loadWorkflowSpec;

export function parseWorkflow(value: unknown): ArtifactGraphWorkflowSpec {
	return parseArtifactGraphWorkflowSpec(value);
}
