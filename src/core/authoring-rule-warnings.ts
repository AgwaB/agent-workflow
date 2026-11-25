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
	/** `defaults.readOnly` or the spec's own `readOnly`: what a stage without its own setting gets. */
	readOnlyDefault?: boolean,
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
		everyStage: ReadonlyMap<string, Stage>,
		inLoop = false,
	): Promise<void> => {
		const byId = new Map<string, Stage>();
		for (const stage of siblings) {
			if (isRecord(stage) && typeof stage.id === "string")
				byId.set(stage.id, stage);
		}
		warnings.push(...implicitChainWarnings(siblings, mode));
		for (const [index, stage] of siblings.entries()) {
			if (!isRecord(stage) || typeof stage.id !== "string") continue;
			warnings.push(...profileRoleWarnings(stage));
			warnings.push(...placeholderWarnings(stage));
			warnings.push(...readOnlyCommandWarnings(stage, readOnlyDefault));
			if (!inLoop) warnings.push(...selfManagedControlWarnings(stage));
			warnings.push(...verifyFilesWarnings(stage, everyStage));
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
				await walk(stage.stages, "loop", everyStage, true);
				if (isRecord(stage.onExhausted))
					await walk([stage.onExhausted], "dag", everyStage, inLoop);
			} else if (stage.type === "dag" && Array.isArray(stage.stages)) {
				await walk(stage.stages, "dag", everyStage, inLoop);
			}
		}
	};
	const everyStage = new Map<string, Stage>();
	const collectStages = (list: readonly unknown[]): void => {
		for (const stage of list) {
			if (!isRecord(stage)) continue;
			if (typeof stage.id === "string" && !everyStage.has(stage.id))
				everyStage.set(stage.id, stage);
			if (Array.isArray(stage.stages)) collectStages(stage.stages);
			if (isRecord(stage.onExhausted)) collectStages([stage.onExhausted]);
		}
	};
	collectStages(stages);
	await walk(stages, "top", everyStage);
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

/**
 * Top-level stages (not the first) with neither `from` nor `after` run after and read the previous stage.
 * One warning per spec names them all, so a linear spec is not flagged once per stage on every launch.
 */
function implicitChainWarnings(
	siblings: readonly unknown[],
	mode: "top" | "dag" | "loop",
): string[] {
	if (mode !== "top") return [];
	const chained: string[] = [];
	for (const [index, stage] of siblings.entries()) {
		if (index === 0 || !isRecord(stage) || typeof stage.id !== "string")
			continue;
		if (stage.from !== undefined || stage.after !== undefined) continue;
		const previous = siblings[index - 1];
		if (!isRecord(previous) || typeof previous.id !== "string") continue;
		chained.push(stage.id);
	}
	if (chained.length === 0) return [];
	const names = chained.map((id) => `"${id}"`).join(", ");
	return [
		`stage${chained.length === 1 ? "" : "s"} ${names} ${chained.length === 1 ? "has" : "have"} neither from nor after, so ${chained.length === 1 ? "it runs" : "they run"} after and read${chained.length === 1 ? "s" : ""} the previous stage implicitly (the previous stage is the source, except after a loop). Declare from: [...] to read a stage, or after: [] to start without one, to make it explicit.`,
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
// Words after the noun that narrow a prohibition to some tools or commands ("other than", "that write").
const NOT_NARROWED_BY_CLAUSE =
	"(?!\\s+(?:other than|except|apart from|besides|beyond|that|which|with|on|when|if|unless|before|after|again)\\b)";
const NOT_NARROWED_BY_PURPOSE =
	"(?!\\s+(?:to|for)\\s+(?:write|writing|modify|modifying|edit|editing|change|changing|mutate|mutating|delete|deleting|run|running)\\b)";
const FORBID_WORD =
	"(?:do not|don't|never|must not|mustn't|cannot|can't|should not|shouldn't|without|avoid)";

const FORBIDS_TOOLS: RegExp[] = [
	new RegExp(
		`\\b${FORBID_WORD}\\s+(?:(?:to\\s+)?(?:use|using|call|calling|invoke|invoking|rely on|relying on)\\s+)?(?:(?:any|the|your|available|more|further)\\s+)*(?:tools?|tool calls?|tool use|workflow_artifact)\\b${NOT_NARROWED_BY_CLAUSE}${NOT_NARROWED_BY_PURPOSE}`,
		"i",
	),
	/\bno\s+(?:further\s+|additional\s+|extra\s+)?tool(?:s| calls?| use)\b/i,
	/\btool[- ]free\b/i,
	/\btools?\s+(?:are|is)\s+(?:not\s+available|unavailable|disabled|forbidden|not\s+allowed)\b/i,
];

// "do not run commands", "never execute any shell commands", "avoid using the shell", "run no commands".
// The same narrowing exemptions as the tool check, plus "such as"/"like"/"including" ("do not run commands
// such as rm"), and wording about effects ("do not run tests", "do not modify files") is not a match.
const FORBIDS_COMMANDS: RegExp[] = [
	new RegExp(
		`\\b${FORBID_WORD}\\s+(?:to\\s+)?(?:run|running|execute|executing|use|using|call|calling|invoke|invoking)\\s+(?:(?:any|the|your|available|more|further|shell|bash|terminal)\\s+)*(?:commands?|shell|bash|terminal|command[- ]line(?:\\s+tools?)?)\\b(?!\\s+(?:commands?|line)\\b)${NOT_NARROWED_BY_CLAUSE}(?!\\s+(?:such as|like|including|e\\.g\\.))${NOT_NARROWED_BY_PURPOSE}`,
		"i",
	),
	/\b(?:run|execute|use)\s+no\s+(?:shell\s+)?commands?\b/i,
];

/**
 * The write-verify helper shape: a support stage whose `options.files` lists `{ path }` entries is checked
 * against the writer stage (`options.writer`, default "write"). A path the writer's prompt never names is a
 * file the writer has no reason to create. Only this shape is judged; a writer that is not found is skipped.
 */
function verifyFilesWarnings(
	stage: Stage,
	everyStage: ReadonlyMap<string, Stage>,
): string[] {
	const options = stage.support?.options;
	if (!isRecord(options) || !Array.isArray(options.files)) return [];
	const files = options.files;
	if (files.length === 0) return [];
	const paths: string[] = [];
	for (const entry of files) {
		if (!isRecord(entry) || typeof entry.path !== "string" || entry.path === "")
			return [];
		paths.push(entry.path);
	}
	const writerId =
		typeof options.writer === "string" ? options.writer : "write";
	const writer = everyStage.get(writerId);
	if (!writer || !isModelBacked(writer)) return [];
	const prompt = [writer.prompt, writer.each?.prompt]
		.filter((text): text is string => typeof text === "string")
		.join("\n");
	return paths
		.filter((path) => !prompt.includes(path))
		.map(
			(path) =>
				`stage "${stage.id}" checks ${JSON.stringify(path)} (support.options.files) but the prompt of its writer "${writerId}" does not name that path, so the writer has no reason to create it and the check would fail. Name the path in the writer's prompt, or correct the path.`,
		);
}

// Retries or attempts the model is asked to manage inside one stage ("make at most 3 repair attempts",
// "retry up to 3 times", "repeat until the tests pass", "stop as soon as npm test exits 0"). The engine
// can neither enforce nor observe those attempts, and a loop with a code-decided exit can. Precision over
// recall: each pattern needs the count, the "until" or the stop condition next to the attempt word, so a
// domain noun ("retry logic", "payment retries") never matches.
const COUNT_WORD =
	"(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple)";
const SELF_RETRY: RegExp[] = [
	new RegExp(
		`\\b(?:at most|up to|no more than|maximum of|max(?:imum)?|never (?:run )?more than|a limit of)\\s+${COUNT_WORD}\\s+(?:[\\w-]+\\s+){0,3}?(?:attempts?|tries|retries|re-?runs?)\\b`,
		"i",
	),
	/\b(?:retry|retries|try again|re-?try|re-?run|repeat)\b[^.\n]{0,80}\b(?:up to|at most|until|as many times as)\b/i,
	/\b(?:up to|at most)\s+\S+\s+(?:times|retries|rounds|iterations)\b[^.\n]{0,40}\b(?:retry|try|repeat|fix|re-?run)/i,
	/\b(?:until|till)\b[^.\n]{0,60}\b(?:pass(?:es|ed|ing)?|green|succeeds?|succeeded|exits? (?:with )?(?:status |code )?0)\b/i,
	/\bkeep (?:trying|fixing|iterating|retrying)\b/i,
	/\bstop (?:early |immediately )?(?:as soon as|when|once|after the first)\b[^.\n]{0,60}\b(?:pass(?:es|ed|ing)?|green|exits? (?:with )?(?:status |code )?0|succeeds?)\b/i,
];

// Re-reading with a larger window or after a truncated tool result ("if the projection is truncated, retry
// with a larger maxChars") is one tool call repeated, not an attempt loop the engine could own.
const TOOL_READ_RETRY =
	/\b(?:maxChars|originalChars|truncat\w*|larger|continuation|next page|pagination)\b/i;

// Depth tiers the model is asked to apply to itself per item ("deeper investigation for hard items",
// "for trivial inspect at most 1 file; for deep do 3 steps", "follow the item's depth cap").
const TIER_WORD =
	"(?:trivial|quick|easy|simple|light|shallow|focused|standard|medium|deep|hard|complex|difficult)";
const SELF_TIER: RegExp[] = [
	/\b(?:depth|effort|step)s?\s+(?:cap|budget|limit)s?\b/i,
	new RegExp(
		`\\bfor\\s+(?:a\\s+|an\\s+)?${TIER_WORD}\\s+(?:items?|issues?|cases?|problems?|findings?|questions?)?[^.\\n;]{0,60}\\b(?:at most|up to|exactly|no more than)\\s+${COUNT_WORD}\\s+(?:[\\w-]+\\s+){0,2}?(?:steps?|files?|passes?|rounds?|checks?|tool calls?|searches|reads)\\b`,
		"i",
	),
	/\b(?:deeper|more (?:steps|passes|rounds|effort|investigation)|extra (?:steps|passes|rounds)|additional (?:steps|passes|rounds))\b[^.\n]{0,60}\b(?:hard|harder|difficult|complex|complicated|deep|risky)\s+(?:items?|issues?|cases?|problems?|findings?|questions?)\b/i,
	/\b(?:hard|harder|difficult|complex|complicated|deep|risky)\s+(?:items?|issues?|cases?|problems?|findings?|questions?)\b[^.\n]{0,60}\b(?:deeper|more (?:steps|passes|rounds|effort|investigation)|extra (?:steps|passes|rounds)|additional (?:steps|passes|rounds))\b/i,
];

function selfManagedControlWarnings(stage: Stage): string[] {
	// A dynamic controller decides rounds and depth in the engine's own loop; support stages run code.
	if (!isModelBacked(stage) || stage.type === "dynamic") return [];
	const prompt = [stage.prompt, stage.each?.prompt]
		.filter((text): text is string => typeof text === "string")
		.join("\n");
	const warnings: string[] = [];
	let phrase: string | undefined;
	for (const pattern of SELF_RETRY) {
		const found = pattern.exec(prompt)?.[0];
		if (found !== undefined && !TOOL_READ_RETRY.test(found)) {
			phrase = found;
			break;
		}
	}
	if (phrase)
		warnings.push(
			`stage "${stage.id}" asks the model to manage its own retries or attempts ("${phrase.trim()}"), outside a loop. The engine cannot enforce or observe that count or when it stops. Use a \`loop\` stage (bounded \`maxRounds\`, an exit decided in code from a check stage or helper) and give each round one attempt; \`agent-workflow new fix-loop <name>\` generates one for fixing failing tests.`,
		);
	phrase = undefined;
	for (const pattern of SELF_TIER) {
		phrase = pattern.exec(prompt)?.[0];
		if (phrase) break;
	}
	if (phrase)
		warnings.push(
			`stage "${stage.id}" asks the model to scale its own depth by item difficulty ("${phrase.trim()}"). The engine cannot enforce or observe tiers written as prompt text. Have a plan or support stage assign each item a tier in code and give each tier its own bounded stage (or a dynamic controller), instead of one prompt with all tiers; \`agent-workflow new adaptive-depth <name>\` generates that triage.`,
		);
	return warnings;
}

function readOnlyCommandWarnings(
	stage: Stage,
	readOnlyDefault: boolean | undefined,
): string[] {
	if (!isModelBacked(stage) || stage.type === "dynamic") return [];
	const readOnly = stage.each?.readOnly ?? stage.readOnly ?? readOnlyDefault;
	if (readOnly !== true) return [];
	const prompt = [stage.prompt, stage.each?.prompt]
		.filter((text): text is string => typeof text === "string")
		.join("\n");
	let phrase: string | undefined;
	for (const pattern of FORBIDS_COMMANDS) {
		phrase = pattern.exec(prompt)?.[0];
		if (phrase) break;
	}
	if (!phrase) return [];
	return [
		`stage "${stage.id}" is readOnly and its prompt forbids running commands ("${phrase}"). Codex reads files through shell commands, so this can leave it with no way to read. Forbid the effect instead (for example "do not modify files, run tests or run builds").`,
	];
}

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
			const consequence = !isModelBacked(finalChild)
				? "the helper should return this field explicitly"
				: lookup.closed
					? "the schema sets additionalProperties: false, so the model can never emit it and the loop can only end exhausted"
					: "nothing makes the model emit it";
			warnings.push(
				`loop stage "${loop.id}" until path "${leaf.path}" is not declared in the control schema (${controlSchema}) of its final child "${finalChild.id}": ${consequence}. Add "${lookup.property}" to that schema's properties${isModelBacked(finalChild) ? " and show it in the child's prompt" : ""}, or point until at a declared field.`,
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
