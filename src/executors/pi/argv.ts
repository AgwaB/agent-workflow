// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/runners/headless-model.ts
// (`buildPiArgv`, lines ~588–643) and @agwab/pi-workflow 0.16.4 (b83cc4f)
// src/workflow-native-host-context.ts (`workflowNativeLaunchTools`). MIT, same author.
// Changes: input is the SDK `SubmitRequest` (plus the Pi executor config) instead of agent
// definitions; the prompt goes to stdin instead of argv (no argv length limit, no prompt in `ps`);
// the system prompt is a file path; B5 isolation adds `-ne -ns -np --no-themes -na` next to the
// ported `--no-context-files`; MCP servers and Pi-only options are carried by one generated per-run
// extension (`-e`); `--session-dir` keeps D3 sessions under adapter state.
import type { ToolKind } from "../../sdk/events.js";
import {
	isMutatingKind,
	type ToolMapping,
	type ToolMappingEntry,
	toolKind,
} from "../../sdk/tools.js";

/** Pi `--thinking` levels (Pi 1.1 `docs/cli.md`); clamped by Pi to the model's capabilities. */
export const PI_EFFORT_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Pi built-in tools (Pi 1.1 `docs/cli.md` "Tools"). `powershell` is Windows-only and not mapped. */
export const PI_BUILTIN_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

/** Tools of the `pi-web-access` extension (C2: Pi's native web tools). */
export const PI_WEB_TOOLS = ["web_search", "fetch_content"] as const;

/** MCP server the engine injects for `workflow_artifact` (WP5). */
export const ARTIFACT_SERVER = "workflow_artifact";

/**
 * Pi tool name → Pi executor tool. Identity for built-ins and web tools; `workflow_artifact` is the
 * engine's MCP server reached through Pi's native MCP as `mcp__workflow_artifact__workflow_artifact`.
 */
export const PI_EXECUTOR_TOOL_MAPPING: ToolMapping = {
	executorId: "pi",
	entries: {
		...Object.fromEntries(
			[...PI_BUILTIN_TOOLS, ...PI_WEB_TOOLS].map(
				(name): [string, ToolMappingEntry] => [
					name,
					{ type: "tool", names: [name] },
				],
			),
		),
		workflow_artifact: {
			type: "mcp",
			server: ARTIFACT_SERVER,
			tool: "workflow_artifact",
		},
	},
	kinds: {
		codemode: "execute",
		tool_search: "search",
		list_mcp_resources: "read",
		list_mcp_resource_templates: "read",
		read_mcp_resource: "read",
	},
};

/** Tools `inheritHostTools` adds (pi-workflow `workflowNativeLaunchTools`). */
export const INHERITED_HOST_TOOLS = [
	"codemode",
	"tool_search",
	"mcp__*",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
] as const;

/** `mcp__<server>__<tool>` with chars outside `[A-Za-z0-9_]` → `_` (Pi 1.1 `docs/mcp.md`). */
export function piMcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/gu, "_");
}

/** `--tools` pattern that declares every tool of one injected server. */
export function piMcpServerPattern(server: string): string {
	return `${piMcpToolName(server, "")}*`;
}

/** ACP kind of a Pi-visible tool name (built-ins, extension tools, MCP tools). */
export function piToolKind(name: string): ToolKind {
	if (name === piMcpToolName(ARTIFACT_SERVER, "workflow_artifact"))
		return "read";
	if (name.startsWith("mcp__")) return "other";
	return toolKind(name, PI_EXECUTOR_TOOL_MAPPING);
}

export interface PiArgvOptions {
	readonly piCommand: string;
	/** B5: workers ignore the user's extensions, skills, prompt templates, themes, context files and project settings. */
	readonly isolated: boolean;
	/**
	 * Keep the session (D3) under `dir` with this id; absent = `--no-session`. `resumePath` opens a
	 * kept session file directly (`--session <path>` is not scoped to the cwd, `--session-id` is).
	 */
	readonly session?: {
		readonly dir: string;
		readonly id: string;
		readonly resumePath?: string;
	};
	readonly systemPromptPath?: string;
	readonly model?: string;
	readonly thinking?: string;
	/** Final `--tools` allowlist (Pi names and MCP patterns). Empty = `--no-tools`. */
	readonly tools: readonly string[];
	/** Extension paths or `builtin:<name>` loaded with `-e`, in order. */
	readonly extensions: readonly string[];
}

/** Pi argv for one attempt. The prompt is written to stdin (Pi prepends piped stdin to the prompt). */
export function buildPiArgv(options: PiArgvOptions): [string, ...string[]] {
	const argv: [string, ...string[]] = [
		options.piCommand,
		"--mode",
		"json",
		"--print",
	];
	if (options.session?.resumePath !== undefined)
		argv.push(
			"--session-dir",
			options.session.dir,
			"--session",
			options.session.resumePath,
		);
	else if (options.session !== undefined)
		argv.push(
			"--session-dir",
			options.session.dir,
			"--session-id",
			options.session.id,
		);
	else argv.push("--no-session");
	argv.push("--exclude-tools", "subagent");
	if (options.isolated)
		argv.push(
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-approve",
		);
	if (options.systemPromptPath !== undefined)
		argv.push("--system-prompt", options.systemPromptPath);
	if (options.model !== undefined) argv.push("--model", options.model);
	if (options.thinking !== undefined) argv.push("--thinking", options.thinking);
	if (options.tools.length > 0) argv.push("--tools", options.tools.join(","));
	else argv.push("--no-tools");
	for (const extension of options.extensions) argv.push("-e", extension);
	return argv;
}

/** Drop mutating tools for readOnly stages (Pi has no sandbox: the allowlist is the enforcement). */
export function readOnlyTools(tools: readonly string[]): {
	kept: string[];
	dropped: string[];
} {
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const tool of tools)
		(isMutatingKind(piToolKind(tool)) ? dropped : kept).push(tool);
	return { kept, dropped };
}
