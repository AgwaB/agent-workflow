// Facts about a control schema that the output protocol states in the prompt, so the author need not
// (compiler.ts "Workflow Output Protocol"). Conservative: only the root level of the schema is read,
// and anything not plainly decided gives no fact.

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
 * Sentence that gives a stage with a required non-empty list its honest way out. The prompt already
 * saying `inputIntegrity` means the author handled it, so nothing is added then.
 */
export function noInventSentence(
	schema: unknown,
	authorPrompt: string,
): string | undefined {
	if (authorPrompt.includes("inputIntegrity")) return undefined;
	const lists = requiredNonEmptyLists(schema);
	if (lists.length === 0) return undefined;
	const names = lists.map((key) => `\`${key}\``).join(", ");
	return `${names} must contain at least one item. Do not invent items: if you find none or cannot read the inputs, report control.inputIntegrity {"status":"blocked","reason":"inconsistent_input","detail":"what you could not do"} instead.`;
}
