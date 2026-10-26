/**
 * `SubmitRequest` → `claude -p` invocation (WP8). Every flag below was checked against
 * `claude --help` 2.1.310 and live runs; docs/executors/claude.md explains each one.
 *
 * Transport: `-p --input-format stream-json --output-format stream-json --verbose
 * --include-partial-messages`. The prompt is written to stdin as one `user` message, which keeps
 * stdin open for the control protocol: `can_use_tool` approval requests (needs
 * `--permission-prompt-tool stdio`) and `interrupt` (cancel). The adapter ends stdin after the
 * `result` event so the CLI exits.
 *
 * Isolation (B5, `inherit: false`): `--setting-sources ""` (no user/project/local settings: no
 * hooks, permission rules, `defaultMode`, plugins, CLAUDE.md), `--strict-mcp-config` (only injected
 * MCP servers), `--disable-slash-commands` (no skills/commands), `--settings
 * {"autoMemoryEnabled":false}` (no auto-memory). Login survives (claude.ai OAuth, verified live).
 * `--bare` is never used: it refuses OAuth ("Not logged in") and still loads user plugins.
 *
 * Permissions (D2): always `--permission-mode default` (user settings may say `auto`); never a
 * bypass/auto-accept mode. Mutating tools are removed for readOnly; otherwise they go through the
 * approval channel. Only web tools the stage asked for and tools of engine-injected MCP servers are
 * pre-allowed.
 */
import { createHash } from "node:crypto";
import type { McpServerSpec, SubmitRequest } from "../../sdk/contract.js";
import { SdkError } from "../../sdk/errors.js";
import { mapTools } from "../../sdk/tools.js";
import type { ClaudeExecutorConfig } from "./config.js";
import {
	CLAUDE_MUTATING_TOOLS,
	CLAUDE_TOOL_MAPPING,
	CLAUDE_WEB_TOOLS,
} from "./tools.js";

export const CLAUDE_EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Pi effort names Claude does not have, mapped to the nearest Claude level. */
const EFFORT_ALIASES: Readonly<Record<string, string>> = { minimal: "low" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
	return UUID.test(value);
}

/**
 * Deterministic worker session id for an attempt (UUID v4 layout over SHA-256). The session id is
 * on argv (`--session-id`), so launch evidence (stub CLI log, `ps`) can be tied to the attempt.
 */
export function attemptSessionId(attemptKey: string): string {
	const hex = createHash("sha256")
		.update(`agent-workflow-claude-attempt:${attemptKey}`)
		.digest("hex");
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
		16,
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Env var that carries `mcpServers[index].env[key]` into the CLI (expanded from `${VAR}`). */
export function mcpEnvVarName(index: number, key: string): string {
	return `AW_CLAUDE_MCP_${index}_${key.replace(/[^A-Za-z0-9_]/gu, "_")}`;
}

export interface ClaudeMcpConfig {
	readonly mcpServers: Record<
		string,
		{
			readonly type: "stdio";
			readonly command: string;
			readonly args: readonly string[];
			readonly env: Readonly<Record<string, string>>;
		}
	>;
}

/**
 * MCP config for `--mcp-config <file>`. Env *values* never reach the file: each value becomes a
 * `${AW_CLAUDE_MCP_<i>_<KEY>}` reference that Claude Code expands from its own environment
 * (verified live: the server saw the value, the file held only the reference).
 */
export function buildMcpConfig(servers: readonly McpServerSpec[]): {
	config: ClaudeMcpConfig;
	env: Record<string, string>;
} {
	const mcpServers: Record<string, ClaudeMcpConfig["mcpServers"][string]> = {};
	const env: Record<string, string> = {};
	servers.forEach((server, index) => {
		if (!/^[A-Za-z0-9_-]+$/u.test(server.name))
			throw new SdkError(
				"INVALID_REQUEST",
				`mcp server name ${JSON.stringify(server.name)} must match [A-Za-z0-9_-]+`,
			);
		if (Object.hasOwn(mcpServers, server.name))
			throw new SdkError(
				"INVALID_REQUEST",
				`duplicate mcp server name ${server.name}`,
			);
		for (const part of [server.command, ...server.args])
			if (part.includes("${"))
				throw new SdkError(
					"INVALID_REQUEST",
					`mcp server ${server.name}: "\${" in command/args would be expanded by Claude Code`,
				);
		const serverEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(server.env ?? {})) {
			const name = mcpEnvVarName(index, key);
			serverEnv[key] = `\${${name}}`;
			env[name] = value;
		}
		mcpServers[server.name] = {
			type: "stdio",
			command: server.command,
			args: [...server.args],
			env: serverEnv,
		};
	});
	return { config: { mcpServers }, env };
}

export interface ClaudeInvocationPlan {
	readonly argv: string[];
	/** Env added on top of the inherited environment (request env, MCP values, limits). */
	readonly env: Record<string, string>;
	readonly mcpConfig: ClaudeMcpConfig | null;
	readonly sessionId: string;
	/** True when the CLI keeps the session on disk (requested `sessionId` or a resume). */
	readonly keepSession: boolean;
	readonly builtinTools: readonly string[];
	readonly allowedTools: readonly string[];
	readonly effort: string | null;
}

export function resolveEffort(effort: string | undefined): string | null {
	if (effort === undefined || effort === "") return null;
	const value = EFFORT_ALIASES[effort] ?? effort;
	if (!(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value))
		throw new SdkError(
			"INVALID_REQUEST",
			`claude does not support effort ${JSON.stringify(effort)} (levels: ${CLAUDE_EFFORT_LEVELS.join(", ")})`,
			{ subject: "effort" },
		);
	return value;
}

/** Build argv/env for one attempt. Throws `SdkError` (before any effect) on unsupported input. */
export function buildClaudeInvocation(
	req: SubmitRequest,
	config: ClaudeExecutorConfig,
	options: { readonly mcpConfigPath: string | null },
): ClaudeInvocationPlan {
	const mapped = mapTools(req.tools, CLAUDE_TOOL_MAPPING);
	if (mapped.unmapped.length > 0)
		throw new SdkError(
			"CAPABILITY_MISSING",
			`claude executor has no mapping for tools: ${mapped.unmapped.join(", ")}`,
			{ subject: `tool:${mapped.unmapped[0]}` },
		);
	for (const tool of mapped.mcpTools)
		if (!req.mcpServers.some((server) => server.name === tool.server))
			throw new SdkError(
				"INVALID_REQUEST",
				`tool ${tool.tool} needs the injected MCP server ${tool.server}`,
			);
	if (req.resumeSessionId !== undefined && !isUuid(req.resumeSessionId))
		throw new SdkError(
			"INVALID_REQUEST",
			"resumeSessionId must be a Claude session UUID",
		);
	if (req.sessionId !== undefined && !isUuid(req.sessionId))
		throw new SdkError(
			"INVALID_REQUEST",
			"sessionId must be a UUID (claude --session-id)",
		);
	const effort = resolveEffort(req.effort);
	const mutating = new Set<string>(CLAUDE_MUTATING_TOOLS);
	const builtinTools = mapped.executorTools.filter(
		(name) => !(req.readOnly && mutating.has(name)),
	);
	const allowedTools = [
		...builtinTools.filter((name) =>
			(CLAUDE_WEB_TOOLS as readonly string[]).includes(name),
		),
		// Engine-injected servers (artifact server, …): the engine chose to expose them.
		...req.mcpServers.map((server) => `mcp__${server.name}`),
	];
	const argv = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode",
		"default",
		"--permission-prompt-tool",
		"stdio",
		"--tools",
		builtinTools.join(","),
	];
	if (allowedTools.length > 0)
		argv.push("--allowedTools", allowedTools.join(","));
	if (req.readOnly)
		argv.push("--disallowedTools", [...CLAUDE_MUTATING_TOOLS].join(","));
	if (!req.isolation.inherit)
		argv.push(
			"--setting-sources",
			"",
			"--settings",
			JSON.stringify({ autoMemoryEnabled: false }),
			"--strict-mcp-config",
			"--disable-slash-commands",
		);
	const mcp = req.mcpServers.length > 0 ? buildMcpConfig(req.mcpServers) : null;
	if (mcp !== null) {
		if (options.mcpConfigPath === null)
			throw new SdkError("INVALID_REQUEST", "mcp config path missing");
		argv.push("--mcp-config", options.mcpConfigPath);
	}
	if (req.model !== undefined && req.model !== "")
		argv.push("--model", req.model);
	if (effort !== null) argv.push("--effort", effort);
	if (req.systemPrompt !== undefined && req.systemPrompt !== "")
		argv.push(
			config.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			req.systemPrompt,
		);
	let sessionId: string;
	let keepSession: boolean;
	if (req.resumeSessionId !== undefined) {
		// Same-session repair (D3): continue the kept session; it stays kept.
		sessionId = req.resumeSessionId;
		keepSession = true;
		argv.push("--resume", req.resumeSessionId);
	} else if (req.sessionId !== undefined) {
		sessionId = req.sessionId;
		keepSession = true;
		argv.push("--session-id", req.sessionId);
	} else {
		sessionId = attemptSessionId(req.attemptKey);
		keepSession = false;
		argv.push("--session-id", sessionId, "--no-session-persistence");
	}
	const env: Record<string, string> = {
		...req.env,
		...(mcp?.env ?? {}),
		MAX_MCP_OUTPUT_TOKENS: String(config.mcpOutputTokens),
	};
	if (config.mcpToolTimeoutMs !== null)
		env.MCP_TOOL_TIMEOUT = String(config.mcpToolTimeoutMs);
	return {
		argv,
		env,
		mcpConfig: mcp?.config ?? null,
		sessionId,
		keepSession,
		builtinTools,
		allowedTools,
		effort,
	};
}

/** The stream-json `user` message carrying the prompt. */
export function userMessageLine(prompt: string): string {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: prompt },
		parent_tool_use_id: null,
		session_id: "",
	});
}
