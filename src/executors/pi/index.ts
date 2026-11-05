// Pi executor adapter (WP6): `pi --mode json --print` (A2-3). Public entry
// `@agwab/agent-workflow/executors/pi`; descriptor convention `createExecutor(config)` (B1, R#15).
// See docs/executors.md#pi.
import type { JsonValue } from "../../sdk/json.js";
import { createPiExecutor, type PiExecutor } from "./executor.js";

export const MODULE = "src/executors/pi";

export {
	ARTIFACT_SERVER,
	buildPiArgv,
	INHERITED_HOST_TOOLS,
	PI_BUILTIN_TOOLS,
	PI_EFFORT_LEVELS,
	PI_EXECUTOR_TOOL_MAPPING,
	PI_WEB_TOOLS,
	type PiArgvOptions,
	piMcpServerPattern,
	piMcpToolName,
	piToolKind,
	readOnlyTools,
} from "./argv.js";
export { type PiExecutorConfig, parsePiExecutorConfig } from "./config.js";
export {
	classifyPiFailure,
	PI_ERROR_RULES,
	type PiErrorRule,
} from "./errors.js";
export {
	createPiExecutor,
	PI_EXECUTOR_ID,
	PI_EXECUTOR_VERSION,
	PI_EXTENSION_FILE,
	PI_MCP_OUTPUT_LIMIT_CHARS,
	PI_MCP_OUTPUT_NOTICE_CHARS,
	PI_MIN_CLI_VERSION,
	PI_RAW_STDERR,
	PI_RAW_STDOUT,
	PI_SESSION_KIND,
	PI_VERIFIED_OFFLINE,
	PI_VERIFIED_WITH,
	type PiExecutor,
	type PiExecutorProbe,
	parsePiModelEfforts,
	parsePiModelList,
	parsePiWebAccessPath,
	piCapabilities,
} from "./executor.js";
export {
	MAX_TOOL_OUTPUT_CHARS,
	PiEventNormalizer,
	PiJsonlSplitter,
	textFromContent,
	usageFromPi,
} from "./parse.js";
export {
	applyFastServiceTier,
	PI_RUN_SECRETS_ENV,
	type PiRunConfig,
	piRunExtensionSource,
} from "./run-extension.js";
export {
	ToolResultBudgetEnforcer,
	type ToolResultBudgetState,
} from "./tool-result-budget.js";
export {
	enablePiWebTool,
	listPiWebSessionTools,
	PI_WEB_TOOL_CONFIG_KEYS,
	type PiWebToolFixResult,
	piWebAccessConfigPath,
	piWebToolUnavailableGuidance,
} from "./web-tools.js";

/** Descriptor convention (`loadExecutor`): `{ id: "pi", module: "@agwab/agent-workflow/executors/pi", config }`. */
export function createExecutor(config: JsonValue = null): PiExecutor {
	return createPiExecutor(config);
}
