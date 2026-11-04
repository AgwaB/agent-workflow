// JSON value normalizers shared by the dynamic-workflow records and the state-root/batch identity
// checks (moved here unchanged from their copies, refactor 2026-11-04).

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function toStableJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => toStableJson(item));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort())
		result[key] = toStableJson(value[key]);
	return result;
}

export function toJsonNormalizedValue(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
}

export function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
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
