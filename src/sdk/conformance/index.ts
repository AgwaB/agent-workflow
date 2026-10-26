// Executor conformance kit (stage-1 plan WP9a): `@agwab/agent-workflow/sdk/conformance`.
// Pi-free. Offline checks run against stubs/fakes; live checks are opt-in; runtime checks (WP2b)
// drive the durable runtime, which they import lazily.
export const MODULE = "src/sdk/conformance";
export * from "./catalog.js";
export type { CheckBody, ConformanceCheck } from "./checks-core.js";
export {
	CheckContext,
	ConformanceSkip,
	ConformanceTimeout,
	type ConsumeRecord,
	createFenceProbe,
	type DrainOptions,
	type DrainResult,
	drain,
	type FenceProbe,
	withTimeout,
} from "./context.js";
export {
	MCP_NONCE_PATTERN,
	MCP_SECRET_ENV,
	mcpToolPrompt,
} from "./checks-mcp.js";
export * from "./harness-fake.js";
export { RUNTIME_CHECKS } from "./checks-runtime.js";
export {
	readRuntimeFakeLog,
	type RuntimeFakeConfig,
	type RuntimeFakeFaults,
	type RuntimeFakeLogEntry,
} from "./runtime-fake-module.js";
export * from "./mcp-client.js";
export * from "./runner.js";
export * from "./stub-cli.js";
export * from "./stub-mcp.js";
export * from "./types.js";
