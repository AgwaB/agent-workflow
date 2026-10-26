// Claude Code executor adapter (WP8). Public entry: `@agwab/agent-workflow/executors/claude`.
// Descriptor convention (R#15): `createExecutor(config)` rebuilds the adapter from JSON config.
import type { JsonValue } from "../../sdk/json.js";
import { parseClaudeConfig } from "./config.js";
import {
	type ClaudeWorkflowExecutor,
	createClaudeExecutor,
} from "./executor.js";

export const MODULE = "src/executors/claude";

export * from "./argv.js";
export * from "./capabilities.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./executor.js";
export * from "./probe.js";
export * from "./sessions.js";
export * from "./state.js";
export * from "./stream.js";
export * from "./tools.js";

export function createExecutor(
	config: JsonValue = null,
): ClaudeWorkflowExecutor {
	return createClaudeExecutor({ config: parseClaudeConfig(config) });
}
