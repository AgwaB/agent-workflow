/**
 * MCP output limits (R#9, WP5b): how much the workflow_artifact server may return per tool result
 * for an executor whose probe declares `mcpOutputLimitChars` / `mcpOutputNoticeChars`. Shared by
 * the core (server launch spec) and the conformance kit (`mcp.paged_read`).
 */
import type { ExecutorProbe } from "./contract.js";

/** Artifact-server output limit when the executor declares none (below every stage-1 CLI limit). */
export const MCP_OUTPUT_LIMIT_DEFAULT_CHARS = 8192;
/** Smallest accepted artifact-server output limit: room for a header, a page and the notices. */
export const MCP_OUTPUT_LIMIT_MIN_CHARS = 512;
/** Largest accepted artifact-server output limit (16 MiB): a sanity bound, not a client limit. */
export const MCP_OUTPUT_LIMIT_MAX_CHARS = 16 * 1024 * 1024;
/** Safety margin below the declared limit: 5 % of it … */
export const MCP_OUTPUT_SAFETY_MARGIN_RATIO = 0.05;
/** … but at least this many chars. */
export const MCP_OUTPUT_SAFETY_MARGIN_MIN_CHARS = 256;

/**
 * Output limit for the workflow_artifact server given an executor's probe:
 * `mcpOutputLimitChars − mcpOutputNoticeChars − max(256, ⌈5 % of mcpOutputLimitChars⌉)`, clamped to
 * [{@link MCP_OUTPUT_LIMIT_MIN_CHARS}, {@link MCP_OUTPUT_LIMIT_MAX_CHARS}].
 *
 * - The notice allowance is subtracted although results up to the declared limit pass unchanged:
 *   a CLI whose real cut point is a little lower than declared then still never cuts a page.
 * - The margin covers client-side framing the declaration may not count (content-array joins,
 *   escaping, token-vs-char rounding).
 *
 * `null` when the probe declares no limit: the server then keeps its conservative default (8192).
 */
export function artifactServerOutputLimit(
	probe:
		| Pick<ExecutorProbe, "mcpOutputLimitChars" | "mcpOutputNoticeChars">
		| null
		| undefined,
): number | null {
	const limit = probe?.mcpOutputLimitChars;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
		return null;
	const rawNotice = probe?.mcpOutputNoticeChars;
	const notice =
		typeof rawNotice === "number" &&
		Number.isSafeInteger(rawNotice) &&
		rawNotice > 0
			? rawNotice
			: 0;
	const margin = Math.max(
		MCP_OUTPUT_SAFETY_MARGIN_MIN_CHARS,
		Math.ceil(limit * MCP_OUTPUT_SAFETY_MARGIN_RATIO),
	);
	return Math.min(
		MCP_OUTPUT_LIMIT_MAX_CHARS,
		Math.max(MCP_OUTPUT_LIMIT_MIN_CHARS, limit - notice - margin),
	);
}

/**
 * The limit is unit-agnostic: a text fits when both its UTF-16 length (JS string length, never
 * less than the code-point count) and its UTF-8 byte length are within the limit. That keeps the
 * bound correct whether the client counts chars, code points or bytes.
 */
export function fitsDeliveryLimit(text: string, limit: number): boolean {
	return text.length <= limit && Buffer.byteLength(text, "utf8") <= limit;
}

/** Longest prefix of `text` that fits `budget` (chars and UTF-8 bytes), never splitting a surrogate pair. */
export function cutToDeliveryBudget(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (fitsDeliveryLimit(text, budget)) return text;
	let low = 0;
	let high = Math.min(text.length, budget);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) low = mid;
		else high = mid - 1;
	}
	let end = low;
	const last = text.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
	return text.slice(0, end);
}
