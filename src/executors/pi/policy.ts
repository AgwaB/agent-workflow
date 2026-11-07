// Pi rules the engine applies before launch (core/executor-policy.ts): which host tools Pi workers
// inherit, Pi's `provider/model` naming, the fast tier, the per-task descriptor config and the
// pi-web-access doctor fix. Kept out of the adapter entry so core never loads the adapter.
import type {
	ExecutorDoctorFix,
	ExecutorPolicy,
} from "../../core/executor-policy.js";
import type { ExecutorNameResolution } from "../../core/executor-model-id.js";
import { isPlainObject, type JsonValue } from "../../sdk/json.js";
import { resolveWorkflowFastModeConfig } from "./fast-tier.js";
import {
	enablePiWebTool,
	PI_WEB_TOOL_CONFIG_KEYS,
	piWebAccessConfigPath,
} from "./web-tools.js";

/**
 * Host tools a Pi worker inherits when the Pi host lends its tools (`inheritHostTools`). The Pi
 * executor passes them to the worker, and the worker prompt names them.
 */
export const INHERITED_HOST_TOOL_NAMES = [
	"codemode",
	"tool_search",
	"mcp__*",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
] as const;

/** Pi providers preferred for a bare id of a vendor (ChatGPT login first, as Pi users have it). */
const PI_PROVIDER_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
	openai: ["openai-codex", "openai"],
	anthropic: ["anthropic"],
};

function bare(model: string): string {
	return model.replace(/^[a-z0-9][a-z0-9-]*\//iu, "");
}

function resolvePiModel(
	model: string,
	vendor: string | undefined,
	listed: readonly string[] | null,
	listComplete: boolean,
): ExecutorNameResolution {
	if (/^[a-z0-9][a-z0-9-]*\//u.test(model)) {
		if (listed === null || listComplete === false)
			return {
				value: model,
				changed: false,
				...(listed === null
					? {}
					: {
							notice: `model "${model}" is not in Pi's model list (providers with configured auth); it runs only if Pi can resolve it`,
						}),
			};
		return {
			refused: `model "${model}" is not offered by pi (its models: ${listed.join(", ")})`,
		};
	}
	// A bare id (codex/claude form): find the Pi provider that offers it.
	if (listed === null)
		return {
			value: model,
			changed: false,
			notice: `model "${model}" has no provider prefix and Pi's model list is not available; Pi resolves it itself`,
		};
	const matches = listed.filter((entry) => bare(entry) === model);
	if (matches.length === 1) return { value: matches[0]!, changed: true };
	const preferred = (PI_PROVIDER_PREFERENCE[vendor ?? ""] ?? [])
		.map((provider) => `${provider}/${model}`)
		.find((candidate) => matches.includes(candidate));
	if (preferred !== undefined) return { value: preferred, changed: true };
	if (matches.length > 1)
		return {
			refused: `model "${model}" is offered by several Pi providers (${matches.join(", ")}); name one`,
		};
	// Pi's --model also resolves patterns ("sonnet", "opus"); it reports one it cannot resolve.
	return {
		value: model,
		changed: false,
		notice: `model "${model}" is not an exact Pi model id; Pi resolves it as a pattern when the stage starts (exact ids look like "anthropic/claude-opus-5-5")`,
	};
}

export const PI_EXECUTOR_POLICY: ExecutorPolicy = {
	inheritedHostTools: INHERITED_HOST_TOOL_NAMES,
	resolveModel: resolvePiModel,
	resolveFastMode: resolveWorkflowFastModeConfig,
	/**
	 * WP35: Pi per-task options travel as descriptor config (docs/executors.md#pi): `inheritHostTools`
	 * exactly when the sealed launch carries the run's host context; `fast: "on"` (+ `fastApi`, the
	 * API the compiler bound) when the task asks for the fast tier and the recorded negotiation
	 * accepted `fastTier` (an `unverified` fastTier needs the run's opt-in; without it the preview
	 * said "runs without fast tier"). Runs recorded before negotiation get no fast tier.
	 */
	taskDescriptor(descriptor, compiledTask, launch, capability) {
		const extra: Record<string, JsonValue> = {};
		if (launch.hostContext !== undefined) extra.inheritHostTools = true;
		const fastAccepted = capability.report?.entries.some(
			(entry) =>
				entry.key === "fastTier" &&
				(entry.outcome === "native" || entry.outcome === "emulated"),
		);
		if (compiledTask.runtime.fast === "on" && fastAccepted === true) {
			extra.fast = "on";
			const api = (compiledTask.runtime as { api?: unknown }).api;
			if (typeof api === "string" && api !== "") extra.fastApi = api;
		}
		if (Object.keys(extra).length === 0) return descriptor;
		const base = isPlainObject(descriptor.config) ? descriptor.config : {};
		return { ...descriptor, config: { ...base, ...extra } };
	},
	/** Only web tools turned off in pi-web-access's own config are fixable (one key flips to true). */
	doctorFixes(unavailableTools, env) {
		const fixes: ExecutorDoctorFix[] = [];
		for (const tool of Object.keys(unavailableTools)) {
			const key = PI_WEB_TOOL_CONFIG_KEYS[tool];
			if (key === undefined) continue;
			fixes.push({
				tool,
				description: `Turn on ${tool} in pi-web-access (set tools.${key}.enabled to true in ${piWebAccessConfigPath(env)})`,
			});
		}
		return fixes;
	},
	applyDoctorFix: enablePiWebTool,
};
