// New in agent-workflow (WP13): the `agent-workflow` host MCP server over stdio: the shared
// protocol layer (../stdio-server.ts) with the eight workflow tools (./tools.ts).
import type { Readable, Writable } from "node:stream";

import { serveMcpStdioServer } from "../stdio-server.js";
import {
	createHostMcpService,
	HOST_MCP_SERVER_NAME,
	type HostMcpServiceOptions,
	hostMcpInstructions,
	hostMcpToolDefinitions,
} from "./tools.js";

export interface HostMcpStdioOptions extends HostMcpServiceOptions {
	input: Readable;
	output: Writable;
	log: (message: string) => void;
	serverVersion: string;
	/** Called once after input EOF (or `shutdown()`) and all in-flight calls have answered. */
	onDrained: () => void;
	/** 2026-11-05: tool calls wait for this first (the login-shell PATH, login-shell-path.ts). */
	ready?: Promise<unknown>;
}

export function serveHostMcpStdio(options: HostMcpStdioOptions): {
	shutdown(): void;
} {
	const service = createHostMcpService(options);
	return serveMcpStdioServer({
		input: options.input,
		output: options.output,
		log: options.log,
		serverInfoName: HOST_MCP_SERVER_NAME,
		serverVersion: options.serverVersion,
		instructions: hostMcpInstructions(options.waitSliceMs),
		tools: (protocolVersion) =>
			hostMcpToolDefinitions(protocolVersion, options.waitSliceMs),
		callTool: async (name, args, context) => {
			await options.ready;
			return service.call(name, args, context);
		},
		onDrained: options.onDrained,
	});
}
