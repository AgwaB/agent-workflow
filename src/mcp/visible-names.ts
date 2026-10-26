// New in agent-workflow (WP5): how each executor's CLI surfaces the workflow_artifact MCP tool to
// the model. Used by WP6–WP8 adapters and prompt rendering. Every row stays `verified: false`
// until the adapter work confirms it against a live CLI.
import {
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_NAME,
} from "../core/artifact-access.js";

export interface ArtifactToolNameMapping {
	readonly executorId: string;
	/** Name the model sees and calls. */
	readonly visibleName: string;
	/** Naming rule the visible name was derived from. */
	readonly rule: string;
	/** Where the rule was taken from (documentation or CLI build inspected). */
	readonly evidence: string;
	/** `true` only after a live run of that CLI called the tool by this name (WP6–WP8). */
	readonly verified: false;
}

/** `mcp__<server>__<tool>` with every char outside `[A-Za-z0-9_]` replaced by `_`. */
export function mcpPrefixedToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/gu, "_");
}

const PREFIXED = mcpPrefixedToolName(
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_NAME,
);

export const ARTIFACT_TOOL_NAME_MAPPINGS: Readonly<
	Record<"claude" | "codex" | "pi", ArtifactToolNameMapping>
> = {
	claude: {
		executorId: "claude",
		visibleName: PREFIXED,
		rule: "mcp__<server>__<tool>",
		evidence:
			"Claude Code MCP documentation (permission rules name MCP tools mcp__<server>__<tool>)",
		verified: false,
	},
	codex: {
		executorId: "codex",
		visibleName: PREFIXED,
		rule: "mcp__<server>__<tool> (unless the non_prefixed_mcp_tool_names feature is on)",
		evidence:
			"codex-cli 0.159.2 build strings: 'MCP tools keep standard MCP identifiers such as mcp__server__tool'",
		verified: false,
	},
	pi: {
		executorId: "pi",
		visibleName: PREFIXED,
		rule: "mcp__<server>__<tool>, chars outside [A-Za-z0-9_] → _, hash suffix on collision",
		evidence: "Pi 1.1.0 docs/mcp.md and createMcpToolName",
		verified: false,
	},
};

export function artifactToolNameMapping(
	executorId: string,
): ArtifactToolNameMapping | undefined {
	return Object.hasOwn(ARTIFACT_TOOL_NAME_MAPPINGS, executorId)
		? ARTIFACT_TOOL_NAME_MAPPINGS[executorId as "claude" | "codex" | "pi"]
		: undefined;
}

/**
 * Name the worker model should call for `executorId`. Unknown executors get the common
 * `mcp__<server>__<tool>` convention (also unverified).
 */
export function artifactToolVisibleName(executorId: string): string {
	return artifactToolNameMapping(executorId)?.visibleName ?? PREFIXED;
}
