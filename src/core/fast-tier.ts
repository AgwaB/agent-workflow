// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/workflow-fast-mode-extension.ts. MIT, same author. Changes: kept only the pure config resolution behind capability fastTier (eligible models, service tier, resolveWorkflowFastModeConfig); the Pi provider-stream guard, payload hooks and extension wrapper moved out (Pi executor, WP6).
import type { FastMode } from "./types.js";
import type { WorkflowModelInfo } from "./workflow-runtime.js";

export const WORKFLOW_FAST_SERVICE_TIER = "priority" as const;

export type WorkflowFastApi = "openai-responses" | "openai-codex-responses";

const WORKFLOW_FAST_MODEL_APIS = new Map<string, WorkflowFastApi>([
	["openai/gpt-5.4", "openai-responses"],
	["openai/gpt-5.5", "openai-responses"],
	["openai/gpt-5.6-sol", "openai-responses"],
	["openai/gpt-5.6-terra", "openai-responses"],
	["openai/gpt-5.6-luna", "openai-responses"],
	["openai/gpt-6-astra", "openai-responses"],
	["openai/gpt-6-sol", "openai-responses"],
	["openai/gpt-6-luna", "openai-responses"],
	["openai/gpt-6.1-sol", "openai-responses"],
	["openai-codex/gpt-5.4", "openai-codex-responses"],
	["openai-codex/gpt-5.5", "openai-codex-responses"],
	["openai-codex/gpt-5.6", "openai-codex-responses"],
	["openai-codex/gpt-5.6-sol", "openai-codex-responses"],
	["openai-codex/gpt-5.6-terra", "openai-codex-responses"],
	["openai-codex/gpt-5.6-luna", "openai-codex-responses"],
	["openai-codex/gpt-6-astra", "openai-codex-responses"],
	["openai-codex/gpt-6-sol", "openai-codex-responses"],
	["openai-codex/gpt-6-luna", "openai-codex-responses"],
	["openai-codex/gpt-6.1-sol", "openai-codex-responses"],
]);

export interface WorkflowFastModeConfig {
	provider: "openai" | "openai-codex";
	model: string;
	api: WorkflowFastApi;
	serviceTier: typeof WORKFLOW_FAST_SERVICE_TIER;
}

export function workflowFastEligibleModelIds(): string[] {
	return [...WORKFLOW_FAST_MODEL_APIS.keys()];
}

/** Resolve and validate the task-bound Fast configuration before child launch. */
export function resolveWorkflowFastModeConfig(
	runtime: { fast?: FastMode; model?: string; api?: string },
	availableModels?: readonly WorkflowModelInfo[],
): WorkflowFastModeConfig | undefined {
	if (runtime.fast !== "on") return undefined;
	const fullId = runtime.model?.trim();
	if (!fullId) {
		throw new Error(
			"fast:on requires a resolved OpenAI model before workflow launch",
		);
	}
	const api = WORKFLOW_FAST_MODEL_APIS.get(fullId);
	if (!api) {
		throw new Error(
			`fast:on is not supported for model "${fullId}"; supported models: ${workflowFastEligibleModelIds().join(", ")}`,
		);
	}
	const provider = fullId.startsWith("openai-codex/")
		? "openai-codex"
		: "openai";
	const model = fullId.slice(provider.length + 1);
	const registered = availableModels?.find((entry) => entry.fullId === fullId);
	const boundApi = runtime.api ?? registered?.api;
	if (!boundApi) {
		throw new Error(
			`fast:on requires a resolved API binding for model "${fullId}" before workflow launch`,
		);
	}
	if (registered?.api !== undefined && registered.api !== api) {
		throw new Error(
			`fast:on requires ${api} for model "${fullId}"; Pi registered ${registered.api}`,
		);
	}
	if (boundApi !== api) {
		throw new Error(
			`fast:on requires ${api} for model "${fullId}"; workflow resolved ${boundApi}`,
		);
	}
	return {
		provider,
		model,
		api,
		serviceTier: WORKFLOW_FAST_SERVICE_TIER,
	};
}
