import { parseSimpleJsonPath } from "./workflow-runtime.js";

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
	// The same tokenizer the runtime reads the path with (`$.work-items` is one property).
	const tokens = parseSimpleJsonPath(path);
	if (!tokens) return { status: "unknown" };
	let current: unknown = schema;
	for (const token of tokens) {
		if (!isRecord(current)) return { status: "unknown" };
		if (COMBINATOR_KEYS.some((key) => Object.hasOwn(current as object, key))) {
			return { status: "unknown" };
		}
		if (token.type === "property") {
			const properties = current.properties;
			if (!isRecord(properties)) return { status: "unknown" };
			if (!Object.hasOwn(properties, token.key)) {
				return {
					status: "missing",
					property: token.key,
					closed: current.additionalProperties === false,
				};
			}
			current = properties[token.key];
			continue;
		}
		if (!isRecord(current.items)) return { status: "unknown" };
		current = current.items;
	}
	return { status: "found", schema: current };
}

export type ArrayBoundLookup = "present" | "absent" | "unknown";

// Keywords through which a schema may bound an array in a way this scan does not follow.
const UNPROVABLE_BOUND_KEYS = [
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"$ref",
	"$dynamicRef",
];

/**
 * Whether an array schema carries `minItems`/`maxItems`: directly or through `allOf` (all branches
 * apply, so one proven branch proves the bound). A bound that might live behind another combinator
 * or a reference is `unknown`, never `absent`, so callers stay silent rather than assert a gap.
 */
export function lookupArrayBound(
	schema: unknown,
	key: "minItems" | "maxItems",
): ArrayBoundLookup {
	if (!isRecord(schema)) return "unknown";
	if (typeof schema[key] === "number") return "present";
	let result: ArrayBoundLookup = "absent";
	if (UNPROVABLE_BOUND_KEYS.some((name) => Object.hasOwn(schema, name))) {
		result = "unknown";
	}
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) {
			const found = lookupArrayBound(branch, key);
			if (found === "present") return "present";
			if (found === "unknown") result = "unknown";
		}
	}
	return result;
}
