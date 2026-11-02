/**
 * ACP executor configuration and agent presets (pilot). A preset says how to start one agent in ACP
 * mode and how a request maps onto that agent's launch flags; everything after the launch is plain
 * ACP v1 (executor.ts). Config is persisted in descriptors: never put a secret here.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubmitRequest } from "../../sdk/contract.js";
import { SdkError } from "../../sdk/errors.js";
import type { JsonValue } from "../../sdk/json.js";
import { isUnrestricted } from "../../sdk/permission.js";
import { ACP_PRESET_IDS, type AcpPresetId } from "./version.js";

export interface AcpPreset {
	readonly id: AcpPresetId;
	/** Executable name or path (resolved on PATH). */
	readonly command: string;
	/** Display name in probes and errors. */
	readonly label: string;
	readonly versionArgs: readonly string[];
	/** Launch argv for one attempt (after the command). */
	launchArgs(req: SubmitRequest): string[];
	/** How the agent names an MCP tool for the model (prompts render the artifact tool with it). */
	readonly mcpToolName: (server: string, tool: string) => string;
}

/**
 * Gemini CLI (`gemini --acp`; reference: gemini-cli 6814e00, internal design note §Gemini).
 * - `--allowed-mcp-server-names` keeps only the engine's servers: ACP-supplied servers are merged
 *   into the user's settings servers, and the allow list is the exclusion (config.ts:379-384,
 *   1005-1015). Without engine servers the list is the sentinel name below, so no ambient server
 *   loads either.
 * - Approval mode: readOnly → `plan` (read-only); `free` on a writing stage → `yolo`; otherwise
 *   `default`, where permission requests reach respond() (config.ts:334-352).
 */
export const NO_MCP_SERVERS_SENTINEL = "agent-workflow-none";

const GEMINI: AcpPreset = {
	id: "gemini",
	command: "gemini",
	label: "Gemini CLI",
	versionArgs: ["--version"],
	launchArgs(req) {
		const args = ["--acp"];
		if (req.model !== undefined && req.model !== "")
			args.push("--model", req.model);
		const names = req.mcpServers.map((server) => server.name);
		args.push(
			"--allowed-mcp-server-names",
			names.length > 0 ? names.join(",") : NO_MCP_SERVERS_SENTINEL,
		);
		const mode = req.readOnly
			? "plan"
			: isUnrestricted(req)
				? "yolo"
				: "default";
		args.push("--approval-mode", mode);
		return args;
	},
	// mcp-tool.ts:32-37, 725-749: `mcp_<server>_<tool>`, invalid characters → `_`.
	mcpToolName: (server, tool) =>
		`mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_\-.:]/g, "_"),
};

export const ACP_PRESETS: Readonly<Record<AcpPresetId, AcpPreset>> = {
	gemini: GEMINI,
};

export interface AcpExecutorConfig {
	readonly preset: AcpPreset;
	/** Executable to run instead of the preset's (tests, non-PATH installs). */
	readonly command: string;
	readonly stateDir: string;
	/** Grace before SIGTERM, then SIGKILL, once the session should end. */
	readonly killGraceMs: number;
	/** How long the ACP handshake (initialize + session/new) may take. */
	readonly handshakeTimeoutMs: number;
}

const DEFAULT_STATE_DIR = () =>
	join(
		process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), ".agent-workflow"),
		"executors",
		"acp",
	);

const CONFIG_KEYS: ReadonlySet<string> = new Set([
	"preset",
	"command",
	"stateDir",
	"killGraceMs",
	"handshakeTimeoutMs",
]);

/** `{ preset: "gemini", command?, stateDir?, killGraceMs?, handshakeTimeoutMs? }`. */
export function parseAcpConfig(raw: JsonValue = null): AcpExecutorConfig {
	const value =
		raw === null
			? {}
			: typeof raw === "object" && !Array.isArray(raw)
				? raw
				: undefined;
	if (value === undefined)
		throw new SdkError("DESCRIPTOR_INVALID", "acp config must be an object");
	const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
	if (unknown.length > 0)
		throw new SdkError(
			"DESCRIPTOR_INVALID",
			`acp config: unknown key(s) ${unknown.join(", ")}`,
		);
	const presetId = value.preset ?? "gemini";
	if (
		typeof presetId !== "string" ||
		!(ACP_PRESET_IDS as readonly string[]).includes(presetId)
	)
		throw new SdkError(
			"DESCRIPTOR_INVALID",
			`acp config: unknown preset ${JSON.stringify(presetId)} (known: ${ACP_PRESET_IDS.join(", ")})`,
		);
	const preset = ACP_PRESETS[presetId as AcpPresetId];
	const text = (key: string): string | undefined => {
		const item = value[key];
		if (item === undefined || item === null) return undefined;
		if (typeof item !== "string" || item === "")
			throw new SdkError(
				"DESCRIPTOR_INVALID",
				`acp config: ${key} must be a non-empty string`,
			);
		return item;
	};
	const millis = (key: string, fallback: number): number => {
		const item = value[key];
		if (item === undefined || item === null) return fallback;
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0)
			throw new SdkError(
				"DESCRIPTOR_INVALID",
				`acp config: ${key} must be a non-negative number`,
			);
		return item;
	};
	return {
		preset,
		command: text("command") ?? preset.command,
		stateDir: text("stateDir") ?? DEFAULT_STATE_DIR(),
		killGraceMs: millis("killGraceMs", 2_000),
		handshakeTimeoutMs: millis("handshakeTimeoutMs", 60_000),
	};
}
