/**
 * Declared capabilities of an ACP agent preset (pilot). Nothing here is probed or live-verified yet:
 * every row stays `declared` until the live tier ran (design note, phase B2).
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
