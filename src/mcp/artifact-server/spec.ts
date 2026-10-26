// New in agent-workflow (WP5, R#9): launch spec with the client's MCP output limit. The core spec
// (`artifactMcpServerSpec`) stays `[entry, "--config", path]`; the limit travels as a flag because
// the config file is digested byte-for-byte by launch provenance and admits no extra keys.
import {
	type ArtifactAccessConfig,
	artifactMcpServerSpec,
} from "../../core/artifact-access.js";
import type { McpServerSpec } from "../../sdk/contract.js";
import {
	MAX_MCP_OUTPUT_LIMIT_CHARS,
	MIN_MCP_OUTPUT_LIMIT_CHARS,
} from "./delivery.js";

export const MAX_OUTPUT_CHARS_FLAG = "--max-output-chars" as const;

/**
 * `artifactMcpServerSpec(config)` plus `--max-output-chars <limit>` when the executor knows its
 * CLI's MCP output limit (e.g. `probe().mcpOutputLimitChars`). `null`/`undefined` → server default.
 */
export function artifactMcpServerSpecWithOutputLimit(
	config: ArtifactAccessConfig,
	outputLimitChars: number | null | undefined,
): McpServerSpec {
	const spec = artifactMcpServerSpec(config);
	if (outputLimitChars === null || outputLimitChars === undefined)
		return { ...spec, args: [...spec.args] };
	if (
		!Number.isSafeInteger(outputLimitChars) ||
		outputLimitChars < MIN_MCP_OUTPUT_LIMIT_CHARS ||
		outputLimitChars > MAX_MCP_OUTPUT_LIMIT_CHARS
	)
		throw new Error(
			`MCP output limit must be an integer between ${MIN_MCP_OUTPUT_LIMIT_CHARS} and ${MAX_MCP_OUTPUT_LIMIT_CHARS}`,
		);
	return {
		...spec,
		args: [...spec.args, MAX_OUTPUT_CHARS_FLAG, String(outputLimitChars)],
	};
}
