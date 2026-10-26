// New in agent-workflow (WP5, R#9): delivery bound for workflow_artifact results. A CLI may cut an
// MCP tool result again after the server returned it, so the server cuts first, below the
// client's limit, and records every cut read as `deliveryUnverified` in the read ledger.
import {
	MCP_OUTPUT_LIMIT_DEFAULT_CHARS,
	MCP_OUTPUT_LIMIT_MAX_CHARS,
	MCP_OUTPUT_LIMIT_MIN_CHARS,
} from "../../sdk/mcp-delivery.js";

export {
	cutToDeliveryBudget,
	fitsDeliveryLimit,
} from "../../sdk/mcp-delivery.js";

/**
 * Used when the executor does not pass `--max-output-chars`. Below every client limit found for
 * the stage-1 executors (Pi 1.1 cuts text results above 20 KiB; Claude Code caps MCP output at
 * MAX_MCP_OUTPUT_TOKENS, default 25,000 tokens; Codex applies a per-tool output token limit of
 * roughly 10k tokens/bytes by default), with headroom for client-side wrapping/escaping. All of
 * these are unverified until WP6–WP8 measure them.
 */
export const DEFAULT_MCP_OUTPUT_LIMIT_CHARS = MCP_OUTPUT_LIMIT_DEFAULT_CHARS;

/** Smallest accepted `--max-output-chars`: room for the header plus the cut notice. */
export const MIN_MCP_OUTPUT_LIMIT_CHARS = MCP_OUTPUT_LIMIT_MIN_CHARS;

/** Largest accepted `--max-output-chars` (16 MiB): a sanity bound, not a client limit. */
export const MAX_MCP_OUTPUT_LIMIT_CHARS = MCP_OUTPUT_LIMIT_MAX_CHARS;

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
