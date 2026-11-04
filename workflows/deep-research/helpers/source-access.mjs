// Source lookups and value guards shared by the deep-research helpers (moved here unchanged from
// their copies, refactor 2026-11-04).

export function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {}).filter(
		([specId]) => specId === stageId || specId.startsWith(`${stageId}.`),
	);
	if (matches.length > 1) {
		throw new Error(
			`deep-research: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

export function asArray(value) {
	return Array.isArray(value) ? value : [];
}

export function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

export function stringOf(value) {
	return typeof value === "string" ? value : undefined;
}
