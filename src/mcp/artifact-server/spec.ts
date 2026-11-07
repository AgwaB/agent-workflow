// New in agent-workflow (WP5, R#9): launch spec with the client's MCP output limit. The core spec
// (`artifactMcpServerSpec`) stays `[entry, "--config", path]`; the limit travels as a flag because
// the config file is digested byte-for-byte by launch provenance and admits no extra keys.
// WP5b: the flag logic moved to core (`withArtifactMcpOutputLimit`), which the task runner uses.
import {
	ARTIFACT_MCP_OUTPUT_LIMIT_FLAG,
	type ArtifactAccessConfig,
	artifactMcpServerSpec,
	withArtifactMcpOutputLimit,
} from "../../core/artifact-access.js";
import type { McpServerSpec } from "../../sdk/contract.js";

export const MAX_OUTPUT_CHARS_FLAG = ARTIFACT_MCP_OUTPUT_LIMIT_FLAG;

/**
 * `artifactMcpServerSpec(config)` plus `--max-output-chars <limit>` when the executor knows its
 * CLI's MCP output limit (e.g. `artifactServerOutputLimit(probe())`). `null`/`undefined` → server default.
 */
export function artifactMcpServerSpecWithOutputLimit(
	config: ArtifactAccessConfig,
	outputLimitChars: number | null | undefined,
): McpServerSpec {
	return withArtifactMcpOutputLimit(
		artifactMcpServerSpec(config),
		outputLimitChars,
	);
}
