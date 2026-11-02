/**
 * ACP executor configuration and agent presets (pilot). A preset says how to start one agent in ACP
 * mode and how a request maps onto that agent's launch flags; everything after the launch is plain
 * ACP v1 (executor.ts). Config is persisted in descriptors: never put a secret here.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubmitRequest } from "../../sdk/contract.js";
import { type FailureClass, SdkError } from "../../sdk/errors.js";
import type { JsonValue } from "../../sdk/json.js";
import { isUnrestricted } from "../../sdk/permission.js";
import {
	antigravityAnswerFailure,
	antigravityLaunchEnv,
	antigravityInheritedEnvBlocked,
	antigravitySummaryKey,
	readAntigravityToolResults,
} from "./antigravity.js";
import { ACP_PRESET_IDS, type AcpPresetId } from "./version.js";

/** A completed tool report, as seen live, for deciding whether its rawOutput is only a summary. */
export interface SummaryCall {
	readonly title: string;
	readonly input: JsonValue | undefined;
	readonly rawOutput: unknown;
}

/** One real tool result the agent recorded outside ACP, keyed like the preset's summaryKey. */
export interface AgentToolResult {
	readonly key: string;
	readonly text: string;
}

export interface AcpPreset {
	readonly id: AcpPresetId;
	/** Executable name or path (resolved on PATH). */
	readonly command: string;
	/** Env variable that names the executable when the config has no `command`. */
	readonly commandEnv?: string;
	/** Env the launch needs for this executable (e.g. where a symlinked server finds its helper). */
	launchEnv?(command: string): Promise<Record<string, string>>;
	/** Display name in probes and errors. */
	readonly label: string;
	/** `--version` style probe args; absent: the probe asks the agent's ACP `initialize` instead. */
	readonly versionArgs?: readonly string[];
	/** Launch argv for one attempt (after the command). */
	launchArgs(req: SubmitRequest): string[];
	/**
	 * Env that points the agent at the engine-owned home (B5: no user hooks, MCP servers or memory)
	 * unless the request inherits context. Absent: the agent uses the user's own home.
	 */
	isolatedEnv?(agentHome: string): Record<string, string>;
	/** Whether a login is recorded in the agent home (no credential is read); absent: unknown. */
	authRecorded?(agentHome: string): Promise<boolean>;
	/** Agent-specific `_meta` sent with `session/new` (e.g. built-in tools to disable). */
	readonly sessionMeta?: Readonly<Record<string, unknown>>;
	/** Inherited (not request) variables dropped for an isolated worker; their names are recorded. */
	inheritedEnvBlocked?(key: string): boolean;
	/** A final answer that is the agent's failure report (quota, internal error), not work. */
	answerFailure?(
		text: string,
		classify: (message: string) => FailureClass,
	): { readonly class: FailureClass; readonly message: string } | undefined;
	/**
	 * Where real tool results come from when ACP only carries a summary: `summaryKey` picks the
	 * completed calls to hold back, `read` returns the results the agent recorded in its home after
	 * the turn (isolated workers only).
	 */
	readonly toolResults?: {
		summaryKey(
			call: SummaryCall,
			mcpServers: readonly string[],
		): string | undefined;
		read(agentHome: string, sessionId: string): Promise<AgentToolResult[]>;
	};
	/**
	 * Requests to send after `session/new` (mode, model, effort), built from the session it returned.
	 * Throws to refuse what the agent does not offer (e.g. an unknown model).
	 */
	afterSession?(
		req: SubmitRequest,
		session: Readonly<Record<string, unknown>>,
	): { method: string; params: Record<string, unknown> }[];
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
};

/** Values a `select` config option of the session offers (ACP `configOptions`). */
export function sessionOptionValues(
	session: Readonly<Record<string, unknown>>,
	id: string,
): string[] | undefined {
	const options = Array.isArray(session.configOptions)
		? session.configOptions
		: [];
	const option = options.find(
		(item): item is Record<string, unknown> =>
			item !== null &&
			typeof item === "object" &&
			(item as Record<string, unknown>).id === id,
	);
	if (option === undefined || !Array.isArray(option.options)) return undefined;
	return option.options
		.map((item) =>
			item !== null && typeof item === "object"
				? (item as Record<string, unknown>).value
				: undefined,
		)
		.filter((value): value is string => typeof value === "string");
}

/** Effort → Antigravity `thinking_level` (low / medium / high), nearest, lower on a tie. */
const ANTIGRAVITY_THINKING: Readonly<Record<string, string>> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
	ultra: "high",
};

/**
 * Google Antigravity's ACP server (`agy_acp_server`, ACP registry `antigravity-acp`; Google's
 * answer to Gemini CLI's free tier being refused, 2026-11-02). Reference: agent-orchestrator
 * `chatdriver/agyacp` (launch without args on macOS, `--uid=` on Linux; modes default / auto_edit /
 * yolo). There is no read-only mode and no MCP allow list: readOnly relies on permission requests
 * (mode `default`, the engine denies writing kinds), and isolation on an engine-owned `GEMINI_HOME`
 * (`isolatedEnv`). Model and effort are session config options (`model`, `thinking_level`).
 */
const ANTIGRAVITY: AcpPreset = {
	id: "antigravity",
	command: "agy_acp_server",
	label: "Google Antigravity ACP server",
	// The registry ships the server as an archive, not an installer: name it on PATH or here.
	commandEnv: "AGENT_WORKFLOW_AGY_ACP_SERVER",
	launchEnv: antigravityLaunchEnv,
	launchArgs: () => (process.platform === "linux" ? ["--uid="] : []),
	// Built-in tools that would run work outside the engine: `run_workflow` starts its own agents in
	// the background, `schedule` sets timers/cron jobs that can fire after the attempt. Disabling
	// `run_workflow` also stops 1.4.2+ writing skills/system/run-workflow/SKILL.md into the cwd at
	// session/new, and cuts ~2.6k input tokens per request (live 2026-11-02: 13,619 → 11,032).
	// Documented since ACP server 1.2.1 as `_meta.agy.disabledTools`; 1.4.5 logs "Reading enabledTools
	// from legacy _meta.agy", and `_meta.antigravity` works the same (live no-model check), so that key.
	// `invoke_subagent` would also start agents outside the engine; disabling it cut another ~2.5k
	// input tokens (live: 8,531 vs 11,032). The filter knows only the SDK BuiltinTools names
	// (no-model probe: it warns "Unknown tool name" for define_subagent, send_message,
	// manage_subagents), so the list holds only names it knows.
	sessionMeta: {
		antigravity: {
			disabledTools: ["run_workflow", "schedule", "invoke_subagent"],
		},
	},
	inheritedEnvBlocked: antigravityInheritedEnvBlocked,
	answerFailure: antigravityAnswerFailure,
	toolResults: {
		summaryKey: antigravitySummaryKey,
		read: readAntigravityToolResults,
	},
	// The server resolves its home from $GEMINI_HOME (log: "Gemini home resolved to …"); the user's
	// home carries global hooks (`config/hooks.json`, e.g. a status hook that denied every tool call
	// in the live check), global MCP servers (`config/mcp_config.json`) and GEMINI.md. Workers get an
	// engine-owned home with its own one-time login instead (live check 2026-11-02).
	isolatedEnv: (agentHome) => ({ GEMINI_HOME: agentHome }),
	async authRecorded(agentHome) {
		// `authenticate` records only the method in settings.json (the credentials are the server's).
		try {
			const settings = JSON.parse(
				await readFile(
					join(agentHome, "antigravity-acp", "settings.json"),
					"utf8",
				),
			) as { auth?: { type?: unknown } };
			return typeof settings.auth?.type === "string";
		} catch {
			return false;
		}
	},
	afterSession(req, session) {
		const sessionId = session.sessionId as string;
		const steps: { method: string; params: Record<string, unknown> }[] = [
			{
				method: "session/set_mode",
				params: { sessionId, modeId: isUnrestricted(req) ? "yolo" : "default" },
			},
		];
		if (req.model !== undefined && req.model !== "") {
			const models = sessionOptionValues(session, "model");
			if (models !== undefined && !models.includes(req.model))
				throw new SdkError(
					"INVALID_REQUEST",
					`invalid model ${req.model} for antigravity; offered: ${models.join(", ")}`,
				);
			steps.push({
				method: "session/set_config_option",
				params: { sessionId, configId: "model", value: req.model },
			});
		}
		const thinking =
			req.effort === undefined ? undefined : ANTIGRAVITY_THINKING[req.effort];
		if (
			thinking !== undefined &&
			sessionOptionValues(session, "thinking_level")?.includes(thinking)
		)
			steps.push({
				method: "session/set_config_option",
				params: { sessionId, configId: "thinking_level", value: thinking },
			});
		return steps;
	},
};

export const ACP_PRESETS: Readonly<Record<AcpPresetId, AcpPreset>> = {
	gemini: GEMINI,
	antigravity: ANTIGRAVITY,
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
	/** Engine-owned agent home for isolated workers (presets with `isolatedEnv`). */
	readonly agentHome: string;
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
	"agentHome",
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
	const stateDir = text("stateDir") ?? DEFAULT_STATE_DIR();
	return {
		preset,
		command:
			text("command") ??
			(preset.commandEnv === undefined
				? undefined
				: process.env[preset.commandEnv]?.trim() || undefined) ??
			preset.command,
		stateDir,
		agentHome: text("agentHome") ?? join(stateDir, `${preset.id}-home`),
		killGraceMs: millis("killGraceMs", 2_000),
		handshakeTimeoutMs: millis("handshakeTimeoutMs", 60_000),
	};
}
