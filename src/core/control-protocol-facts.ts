// Facts about a control schema that the output protocol states in the prompt, so the author need not
// (compiler.ts "Workflow Output Protocol"). Conservative: only the root level of the schema is read,
// and anything not plainly decided gives no fact.

import { parseSimpleJsonPath } from "./workflow-runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one value the root schema allows for `control.schema` (`const` or a one-value `enum`), if any. */
export function pinnedControlSchemaId(schema: unknown): string | undefined {
	if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
	const property = schema.properties.schema;
	if (!isRecord(property)) return undefined;
	if (typeof property.const === "string" && property.const.length > 0)
		return property.const;
	if (
		Array.isArray(property.enum) &&
		property.enum.length === 1 &&
		typeof property.enum[0] === "string" &&
		property.enum[0].length > 0
	)
		return property.enum[0];
	return undefined;
}

/** Root `required` properties that are arrays with `minItems >= 1`: an empty answer fails validation. */
export function requiredNonEmptyLists(schema: unknown): string[] {
	if (
		!isRecord(schema) ||
		!isRecord(schema.properties) ||
		!Array.isArray(schema.required)
	)
		return [];
	const properties = schema.properties;
	return schema.required.filter((key): key is string => {
		if (typeof key !== "string") return false;
		const property = properties[key];
		return (
			isRecord(property) &&
			(property.type === "array" || isRecord(property.items)) &&
			typeof property.minItems === "number" &&
			property.minItems >= 1
		);
	});
}

/**
 * Root keys of `stageId`'s control output that a `foreach` among `siblings` fans out over: its `from` is
 * `{source: stageId, path: "$.<key>…"}` (`stage` is the older spelling of `source`).
 */
export function foreachReadKeys(
	siblings: readonly unknown[],
	stageId: string,
): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const sibling of siblings) {
		if (!isRecord(sibling) || sibling.type !== "foreach") continue;
		const from = sibling.from;
		if (!isRecord(from)) continue;
		if ((from.source ?? from.stage) !== stageId) continue;
		if (typeof from.path !== "string") continue;
		const first = parseSimpleJsonPath(from.path)?.[0];
		if (first?.type === "property") keys.add(first.key);
	}
	return keys;
}

/**
 * Sentence that gives a stage with a required non-empty list its honest way out. Only a list that a
 * `foreach` reads (`fannedOut`) gets it: that is the inventory case, where an invented item becomes a
 * task. Lists that are evidence rows have their own empty/unreadable exits. The prompt already saying
 * `inputIntegrity` means the author handled it, so nothing is added then.
 */
export function noInventSentence(
	schema: unknown,
	authorPrompt: string,
	fannedOut: ReadonlySet<string>,
): string | undefined {
	if (authorPrompt.includes("inputIntegrity")) return undefined;
	const lists = requiredNonEmptyLists(schema).filter((key) =>
		fannedOut.has(key),
	);
	if (lists.length === 0) return undefined;
	const names = lists.map((key) => `\`${key}\``).join(", ");
	return `${names} must contain at least one item. Do not invent items: if you find none or cannot read the inputs, report control.inputIntegrity {"status":"blocked","reason":"inconsistent_input","detail":"what you could not do"} instead.`;
}
