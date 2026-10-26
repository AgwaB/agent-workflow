/**
 * The conformance check catalog. Order is the run order. Ids are stable: adapters record them as
 * evidence (`capabilities.*.verifiedWith`), so never reuse an id for a different meaning.
 */
import { type ConformanceCheck, CORE_CHECKS } from "./checks-core.js";
import { LIVE_CHECKS } from "./checks-live.js";
import { MCP_CHECKS } from "./checks-mcp.js";
import { RUNTIME_CHECKS } from "./checks-runtime.js";
import type { ConformanceCheckInfo, ConformanceTier } from "./types.js";

export const CONFORMANCE_CATALOG: readonly ConformanceCheck[] = [
	...CORE_CHECKS,
	...MCP_CHECKS,
	...LIVE_CHECKS,
	...RUNTIME_CHECKS,
];

/** JSON-serializable view of the catalog (no functions). */
export function describeCatalog(
	catalog: readonly ConformanceCheck[] = CONFORMANCE_CATALOG,
): ConformanceCheckInfo[] {
	return catalog.map(({ id, tier, area, title, refs, scenarios, pending }) =>
		pending === undefined
			? { id, tier, area, title, refs, scenarios }
			: { id, tier, area, title, refs, scenarios, pending },
	);
}

/** Count checks per tier (for reports and docs). */
export function catalogCounts(
	catalog: readonly ConformanceCheck[] = CONFORMANCE_CATALOG,
): Record<ConformanceTier, number> {
	const counts: Record<ConformanceTier, number> = {
		offline: 0,
		live: 0,
		runtime: 0,
	};
	for (const check of catalog) counts[check.tier] += 1;
	return counts;
}
