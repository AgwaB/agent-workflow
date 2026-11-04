// JSON value normalizers shared by the dynamic-workflow records and the state-root/batch identity
// checks (moved here unchanged from their copies, refactor 2026-11-04).

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops undefined object entries, recursively; key order and arrays are kept. */
export function pruneUndefined<T>(value: T): T {
	if (Array.isArray(value))
		return value.map((item) => pruneUndefined(item)) as T;
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = pruneUndefined(item);
	}
	return result as T;
}

/** Sorts object keys recursively; undefined entries are kept (assigned
 * into a fresh object, so an own "__proto__" key sets the prototype). The dynamic-state digests. */
export function toStableJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => toStableJson(item));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort())
		result[key] = toStableJson(value[key]);
	return result;
}

/** What JSON.stringify/parse round-trips to (undefined → null at the top level). */
export function toJsonNormalizedValue(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
}

/** Sorts object keys recursively and drops undefined entries (built with
 * Object.fromEntries, so "__proto__" stays an own key). The state-root and foreach-batch identity
 * digests; not interchangeable with toStableJson. */
export function canonicalWithoutUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalWithoutUndefined);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonicalWithoutUndefined(entry)]),
		);
	}
	return value;
}

export function hasRequiredKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.every((key) => Object.hasOwn(value, key));
}
