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
