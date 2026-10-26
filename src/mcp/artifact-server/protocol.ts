// New in agent-workflow (WP5): MCP protocol constants for the hand-written stdio artifact server.
// Zero runtime dependencies; the version list is checked against @modelcontextprotocol/sdk
// (devDependency) in test/unit/mcp-sdk-interop.test.mjs.

/**
 * MCP revisions this server speaks, newest first. Matches the published revisions in the
 * official SDK's `SUPPORTED_PROTOCOL_VERSIONS`, minus the pre-release `2024-10-07` draft (never a
 * published spec revision). The server uses only `initialize`/`ping`/`tools/list`/`tools/call` and
 * text content, which every listed revision defines identically; per-revision differences
 * (batches in 2025-03-26, tool `annotations` from 2025-03-26, tool `title` from 2025-06-18) are
 * gated on the negotiated version.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
] as const;

export type McpProtocolVersion =
	(typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];

export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = "2025-11-25";

/**
 * Lifecycle rule (spec "Version Negotiation"): echo the client's version when supported,
 * otherwise answer with the latest version this server supports and let the client decide.
 */
export function negotiateMcpProtocolVersion(
	requested: string,
): McpProtocolVersion {
	return (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
		requested,
	)
		? (requested as McpProtocolVersion)
		: MCP_LATEST_PROTOCOL_VERSION;
}

/** JSON-RPC batches exist only in the 2025-03-26 revision (added there, removed in 2025-06-18). */
export function mcpVersionAllowsBatch(version: string | undefined): boolean {
	return version === "2025-03-26";
}

/** Tool `annotations` were introduced in 2025-03-26. */
export function mcpVersionHasToolAnnotations(version: string): boolean {
	return version !== "2024-11-05";
}

/** Tool `title` was introduced in 2025-06-18. */
export function mcpVersionHasToolTitle(version: string): boolean {
	return version !== "2024-11-05" && version !== "2025-03-26";
}

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export class JsonRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = "JsonRpcError";
		this.code = code;
	}
}
