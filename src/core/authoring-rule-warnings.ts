import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { lookupControlSchemaPath } from "./control-schema-path.js";

// Advisory authoring-rule checks for the workflow-guide skill's "Must know" rules that a spec
// alone can decide. They are warnings (heuristics or conventions with a runtime effect), listed by
// `validate` next to the prompt/schema warnings. Every message names the stage and says what to do.
// The one guaranteed runtime failure (a loop `until` path a closed control schema cannot carry) is
// an error in schema.ts. Stage arrays are walked recursively (dag/loop children, onExhausted).

// Specs are validated JSON read untyped, like the other compiler collectors.
type Stage = any;

function isRecord(value: unknown): value is Stage {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODEL_STAGE_TYPES = new Set(["single", "reduce", "foreach", "dynamic"]);
const PROFILE_ROLES =
	"planning, research-execution, synthesis, verification or final-judgment";

export async function collectAuthoringRuleWarnings(
	stages: readonly unknown[],
	specDir: string,
): Promise<string[]> {
	const warnings: string[] = [];
	const schemaCache = new Map<string, unknown>();
	const loadSchema = async (stage: Stage | undefined): Promise<unknown> => {
		const controlSchema = stage?.output?.controlSchema;
		if (typeof controlSchema !== "string") return undefined;
		if (schemaCache.has(controlSchema)) return schemaCache.get(controlSchema);
		let schema: unknown;
		try {
			schema = JSON.parse(
				await readFile(resolve(specDir, controlSchema), "utf8"),
			);
		} catch {
			schema = undefined;
		}
		schemaCache.set(controlSchema, schema);
		return schema;
	};

	const walk = async (
		siblings: readonly unknown[],
		mode: "top" | "dag" | "loop",
	): Promise<void> => {
		const byId = new Map<string, Stage>();
		for (const stage of siblings) {
			if (isRecord(stage) && typeof stage.id === "string")
				byId.set(stage.id, stage);
		}
		for (const [index, stage] of siblings.entries()) {
			if (!isRecord(stage) || typeof stage.id !== "string") continue;
			warnings.push(...profileRoleWarnings(stage));
			warnings.push(...placeholderWarnings(stage));
			const sources = stageSourceIds(siblings, index, mode);
			if (sources.length > 0 || (mode === "loop" && index > 0)) {
				warnings.push(...forbidsToolsWarnings(stage, sources));
			}
			if (stage.type === "foreach") {
				const warning = await foreachCapWarning(stage, byId, loadSchema);
				if (warning) warnings.push(warning);
			}
			if (stage.type === "loop" && Array.isArray(stage.stages)) {
				warnings.push(...(await loopUntilWarnings(stage, loadSchema)));
				await walk(stage.stages, "loop");
				if (isRecord(stage.onExhausted)) await walk([stage.onExhausted], "dag");
			} else if (stage.type === "dag" && Array.isArray(stage.stages)) {
				await walk(stage.stages, "dag");
			}
		}
	};
	await walk(stages, "top");
	return warnings;
}

function isModelBacked(stage: Stage): boolean {
	return stage.support === undefined && MODEL_STAGE_TYPES.has(stage.type);
}

function profileRoleWarnings(stage: Stage): string[] {
	if (!isModelBacked(stage)) return [];
	const warnings: string[] = [];
	if (stage.profileRole === undefined) {
		warnings.push(
			`stage "${stage.id}" (${stage.type}) has no profileRole. Set ${PROFILE_ROLES} by what the stage does; without it a role profile (Codex, Claude, Mixed, Custom) matches the stage only by agent:<name> or default.`,
		);
	}
	if (stage.type === "dynamic" && isRecord(stage.dynamic?.decisionLoop)) {
		const loop = stage.dynamic.decisionLoop;
		for (const key of ["planner", "workerDefaults", "verifier", "synthesis"]) {
			if (isRecord(loop[key]) && loop[key].profileRole === undefined) {
				warnings.push(
					`stage "${stage.id}" dynamic.decisionLoop.${key} has no profileRole. Set ${PROFILE_ROLES} on that profile object.`,
				);
			}
		}
	}
	return warnings;
}

const PLACEHOLDER = /\$\{([^}\n]*)\}/g;

function placeholderWarnings(stage: Stage): string[] {
	if (stage.support !== undefined || stage.type === "dynamic") return [];
	const fields: Array<{ label: string; text: string; allowItem: boolean }> = [];
	if (typeof stage.prompt === "string") {
		fields.push({ label: "prompt", text: stage.prompt, allowItem: false });
	}
	if (stage.type === "foreach" && typeof stage.each?.prompt === "string") {
		fields.push({
			label: "each.prompt",
			text: stage.each.prompt,
			allowItem: true,
		});
	}
	const warnings: string[] = [];
	for (const field of fields) {
		const found = new Set<string>();
		for (const match of field.text.matchAll(PLACEHOLDER)) {
			// Only the exact `${item}` is substituted (compiler.ts): `${ item }` stays literal.
			if (match[1] === "item" && field.allowItem) continue;
			found.add(`\${${match[1]}}`);
		}
		if (found.size === 0) continue;
		const list = [...found].slice(0, 3).join(", ");
		const more = found.size > 3 ? ` (+${found.size - 3} more)` : "";
		warnings.push(
			`stage "${stage.id}" ${field.label} contains ${list}${more}, which the engine does not substitute (only \${item} in a foreach stage's each.prompt is). The model would read it as literal text. Declared input reaches a prompt only as the "# Workflow Input" block: describe it in words, or remove the placeholder.`,
		);
	}
	return warnings;
}

function refStrings(from: unknown): string[] {
	if (typeof from === "string") return [from];
	if (Array.isArray(from))
		return from.filter((ref): ref is string => typeof ref === "string");
	if (isRecord(from)) {
		const source = from.source ?? from.stage;
		return typeof source === "string" ? [source] : [];
	}
	return [];
}

/** Sources a single/reduce stage reads: its `from` (or the implicitly chained previous stage). */
function stageSourceIds(
	siblings: readonly unknown[],
	index: number,
	mode: "top" | "dag" | "loop",
): string[] {
	const stage = siblings[index] as Stage;
	if (stage.type !== "single" && stage.type !== "reduce") return [];
	if (stage.support !== undefined) return [];
	const explicit = refStrings(stage.from);
	if (explicit.length > 0) return explicit;
	if (
		mode === "top" &&
		index > 0 &&
		stage.from === undefined &&
		stage.after === undefined
	) {
		const previous = siblings[index - 1];
		if (isRecord(previous) && previous.type !== "loop" && previous.id) {
			return [String(previous.id)];
		}
	}
	return [];
}

// "do not use tools", "never call any tool", "without tools", "no tools", "tool-free", "tools are
// disabled". Phrases that only narrow the tools ("do not use tools other than ...", "tools that
// write", "tools to modify files", "never call workflow_artifact with maxChars and no path") are not
// matches.
const FORBIDS_TOOLS: RegExp[] = [
	/\b(?:do not|don't|never|must not|mustn't|cannot|can't|should not|shouldn't|without|avoid)\s+(?:(?:to\s+)?(?:use|using|call|calling|invoke|invoking|rely on|relying on)\s+)?(?:(?:any|the|your|available|more|further)\s+)*(?:tools?|tool calls?|tool use|workflow_artifact)\b(?!\s+(?:other than|except|apart from|besides|beyond|that|which|with|on|when|if|unless|before|after|again)\b)(?!\s+(?:to|for)\s+(?:write|writing|modify|modifying|edit|editing|change|changing|mutate|mutating|delete|deleting|run|running)\b)/i,
	/\bno\s+(?:further\s+|additional\s+|extra\s+)?tool(?:s| calls?| use)\b/i,
	/\btool[- ]free\b/i,
	/\btools?\s+(?:are|is)\s+(?:not\s+available|unavailable|disabled|forbidden|not\s+allowed)\b/i,
];

function forbidsToolsWarnings(
	stage: Stage,
	sources: readonly string[],
): string[] {
	if (stage.type !== "single" && stage.type !== "reduce") return [];
	if (stage.support !== undefined) return [];
	if (stage.inputPolicy?.artifactAccess === "none") return [];
	if (typeof stage.prompt !== "string") return [];
	let phrase: string | undefined;
	for (const pattern of FORBIDS_TOOLS) {
		phrase = pattern.exec(stage.prompt)?.[0];
		if (phrase) break;
	}
	if (!phrase) return [];
	const reads =
		sources.length > 0
			? `reads sources (from: ${sources.join(", ")})`
			: "reads the earlier children of its loop round";
	return [
		`stage "${stage.id}" ${reads} but its prompt forbids tool use ("${phrase}"). Sources are read through workflow_artifact, so the stage could not open them. Reword the prompt to forbid only what you mean (for example "do not modify files"), or remove from if the stage needs no upstream data.`,
	];
}

async function foreachCapWarning(
	stage: Stage,
	byId: ReadonlyMap<string, Stage>,
	loadSchema: (stage: Stage | undefined) => Promise<unknown>,
): Promise<string | undefined> {
	if (stage.maxItems !== undefined) return undefined;
	const from = stage.from;
	if (!isRecord(from)) return undefined;
	const sourceId = from.source ?? from.stage;
	const path = from.path;
	if (typeof sourceId !== "string" || typeof path !== "string")
		return undefined;
	const source = byId.get(sourceId);
	// A support helper bounds its array in code, which a spec cannot show; a container has no schema.
	if (!source || !isModelBacked(source) || source.type === "dynamic")
		return undefined;
	const schema = await loadSchema(source);
	if (!schema) return undefined;
	const lookup = lookupControlSchemaPath(schema, path);
	if (lookup.status !== "found" || !isRecord(lookup.schema)) return undefined;
	const array = lookup.schema;
	if (array.type !== "array" && !isRecord(array.items)) return undefined;
	if (typeof array.maxItems === "number") return undefined;
	return `foreach stage "${stage.id}" fans out over "${path}" from "${sourceId}", but that array in ${sourceId}'s control schema (${source.output.controlSchema}) has no maxItems, so the model decides the task count without bound. Add maxItems to the array (and state the cap in ${sourceId}'s prompt), or set maxItems on the foreach stage.`;
}

function untilLeaves(until: unknown, leaves: Stage[] = []): Stage[] {
	if (!isRecord(until)) return leaves;
	for (const key of ["all", "any"]) {
		if (Array.isArray(until[key])) {
			for (const child of until[key]) untilLeaves(child, leaves);
			return leaves;
		}
	}
	leaves.push(until);
	return leaves;
}

async function loopUntilWarnings(
	loop: Stage,
	loadSchema: (stage: Stage | undefined) => Promise<unknown>,
): Promise<string[]> {
	const children = loop.stages as unknown[];
	const finalChild = children.at(-1);
	if (!isRecord(finalChild)) return [];
	const leaves = untilLeaves(loop.until).filter(
		(leaf) => typeof leaf.path === "string" && leaf.exists !== false,
	);
	if (leaves.length === 0) return [];
	// Without a control schema there is nothing to check the path against.
	const controlSchema = finalChild.output?.controlSchema;
	if (typeof controlSchema !== "string") return [];
	const schema = await loadSchema(finalChild);
	if (!schema) return [];
	const warnings: string[] = [];
	for (const leaf of leaves) {
		const lookup = lookupControlSchemaPath(schema, leaf.path);
		if (lookup.status !== "missing") continue;
		const consequence = lookup.closed
			? "the schema sets additionalProperties: false, so the model can never emit it and the loop can only end exhausted"
			: "nothing makes the model emit it";
		warnings.push(
			`loop stage "${loop.id}" until path "${leaf.path}" is not declared in the control schema (${controlSchema}) of its final child "${finalChild.id}": ${consequence}. Add "${lookup.property}" to that schema's properties and show it in the child's prompt, or point until at a declared field.`,
		);
	}
	return warnings;
}
