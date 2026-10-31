/** Latest sanitized tool intent, never tool output or a history of calls. */
export const TASK_ACTIVITY_KINDS = [
	"read",
	"search",
	"web",
	"edit",
	"shell",
	"agent",
	"tool",
] as const;

export interface TaskActivity {
	kind: (typeof TASK_ACTIVITY_KINDS)[number];
	label: string;
	at: string;
}

export function activityPlainText(value: string): string {
	return value
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

/** Allowlist again at persisted-record / browser boundaries. */
export function projectTaskActivity(value: unknown): TaskActivity | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		!TASK_ACTIVITY_KINDS.includes(record.kind as TaskActivity["kind"]) ||
		typeof record.label !== "string" ||
		typeof record.at !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(record.at) ||
		!Number.isFinite(Date.parse(record.at))
	)
		return undefined;
	const label = activityPlainText(record.label).slice(0, 120);
	if (!label) return undefined;
	return { kind: record.kind as TaskActivity["kind"], label, at: record.at };
}
