/**
 * Declared capabilities of an ACP agent preset (pilot). Rows stay `declared`: only the antigravity
 * preset had a manual live check (design note, phase B2, 2026-11-02), not the live conformance tier.
 */
import {
	type ExecutorCapabilities,
	level,
	noneCapabilities,
} from "../../sdk/capabilities.js";
import type { AcpPresetId } from "./version.js";

export function acpCapabilities(preset: AcpPresetId): ExecutorCapabilities {
	const none = noneCapabilities();
	switch (preset) {
		case "antigravity":
			return {
				...none,
				toolLoop: "agent",
				context: "agent",
				sessionBound: true,
				// session/new mcpServers (live: started with its env, called, permission-gated). No allow
				// list; the user's global MCP servers stay out through the worker home (contextIsolation).
				mcpInjection: level("native"),
				// No read-only mode: mode `default` and the engine's answers to permission requests.
				readOnly: level("emulated"),
				// _meta.antigravity.enabledTools (server-enforced allowlist of built-ins; live: only the
				// listed tools were offered). Coarse: grep/find/ls/bash all map to run_command.
				toolAllowlist: { ...level("native"), detail: "coarse" },
				systemPrompt: { ...level("emulated"), detail: "append" },
				modelSelect: level("native"),
				effortLevels: ["low", "medium", "high"],
				partialStream: level("native"),
				usage: { ...level("native"), detail: "tokens" },
				// Live: tool_call/tool_call_update with rawInput (arguments), but rawOutput is a display
				// summary ("Conformance echo"), not the tool result — evidence needs engine-side capture.
				toolTelemetry: level("native"),
				cancel: { ...level("native"), detail: "notify" },
				// Engine-owned GEMINI_HOME: no user hooks, global MCP servers or GEMINI.md (B5).
				contextIsolation: level("emulated"),
				webTools: { ...level("none"), detail: "none", safetyPolicy: "unknown" },
			};
		case "gemini":
			return {
				...none,
				toolLoop: "agent",
				context: "agent",
				// The ACP session lives in the agent process this adapter instance started.
				sessionBound: true,
				// session/new mcpServers + --allowed-mcp-server-names (config.ts).
				mcpInjection: level("native"),
				// --approval-mode plan, and permission requests for writing kinds are denied.
				readOnly: level("emulated"),
				// No per-run tool list on the CLI (tools.core is a settings key).
				toolAllowlist: { ...level("none"), detail: "none" },
				// ACP has no system prompt field: the adapter prefixes it to the prompt.
				systemPrompt: { ...level("emulated"), detail: "append" },
				modelSelect: level("native"),
				partialStream: level("native"),
				usage: { ...level("native"), detail: "tokens" },
				toolTelemetry: level("native"),
				cancel: { ...level("native"), detail: "notify" },
				// GEMINI.md memory files and user settings still load (survey E4).
				contextIsolation: level("none"),
				webTools: {
					...level("native"),
					detail: "search+fetch",
					// google_web_search / web_fetch are model-processed (survey E2).
					safetyPolicy: "unknown",
				},
			};
	}
}
