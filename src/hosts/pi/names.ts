// New in agent-workflow (WP11b): registered names of the Pi host. Decision A2-1/A2-2: the Pi host is
// a Pi extension that may be loaded next to other extensions, so its names carry the `aw` prefix. A
// unit test registers them next to another extension's `/workflow` and `workflow_*` names.

/** Slash command: `/aw <action> …`. */
export const AW_COMMAND = "aw" as const;

export const AW_LIST_TOOL = "aw_list" as const;
export const AW_RUN_TOOL = "aw_run" as const;
export const AW_DYNAMIC_TOOL = "aw_dynamic" as const;
export const AW_WAIT_TOOL = "aw_wait" as const;

export const AW_TOOL_NAMES = [
	AW_LIST_TOOL,
	AW_RUN_TOOL,
	AW_DYNAMIC_TOOL,
	AW_WAIT_TOOL,
] as const;
