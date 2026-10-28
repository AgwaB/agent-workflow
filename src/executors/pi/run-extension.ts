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
//   `assertWorkflowFastProviderModel`; WP35: `installWorkflowFastProviderGuard`,
//   `createWorkflowFastProviderStream`, `buildWorkflowFastProviderOptions`,
//   `resolveReasoningEffort`). MIT, same author. Changes: the OpenAI stream functions and
//   `clampThinkingLevel` are handed in by the generated wrapper (Pi's own `pi-ai/compat`), so this
//   module stays Pi-free; WP35 adds failure/degrade reporting (a state file next to the attempt, a
//   stderr line, `ctx.abort()` on a binding failure). `fastTier` stays `unverified` until a live run
//   (docs/executors/pi.md).
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
	/** WP35: where the extension reports the guard state (`pi-fast-tier.json` in the attempt dir). */
	readonly statePath?: string;
}

/** File name of the fast-tier guard report in the attempt directory (WP35). */
export const PI_FAST_TIER_STATE_FILE = "pi-fast-tier.json";

/**
 * WP35: what the fast-tier guard reports. `guarded` = the OpenAI provider stream was re-registered
 * with `serviceTier` and a payload guard (pi-workflow behavior); `payload-only` = degraded, Pi
 * offered no provider registry (or the wrapper no stream functions), so only the
 * `before_provider_request` hook sets `service_tier`; `failed` = a model/payload binding check
 * failed and the request was aborted.
 */
export interface PiFastTierState {
	readonly schema: "agent-workflow-pi-fast-tier-v1";
	status: "pending" | "guarded" | "payload-only" | "failed";
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	readonly serviceTier: string;
	/** Requests sent through the guarded provider stream. */
	guardedRequests: number;
	/** Provider payloads the `before_provider_request` hook stamped. */
	payloadRequests: number;
	reason?: string;
}

/** Pi's OpenAI stream functions (`pi-ai/compat`), handed in by the generated wrapper. */
export interface PiFastStreams {
	readonly openaiResponses: (
		model: any,
		context: any,
		options?: Record<string, unknown>,
	) => unknown;
	readonly openaiCodexResponses: (
		model: any,
		context: any,
		options?: Record<string, unknown>,
	) => unknown;
	/** `clampThinkingLevel(model, level)` of pi-ai; absent = the level is passed unchanged. */
	readonly clampThinkingLevel?: (model: any, level: string) => string;
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

/** The slice of Pi's ExtensionContext the fast-tier guard uses. */
interface PiFastContextLike {
	model?: unknown;
	abort?(): void;
	modelRegistry?: {
		registerProvider?(name: string, config: Record<string, unknown>): void;
	};
}

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

/** `buildWorkflowFastProviderOptions` (ported): force the tier and guard the payload. */
export function buildFastProviderOptions(
	options: unknown,
	config: PiFastTierConfig,
	onFailure: (error: unknown) => void = () => undefined,
): Record<string, unknown> & {
	serviceTier: string;
	onPayload: (
		payload: unknown,
		model: unknown,
	) => Promise<Record<string, unknown>>;
} {
	const base = isRecord(options) ? options : {};
	const upstreamOnPayload =
		typeof base.onPayload === "function"
			? (base.onPayload as (payload: unknown, model: unknown) => unknown)
			: undefined;
	return {
		...base,
		serviceTier: config.serviceTier,
		onPayload: async (payload, model) => {
			try {
				assertFastModel(model, config);
				const replacement = await upstreamOnPayload?.(payload, model);
				return applyFastServiceTier(replacement ?? payload, config);
			} catch (error) {
				onFailure(error);
				throw error;
			}
		},
	};
}

/**
 * `createWorkflowFastProviderStream` (ported): the provider stream the guard registers. Every
 * request is checked against the launch binding, sent with `serviceTier` and the payload guard,
 * and the reasoning level is clamped to the model. Exported for tests (fake provider streams).
 */
export function createFastProviderStream(
	config: PiFastTierConfig,
	streams: PiFastStreams,
	hooks: {
		onRequest?: () => void;
		onFailure?: (error: unknown) => void;
	} = {},
) {
	return (
		model: unknown,
		requestContext: unknown,
		options?: Record<string, unknown>,
	): unknown => {
		try {
			assertFastModel(model, config);
		} catch (error) {
			hooks.onFailure?.(error);
			throw error;
		}
		hooks.onRequest?.();
		const guarded = buildFastProviderOptions(options, config, hooks.onFailure);
		const reasoning =
			typeof options?.reasoning === "string" ? options.reasoning : undefined;
		const clamped =
			reasoning === undefined
				? undefined
				: (streams.clampThinkingLevel?.(model, reasoning) ?? reasoning);
		const providerOptions = {
			...guarded,
			reasoningEffort: clamped === "off" ? undefined : clamped,
		};
		return config.api === "openai-codex-responses"
			? streams.openaiCodexResponses(model, requestContext, providerOptions)
			: streams.openaiResponses(model, requestContext, providerOptions);
	};
}

function writeFastState(
	state: PiFastTierState,
	path: string | undefined,
): void {
	if (path === undefined) return;
	try {
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Reporting only; the request outcome is decided by the guard itself.
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * WP35 (row 39): the fast-tier guard. `session_start` re-registers the bound OpenAI provider with
 * the guarded stream (pi-workflow `installWorkflowFastProviderGuard`); `before_provider_request`
 * still stamps `service_tier` after the binding check. Without a provider registry or stream
 * functions the guard degrades to the payload hook (`payload-only`, reported on stderr and in the
 * state file); any binding failure aborts the request and is reported as `failed`.
 */
export function registerFastTierGuard(
	pi: PiExtensionApiLike,
	config: PiFastTierConfig,
	streams: PiFastStreams | undefined,
	report: { stderr?: (line: string) => void } = {},
): PiFastTierState {
	const state: PiFastTierState = {
		schema: "agent-workflow-pi-fast-tier-v1",
		status: "pending",
		provider: config.provider,
		model: config.model,
		api: config.api,
		serviceTier: config.serviceTier,
		guardedRequests: 0,
		payloadRequests: 0,
	};
	const stderr =
		report.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
	const save = () => writeFastState(state, config.statePath);
	const fail = (error: unknown, ctx?: PiFastContextLike) => {
		if (state.status !== "failed") {
			state.status = "failed";
			state.reason = errorText(error);
			save();
			stderr(`agent-workflow: fast tier failed: ${state.reason}`);
		}
		ctx?.abort?.();
	};
	save();
	pi.on("session_start", (_event: unknown, ctx: PiFastContextLike) => {
		if (state.status === "failed") return;
		const registry = ctx?.modelRegistry;
		if (
			streams === undefined ||
			typeof registry?.registerProvider !== "function"
		) {
			state.status = "payload-only";
			state.reason =
				streams === undefined
					? "no provider stream functions"
					: "Pi offers no provider registry";
			save();
			stderr(
				`agent-workflow: fast tier degraded to the payload hook (${state.reason}); service_tier ${config.serviceTier} is still requested`,
			);
			return;
		}
		try {
			registry.registerProvider(config.provider, {
				api: config.api,
				streamSimple: createFastProviderStream(config, streams, {
					onRequest: () => {
						state.guardedRequests += 1;
						save();
					},
					onFailure: (error) => fail(error, ctx),
				}),
			});
			state.status = "guarded";
			save();
		} catch (error) {
			fail(error, ctx);
			throw error;
		}
	});
	pi.on(
		"before_provider_request",
		(event: { payload: unknown }, ctx: PiFastContextLike) => {
			try {
				assertFastModel(ctx?.model, config);
				const stamped = applyFastServiceTier(event.payload, config);
				state.payloadRequests += 1;
				save();
				return stamped;
			} catch (error) {
				fail(error, ctx);
				throw error;
			}
		},
	);
	return state;
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
	deps: {
		createMcpExtension?: McpExtensionFactory;
		/** WP35: Pi's OpenAI stream functions for the fast-tier provider guard. */
		fastStreams?: PiFastStreams;
	} = {},
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
	if (fast !== undefined) registerFastTierGuard(pi, fast, deps.fastStreams);
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
	const mcp = options.config.privateMcp && options.config.mcpServers.length > 0;
	const fast = options.config.fastTier !== undefined;
	if (mcp)
		lines.push(
			`import { createMcpExtension } from "${scope}/pi-coding-agent";`,
		);
	// WP35: Pi resolves its own pi-ai for extensions; the guard re-registers the OpenAI streams.
	if (fast)
		lines.push(
			`import { clampThinkingLevel, streamOpenAICodexResponses, streamOpenAIResponses } from "${scope}/pi-ai/compat";`,
		);
	const deps = [
		...(mcp ? ["createMcpExtension"] : []),
		...(fast
			? [
					"fastStreams: { openaiResponses: streamOpenAIResponses, openaiCodexResponses: streamOpenAICodexResponses, clampThinkingLevel }",
				]
			: []),
	];
	lines.push(
		`import { registerPiRun } from ${JSON.stringify(options.runExtensionUrl)};`,
		`const config = ${JSON.stringify(options.config)};`,
		"export default async function agentWorkflowPiRun(pi) {",
		deps.length > 0
			? `\tawait registerPiRun(pi, config, { ${deps.join(", ")} });`
			: "\tawait registerPiRun(pi, config);",
		"}",
		"",
	);
	return lines.join("\n");
}
