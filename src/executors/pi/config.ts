// New in agent-workflow (WP6): descriptor config of the Pi executor. The config is persisted in
// plain text (`worker.json`, `executor.json`) and digested into the execution plan, so it carries
// only non-secret, per-task launch options. Secrets travel through `SubmitRequest.env` /
// `McpServerSpec.env` (WP2c).
import { isAbsolute } from "node:path";
import { SdkError } from "../../sdk/errors.js";
import { isPlainObject, type JsonValue } from "../../sdk/json.js";

export interface PiExecutorConfig {
	/** Pi binary (absolute path or a name on PATH). Default `pi`. */
	readonly piCommand: string;
	/**
	 * Durable adapter state: attempt records (B3 reconcile across processes), raw logs for requests
	 * without `artifactsDir`, kept worker sessions (D3). Default `<AGENT_WORKFLOW_HOME>/executors/pi`.
	 */
	readonly stateDir?: string;
	/** Pi-only (C1): cumulative tool-result budget enforced by a per-run Pi extension. */
	readonly toolResultBudget?: { readonly maxTotalChars: number };
	/**
	 * Pi-only fast tier (`src/core/fast-tier.ts`). `on` requires an eligible OpenAI model in the
	 * request; `api` is the API binding the core resolved for that model.
	 */
	readonly fast?: "on" | "off";
	readonly fastApi?: string;
	/**
	 * Pi-only (A2-4, core-port WP4b): the host asked to inherit its tools; adds codemode,
	 * tool_search, `mcp__*` and the MCP resource tools and loads Pi's built-in MCP with the user's
	 * `mcp.json`. Ignored for readOnly requests.
	 */
	readonly inheritHostTools?: boolean;
	/**
	 * Absolute path of the `pi-web-access` package (Pi's web tools, C2). When absent the adapter
	 * discovers it through `pi list`.
	 */
	readonly webAccessExtension?: string;
	/** Model used by `probe()` for the non-secret `pi auth check` (no model turn). */
	readonly authCheckModel?: string;
	/** Grace between SIGTERM and SIGKILL when cancelling, ms. Default 3000. */
	readonly killGraceMs?: number;
}

const KEYS = new Set([
	"piCommand",
	"stateDir",
	"toolResultBudget",
	"fast",
	"fastApi",
	"inheritHostTools",
	"webAccessExtension",
	"authCheckModel",
	"killGraceMs",
]);

function invalid(message: string): never {
	throw new SdkError("DESCRIPTOR_INVALID", `pi executor config: ${message}`);
}

/** Validate the descriptor config (`null` = defaults). Unknown keys are refused. */
export function parsePiExecutorConfig(
	config: JsonValue | undefined,
): PiExecutorConfig {
	if (config === undefined || config === null) return { piCommand: "pi" };
	if (!isPlainObject(config)) invalid("must be an object or null");
	for (const key of Object.keys(config))
		if (!KEYS.has(key)) invalid(`unknown key ${key}`);
	const out: {
		-readonly [K in keyof PiExecutorConfig]: PiExecutorConfig[K];
	} = { piCommand: "pi" };
	if (config.piCommand !== undefined) {
		if (typeof config.piCommand !== "string" || config.piCommand === "")
			invalid("piCommand must be a non-empty string");
		out.piCommand = config.piCommand;
	}
	for (const key of ["stateDir", "webAccessExtension"] as const) {
		const value = config[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !isAbsolute(value))
			invalid(`${key} must be an absolute path`);
		out[key] = value;
	}
	if (config.toolResultBudget !== undefined) {
		const budget = config.toolResultBudget;
		if (
			!isPlainObject(budget) ||
			typeof budget.maxTotalChars !== "number" ||
			!Number.isSafeInteger(budget.maxTotalChars) ||
			budget.maxTotalChars <= 0
		)
			invalid("toolResultBudget must be { maxTotalChars: positive integer }");
		out.toolResultBudget = { maxTotalChars: budget.maxTotalChars };
	}
	if (config.fast !== undefined) {
		if (config.fast !== "on" && config.fast !== "off")
			invalid("fast must be on|off");
		out.fast = config.fast;
	}
	for (const key of ["fastApi", "authCheckModel"] as const) {
		const value = config[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value === "")
			invalid(`${key} must be a non-empty string`);
		out[key] = value;
	}
	if (config.inheritHostTools !== undefined) {
		if (typeof config.inheritHostTools !== "boolean")
			invalid("inheritHostTools must be boolean");
		out.inheritHostTools = config.inheritHostTools;
	}
	if (config.killGraceMs !== undefined) {
		if (
			typeof config.killGraceMs !== "number" ||
			!Number.isSafeInteger(config.killGraceMs) ||
			config.killGraceMs < 0
		)
			invalid("killGraceMs must be a non-negative integer");
		out.killGraceMs = config.killGraceMs;
	}
	return out;
}
