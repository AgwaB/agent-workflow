// New in agent-workflow (WP11b): the structural subset of Pi's extension API (Pi 1.1,
// `@earendil-works/pi-coding-agent` `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`,
// `ToolDefinition`) that the Pi host uses. Declared locally so the package type-checks and builds
// without the optional Pi peer installed; Pi passes its real objects, which satisfy these shapes.

export type PiNotifyLevel = "info" | "warning" | "error";

export interface PiUiContext {
	notify(message: string, type?: PiNotifyLevel): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Footer status entry; `undefined` clears it (WP16). Fire-and-forget in RPC mode. */
	setStatus?(key: string, text: string | undefined): void;
}

export interface PiModelLike {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
	// Pi's model object carries more fields; only these are read.
	[key: string]: unknown;
}

/** `ExtensionContext` (event handlers, tools) and `ExtensionCommandContext` (commands). */
export interface PiExtensionContext {
	ui: PiUiContext;
	mode?: "tui" | "rpc" | "json" | "print" | string;
	/** Dialog-capable UI (TUI and RPC modes). */
	hasUI: boolean;
	cwd: string;
	model?: PiModelLike | undefined;
	modelRegistry?: { getAvailable?: () => PiModelLike[] } | undefined;
	/** WP35: Pi 1.1 project trust (present with native MCP); host-tool inheritance records it. */
	isProjectTrusted?: () => boolean;
	/** WP16: the session id is the audience of completion delivery. */
	sessionManager?:
		| {
				getSessionId?: () => string;
				/**
				 * WP19: all session entries (Pi `ReadonlySessionManager.getEntries()`); completion
				 * delivery looks for its own `custom_message` here after a crash.
				 */
				getEntries?: () => unknown[];
		  }
		| undefined;
}

/** `pi.sendMessage` custom message (WP16 completion delivery). */
export interface PiCustomMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: Record<string, unknown>;
}

export interface PiToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown> | undefined;
	isError?: boolean;
}

export type PiToolUpdate = (partial: PiToolResult) => void;

export interface PiToolDefinition {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	/** JSON Schema object (TypeBox schemas are JSON Schema). */
	parameters: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	/** WP28: `deferred` keeps the tool out of each request until Pi's `tool_search` loads it. */
	exposure?: "deferred";
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: PiToolUpdate | undefined,
		ctx: PiExtensionContext,
	): Promise<PiToolResult>;
}

export interface PiCommandOptions {
	description?: string;
	getArgumentCompletions?: (
		prefix: string,
	) => Array<{ value: string; label: string; description?: string }> | null;
	handler: (args: string, ctx: PiExtensionContext) => Promise<void>;
}

export interface PiSessionStartEvent {
	type: "session_start";
	reason?: string;
}

/** `ExtensionAPI` subset. */
export interface PiExtensionApi {
	registerTool(tool: PiToolDefinition): void;
	registerCommand(name: string, options: PiCommandOptions): void;
	on(
		event: "session_start",
		handler: (
			event: PiSessionStartEvent,
			ctx: PiExtensionContext,
		) => void | Promise<void>,
	): () => void;
	on(
		event: "session_shutdown",
		handler: (event: unknown, ctx: PiExtensionContext) => void | Promise<void>,
	): () => void;
	getThinkingLevel?: () => string | undefined;
	/** WP35: Pi 1.1 native MCP (its presence marks a native codemode/MCP host). */
	getMcpServers?: () => unknown;
	sendMessage?(
		message: PiCustomMessage,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): void | Promise<void>;
}
