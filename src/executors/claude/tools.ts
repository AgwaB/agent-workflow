/**
 * Workflow tool name → Claude Code tool mapping (plan §2.4, owner decision "workflow tool mapping").
 * Names verified against `claude` 2.1.310 `system/init.tools` and live tool calls (WP8); see
 * docs/executors.md#claude-code for the evidence per row.
 */
import type { ToolKind } from "../../sdk/events.js";
import type { ToolMapping } from "../../sdk/tools.js";

export const ARTIFACT_MCP_SERVER = "workflow_artifact";
export const ARTIFACT_MCP_TOOL = "workflow_artifact";

export const CLAUDE_TOOL_MAPPING: ToolMapping = {
	executorId: "claude",
	entries: {
		read: { type: "tool", names: ["Read"] },
		grep: { type: "tool", names: ["Grep"] },
		find: { type: "tool", names: ["Glob"] },
		// Claude Code 2.1.310 has no LS tool; directory listing is Glob (`*`) (read-only).
		ls: { type: "tool", names: ["Glob"] },
		bash: { type: "tool", names: ["Bash"] },
		edit: { type: "tool", names: ["Edit"] },
		write: { type: "tool", names: ["Write"] },
		web_search: { type: "tool", names: ["WebSearch"] },
		fetch_content: { type: "tool", names: ["WebFetch"] },
		workflow_artifact: {
			type: "mcp",
			server: ARTIFACT_MCP_SERVER,
			tool: ARTIFACT_MCP_TOOL,
		},
	},
};

/** Built-in Claude tools that change state; never offered to safe readOnly workers. */
export const CLAUDE_MUTATING_TOOLS = [
	"Bash",
	"Edit",
	"Write",
	"NotebookEdit",
] as const;

/** Web tools the adapter pre-allows when the stage asks for them (C2: native CLI web tools). */
export const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

const CLAUDE_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
	Read: "read",
	Grep: "search",
	Glob: "search",
	Bash: "execute",
	Edit: "edit",
	MultiEdit: "edit",
	Write: "edit",
	NotebookEdit: "edit",
	WebSearch: "fetch",
	WebFetch: "fetch",
	TodoWrite: "think",
	Task: "other",
	Agent: "other",
};

/** `mcp__<server>__<tool>`, chars outside `[A-Za-z0-9_-]` replaced by `_` (Claude Code rule). */
export function claudeMcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** ACP kind of a Claude tool name (built-in or `mcp__*`). */
export function claudeToolKind(name: string): ToolKind {
	const builtin = CLAUDE_TOOL_KINDS[name];
	if (builtin !== undefined) return builtin;
	if (name === claudeMcpToolName(ARTIFACT_MCP_SERVER, ARTIFACT_MCP_TOOL))
		return "read";
	return "other";
}
