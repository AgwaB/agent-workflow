/**
 * Claude executor configuration (WP8). The config travels in the persisted `ExecutorDescriptor`
 * (`worker.json`, `executor.json`), so it never carries secrets (D1): the CLI owns its login.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SdkError } from "../../sdk/errors.js";
import type { JsonValue } from "../../sdk/json.js";

export const CLAUDE_EXECUTOR_ID = "claude";
export const CLAUDE_ADAPTER_VERSION = "0.1.0";
/** CLI version every `probed` capability row was verified with (live, 2026-10-26). */
export const CLAUDE_VERIFIED_CLI_VERSION = "2.1.310";
export const CLAUDE_VERIFIED_WITH = `claude-code ${CLAUDE_VERIFIED_CLI_VERSION}, WP8 live 2026-10-26`;

/** Claude Code default for `MAX_MCP_OUTPUT_TOKENS` (measured: 45,000 chars inline, 90,000 spilled). */
export const DEFAULT_MCP_OUTPUT_TOKENS = 25_000;

export type SystemPromptMode = "append" | "replace";

export interface ClaudeExecutorConfig {
	/** CLI binary (absolute path or a name resolved on PATH). Default `claude`. */
	readonly claudePath: string;
	/** Adapter-owned durable state (attempt records, owned sessions). */
	readonly stateDir: string;
	/** `MAX_MCP_OUTPUT_TOKENS` the adapter sets for every worker (overrides inherited values). */
	readonly mcpOutputTokens: number;
	/** `MCP_TOOL_TIMEOUT` in ms; unset = Claude Code default. */
	readonly mcpToolTimeoutMs: number | null;
	/** How `SubmitRequest.systemPrompt` is passed: `--append-system-prompt` or `--system-prompt`. */
	readonly systemPromptMode: SystemPromptMode;
	/** List models through the `initialize` control request in `probe()` (no model turn). */
	readonly listModels: boolean;
	/** Grace between interrupt and SIGTERM, and SIGTERM and SIGKILL, for `cancel(owned)`. */
	readonly killGraceMs: number;
	/** Claude config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`); only used to clean worker sessions. */
	readonly claudeConfigDir: string;
}

function defaultStateDir(): string {
	const home =
		process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), ".agent-workflow");
	return join(home, "executors", "claude");
}

function defaultClaudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

const KNOWN_KEYS = new Set([
	"claudePath",
	"stateDir",
	"mcpOutputTokens",
	"mcpToolTimeoutMs",
	"systemPromptMode",
	"listModels",
	"killGraceMs",
	"claudeConfigDir",
]);

function invalid(message: string): never {
	throw new SdkError(
		"DESCRIPTOR_INVALID",
		`claude executor config: ${message}`,
	);
}

/** Parse the JSON descriptor config. `null`/`{}` gives the defaults. Unknown keys are refused. */
export function parseClaudeConfig(
	raw: JsonValue | undefined,
): ClaudeExecutorConfig {
	const record =
		raw === null || raw === undefined
			? {}
			: typeof raw === "object" && !Array.isArray(raw)
				? raw
				: invalid("must be an object or null");
	for (const key of Object.keys(record))
		if (!KNOWN_KEYS.has(key)) invalid(`unknown key ${key}`);
	const str = (key: string): string | undefined => {
		const value = record[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value === "")
			invalid(`${key} must be a non-empty string`);
		return value;
	};
	const absolute = (key: string): string | undefined => {
		const value = str(key);
		if (value !== undefined && !isAbsolute(value))
			invalid(`${key} must be absolute`);
		return value;
	};
	const int = (key: string, min: number, max: number): number | undefined => {
		const value = record[key];
		if (value === undefined || value === null) return undefined;
		if (
			typeof value !== "number" ||
			!Number.isSafeInteger(value) ||
			value < min ||
			value > max
		)
			invalid(`${key} must be an integer in [${min}, ${max}]`);
		return value;
	};
	const mode = str("systemPromptMode") ?? "append";
	if (mode !== "append" && mode !== "replace")
		invalid("systemPromptMode must be append|replace");
	const listModels = record.listModels ?? true;
	if (typeof listModels !== "boolean") invalid("listModels must be a boolean");
	return {
		claudePath: str("claudePath") ?? "claude",
		stateDir: absolute("stateDir") ?? defaultStateDir(),
		mcpOutputTokens:
			int("mcpOutputTokens", 1_000, 1_000_000) ?? DEFAULT_MCP_OUTPUT_TOKENS,
		mcpToolTimeoutMs: int("mcpToolTimeoutMs", 1_000, 86_400_000) ?? null,
		systemPromptMode: mode,
		listModels,
		killGraceMs: int("killGraceMs", 50, 60_000) ?? 3_000,
		claudeConfigDir: absolute("claudeConfigDir") ?? defaultClaudeConfigDir(),
	};
}

/**
 * Characters the artifact MCP server may return so that Claude delivers the result inline.
 * Claude counts tokens; a token covers at least one UTF-8 byte, so `bytes ≤ tokens` guarantees the
 * token bound. The artifact server bounds both UTF-16 length and UTF-8 bytes. 10% headroom for the
 * client's own wrapping. Measured live: 22,500 chars at the default 25k tokens arrive intact.
 */
export function mcpOutputLimitChars(tokens: number): number {
	return Math.floor(tokens * 0.9);
}
