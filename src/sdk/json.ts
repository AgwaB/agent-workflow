/** JSON-serializable value. Used for anything that is persisted in run records. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** True when `value` survives a JSON round trip unchanged in shape (no functions, symbols, cycles, NaN, undefined). */
export function isJsonValue(
	value: unknown,
	seen: Set<object> = new Set(),
): value is JsonValue {
	if (value === null) return true;
	switch (typeof value) {
		case "boolean":
		case "string":
			return true;
		case "number":
			return Number.isFinite(value);
		case "object": {
			if (seen.has(value)) return false;
			seen.add(value);
			try {
				if (Array.isArray(value))
					return value.every((entry) => isJsonValue(entry, seen));
				const proto: unknown = Object.getPrototypeOf(value);
				if (proto !== Object.prototype && proto !== null) return false;
				return Object.values(value).every((entry) => isJsonValue(entry, seen));
			} finally {
				seen.delete(value);
			}
		}
		default:
			return false;
	}
}

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
