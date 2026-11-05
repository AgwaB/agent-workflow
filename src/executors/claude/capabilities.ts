/**
 * Claude executor capability table (plan §2.2). `probed` rows were proven live with
 * claude-code 2.1.310 (`CLAUDE_VERIFIED_WITH`); evidence per row is in docs/executors.md#claude-code and
 * test/fixtures/executors/claude/live-calls.md.
 */
import {
	type ExecutorCapabilities,
	level,
	noneCapabilities,
} from "../../sdk/capabilities.js";
import { CLAUDE_EFFORT_LEVELS } from "./argv.js";
import { CLAUDE_VERIFIED_WITH, type SystemPromptMode } from "./config.js";

export function claudeCapabilities(
	systemPromptMode: SystemPromptMode,
): ExecutorCapabilities {
	const probed = level("native", "probed", CLAUDE_VERIFIED_WITH);
	return {
		...noneCapabilities(),
		toolLoop: "agent",
		context: "agent",
		// The CLI's stdio (prompt, control protocol) is owned by the process that spawned it; another
		// process cannot attach to a running attempt, so the runtime must not adopt it.
		sessionBound: true,
		mcpInjection: probed,
		readOnly: probed,
		toolAllowlist: { ...probed, detail: "fine" },
		// --append-system-prompt (default) / --system-prompt (config `systemPromptMode: replace`),
		// both verified live (replace dropped the prompt from ~2.7k to ~0.6k input tokens).
		systemPrompt: { ...probed, detail: systemPromptMode },
		modelSelect: probed,
		effortLevels: [...CLAUDE_EFFORT_LEVELS],
		resume: { ...probed, detail: "native" },
		partialStream: probed,
		usage: { ...probed, detail: "cost" },
		toolTelemetry: probed,
		cancel: { ...probed, detail: "interrupt" },
		// `--json-schema` exists, but SubmitRequest carries no schema yet: not wired.
		nativeSchema: level("none"),
		contextIsolation: probed,
		// Fast mode needs an SDK opt-in (`fast_mode_disabled_reason: sdk_opt_in_required`).
		fastTier: level("none"),
		// C1: the agent owns the tool loop.
		toolResultBudget: level("none"),
		// C2: native WebSearch + WebFetch. Safety controls (private IPs, credential URLs, redaction,
		// budgets) are not documented for the CLI ⇒ unknown (owner decision Q2).
		webTools: { ...probed, detail: "search+fetch", safetyPolicy: "unknown" },
	};
}
