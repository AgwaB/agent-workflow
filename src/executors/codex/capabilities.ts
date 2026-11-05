/**
 * Codex capability table (plan §2.2) with evidence. `probed` rows were confirmed against a live
 * codex-cli (see docs/executors.md#codex and test/fixtures/executors/codex/live-calls.md);
 * `declared` rows follow the 0.159.2 app-server protocol without a live proof.
 */
import {
	type ExecutorCapabilities,
	level,
	noneCapabilities,
} from "../../sdk/capabilities.js";

/** CLI version the probed rows were verified with. */
// 2026-11-01: the live tier (smoke + readonly_enforced, tool_allowlist, isolation,
// session_ownership, resume) re-passed on 0.165.0 (test/fixtures/executors/codex/live-calls.md
// "Re-verification on 0.165.0"); the MCP output limit was re-measured on it the same day. Again on
// 0.166.0 on 2026-11-04 ("Re-verification on 0.166.0"); the output limit was re-measured on it the
// same day (docs/executors.md#codex, unchanged).
export const CODEX_VERIFIED_CLI_VERSION = "0.166.0";
export const CODEX_VERIFIED_WITH = `codex-cli ${CODEX_VERIFIED_CLI_VERSION}, WP7 live 2026-10-26, re-verified 2026-11-04`;

/**
 * Characters of one MCP tool result the model receives (R#9), measured live with the per-run
 * `tool_output_token_limit` below (see docs/executors.md#codex "MCP output limit"). The artifact
 * server is launched with `--max-output-chars` at or below this value.
 */
export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 10_000;
export const CODEX_MCP_OUTPUT_LIMIT_CHARS = 32_000;

/** Reasoning efforts listed by `model/list` for the catalog models (union, 0.159.2). */
export const CODEX_EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;

const probed = (name: "native" | "emulated") =>
	level(name, "probed", CODEX_VERIFIED_WITH);
const declared = (name: "native" | "emulated") => level(name, "declared");

export function codexCapabilities(): ExecutorCapabilities {
	return {
		...noneCapabilities(),
		toolLoop: "agent",
		context: "agent",
		// The app-server owns the thread over one stdio connection; another process cannot attach
		// to a running attempt, so the runtime must not adopt it on reconcile.
		sessionBound: true,
		mcpInjection: probed("native"),
		readOnly: probed("native"),
		toolAllowlist: { ...probed("native"), detail: "coarse" },
		systemPrompt: { ...declared("native"), detail: "append" },
		modelSelect: probed("native"),
		effortLevels: [...CODEX_EFFORT_LEVELS],
		resume: { ...probed("native"), detail: "native" },
		partialStream: probed("native"),
		usage: { ...probed("native"), detail: "tokens" },
		toolTelemetry: probed("native"),
		cancel: { ...probed("native"), detail: "interrupt" },
		// turn/start accepts outputSchema, but SDK v0 SubmitRequest has no schema field.
		nativeSchema: level("none"),
		// Project AGENTS.md, skills, plugins/apps, hooks, memories and the user's MCP servers are
		// switched off per run; $CODEX_HOME/AGENTS.md and ~/.codex/rules cannot be (documented).
		// probe() overrides readOnly/contextIsolation per machine (environment.ts, WP4d).
		contextIsolation: probed("emulated"),
		fastTier: level("none"),
		toolResultBudget: level("none"),
		webTools: {
			...probed("native"),
			detail: "search",
			safetyPolicy: "unknown",
		},
	};
}
