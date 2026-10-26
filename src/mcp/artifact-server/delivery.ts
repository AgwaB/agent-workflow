// New in agent-workflow (WP5, R#9): delivery bound for workflow_artifact results. A CLI may cut an
// MCP tool result again after the server returned it, so the server cuts first, below the
// client's limit, and records every cut read as `deliveryUnverified` in the read ledger.

/**
 * Used when the executor does not pass `--max-output-chars`. Below every client limit found for
 * the stage-1 executors (Pi 1.1 cuts text results above 20 KiB; Claude Code caps MCP output at
 * MAX_MCP_OUTPUT_TOKENS, default 25,000 tokens; Codex applies a per-tool output token limit of
 * roughly 10k tokens/bytes by default), with headroom for client-side wrapping/escaping. All of
 * these are unverified until WP6–WP8 measure them.
 */
export const DEFAULT_MCP_OUTPUT_LIMIT_CHARS = 8192;

/** Smallest accepted `--max-output-chars`: room for the header plus the cut notice. */
export const MIN_MCP_OUTPUT_LIMIT_CHARS = 512;

/** Largest accepted `--max-output-chars` (16 MiB): a sanity bound, not a client limit. */
export const MAX_MCP_OUTPUT_LIMIT_CHARS = 16 * 1024 * 1024;

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

export function parseOutputLimit(value: string): number {
	if (!/^\d+$/u.test(value))
		throw new Error("--max-output-chars must be a positive integer");
	const limit = Number(value);
	if (
		!Number.isSafeInteger(limit) ||
		limit < MIN_MCP_OUTPUT_LIMIT_CHARS ||
		limit > MAX_MCP_OUTPUT_LIMIT_CHARS
	)
		throw new Error(
			`--max-output-chars must be between ${MIN_MCP_OUTPUT_LIMIT_CHARS} and ${MAX_MCP_OUTPUT_LIMIT_CHARS}`,
		);
	return limit;
}

export function readCutNotice(options: {
	limit: number;
	limitSource: "client" | "default";
	bytes: number;
	rawAssurance?: { kind: string; originalBytes: string };
}): string {
	const raw = options.rawAssurance
		? ` [raw assurance: ${options.rawAssurance.kind}; original bytes: ${options.rawAssurance.originalBytes}]`
		: "";
	return `\n\n[workflow_artifact delivery bound: response cut to the ${options.limitSource === "client" ? "client" : "default"} limit of ${options.limit} chars; only a prefix of the ${options.bytes}-byte artifact was delivered. This read is recorded as truncated and deliveryUnverified and does not satisfy required reads. Re-read with path plus maxItems/maxChars for a smaller projection.]${raw}`;
}

export function genericCutNotice(limit: number): string {
	return `\n\n[workflow_artifact delivery bound: response cut to ${limit} chars.]`;
}
