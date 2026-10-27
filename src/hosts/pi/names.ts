// New in agent-workflow (WP11b): registered names of the Pi host. Decision A2-1/A2-2: the Pi host is
// a Pi extension that may be loaded next to pi-workflow (`@agwab/pi-workflow`), so none of these
// names may equal a pi-workflow name. A unit test registers both sets in one fake ExtensionAPI.

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

/** pi-workflow 0.16.4 (`b83cc4f`) registrations the Pi host must never collide with. */
export const PI_WORKFLOW_COMMAND = "workflow" as const;
export const PI_WORKFLOW_TOOL_NAMES = [
	"workflow_list",
	"workflow_run",
	"workflow_dynamic",
	"workflow_wait",
] as const;
