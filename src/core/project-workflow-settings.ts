import { EFFORT_LEVELS, type EffortLevel } from "./types.js";

export interface ProjectWorkflowSettingsBinding {
	executor: string;
	model?: string;
	effort?: EffortLevel;
}

export interface ProjectWorkflowSettingsIntent {
	defaults?: ProjectWorkflowSettingsBinding;
	slots?: Record<string, ProjectWorkflowSettingsBinding>;
}

export type ProjectWorkflowSettingsIdentity =
	| {
			scope: "project-shared" | "project-private" | "user" | "package";
			relativeSpec: string;
	  }
	| { scope: "external"; physicalSpecPath: string };

export interface ProjectWorkflowSettingsTarget {
	specPath: string;
	identity: ProjectWorkflowSettingsIdentity;
	key: string;
	definitionFingerprint: string;
	resolutionToken: string;
}

/** Frozen intent only; runtime resolution and provenance are captured separately. */
export interface ProjectWorkflowSettingsCapture {
	identity: ProjectWorkflowSettingsIdentity;
	key: string;
	storeEpoch: string;
	revision: string;
	definitionFingerprint: string;
	intent: ProjectWorkflowSettingsIntent;
}

/** Server-provided metadata, never request-provided slot authorization. */
export interface ProjectWorkflowSettingsEditableSlot {
	id: string;
	kind: "model" | "dynamic-profile" | "controller" | "code" | "group";
	/** Dynamic profiles must retain their controller's effective executor. */
	parentExecutor?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		throw new Error(`Invalid ${label}: expected an object`);
	return value as Record<string, unknown>;
}

function fields(
	value: Record<string, unknown>,
	allowed: string[],
	label: string,
): void {
	for (const key of Reflect.ownKeys(value)) {
		if (
			typeof key !== "string" ||
			!allowed.includes(key) ||
			value[key] === undefined
		)
			throw new Error(
				`Invalid ${label}: unknown or undefined field ${String(key)}`,
			);
	}
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim())
		throw new Error(
			`Invalid ${label}: expected a nonempty string without surrounding whitespace`,
		);
	return value;
}

function binding(value: unknown): ProjectWorkflowSettingsBinding {
	const block = record(value, "settings binding");
	fields(block, ["executor", "model", "effort"], "settings binding");
	const executor = text(block.executor, "executor binding");
	const model = Object.hasOwn(block, "model")
		? text(block.model, "model")
		: undefined;
	if (model?.toLowerCase() === "automatic")
		throw new Error("Automatic is not an explicit model");
	const effort = block.effort;
	if (
		Object.hasOwn(block, "effort") &&
		!EFFORT_LEVELS.includes(effort as EffortLevel)
	)
		throw new Error("Invalid effort");
	return {
		executor,
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort: effort as EffortLevel }),
	};
}

/** Strict structural validation does not discard unknown or empty explicit values. */
export function validateProjectWorkflowSettingsIntent(
	value: unknown,
): ProjectWorkflowSettingsIntent {
	const intent = record(value, "settings intent");
	fields(intent, ["defaults", "slots"], "settings intent");
	const result: ProjectWorkflowSettingsIntent = {};
	if (Object.hasOwn(intent, "defaults"))
		result.defaults = binding(intent.defaults);
	if (Object.hasOwn(intent, "slots")) {
		const slots = record(intent.slots, "settings slots");
		result.slots = Object.fromEntries(
			Reflect.ownKeys(slots).map((id) => {
				text(id, "slot id");
				return [id, binding(slots[id as string])];
			}),
		);
	}
	return result;
}

/** Orphan intent remains readable, but cannot be saved until removed or valid again. */
export function validateProjectWorkflowSettingsSlots(
	intent: ProjectWorkflowSettingsIntent,
	slots: readonly ProjectWorkflowSettingsEditableSlot[],
): void {
	for (const [id, block] of Object.entries(intent.slots ?? {})) {
		const matches = slots.filter((slot) => slot.id === id);
		const slot = matches[0];
		if (
			matches.length !== 1 ||
			!slot ||
			(slot.kind !== "model" && slot.kind !== "dynamic-profile")
		)
			throw new Error(`Unknown or noneditable settings slot: ${id}`);
		if (
			slot.kind === "dynamic-profile" &&
			(!slot.parentExecutor || block.executor !== slot.parentExecutor)
		)
			throw new Error(
				`Dynamic settings slot must use its controller executor: ${id}`,
			);
	}
}
