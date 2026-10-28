// New in agent-workflow (WP31 item 3, owner decisions B2/E4): built-in executor presets. A preset is
// a ready-made role profile (role-profiles.ts): a run executor plus role → executor/model/effort.
// Model ids are names the adapters' CLIs already accept (Codex `codex debug models` slugs, Claude
// Code model aliases); Pi model ids depend on the user's Pi providers, so the `pi` preset leaves the
// model to Pi's own default. Defaults are conservative: one mid-size model per executor, effort
// `high` only for planning, verification and final judgment.
//   codex  every role on codex (gpt-5.6-luna)
//   claude every role on claude (sonnet)
//   pi     every role on pi (Pi's configured default model)
//   mixed  planning, synthesis and final judgment on claude (sonnet); research/implementation
//          (`research-execution`) on codex (gpt-5.6-luna); verification on claude, a different
//          model family from the codex workers whose findings it checks (E4).
// `agent-workflow profile set <name> --preset <id>` saves one as a user profile; `--profile <id>`
// selects one directly when no declared or saved profile has that name.
import type { ThinkingLevel, WorkflowRoleMap } from "./types.js";

export const EXECUTOR_PRESET_IDS = ["codex", "claude", "pi", "mixed"] as const;
export type ExecutorPresetId = (typeof EXECUTOR_PRESET_IDS)[number];

export const PRESET_CODEX_MODEL = "gpt-5.6-luna";
export const PRESET_CLAUDE_MODEL = "sonnet";

export interface ExecutorPreset {
	id: ExecutorPresetId;
	description: string;
	/** The run's executor (role `default`). */
	executor: string;
	roles: WorkflowRoleMap;
}

const EFFORT: Record<string, ThinkingLevel> = {
	default: "medium",
	planning: "high",
	"research-execution": "medium",
	synthesis: "medium",
	verification: "high",
	"final-judgment": "high",
};

function allOn(executor: string, model?: string): WorkflowRoleMap {
	return Object.fromEntries(
		Object.entries(EFFORT).map(([role, effort]) => [
			role,
			{ executor, ...(model === undefined ? {} : { model }), effort },
		]),
	);
}

const PRESETS: Record<ExecutorPresetId, () => ExecutorPreset> = {
	codex: () => ({
		id: "codex",
		description: `every role on codex (${PRESET_CODEX_MODEL})`,
		executor: "codex",
		roles: allOn("codex", PRESET_CODEX_MODEL),
	}),
	claude: () => ({
		id: "claude",
		description: `every role on claude (${PRESET_CLAUDE_MODEL})`,
		executor: "claude",
		roles: allOn("claude", PRESET_CLAUDE_MODEL),
	}),
	pi: () => ({
		id: "pi",
		description: "every role on pi (Pi's configured default model)",
		executor: "pi",
		roles: allOn("pi"),
	}),
	mixed: () => {
		const claude = allOn("claude", PRESET_CLAUDE_MODEL);
		return {
			id: "mixed",
			description: `planning, synthesis, verification and final judgment on claude (${PRESET_CLAUDE_MODEL}); research/implementation on codex (${PRESET_CODEX_MODEL})`,
			executor: "claude",
			roles: {
				...claude,
				"research-execution": {
					executor: "codex",
					model: PRESET_CODEX_MODEL,
					effort: EFFORT["research-execution"]!,
				},
			},
		};
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
	return PRESETS[id]();
}
