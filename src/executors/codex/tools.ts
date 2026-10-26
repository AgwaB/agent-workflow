/**
 * Pi tool name → Codex mapping (plan §2.4, owner decision "Pi 도구 이름 매핑", B4, C2).
 * Codex has no per-tool allowlist: file/shell tools are only expressible as a sandbox mode
 * (`toolAllowlist: coarse`). Web tools map to Codex's hosted `web_search` (C2), the artifact tool
 * to the engine-injected MCP server (A2-4). `verified` records whether a live codex-cli run
 * exercised the row (see docs/executors/codex.md).
 */
import {
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_NAME,
} from "../../core/artifact-access.js";
import type { ToolKind } from "../../sdk/events.js";
import {
	mapTools,
	type SandboxMode,
	type ToolMapping,
	type ToolMappingEntry,
} from "../../sdk/tools.js";

export interface CodexToolMappingRow {
	readonly piName: string;
	readonly entry: ToolMappingEntry;
	/** What the Codex model actually uses for it. */
	readonly codexTool: string;
	readonly verified: boolean;
	readonly evidence: string;
}

const READ_ONLY: ToolMappingEntry = { type: "sandbox", mode: "read-only" };
const WRITE: ToolMappingEntry = { type: "sandbox", mode: "workspace-write" };

export const CODEX_TOOL_MAPPING_ROWS: readonly CodexToolMappingRow[] = [
	{
		piName: "read",
		entry: READ_ONLY,
		codexTool: "shell (exec_command: cat/sed/nl) under the read-only sandbox",
		verified: true,
		evidence:
			"live call #1: `cat a.txt` reported as commandExecution with a read action",
	},
	{
		piName: "grep",
		entry: READ_ONLY,
		codexTool: "shell (rg/grep) under the read-only sandbox",
		verified: false,
		evidence: "same shell tool as read; search action not recorded live",
	},
	{
		piName: "find",
		entry: READ_ONLY,
		codexTool: "shell (rg --files/find) under the read-only sandbox",
		verified: false,
		evidence: "same shell tool as read",
	},
	{
		piName: "ls",
		entry: READ_ONLY,
		codexTool: "shell (ls) under the read-only sandbox",
		verified: false,
		evidence:
			"not exercised live; listFiles is a commandActions type in the 0.159.2 protocol",
	},
	{
		piName: "bash",
		entry: WRITE,
		codexTool: "shell (exec_command) under the workspace-write sandbox",
		verified: true,
		evidence:
			"live #12: `touch` under read-only raised an execute approval (denied); live #18: shell ran in workspace-write",
	},
	{
		piName: "edit",
		entry: WRITE,
		codexTool: "apply_patch under the workspace-write sandbox",
		verified: true,
		evidence:
			"live #18: apply_patch created out.txt under workspace-write (disposable temp dir)",
	},
	{
		piName: "write",
		entry: WRITE,
		codexTool: "apply_patch under the workspace-write sandbox",
		verified: true,
		evidence:
			"live #18: apply_patch created out.txt under workspace-write (disposable temp dir)",
	},
	{
		piName: "web_search",
		entry: { type: "tool", names: ["web_search"] },
		codexTool: 'hosted web_search (thread config web_search = "live")',
		verified: true,
		evidence:
			'live #6: webSearch item (action search) under web_search = "live"',
	},
	{
		piName: "fetch_content",
		entry: { type: "tool", names: ["web_search"] },
		codexTool:
			'hosted web_search open_page/find_in_page actions (web_search = "live")',
		verified: false,
		evidence:
			"WebSearchAction openPage exists in the 0.159.2 protocol; not observed live",
	},
	{
		piName: WORKFLOW_ARTIFACT_TOOL_NAME,
		entry: {
			type: "mcp",
			server: ARTIFACT_MCP_SERVER_NAME,
			tool: WORKFLOW_ARTIFACT_TOOL_NAME,
		},
		codexTool: "mcp__workflow_artifact__workflow_artifact (engine MCP server)",
		verified: true,
		evidence:
			"live #2: the model called mcp__workflow_artifact__workflow_artifact by that name",
	},
];

export const CODEX_TOOL_MAPPING: ToolMapping = {
	executorId: "codex",
	entries: Object.fromEntries(
		CODEX_TOOL_MAPPING_ROWS.map((row) => [row.piName, row.entry]),
	),
};

export interface CodexToolPlan {
	readonly sandbox: SandboxMode;
	readonly webSearch: "live" | "disabled";
	readonly unmapped: readonly string[];
	readonly kinds: Readonly<Record<string, ToolKind>>;
}

/**
 * Sandbox + web mode for a request. readOnly always wins (B4/D2). An empty tool list means "no
 * explicit restriction": workspace-write for writable stages, read-only otherwise. The adapter
 * never selects `danger-full-access`.
 */
export function planCodexTools(
	tools: readonly string[],
	readOnly: boolean,
): CodexToolPlan {
	const mapped = mapTools(tools, CODEX_TOOL_MAPPING);
	const webSearch =
		tools.includes("web_search") || tools.includes("fetch_content")
			? "live"
			: "disabled";
	let sandbox: SandboxMode;
	if (readOnly) sandbox = "read-only";
	else if (tools.length === 0) sandbox = "workspace-write";
	else sandbox = mapped.sandbox ?? "read-only";
	return {
		sandbox,
		webSearch,
		unmapped: mapped.unmapped,
		kinds: mapped.kinds,
	};
}
