/**
 * Workflow tool name → Codex mapping (plan §2.4, owner decision "workflow tool mapping", B4, C2).
 * Codex has no per-tool allowlist: file/shell tools are only expressible as a sandbox mode
 * (`toolAllowlist: coarse`). Web tools map to Codex's hosted `web_search` (C2), the artifact tool
 * to the engine-injected MCP server (A2-4). `verified` records whether a live codex-cli run
 * exercised the row (see docs/executors.md#codex).
 */
import {
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_NAME,
} from "../../core/artifact-access.js";
import type { ToolKind } from "../../sdk/events.js";
import {
	enforcesReadOnly,
	isUnrestricted,
	type PermissionMode,
} from "../../sdk/permission.js";
import {
	mapTools,
	type SandboxMode,
	type ToolMapping,
	type ToolMappingEntry,
} from "../../sdk/tools.js";

export interface CodexToolMappingRow {
	readonly workflowName: string;
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
		workflowName: "read",
		entry: READ_ONLY,
		codexTool: "shell (exec_command: cat/sed/nl) under the read-only sandbox",
		verified: true,
		evidence:
			"live call #1: `cat a.txt` reported as commandExecution with a read action",
	},
	{
		workflowName: "grep",
		entry: READ_ONLY,
		codexTool: "shell (rg/grep) under the read-only sandbox",
		verified: false,
		evidence: "same shell tool as read; search action not recorded live",
	},
	{
		workflowName: "find",
		entry: READ_ONLY,
		codexTool: "shell (rg --files/find) under the read-only sandbox",
		verified: false,
		evidence: "same shell tool as read",
	},
	{
		workflowName: "ls",
		entry: READ_ONLY,
		codexTool: "shell (ls) under the read-only sandbox",
		verified: false,
		evidence:
			"not exercised live; listFiles is a commandActions type in the 0.159.2 protocol",
	},
	{
		workflowName: "bash",
		entry: WRITE,
		codexTool: "shell (exec_command) under the workspace-write sandbox",
		verified: true,
		evidence:
			"live #12: `touch` under read-only raised an execute approval (denied); live #18: shell ran in workspace-write",
	},
	{
		workflowName: "edit",
		entry: WRITE,
		codexTool: "apply_patch under the workspace-write sandbox",
		verified: true,
		evidence:
			"live #18: apply_patch created out.txt under workspace-write (disposable temp dir)",
	},
	{
		workflowName: "write",
		entry: WRITE,
		codexTool: "apply_patch under the workspace-write sandbox",
		verified: true,
		evidence:
			"live #18: apply_patch created out.txt under workspace-write (disposable temp dir)",
	},
	{
		workflowName: "web_search",
		entry: { type: "tool", names: ["web_search"] },
		codexTool: 'hosted web_search (thread config web_search = "live")',
		verified: true,
		evidence:
			'live #6: webSearch item (action search) under web_search = "live"',
	},
	{
		workflowName: "fetch_content",
		entry: { type: "tool", names: ["web_search"] },
		codexTool:
			'hosted web_search open_page/find_in_page actions (web_search = "live")',
		verified: false,
		evidence:
			"WebSearchAction openPage exists in the 0.159.2 protocol; not observed live",
	},
	{
		workflowName: WORKFLOW_ARTIFACT_TOOL_NAME,
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
		CODEX_TOOL_MAPPING_ROWS.map((row) => [row.workflowName, row.entry]),
	),
};

/** `thread/start` `sandbox`: the mapping's modes plus `danger-full-access` (free mode only). */
export type CodexSandboxMode = SandboxMode | "danger-full-access";

/** `thread/start` `approvalPolicy` values this adapter uses (`AskForApproval` in 0.159.2). */
export type CodexApprovalPolicy = "on-request" | "never";

export interface CodexToolPlan {
	readonly sandbox: CodexSandboxMode;
	readonly approvalPolicy: CodexApprovalPolicy;
	readonly webSearch: "live" | "disabled";
	readonly unmapped: readonly string[];
	readonly kinds: Readonly<Record<string, ToolKind>>;
}

/**
 * Sandbox, approval policy and web mode for a request. Safe readOnly stages use the
 * `read-only` sandbox and `on-request` approvals. Every `free` stage uses `danger-full-access` + approvals `never` (the coarse tool list is
 * accepted, not enforced). `safe` (default when absent): an empty tool list means "no explicit
 * restriction" = workspace-write; otherwise the mapped sandbox; approvals `on-request`;
 * `danger-full-access` is never selected.
 */
export function planCodexTools(
	tools: readonly string[],
	readOnly: boolean,
	permissionMode?: PermissionMode,
): CodexToolPlan {
	const mapped = mapTools(tools, CODEX_TOOL_MAPPING);
	const webSearch =
		tools.includes("web_search") || tools.includes("fetch_content")
			? "live"
			: "disabled";
	const unrestricted = isUnrestricted({
		readOnly,
		...(permissionMode === undefined ? {} : { permissionMode }),
	});
	let sandbox: CodexSandboxMode;
	if (enforcesReadOnly({ readOnly, permissionMode })) sandbox = "read-only";
	else if (unrestricted) sandbox = "danger-full-access";
	else if (tools.length === 0) sandbox = "workspace-write";
	else sandbox = mapped.sandbox ?? "read-only";
	return {
		sandbox,
		approvalPolicy: unrestricted ? "never" : "on-request",
		webSearch,
		unmapped: mapped.unmapped,
		kinds: mapped.kinds,
	};
}
