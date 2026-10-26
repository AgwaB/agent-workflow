// Per-run Pi extension body (WP6). Runs **inside the Pi worker process**: the adapter writes a small
// wrapper (`pi-extension.mjs`) into the attempt directory that imports this module and calls
// `registerPiRun(pi, config, deps)`. Pi-free by construction (no Pi import here; the wrapper hands
// in Pi's `createMcpExtension` when it is needed), so it compiles with the rest of the package.
//
// Ported parts:
// - tool-result budget: @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74)
//   src/runners/tool-result-budget-extension.ts. MIT, same author. Changes: config from the run
//   config instead of env variables.
// - fast tier: @agwab/pi-workflow 0.16.4 (b83cc4f) src/workflow-fast-mode-extension.ts
//   (`registerWorkflowFastModeExtension` → `before_provider_request`, `applyWorkflowFastServiceTier`,
//   `assertWorkflowFastProviderModel`). MIT, same author. Changes: only the
//   `before_provider_request` payload hook; the provider-stream guard (re-registering the OpenAI
//   provider stream) is not ported, so `fastTier` stays `unverified` (docs/executors/pi.md).
import { writeFileSync } from "node:fs";
import { Socket } from "node:net";
import {
	ToolResultBudgetEnforcer,
	type ToolResultBudgetState,
} from "./tool-result-budget.js";

/** Env variable carrying the secret part of the run config; deleted as soon as the extension loads. */
export const PI_RUN_SECRETS_ENV = "AGENT_WORKFLOW_PI_RUN_SECRETS_JSON";
/** File descriptor the adapter keeps open; its end means the owning process is gone. */
export const PI_PARENT_WATCH_FD = 3;

export interface PiRunMcpServer {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Env keys only; values come through `PI_RUN_SECRETS_ENV` (never on disk, never on argv). */
	readonly envKeys: readonly string[];
}

export interface PiFastTierConfig {
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	readonly serviceTier: string;
}

/** Non-secret run config written next to the wrapper (`pi-run.json`). */
export interface PiRunConfig {
	readonly schema: "agent-workflow-pi-run-v1";
	/** Start Pi's MCP support privately (no user `mcp.json`) for the injected servers (B5). */
	readonly privateMcp: boolean;
	readonly mcpServers: readonly PiRunMcpServer[];
	readonly mcpLogPath?: string;
	readonly toolResultBudget?: {
		readonly maxTotalChars: number;
		readonly statePath: string;
	};
	readonly fastTier?: PiFastTierConfig;
	/** Kill Pi's process group when `PI_PARENT_WATCH_FD` closes (orphan guard). */
	readonly parentWatch: boolean;
}

export interface PiRunSecrets {
	/** Per `mcpServers[i]`: env values (keys must match `envKeys`). */
	readonly mcpEnv?: readonly (Readonly<Record<string, string>> | null)[];
}

type Handler = (event: any, ctx: any) => unknown;
/** The slice of Pi's ExtensionAPI this module uses. */
export interface PiExtensionApiLike {
	on(event: string, handler: Handler): void;
	registerMcpServer?(name: string, config: Record<string, unknown>): void;
}
type McpExtensionFactory = (
	options: Record<string, unknown>,
) => (pi: PiExtensionApiLike) => unknown;

function readSecrets(): PiRunSecrets {
	const raw = process.env[PI_RUN_SECRETS_ENV];
	delete process.env[PI_RUN_SECRETS_ENV];
	if (raw === undefined || raw === "") return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null
			? (parsed as PiRunSecrets)
			: {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFastModel(model: unknown, config: PiFastTierConfig): void {
	if (
		!isRecord(model) ||
		model.provider !== config.provider ||
		model.id !== config.model ||
		model.api !== config.api
	) {
		const actual = isRecord(model)
			? `${String(model.provider)}/${String(model.id)} (${String(model.api)})`
			: "no model";
		throw new Error(
			`workflow fast mode launch binding mismatch: expected ${config.provider}/${config.model} (${config.api}), received ${actual}`,
		);
	}
}

/** `applyWorkflowFastServiceTier` (ported). Exported for tests. */
export function applyFastServiceTier(
	payload: unknown,
	config: PiFastTierConfig,
): Record<string, unknown> {
	if (!isRecord(payload))
		throw new Error("workflow fast mode requires an object provider payload");
	if (payload.model !== config.model)
		throw new Error(
			`workflow fast mode payload binding mismatch: expected model ${config.model}, received ${typeof payload.model === "string" ? JSON.stringify(payload.model) : typeof payload.model}`,
		);
	return { ...payload, service_tier: config.serviceTier };
}

function writeBudgetState(path: string, state: ToolResultBudgetState): void {
	try {
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Telemetry only; never fail the worker over state persistence.
	}
}

function watchParent(): void {
	let socket: Socket;
	try {
		socket = new Socket({ fd: PI_PARENT_WATCH_FD, readable: true });
	} catch {
		return;
	}
	socket.on("error", () => {});
	const stop = () => {
		try {
			// Pi runs as its own process-group leader (detached spawn): stop the whole group.
			process.kill(-process.pid, "SIGTERM");
		} catch {
			process.kill(process.pid, "SIGTERM");
		}
	};
	socket.on("end", stop);
	socket.on("close", stop);
	socket.resume();
	socket.unref();
}

/** Register everything the run needs. Returns a promise when Pi's MCP support must load first. */
export async function registerPiRun(
	pi: PiExtensionApiLike,
	config: PiRunConfig,
	deps: { createMcpExtension?: McpExtensionFactory } = {},
): Promise<void> {
	const secrets = readSecrets();
	if (config.parentWatch) {
		let watching = false;
		pi.on("session_start", () => {
			if (watching) return;
			watching = true;
			watchParent();
		});
	}
	if (config.mcpServers.length > 0) {
		if (config.privateMcp) {
			if (deps.createMcpExtension === undefined)
				throw new Error("agent-workflow: private MCP needs createMcpExtension");
			// Pi's own MCP support with no file configuration: only the injected servers connect.
			await deps.createMcpExtension({
				loadConfig: () => ({
					servers: [],
					errors: [],
					autoEnableCodemode: false,
				}),
				...(config.mcpLogPath === undefined
					? {}
					: { logPath: config.mcpLogPath }),
				updateConfig: () => {
					throw new Error(
						"agent-workflow worker MCP configuration is read-only",
					);
				},
			})(pi);
		}
		if (typeof pi.registerMcpServer !== "function")
			throw new Error("agent-workflow: this Pi cannot register MCP servers");
		config.mcpServers.forEach((server, index) => {
			const values = secrets.mcpEnv?.[index] ?? {};
			const env: Record<string, string> = {};
			for (const key of server.envKeys)
				if (typeof values[key] === "string") env[key] = values[key];
			pi.registerMcpServer?.(server.name, {
				command: server.command,
				args: [...server.args],
				env,
				exposure: "direct",
			});
		});
	}
	const budget = config.toolResultBudget;
	if (budget !== undefined) {
		const enforcer = new ToolResultBudgetEnforcer({
			maxTotalChars: budget.maxTotalChars,
		});
		pi.on("context", (event: { messages: unknown[] }) => {
			writeBudgetState(budget.statePath, enforcer.enforce(event.messages));
			return { messages: event.messages };
		});
	}
	const fast = config.fastTier;
	if (fast !== undefined)
		pi.on(
			"before_provider_request",
			(
				event: { payload: unknown },
				ctx: { model?: unknown; abort?(): void },
			) => {
				try {
					assertFastModel(ctx.model, fast);
					return applyFastServiceTier(event.payload, fast);
				} catch (error) {
					ctx.abort?.();
					throw error;
				}
			},
		);
}

/** Source of the generated per-run wrapper (`pi-extension.mjs`). */
export function piRunExtensionSource(options: {
	readonly runExtensionUrl: string;
	readonly config: PiRunConfig;
}): string {
	const scope = ["@earendil", "works"].join("-");
	const lines = [
		"// Generated by agent-workflow (WP6 Pi executor) for one attempt. Do not edit.",
	];
	if (options.config.privateMcp && options.config.mcpServers.length > 0)
		lines.push(
			`import { createMcpExtension } from "${scope}/pi-coding-agent";`,
		);
	lines.push(
		`import { registerPiRun } from ${JSON.stringify(options.runExtensionUrl)};`,
		`const config = ${JSON.stringify(options.config)};`,
		"export default async function agentWorkflowPiRun(pi) {",
		options.config.privateMcp && options.config.mcpServers.length > 0
			? "\tawait registerPiRun(pi, config, { createMcpExtension });"
			: "\tawait registerPiRun(pi, config);",
		"}",
		"",
	);
	return lines.join("\n");
}
