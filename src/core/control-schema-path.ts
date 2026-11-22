// Static lookup of a simple control JSONPath (`$.a.b[*].c`) in a control JSON Schema, shared by the
// control-schema file checks (schema.ts, an error) and the authoring warnings (compiler).
// Conservative: anything the lookup cannot decide is `unknown`, never `missing`.

export type ControlSchemaPathLookup =
	| { status: "found"; schema: unknown }
	| { status: "unknown" }
	| {
			status: "missing";
			/** The first property the schema does not declare. */
			property: string;
			/** The schema level that lacks it sets `additionalProperties: false`. */
			closed: boolean;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMBINATOR_KEYS = [
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
];

export function lookupControlSchemaPath(
	schema: unknown,
	path: string,
): ControlSchemaPathLookup {
	if (!isRecord(schema) || !path.startsWith("$")) return { status: "unknown" };
	let current: unknown = schema;
	let remainder = path.slice(1);
	while (remainder !== "") {
		if (!isRecord(current)) return { status: "unknown" };
		if (COMBINATOR_KEYS.some((key) => Object.hasOwn(current as object, key))) {
			return { status: "unknown" };
		}
		const property = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(remainder);
		if (property) {
			const properties = current.properties;
			if (!isRecord(properties)) return { status: "unknown" };
			const key = property[1]!;
			if (!Object.hasOwn(properties, key)) {
				return {
					status: "missing",
					property: key,
					closed: current.additionalProperties === false,
				};
			}
			current = properties[key];
			remainder = remainder.slice(property[0].length);
			continue;
		}
		const selector = /^\[(?:\*|\d+|\d*:\d*)\]/.exec(remainder);
		if (!selector || !isRecord(current.items)) return { status: "unknown" };
		current = current.items;
		remainder = remainder.slice(selector[0].length);
	}
	return { status: "found", schema: current };
}
