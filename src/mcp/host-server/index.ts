// WP13 host MCP server: library surface (no side effects). The stdio entry is server.ts; the
// `agent-workflow-mcp` bin (bin.mjs) launches it. docs/host-mcp.md.
export const MODULE = "src/mcp/host-server";

export { type HostMcpStdioOptions, serveHostMcpStdio } from "./serve.js";
export {
	clientSupportsFormElicitation,
	createHostMcpService,
	DEGRADATION_ELICITATION_TITLE,
	HOST_MCP_HOSTS,
	HOST_MCP_INSTRUCTIONS,
	HOST_MCP_MAX_TEXT_CHARS,
	HOST_MCP_SERVER_NAME,
	HOST_MCP_TEXT_ONLY_HOSTS,
	HOST_MCP_TOOLS,
	type HostMcpApi,
	type HostMcpHost,
	type HostMcpService,
	type HostMcpServiceOptions,
	type HostMcpToolDefinition,
	type HostMcpToolResult,
	hostMcpSendsStructuredContent,
	hostMcpToolDefinitions,
	launchRequestFromArguments,
	mcpVersionHasStructuredContent,
	resolveCallCwd,
	WORKFLOW_DYNAMIC_TOOL,
	WORKFLOW_INSPECT_TOOL,
	WORKFLOW_LIST_TOOL,
	WORKFLOW_RUN_TOOL,
	WORKFLOW_STATUS_TOOL,
	WORKFLOW_STOP_TOOL,
	WORKFLOW_VALIDATE_TOOL,
	WORKFLOW_WAIT_TOOL,
} from "./tools.js";
