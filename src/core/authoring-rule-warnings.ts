import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
	lookupArrayBound,
	lookupControlSchemaPath,
} from "./control-schema-path.js";
import { parseSimpleJsonPath } from "./workflow-runtime.js";
import {
	literalSourceLookups,
	sourceNameReachable,
} from "./support-source-lookups.js";

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
			warnings.push(...implicitChainWarnings(stage, siblings, index, mode));
			warnings.push(
				...(await supportSourceLookupWarnings(
					stage,
					siblings,
					index,
					mode,
					specDir,
				)),
			);
			const sources = stageSourceIds(siblings, index, mode);
			if (sources.length > 0 || (mode === "loop" && index > 0)) {
				warnings.push(...forbidsToolsWarnings(stage, sources));
			}
			if (stage.type === "foreach") {
				warnings.push(
					...(await foreachSourceWarnings(stage, byId, loadSchema)),
				);
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

/** Source ids a support stage is fed by: `from` and `after`, or the previous top-level stage; undefined = unknown. */
function supportStageSourceIds(
	siblings: readonly unknown[],
	index: number,
	mode: "top" | "dag" | "loop",
): string[] | undefined {
	const stage = siblings[index] as Stage;
	if (stage.from !== undefined || stage.after !== undefined) {
		const after = Array.isArray(stage.after)
			? stage.after
			: stage.after === undefined
				? []
				: [stage.after];
		return [
			...refStrings(stage.from),
			...after.filter((id: unknown): id is string => typeof id === "string"),
		];
	}
	if (mode !== "top") return undefined;
	if (index === 0) return [];
	const previous = siblings[index - 1];
	return isRecord(previous) && typeof previous.id === "string"
		? [previous.id]
		: undefined;
}

async function supportSourceLookupWarnings(
	stage: Stage,
	siblings: readonly unknown[],
	index: number,
	mode: "top" | "dag" | "loop",
	specDir: string,
): Promise<string[]> {
	const uses = stage.support?.uses;
	if (typeof uses !== "string" || !uses.startsWith("./")) return [];
	const from = supportStageSourceIds(siblings, index, mode);
	if (from === undefined) return [];
	const path = resolve(specDir, uses);
	const inside = relative(resolve(specDir), path);
	if (inside.startsWith("..") || isAbsolute(inside)) return [];
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	return literalSourceLookups(text)
		.filter((name) => !sourceNameReachable(name, from, mode !== "top"))
		.slice(0, 3)
		.map(
			(name) =>
				`stage "${stage.id}" support helper "${uses}" looks up source ${JSON.stringify(name)}, which is not one of its sources (${from.join(", ") || "none"}). The lookup is always empty, so a helper that then declares failed or blocked is most likely reporting a wiring error, not a content gate. Use a name its from/after provides (or add the stage to from).`,
		);
}

/** A top-level stage (not the first) with neither `from` nor `after` runs after and reads the previous stage. */
function implicitChainWarnings(
	stage: Stage,
	siblings: readonly unknown[],
	index: number,
	mode: "top" | "dag" | "loop",
): string[] {
	if (mode !== "top" || index === 0) return [];
	if (stage.from !== undefined || stage.after !== undefined) return [];
	const previous = siblings[index - 1];
	if (!isRecord(previous) || typeof previous.id !== "string") return [];
	return [
		`stage "${stage.id}" has neither from nor after, so it runs after "${previous.id}" and reads it implicitly (the previous stage is its source, except after a loop). Say what you mean: from: ["${previous.id}"] to read it, or after: [] to start without it.`,
	];
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

async function foreachSourceWarnings(
	stage: Stage,
	byId: ReadonlyMap<string, Stage>,
	loadSchema: (stage: Stage | undefined) => Promise<unknown>,
): Promise<string[]> {
	const from = stage.from;
	if (!isRecord(from)) return [];
	const sourceId = from.source ?? from.stage;
	const path = from.path;
	if (typeof sourceId !== "string" || typeof path !== "string") return [];
	const source = byId.get(sourceId);
	// A support helper bounds its array in code, which a spec cannot show; a container has no schema.
	if (!source || !isModelBacked(source) || source.type === "dynamic") return [];
	const schema = await loadSchema(source);
	if (!schema) return [];
	const lookup = lookupControlSchemaPath(schema, path);
	if (lookup.status !== "found" || !isRecord(lookup.schema)) return [];
	// A `const`/`enum`/`$ref` above the array decides its size and whether `[]` is valid; the bounds of the array
	// schema itself then prove nothing, so say nothing about them (the path itself was still checked).
	if (lookup.constrainedByAncestor) return [];
	const array = lookup.schema;
	if (array.type !== "array" && !isRecord(array.items)) return [];
	const warnings: string[] = [];
	if (
		stage.maxItems === undefined &&
		lookupArrayBound(array, "maxItems") === "absent"
	)
		warnings.push(
			`foreach stage "${stage.id}" fans out over "${path}" from "${sourceId}", but that array in ${sourceId}'s control schema (${source.output.controlSchema}) has no maxItems, so the model decides the task count without bound. Add maxItems to the array (and state the cap in ${sourceId}'s prompt), or set maxItems on the foreach stage.`,
		);
	// An explicit minItems (even 0) says the author chose; only the unstated case is flagged.
	if (lookupArrayBound(array, "minItems") === "absent")
		warnings.push(
			`foreach stage "${stage.id}" fans out over "${path}" from model stage "${sourceId}" whose array has no minItems, so an empty answer completes with 0 tasks. Add minItems: 1 if empty means failure (or minItems: 0 if it is fine), or find the items in a support stage.`,
		);
	return warnings;
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
	const warnings: string[] = [];
	// Without a control schema there is nothing to check the path against.
	const controlSchema = finalChild.output?.controlSchema;
	const schema =
		typeof controlSchema === "string"
			? await loadSchema(finalChild)
			: undefined;
	const undeclared = new Set<unknown>();
	if (schema) {
		for (const leaf of leaves) {
			const lookup = lookupControlSchemaPath(schema, leaf.path);
			if (lookup.status !== "missing") continue;
			undeclared.add(leaf);
			const consequence = lookup.closed
				? "the schema sets additionalProperties: false, so the model can never emit it and the loop can only end exhausted"
				: "nothing makes the model emit it";
			warnings.push(
				`loop stage "${loop.id}" until path "${leaf.path}" is not declared in the control schema (${controlSchema}) of its final child "${finalChild.id}": ${consequence}. Add "${lookup.property}" to that schema's properties and show it in the child's prompt, or point until at a declared field.`,
			);
		}
	}
	// The key the loop ends on has to appear in the child's prompt as a JSON key, or the model has no
	// reason to emit it (a missing key reads as "not done", so the loop runs to maxRounds).
	if (isModelBacked(finalChild)) {
		const prompt = [finalChild.prompt, finalChild.each?.prompt]
			.filter((text): text is string => typeof text === "string")
			.join("\n");
		for (const leaf of leaves) {
			if (undeclared.has(leaf)) continue;
			const key = lastPropertyKey(leaf.path);
			if (key === undefined || promptShowsJsonKey(prompt, key)) continue;
			warnings.push(
				`loop stage "${loop.id}" until reads "${key}" from its final child "${finalChild.id}", but that child's prompt does not show "${key}": as a JSON key. Show it in the <control> example (for example {"${key}": true}) so the model emits it; otherwise the loop can only end exhausted.`,
			);
		}
	}
	return warnings;
}

function lastPropertyKey(path: string): string | undefined {
	const tokens = parseSimpleJsonPath(path);
	const last = tokens?.at(-1);
	return last?.type === "property" ? last.key : undefined;
}

function promptShowsJsonKey(prompt: string, key: string): boolean {
	return prompt.includes(`"${key}":`) || prompt.includes(`"${key}" :`);
}
