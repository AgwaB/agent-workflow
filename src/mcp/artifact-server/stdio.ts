// New in agent-workflow (WP5): the workflow_artifact MCP server over stdio. WP13 moved the
// hand-written transport and method dispatch to ../stdio-server.ts (shared with the host server);
// this module supplies the artifact tool definition, instructions and call handler.
import type { Readable, Writable } from "node:stream";

import {
	WORKFLOW_ARTIFACT_TOOL_DESCRIPTION,
	WORKFLOW_ARTIFACT_TOOL_GUIDELINES,
	WORKFLOW_ARTIFACT_TOOL_NAME,
	WORKFLOW_ARTIFACT_TOOL_PARAMETERS,
} from "../../core/artifact-access.js";
import {
	mcpVersionHasToolAnnotations,
	mcpVersionHasToolTitle,
} from "./protocol.js";
import { serveMcpStdioServer } from "../stdio-server.js";
import type { ArtifactToolCallResult } from "./service.js";

export const ARTIFACT_MCP_SERVER_INFO_NAME = "agent-workflow-artifact";

export { MAX_MCP_MESSAGE_BYTES } from "../stdio-server.js";

export interface McpStdioOptions {
	input: Readable;
	output: Writable;
	log: (message: string) => void;
	callTool: (args: Record<string, unknown>) => Promise<ArtifactToolCallResult>;
	serverVersion: string;
	/** Called once after input EOF (or `shutdown()`) and all in-flight requests have answered. */
	onDrained: () => void;
}

/** Text the server sends as `instructions` (the core tool guidelines, one per line). */
export function artifactServerInstructions(): string {
	return WORKFLOW_ARTIFACT_TOOL_GUIDELINES.map((line) => `- ${line}`).join(
		"\n",
	);
}

export function artifactToolDefinition(
	version: string,
): Record<string, unknown> {
	return {
		name: WORKFLOW_ARTIFACT_TOOL_NAME,
		...(mcpVersionHasToolTitle(version) ? { title: "Workflow Artifact" } : {}),
		description: WORKFLOW_ARTIFACT_TOOL_DESCRIPTION,
		inputSchema: WORKFLOW_ARTIFACT_TOOL_PARAMETERS,
		...(mcpVersionHasToolAnnotations(version)
			? {
					annotations: {
						title: "Workflow Artifact",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: false,
						openWorldHint: false,
					},
				}
			: {}),
	};
}

export function serveMcpStdio(options: McpStdioOptions): { shutdown(): void } {
	return serveMcpStdioServer({
		input: options.input,
		output: options.output,
		log: options.log,
		serverInfoName: ARTIFACT_MCP_SERVER_INFO_NAME,
		serverVersion: options.serverVersion,
		instructions: artifactServerInstructions(),
		tools: (version) => [artifactToolDefinition(version)],
		callTool: (_name, args) => options.callTool(args),
		onDrained: options.onDrained,
	});
}
