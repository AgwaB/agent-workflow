import type { WorkflowTaskRunRecord } from "./types.js";

const LOOP_CHILD_STAGE_ID_PATTERN = /^(.+?)\.r\d{2,}\.(.+)$/;

/**
 * Identity of a loop child for a consumer outside the loop: the loop id and the round-independent source
 * name (`<loop>.<child>`), derived from the persisted stage id so no round number leaks into the name.
 */
export function loopChildSourceIdentity(
	task: Pick<WorkflowTaskRunRecord, "stageId" | "specId">,
): { loopId: string; alias: string } | undefined {
	const match = LOOP_CHILD_STAGE_ID_PATTERN.exec(task.stageId ?? "");
	if (!match || !task.specId.startsWith(task.stageId ?? "")) return undefined;
	const [, loopId, childStageId] = match;
	const taskSuffix = task.specId.slice((task.stageId ?? "").length);
	return {
		loopId: loopId!,
		alias: `${loopId}.${childStageId}${taskSuffix}`,
	};
}

export interface SourceNameOptions {
	/**
	 * Spec id of the task consuming the source. A loop child consumed from outside its loop is named
	 * `<loop>.<child>` (the consumer receives the last executed round); inside the loop the round-specific
	 * stage id stays.
	 */
	consumerSpecId?: string;
}

function loopChildAliasFor(
	task: WorkflowTaskRunRecord,
	options: SourceNameOptions | undefined,
): { loopId: string; alias: string } | undefined {
	if (options?.consumerSpecId === undefined || task.dynamicGenerated)
		return undefined;
	const identity = loopChildSourceIdentity(task);
	if (!identity) return undefined;
	return options.consumerSpecId.startsWith(`${identity.loopId}.`)
		? undefined
		: identity;
}

export function loopChildSourceLoopId(
	task: WorkflowTaskRunRecord,
	consumerSpecId: string,
): string | undefined {
	return loopChildAliasFor(task, { consumerSpecId })?.loopId;
}

/** Shared by manifest emission and bounded raw selection. */
export function sourceNameForTask(
	task: WorkflowTaskRunRecord,
	usedNames: Set<string>,
	options?: SourceNameOptions,
): string {
	const preferred = task.dynamicGenerated
		? task.specId
		: (loopChildAliasFor(task, options)?.alias ?? task.stageId ?? task.specId);
	if (!usedNames.has(preferred)) {
		usedNames.add(preferred);
		return preferred;
	}
	usedNames.add(task.specId);
	return task.specId;
}

export function dynamicOutputSourceName(
	controllerTask: WorkflowTaskRunRecord,
	index: number,
	usedNames: Set<string>,
): string {
	const base = `${controllerTask.stageId ?? controllerTask.specId}.output${index === 0 ? "" : `.${index + 1}`}`;
	if (!usedNames.has(base)) {
		usedNames.add(base);
		return base;
	}
	let suffix = 2;
	while (usedNames.has(`${base}.${suffix}`)) suffix += 1;
	const source = `${base}.${suffix}`;
	usedNames.add(source);
	return source;
}

export function dynamicOutputTaskSpecIds(control: unknown): string[] {
	if (!control || typeof control !== "object" || Array.isArray(control))
		return [];
	const record = control as Record<string, unknown>;
	return [
		...new Set(
			[record.outputTasks, record.outputTaskIds, record.exportedTasks].flatMap(
				(value) =>
					Array.isArray(value)
						? value.filter((item): item is string => typeof item === "string")
						: [],
			),
		),
	];
}
