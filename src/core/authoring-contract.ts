// Prompt text generated from a control schema, for `agent-workflow new` and `contract`.
// The "Contract" paragraph of a generated prompt (allowed keys, exact enum values, caps, the few-shot
// `<control>` skeleton) is derived from the stage's own schema, so the prompt and the schema start
// in sync and the example is schema-valid by construction. Pure and deterministic: no clock, no randomness.
import {
	type JsonSchema,
	type JsonSchemaObject,
	validateJsonSchema,
} from "./json-schema.js";
import { type SampleValue, sampleFromSchema } from "./schema-sample.js";

function isObject(schema: JsonSchema | undefined): schema is JsonSchemaObject {
	return typeof schema === "object" && schema !== null;
}

function describeValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

interface Walked {
	enums: string[];
	arrayCaps: string[];
	stringCaps: string[];
	numbers: string[];
	booleans: string[];
}

function walk(schema: JsonSchema | undefined, path: string, out: Walked): void {
	if (!isObject(schema)) return;
	if (Array.isArray(schema.enum)) {
		out.enums.push(
			`${path} must be exactly one of: ${schema.enum.map(describeValue).join(", ")}.`,
		);
	}
	if (schema.type === "array") {
		if (typeof schema.maxItems === "number")
			out.arrayCaps.push(`${path}<=${schema.maxItems}`);
		walk(
			Array.isArray(schema.items) ? undefined : schema.items,
			`${path}[]`,
			out,
		);
	} else if (schema.type === "object" && schema.properties !== undefined) {
		for (const [key, child] of Object.entries(schema.properties))
			walk(child, path === "" ? key : `${path}.${key}`, out);
	} else if (
		schema.type === "string" &&
		typeof schema.maxLength === "number" &&
		!Array.isArray(schema.enum) &&
		!Object.hasOwn(schema, "const")
	) {
		out.stringCaps.push(`${path}<=${schema.maxLength}`);
	} else if (schema.type === "integer" || schema.type === "number") {
		const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
		const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
		const kind = schema.type === "integer" ? "an integer" : "a number";
		if (min !== undefined && max !== undefined)
			out.numbers.push(`${path} is ${kind} from ${min} to ${max}.`);
		else out.numbers.push(`${path} is ${kind}.`);
	} else if (schema.type === "boolean") {
		out.booleans.push(`${path} is a JSON boolean (true or false).`);
	}
}

/**
 * A compact, schema-valid example control: the schema's deterministic sample (one item per array)
 * with `overrides` replacing top-level values. Throws when the result is not valid for the schema,
 * so a generator bug cannot ship an example the engine would reject.
 */
export function exampleControl(
	schema: JsonSchemaObject,
	overrides: Record<string, SampleValue> = {},
): string {
	const sampled = sampleFromSchema(schema, { arrayItems: 1 });
	if (
		!sampled.valid ||
		sampled.value === null ||
		typeof sampled.value !== "object" ||
		Array.isArray(sampled.value)
	)
		throw new Error(
			`no sample for schema: ${sampled.issues.map((issue) => issue.message).join("; ")}`,
		);
	const value = {
		...(sampled.value as Record<string, SampleValue>),
		...overrides,
	};
	const check = validateJsonSchema(value, schema);
	if (!check.valid)
		throw new Error(
			`example control does not match its schema: ${check.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
	return JSON.stringify(value);
}

/**
 * The generated "Contract" paragraph of a stage prompt: allowed top-level keys, exact constants and
 * enum values, caps, and a few-shot control skeleton, all taken from `schema`.
 */
export function controlContract(
	schema: JsonSchemaObject,
	overrides: Record<string, SampleValue> = {},
): string {
	const properties = schema.properties ?? {};
	const keys = Object.keys(properties);
	const required = schema.required ?? [];
	const parts: string[] = [];
	const closed = schema.additionalProperties === false;
	parts.push(
		closed && keys.length > 0
			? `Put machine-readable JSON in <control>. Emit no top-level keys other than ${keys.join(", ")}.`
			: "Put machine-readable JSON in <control>.",
	);
	if (!closed && keys.length > 0)
		parts.push(`Declared top-level keys: ${keys.join(", ")}.`);
	if (required.length > 0)
		parts.push(
			closed &&
				keys.every((key) => required.includes(key)) &&
				required.length === keys.length
				? "Every listed key is required."
				: `Required keys: ${required.join(", ")}.`,
		);
	for (const [key, child] of Object.entries(properties))
		if (isObject(child) && Object.hasOwn(child, "const"))
			parts.push(`${key} must be exactly ${JSON.stringify(child.const)}.`);
	const walked: Walked = {
		enums: [],
		arrayCaps: [],
		stringCaps: [],
		numbers: [],
		booleans: [],
	};
	for (const [key, child] of Object.entries(properties))
		walk(child, key, walked);
	parts.push(...walked.enums, ...walked.numbers, ...walked.booleans);
	if (walked.arrayCaps.length > 0)
		parts.push(
			`Array caps: ${walked.arrayCaps.join(", ")}; if more items qualify, keep the most important and summarize the overflow in <analysis> instead of exceeding a cap.`,
		);
	if (walked.stringCaps.length > 0)
		parts.push(
			`String limits in characters: ${walked.stringCaps.join(", ")}; keep every string on one line.`,
		);
	parts.push(
		`Example control (illustrative shape only; use real values): <control>${exampleControl(schema, overrides)}</control>`,
	);
	return parts.join(" ");
}
