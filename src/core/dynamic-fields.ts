// Field checks shared by the dynamic-workflow modules (ctx.agent(), controller calls, generated
// tasks). Moved here unchanged from the four copies they had (refactor 2026-11-04).
import {
	isDynamicOutputProfile,
	type DynamicOutputProfile,
} from "./dynamic-profiles.js";
import type { CompiledDynamicWorkflowTask } from "./types.js";

export function requiredDynamicString(
	value: unknown,
	field: string,
	api = "ctx.agent()",
): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${api} ${field} must be a non-empty string`);
	}
	return value.trim();
}

export function optionalDynamicString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicString(value, field);
}

export function optionalDynamicStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`ctx.agent() ${field} must be an array of strings`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

export function requiredDynamicOutputProfile(
	value: unknown,
	field: string,
	api: string,
): DynamicOutputProfile {
	const profile = requiredDynamicString(value, field, api);
	if (!isDynamicOutputProfile(profile)) {
		throw new Error(`${api} ${field} has an unsupported output profile`);
	}
	return profile;
}

export function isPlainDynamicRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function remainingDynamicRuntimeMs(
	dynamic: CompiledDynamicWorkflowTask,
	consumedRuntimeMs: number,
): number {
	return Math.max(0, dynamic.budget.maxRuntimeMs - consumedRuntimeMs);
}
