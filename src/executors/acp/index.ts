// ACP executor adapter (pilot). Public entry: `@agwab/agent-workflow/executors/acp`.
// Descriptor convention (R#15): `createExecutor(config)` rebuilds the adapter from JSON config;
// `config.preset` picks the agent (and the executor id), e.g. `{ "preset": "gemini" }`.
import type { WorkflowExecutor } from "../../sdk/contract.js";
import type { JsonValue } from "../../sdk/json.js";
import { parseAcpConfig } from "./config.js";
import { createAcpExecutor } from "./executor.js";

export const MODULE = "src/executors/acp";

export * from "./antigravity.js";
export * from "./capabilities.js";
export * from "./config.js";
export * from "./executor.js";
export * from "./normalize.js";
export * from "./rpc.js";
export * from "./state.js";
export * from "./version.js";

export function createExecutor(config: JsonValue = null): WorkflowExecutor {
	return createAcpExecutor({ config: parseAcpConfig(config) });
}
