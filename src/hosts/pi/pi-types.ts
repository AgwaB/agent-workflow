// New in agent-workflow (WP11b): the structural subset of Pi's extension API (Pi 1.1,
// `@earendil-works/pi-coding-agent` `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`,
// `ToolDefinition`) that the Pi host uses. Declared locally so the package type-checks and builds
// without the optional Pi peer installed; Pi passes its real objects, which satisfy these shapes.

export type PiNotifyLevel = "info" | "warning" | "error";

export interface PiUiContext {
	notify(message: string, type?: PiNotifyLevel): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
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
}
