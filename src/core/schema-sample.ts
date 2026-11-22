// Deterministic sample values for the workflow control-schema subset (src/core/json-schema.ts).
// `agent-workflow rehearse` answers every model task with a control generated from the stage's own
// control schema, so a rehearsal exercises the wiring (foreach fan-out, loop `until`, joins) without a
// model. The same schema and options always give the same value: no clock, no randomness.
//
//   const out = sampleFromSchema(schema, { arrayItems: 2 });
//   out.valid / out.value / out.issues   (the value is checked against the schema before it is returned)
import {
	type JsonSchema,
	type JsonSchemaIssue,
	type JsonSchemaObject,
	validateJsonSchema,
} from "./json-schema.js";

/** A JSON value (what a control schema describes). */
export type SampleValue =
	| null
	| boolean
	| number
	| string
	| SampleValue[]
	| { [key: string]: SampleValue };

export interface SchemaSampleOptions {
	/** Items of an array whose schema allows any length (clamped to minItems/maxItems). Default 2. */
	arrayItems?: number;
}

export interface SchemaSampleResult {
	valid: boolean;
	value: SampleValue;
	issues: JsonSchemaIssue[];
}

interface Context {
	arrayItems: number;
	/** Property name the value belongs to (strings are named after it). */
	key: string;
	/** 1-based array positions from the outermost array in, so sibling items differ. */
	indexes: number[];
}

const DEFAULT_ARRAY_ITEMS = 2;

function isRecord(value: unknown): value is Record<string, SampleValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringSample(schema: JsonSchemaObject, context: Context): string {
	const suffix =
		context.indexes.length > 0 ? `-${context.indexes.join("-")}` : "";
	let text = `${context.key}${suffix}`;
	const max =
		typeof schema.maxLength === "number" ? schema.maxLength : undefined;
	const min = typeof schema.minLength === "number" ? schema.minLength : 0;
	if (max !== undefined && text.length > max) {
		// Keep the index suffix: it is what tells sibling items apart.
		text =
			suffix.length < max
				? text.slice(0, max - suffix.length) + suffix
				: text.slice(text.length - max);
	}
	while ([...text].length < min) text += "x";
	return text;
}

function numberSample(schema: JsonSchemaObject, integer: boolean): number {
	let value = 1;
	if (typeof schema.minimum === "number" && value < schema.minimum)
		value = schema.minimum;
	if (typeof schema.maximum === "number" && value > schema.maximum)
		value = schema.maximum;
	return integer ? Math.ceil(value) : value;
}

function firstType(schema: JsonSchemaObject): string | undefined {
	const type = schema.type;
	if (typeof type === "string") return type;
	if (Array.isArray(type))
		return type.find((item) => item !== "null") ?? type[0];
	if (isRecord(schema.properties) || Array.isArray(schema.required))
		return "object";
	if (schema.items !== undefined) return "array";
	return undefined;
}

function matches(value: SampleValue, schema: JsonSchema): boolean {
	return validateJsonSchema(value, schema).valid;
}

const MAX_VARIANTS = 16;

/**
 * `base` narrowed by `extra`: the schema a value must satisfy to satisfy both. Properties merge key by key,
 * `required` unions, lower bounds take the larger value and upper bounds the smaller; for anything else
 * `base` wins and `extra` fills what `base` leaves open (type, enum, const, items).
 */
function mergeSchemas(
	base: JsonSchemaObject,
	extra: JsonSchema,
): JsonSchemaObject {
	if (extra === true) return base;
	if (extra === false) return { ...base, enum: [] };
	const out: JsonSchemaObject = { ...extra, ...base };
	if (isRecord(base.properties) || isRecord(extra.properties)) {
		const properties: Record<string, JsonSchema> = {};
		const left = (base.properties ?? {}) as Record<string, JsonSchema>;
		const right = (extra.properties ?? {}) as Record<string, JsonSchema>;
		for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
			const l = left[key];
			const r = right[key];
			properties[key] =
				l === undefined
					? (r as JsonSchema)
					: r === undefined || typeof l === "boolean"
						? l
						: mergeSchemas(l, r);
		}
		out.properties = properties;
	}
	if (base.required !== undefined || extra.required !== undefined)
		out.required = [
			...new Set([...(base.required ?? []), ...(extra.required ?? [])]),
		];
	for (const key of ["minItems", "minLength", "minimum"] as const) {
		const l = base[key];
		const r = extra[key];
		if (typeof l === "number" && typeof r === "number")
			out[key] = Math.max(l, r);
	}
	for (const key of ["maxItems", "maxLength", "maximum"] as const) {
		const l = base[key];
		const r = extra[key];
		if (typeof l === "number" && typeof r === "number")
			out[key] = Math.min(l, r);
	}
	const items = base.items;
	const otherItems = extra.items;
	if (
		items !== undefined &&
		otherItems !== undefined &&
		!Array.isArray(items) &&
		!Array.isArray(otherItems) &&
		typeof items !== "boolean"
	)
		out.items = mergeSchemas(items, otherItems);
	return out;
}

/**
 * The schemas a value may be generated from: `allOf` merged into the schema, then one variant per
 * `anyOf`/`oneOf` alternative (each merged over the schema), recursively. The first variant that yields a
 * value satisfying the whole schema is used.
 */
function schemaVariants(schema: JsonSchemaObject): JsonSchemaObject[] {
	const { allOf, anyOf, oneOf, ...core } = schema;
	let variants: JsonSchemaObject[] = [core];
	const apply = (parts: readonly JsonSchema[], each: boolean): void => {
		const next: JsonSchemaObject[] = [];
		for (const variant of variants) {
			const choices = each ? parts : [];
			if (!each) {
				let merged = variant;
				for (const part of parts)
					for (const resolved of schemaVariants(
						typeof part === "boolean" ? {} : part,
					).slice(0, 1))
						merged = mergeSchemas(merged, resolved);
				next.push(merged);
				continue;
			}
			for (const part of choices) {
				if (part === false) continue;
				for (const resolved of schemaVariants(part === true ? {} : part))
					next.push(mergeSchemas(variant, resolved));
			}
		}
		variants = next.slice(0, MAX_VARIANTS);
	};
	if (Array.isArray(allOf)) apply(allOf, false);
	if (Array.isArray(anyOf) && anyOf.length > 0) apply(anyOf, true);
	if (Array.isArray(oneOf) && oneOf.length > 0) apply(oneOf, true);
	return variants.length === 0 ? [core] : variants;
}

function sample(schema: JsonSchema, context: Context): SampleValue {
	if (schema === true || schema === false)
		return schema === true ? context.key : null;
	const variants = schemaVariants(schema);
	for (const variant of variants) {
		const value = sampleVariant(variant, context);
		if (matches(value, schema)) return value;
	}
	return sampleVariant(variants[0]!, context);
}

function sampleVariant(own: JsonSchemaObject, context: Context): SampleValue {
	if (Object.hasOwn(own, "const")) return own.const as SampleValue;
	if (Array.isArray(own.enum) && own.enum.length > 0) {
		const { enum: _enum, ...rest } = own;
		// The first member that also satisfies the rest of the schema (type, bounds).
		const members = own.enum as SampleValue[];
		return (
			members.find((candidate) => matches(candidate, rest as JsonSchema)) ??
			members[0]!
		);
	}
	return sampleBase(own, context);
}

function sampleBase(schema: JsonSchemaObject, context: Context): SampleValue {
	const type = firstType(schema);
	switch (type) {
		case "object": {
			const out: Record<string, SampleValue> = {};
			const properties = isRecord(schema.properties) ? schema.properties : {};
			for (const [key, child] of Object.entries(properties))
				out[key] = sample(child as JsonSchema, { ...context, key });
			for (const key of schema.required ?? []) {
				if (key in out) continue;
				const extra = schema.additionalProperties;
				out[key] =
					typeof extra === "object" || extra === true
						? sample(extra === true ? true : (extra as JsonSchema), {
								...context,
								key,
							})
						: key;
			}
			return out;
		}
		case "array": {
			if (Array.isArray(schema.items))
				return schema.items.map((child, index) =>
					sample(child, {
						...context,
						indexes: [...context.indexes, index + 1],
					}),
				);
			const min = typeof schema.minItems === "number" ? schema.minItems : 0;
			const max =
				typeof schema.maxItems === "number"
					? schema.maxItems
					: Number.POSITIVE_INFINITY;
			const count = Math.max(min, Math.min(context.arrayItems, max));
			const child: JsonSchema =
				schema.items === undefined ? true : schema.items;
			return Array.from({ length: count }, (_, index) =>
				sample(child, { ...context, indexes: [...context.indexes, index + 1] }),
			);
		}
		case "string":
			return stringSample(schema, context);
		case "integer":
			return numberSample(schema, true);
		case "number":
			return numberSample(schema, false);
		case "boolean":
			return true;
		case "null":
			return null;
		default:
			return stringSample(schema, context);
	}
}

/**
 * A schema-valid value for `schema`, or the schema's own issues when no sample satisfies it
 * (`valid: false`; `value` is then the best attempt).
 */
export function sampleFromSchema(
	schema: JsonSchema,
	options: SchemaSampleOptions = {},
): SchemaSampleResult {
	const value = sample(schema, {
		arrayItems: Math.max(
			0,
			Math.floor(options.arrayItems ?? DEFAULT_ARRAY_ITEMS),
		),
		key: "value",
		indexes: [],
	});
	const check = validateJsonSchema(value, schema);
	return { valid: check.valid, value, issues: check.issues };
}

/** Sample with an array item count; the context for nested generation of one subschema. */
export function sampleSubschema(
	schema: JsonSchema,
	key: string,
	options: SchemaSampleOptions = {},
): SampleValue {
	return sample(schema, {
		arrayItems: Math.max(
			0,
			Math.floor(options.arrayItems ?? DEFAULT_ARRAY_ITEMS),
		),
		key,
		indexes: [],
	});
}

// ---- JSON paths (`$.a.b[0].c`) over a schema and a value ----

type PathToken = string | number;

/** Tokens of a simple JSON path (`$`, `.key`, `[n]`); undefined for anything else (wildcards, filters). */
export function parseSamplePath(path: string): PathToken[] | undefined {
	if (!path.startsWith("$")) return undefined;
	const tokens: PathToken[] = [];
	let index = 1;
	while (index < path.length) {
		const char = path[index];
		if (char === ".") {
			const match = /^[A-Za-z0-9_$-]+/u.exec(path.slice(index + 1));
			if (!match) return undefined;
			tokens.push(match[0]);
			index += 1 + match[0].length;
		} else if (char === "[") {
			const match = /^\[(\d+)\]/u.exec(path.slice(index));
			if (!match) return undefined;
			tokens.push(Number(match[1]));
			index += match[0].length;
		} else return undefined;
	}
	return tokens;
}

/** The subschema a path points at (properties, tuple or list items); undefined when the schema does not say. */
export function schemaAtPath(
	schema: JsonSchema,
	tokens: readonly PathToken[],
): JsonSchema | undefined {
	let current: JsonSchema | undefined = schema;
	for (const token of tokens) {
		if (current === undefined || typeof current === "boolean") return undefined;
		const next: JsonSchema | undefined = childSchema(current, token);
		current = next;
	}
	return current;
}

function childSchema(
	schema: JsonSchemaObject,
	token: PathToken,
): JsonSchema | undefined {
	if (typeof token === "string") {
		if (isRecord(schema.properties) && Object.hasOwn(schema.properties, token))
			return schema.properties[token] as JsonSchema;
	} else if (Array.isArray(schema.items)) return schema.items[token];
	else if (schema.items !== undefined) return schema.items;
	for (const group of [schema.allOf, schema.anyOf, schema.oneOf]) {
		if (!Array.isArray(group)) continue;
		for (const member of group) {
			if (typeof member === "boolean") continue;
			const found = childSchema(member, token);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** The value at `tokens` inside `root`, or undefined. */
export function getAtPath(
	root: SampleValue,
	tokens: readonly PathToken[],
): SampleValue | undefined {
	let current: SampleValue | undefined = root;
	for (const token of tokens) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string | number, SampleValue>)[token];
	}
	return current;
}

/** Set `value` at `tokens` inside `root`, creating objects/arrays on the way. Returns false when it cannot. */
export function setAtPath(
	root: SampleValue,
	tokens: readonly PathToken[],
	value: SampleValue,
): boolean {
	if (tokens.length === 0) return false;
	let current: SampleValue = root;
	for (const [position, token] of tokens.entries()) {
		const last = position === tokens.length - 1;
		if (typeof token === "number") {
			if (!Array.isArray(current)) return false;
			if (last) {
				current[token] = value;
				return true;
			}
			current[token] ??= typeof tokens[position + 1] === "number" ? [] : {};
			current = current[token];
		} else {
			if (!isRecord(current)) return false;
			if (last) {
				current[token] = value;
				return true;
			}
			current[token] ??= typeof tokens[position + 1] === "number" ? [] : {};
			current = current[token];
		}
	}
	return false;
}

/** Remove the value at `tokens` (an `exists: false` condition). */
export function deleteAtPath(
	root: SampleValue,
	tokens: readonly PathToken[],
): void {
	let current: SampleValue = root;
	for (const token of tokens.slice(0, -1)) {
		if (current === null || typeof current !== "object") return;
		current = (current as Record<string | number, SampleValue>)[token];
	}
	const last = tokens.at(-1);
	if (last === undefined || current === null || typeof current !== "object")
		return;
	if (Array.isArray(current) && typeof last === "number")
		current.splice(last, 1);
	else delete (current as Record<string, SampleValue>)[String(last)];
}

/** Candidate values for a position, tried in order: the schema's own sample, then variations of it. */
export function alternativeValues(
	schema: JsonSchema | undefined,
	key: string,
	avoid: SampleValue,
): SampleValue[] {
	const candidates: Array<SampleValue | undefined> = [];
	if (schema !== undefined && typeof schema !== "boolean") {
		if (Array.isArray(schema.enum))
			candidates.push(...(schema.enum as SampleValue[]));
	}
	const base =
		schema === undefined ? `${key}-other` : sampleSubschema(schema, key);
	candidates.push(
		base,
		!base,
		typeof base === "number" ? base + 1 : undefined,
		typeof base === "number" ? base - 1 : undefined,
		typeof base === "string" ? `${base}-other` : undefined,
		typeof base === "string" ? "" : undefined,
		null,
		0,
		"other",
		false,
		true,
	);
	return candidates.filter(
		(candidate): candidate is SampleValue =>
			candidate !== undefined &&
			!Object.is(candidate, avoid) &&
			(schema === undefined || matches(candidate, schema)),
	);
}
