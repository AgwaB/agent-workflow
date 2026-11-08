// Codex executor adapter (WP7): `codex app-server` JSON-RPC over stdio.
// Entry: `@agwab/agent-workflow/executors/codex`; descriptor convention `createExecutor(config)`.
import type { WorkflowExecutor } from "../../sdk/contract.js";
import type { JsonValue } from "../../sdk/json.js";
import { createCodexExecutor } from "./executor.js";

export const MODULE = "src/executors/codex";
/** Package specifier for `ExecutorDescriptor.module`. */
export const CODEX_EXECUTOR_MODULE = "@agwab/agent-workflow/executors/codex";

export {
	CODEX_EFFORT_LEVELS,
	CODEX_MCP_OUTPUT_LIMIT_CHARS,
	CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
	CODEX_VERIFIED_CLI_VERSION,
	CODEX_VERIFIED_WITH,
	codexCapabilities,
} from "./capabilities.js";
export {
	type CodexEnvironmentFindings,
	codexEnvironmentCapabilities,
	codexEnvironmentNotes,
	codexHomeDir,
	codexRequirementsPath,
	codexPolicyWarnings,
	countCodexRules,
	countCodexAllowRules,
	inspectCodexEnvironment,
} from "./environment.js";
export {
	CODEX_ERROR_INFO_CLASSES,
	CODEX_ERROR_RULES,
	classifyCodexFailure,
} from "./errors.js";
export {
	buildThreadConfig,
	CODEX_ADAPTER_VERSION,
	CODEX_EXECUTOR_ID,
	CODEX_OWNED_SESSION_KIND,
	CODEX_RAW_TRANSCRIPT,
	type CodexExecutorConfig,
	createCodexExecutor,
	parseLoginStatus,
	redactForTranscript,
} from "./executor.js";
export {
	CodexTurnNormalizer,
	commandKind,
	TOOL_OUTPUT_EVENT_LIMIT,
	toolCallFromItem,
} from "./normalize.js";
export {
	codexCredentialsStore,
	decideCodexWorkerHome,
	prepareCodexWorkerHome,
	removeCodexWorkerHome,
} from "./home.js";
export { AttemptStore, attemptDigest, defaultStateDir } from "./state.js";
export {
	CODEX_TOOL_MAPPING,
	CODEX_TOOL_MAPPING_ROWS,
	type CodexToolMappingRow,
	type CodexToolPlan,
	planCodexTools,
} from "./tools.js";

/** Descriptor convention (R#15): `loadExecutor` calls this with the persisted JSON config. */
export function createExecutor(config: JsonValue): WorkflowExecutor {
	return createCodexExecutor(config);
}
