// Dependency-free identity of the Claude executor adapter. The core executor registry imports only
// this file to build the built-in descriptor (it must not pull the adapter itself into core).
export const CLAUDE_EXECUTOR_ID = "claude";
export const CLAUDE_ADAPTER_VERSION = "0.1.0";
/** WP17 first-run guidance: the command that installs this CLI (named when it is missing). */
export const CLAUDE_INSTALL_COMMAND = "npm i -g @anthropic-ai/claude-code";
