// Built-in role profiles. These are native executor model ids, not provider-qualified Pi ids.
// `default` and the run executor follow research-execution. A preset is a value table, not a
// compatibility layer; choosing one never imports or migrates another product's settings.
import type {
	EffortLevel,
	WorkflowRoleAssignment,
	WorkflowRoleMap,
} from "./types.js";

export const EXECUTOR_PRESET_IDS = [
	"codex",
	"codex-high",
	"claude",
	"mixed",
] as const;
export type ExecutorPresetId = (typeof EXECUTOR_PRESET_IDS)[number];

export const PRESET_CODEX_MODEL = "gpt-6-luna";
export const PRESET_CODEX_SOL_MODEL = "gpt-6.1-sol";
export const PRESET_CLAUDE_MODEL = "claude-opus-5-5";

export interface ExecutorPreset {
	id: ExecutorPresetId;
	description: string;
	/** The run's executor (role `default`). */
	executor: string;
	roles: WorkflowRoleMap;
}

function runtime(model: string, effort: EffortLevel): WorkflowRoleAssignment {
	return {
		executor: model === PRESET_CLAUDE_MODEL ? "claude" : "codex",
		model,
		effort,
	};
}
const sol = (effort: EffortLevel) => runtime(PRESET_CODEX_SOL_MODEL, effort);
const luna = (effort: EffortLevel) => runtime(PRESET_CODEX_MODEL, effort);
const opus = (effort: EffortLevel) => runtime(PRESET_CLAUDE_MODEL, effort);
const PRESETS: Record<
	ExecutorPresetId,
	{ description: string; roles: WorkflowRoleMap }
> = {
	codex: {
		description: `every role on codex (planning/final judgment: ${PRESET_CODEX_SOL_MODEL}; research, synthesis and verification: ${PRESET_CODEX_MODEL})`,
		roles: {
			planning: sol("high"),
			"research-execution": luna("medium"),
			synthesis: luna("high"),
			verification: luna("high"),
			"final-judgment": sol("xhigh"),
		},
	},
	"codex-high": {
		description: `every role on codex (${PRESET_CODEX_SOL_MODEL}; research: high, planning/synthesis/final judgment: xhigh, verification: max)`,
		roles: {
			planning: sol("xhigh"),
			"research-execution": sol("high"),
			synthesis: sol("xhigh"),
			verification: sol("max"),
			"final-judgment": sol("xhigh"),
		},
	},
	claude: {
		description: `every role on claude (${PRESET_CLAUDE_MODEL}; research: medium, other roles: high)`,
		roles: {
			planning: opus("high"),
			"research-execution": opus("medium"),
			synthesis: opus("high"),
			verification: opus("high"),
			"final-judgment": opus("high"),
		},
	},
	mixed: {
		description: `planning, synthesis and final judgment on claude (${PRESET_CLAUDE_MODEL}, high); research/implementation and verification on codex (${PRESET_CODEX_MODEL}, medium/high)`,
		roles: {
			planning: opus("high"),
			"research-execution": luna("medium"),
			synthesis: opus("high"),
			verification: luna("high"),
			"final-judgment": opus("high"),
		},
	},
};

export function isExecutorPresetId(value: unknown): value is ExecutorPresetId {
	return (
		typeof value === "string" &&
		(EXECUTOR_PRESET_IDS as readonly string[]).includes(value)
	);
}

/** A fresh copy of a built-in preset (throws for an unknown id). */
export function executorPreset(id: string): ExecutorPreset {
	if (!isExecutorPresetId(id))
		throw new Error(
			`unknown preset "${id}"; built-in presets: ${EXECUTOR_PRESET_IDS.join(", ")}`,
		);
	const { description, roles } = PRESETS[id];
	const defaults = roles["research-execution"]!;
	return {
		id,
		description,
		executor: defaults.executor!,
		roles: Object.fromEntries(
			Object.entries({ default: defaults, ...roles }).map(([role, value]) => [
				role,
				{ ...value },
			]),
		),
	};
}
