/**
 * Executor capability table (stage-1 plan §2.2, design §4/§8.1, prior-art §3 #2–#5, §6.5).
 * "unverified" is not the same as "none": it means nobody has confirmed the capability yet.
 */
import { SdkError } from "./errors.js";
import { isPlainObject } from "./json.js";

export const CAPABILITY_LEVELS = ["native", "emulated", "none"] as const;
export type CapabilityLevelName = (typeof CAPABILITY_LEVELS)[number];

export const CAPABILITY_SOURCES = ["declared", "probed", "unverified"] as const;
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export interface Level {
	readonly level: CapabilityLevelName;
	/** declared by the adapter profile / probed at start or by conformance / not confirmed. */
	readonly source: CapabilitySource;
	/** e.g. "codex-cli 0.159.2, conformance 2026-10-26". */
	readonly verifiedWith?: string;
}

export type ToolAllowlistDetail = "fine" | "coarse" | "none";
export type SystemPromptDetail = "replace" | "append" | "none";
export type ResumeDetail = "native" | "fork" | "replay" | "none";
export type UsageDetail = "cost" | "tokens" | "none";
export type CancelDetail = "notify" | "interrupt" | "kill";
export type WebToolsDetail = "search" | "search+fetch" | "none";
/** Who enforces web safety controls (credential URLs, private IPs, redaction, budgets). C2/R#8. */
export type WebSafetyPolicy = "engine" | "cli" | "unknown";

export interface ExecutorCapabilities {
	/** Goose RUNS_OWN_TOOL_LOOP: who drives the tool loop. */
	readonly toolLoop: "engine" | "agent";
	readonly context: "engine" | "agent";
	/** Session cannot be shared across engine sessions/processes. */
	readonly sessionBound: boolean;
	readonly mcpInjection: Level;
	readonly readOnly: Level;
	readonly toolAllowlist: Level & { readonly detail: ToolAllowlistDetail };
	readonly systemPrompt: Level & { readonly detail: SystemPromptDetail };
	readonly modelSelect: Level;
	readonly effortLevels: readonly string[];
	readonly resume: Level & { readonly detail: ResumeDetail };
	readonly partialStream: Level;
	readonly usage: Level & { readonly detail: UsageDetail };
	readonly toolTelemetry: Level;
	readonly cancel: Level & { readonly detail: CancelDetail };
	readonly nativeSchema: Level;
	readonly contextIsolation: Level;
	readonly fastTier: Level;
	/** Only the Pi executor is native; everyone else declares none (C1). */
	readonly toolResultBudget: Level;
	readonly webTools: Level & { readonly detail: WebToolsDetail; readonly safetyPolicy: WebSafetyPolicy };
}

/** Capabilities that carry a `Level` (everything except ownership flags and effortLevels). */
export const LEVEL_CAPABILITY_NAMES = [
	"mcpInjection",
	"readOnly",
	"toolAllowlist",
	"systemPrompt",
	"modelSelect",
	"resume",
	"partialStream",
	"usage",
	"toolTelemetry",
	"cancel",
	"nativeSchema",
	"contextIsolation",
	"fastTier",
	"toolResultBudget",
	"webTools",
] as const;
export type CapabilityName = (typeof LEVEL_CAPABILITY_NAMES)[number];

const DETAIL_VALUES: Partial<Record<CapabilityName, readonly string[]>> = {
	toolAllowlist: ["fine", "coarse", "none"],
	systemPrompt: ["replace", "append", "none"],
	resume: ["native", "fork", "replay", "none"],
	usage: ["cost", "tokens", "none"],
	cancel: ["notify", "interrupt", "kill"],
	webTools: ["search", "search+fetch", "none"],
};

export function level(levelName: CapabilityLevelName, source: CapabilitySource = "declared", verifiedWith?: string): Level {
	return verifiedWith === undefined ? { level: levelName, source } : { level: levelName, source, verifiedWith };
}

/** Most conservative table: nothing supported, every row declared `none`. Adapters spread over this. */
export function noneCapabilities(): ExecutorCapabilities {
	const none = level("none");
	return {
		toolLoop: "agent",
		context: "agent",
		sessionBound: false,
		mcpInjection: none,
		readOnly: none,
		toolAllowlist: { ...none, detail: "none" },
		systemPrompt: { ...none, detail: "none" },
		modelSelect: none,
		effortLevels: [],
		resume: { ...none, detail: "none" },
		partialStream: none,
		usage: { ...none, detail: "none" },
		toolTelemetry: none,
		cancel: { ...none, detail: "kill" },
		nativeSchema: none,
		contextIsolation: none,
		fastTier: none,
		toolResultBudget: none,
		webTools: { ...none, detail: "none", safetyPolicy: "unknown" },
	};
}

/** Structural validation of a capability table. Returns a list of problems (empty = valid). */
export function validateCapabilities(value: unknown): string[] {
	const problems: string[] = [];
	if (!isPlainObject(value)) return ["capabilities must be an object"];
	if (value.toolLoop !== "engine" && value.toolLoop !== "agent") problems.push("toolLoop must be engine|agent");
	if (value.context !== "engine" && value.context !== "agent") problems.push("context must be engine|agent");
	if (typeof value.sessionBound !== "boolean") problems.push("sessionBound must be boolean");
	if (!Array.isArray(value.effortLevels) || !value.effortLevels.every((entry) => typeof entry === "string"))
		problems.push("effortLevels must be string[]");
	for (const name of LEVEL_CAPABILITY_NAMES) {
		const entry = value[name];
		if (!isPlainObject(entry)) {
			problems.push(`${name} must be an object`);
			continue;
		}
		if (!(CAPABILITY_LEVELS as readonly unknown[]).includes(entry.level)) problems.push(`${name}.level is invalid`);
		if (!(CAPABILITY_SOURCES as readonly unknown[]).includes(entry.source)) problems.push(`${name}.source is invalid`);
		if (entry.verifiedWith !== undefined && typeof entry.verifiedWith !== "string")
			problems.push(`${name}.verifiedWith must be a string`);
		const details = DETAIL_VALUES[name];
		if (details !== undefined && !details.includes(entry.detail as string)) problems.push(`${name}.detail is invalid`);
		if (entry.level === "none" && details !== undefined && name !== "cancel" && entry.detail !== "none")
			problems.push(`${name}.detail must be none when level is none`);
	}
	const webTools = value.webTools;
	if (isPlainObject(webTools) && !["engine", "cli", "unknown"].includes(webTools.safetyPolicy as string))
		problems.push("webTools.safetyPolicy must be engine|cli|unknown");
	// Ownership rule (prior-art §3 #2): when the agent owns the tool loop, the engine cannot emulate
	// tool-loop features such as a cumulative tool-result budget.
	const budget = value.toolResultBudget;
	if (value.toolLoop === "agent" && isPlainObject(budget) && budget.level === "emulated")
		problems.push("toolResultBudget cannot be emulated when toolLoop is agent");
	return problems;
}

export function assertCapabilities(value: unknown): asserts value is ExecutorCapabilities {
	const problems = validateCapabilities(value);
	if (problems.length > 0)
		throw new SdkError("INVALID_CAPABILITIES", `invalid executor capabilities: ${problems.join("; ")}`);
}

/**
 * Apply probe results over declared capabilities. Only rows present in `probed` change, and they are
 * marked `source: "probed"` unless they explicitly say otherwise.
 */
export function mergeProbedCapabilities(
	declared: ExecutorCapabilities,
	probed: Partial<ExecutorCapabilities> | undefined,
): ExecutorCapabilities {
	if (probed === undefined) return declared;
	const merged: Record<string, unknown> = { ...declared };
	for (const [key, raw] of Object.entries(probed)) {
		const entry: unknown = raw;
		if (entry === undefined) continue;
		merged[key] =
			(LEVEL_CAPABILITY_NAMES as readonly string[]).includes(key) && isPlainObject(entry)
				? { source: "probed", ...entry }
				: entry;
	}
	assertCapabilities(merged);
	return merged;
}
