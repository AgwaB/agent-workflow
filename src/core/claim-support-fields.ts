// Claim-support field checks shared by output validation, the dynamic state index and the output
// artifacts (moved here unchanged from their copies, refactor 2026-11-04).

export function hasTopLevelClaimSupportFields(
	control: Record<string, unknown>,
): boolean {
	return [
		"claim",
		"sourceLocators",
		"locators",
		"sources",
		"sourceRefs",
		"excerpt",
		"quote",
	].some((key) => control[key] !== undefined);
}

export function isPositiveClaimSupportStatus(value: unknown): boolean {
	return (
		value === "supports" ||
		value === "partial" ||
		value === "verified" ||
		value === "weakened"
	);
}
