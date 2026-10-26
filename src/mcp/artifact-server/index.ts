// WP5 artifact MCP server: library surface (no side effects). The stdio entry is server.ts.
export const MODULE = "src/mcp/artifact-server";

export {
	cutToDeliveryBudget,
	DEFAULT_MCP_OUTPUT_LIMIT_CHARS,
	fitsDeliveryLimit,
	MAX_MCP_OUTPUT_LIMIT_CHARS,
	MIN_MCP_OUTPUT_LIMIT_CHARS,
} from "./delivery.js";
export {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	MCP_LATEST_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
	type McpProtocolVersion,
	negotiateMcpProtocolVersion,
} from "./protocol.js";
export {
	type ArtifactMcpLedgerRecord,
	type ArtifactToolCallResult,
	type ArtifactToolService,
	ArtifactServerStartupError,
	createArtifactToolService,
} from "./service.js";
export {
	artifactMcpServerSpecWithOutputLimit,
	MAX_OUTPUT_CHARS_FLAG,
} from "./spec.js";
export {
	ARTIFACT_MCP_SERVER_INFO_NAME,
	artifactServerInstructions,
	artifactToolDefinition,
} from "./stdio.js";
export {
	ARTIFACT_TOOL_NAME_MAPPINGS,
	type ArtifactToolNameMapping,
	artifactToolNameMapping,
	artifactToolVisibleName,
	mcpPrefixedToolName,
} from "../visible-names.js";
