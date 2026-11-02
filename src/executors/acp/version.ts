// Dependency-free identity of the ACP executor adapter (pilot, 2026-11-02). Not a built-in yet:
// like agent-orchestrator, an ACP agent is registered only after its live conformance passed
// (internal design note acp-pilot-20261102).
export const ACP_ADAPTER_VERSION = "0.1.0";
/** Agent presets this adapter knows; the executor id is the preset id. */
export const ACP_PRESET_IDS = ["gemini"] as const;
export type AcpPresetId = (typeof ACP_PRESET_IDS)[number];
