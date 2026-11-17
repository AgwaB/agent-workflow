import { projectId } from "../core/state-location.js";
import { HostUsageError } from "./args.js";
import {
	assertActionAllowed,
	hostEnv,
	result,
	type HostApiContext,
} from "./types.js";
import {
	clearProjectWorkflowSettingsBinding,
	clearProjectWorkflowSettingsEntry,
	clearProjectWorkflowSettings,
	inspectProjectWorkflowSettingsRecovery,
	listProjectWorkflowSettings,
	readProjectWorkflowSettingsEntry,
	recoverProjectWorkflowSettings,
	ProjectWorkflowSettingsConflict,
} from "./project-workflow-settings.js";

const FIELDS = {
	list: [],
	show: ["key"],
	"inspect-recovery": [],
	"clear-binding": [
		"projectId",
		"key",
		"storeEpoch",
		"revision",
		"binding",
		"slot",
	],
	reset: ["projectId", "key", "storeEpoch", "revision"],
	purge: ["projectId", "key", "storeEpoch", "revision"],
	"clear-project": ["projectId", "storeEpoch", "rawDigest"],
	recover: ["projectId", "rawDigest"],
} as const;
export type ProjectSettingsRecoveryOp = keyof typeof FIELDS;
export interface ProjectSettingsRecoveryRequest {
	op: ProjectSettingsRecoveryOp;
	projectId?: string;
	key?: string;
	storeEpoch?: string;
	revision?: string;
	rawDigest?: string;
	binding?: "defaults" | "slot";
	slot?: string;
}
export function projectSettingsRecoveryRequest(
	value: unknown,
): ProjectSettingsRecoveryRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HostUsageError("Expected project settings request");
	const request = value as Record<string, unknown>;
	if (typeof request.op !== "string" || !Object.hasOwn(FIELDS, request.op))
		throw new HostUsageError(`op must be ${Object.keys(FIELDS).join(", ")}`);
	const fields: readonly string[] =
		FIELDS[request.op as ProjectSettingsRecoveryOp];
	for (const [key, item] of Object.entries(request)) {
		if (key !== "op" && !fields.includes(key))
			throw new HostUsageError(`${key} is not valid with ${request.op}`);
		if (typeof item !== "string" || !item.trim() || item !== item.trim())
			throw new HostUsageError(`Invalid ${key}`);
	}
	for (const field of fields) {
		if (field === "slot") continue;
		if (!Object.hasOwn(request, field))
			throw new HostUsageError(`${field} is required with ${request.op}`);
	}
	for (const field of ["key", "rawDigest"]) {
		if (
			request[field] !== undefined &&
			!(
				field === "rawDigest" &&
				request.op === "clear-project" &&
				request[field] === "absent"
			) &&
			!/^[a-f0-9]{64}$/.test(request[field] as string)
		)
			throw new HostUsageError(`Invalid ${field}`);
	}
	if (request.op === "clear-binding") {
		if (request.binding !== "defaults" && request.binding !== "slot")
			throw new HostUsageError("binding must be defaults or slot");
		if ((request.binding === "slot") !== Object.hasOwn(request, "slot"))
			throw new HostUsageError("slot is required only for binding slot");
	}
	// SAFETY: the operation-specific allowlist, required fields and string/binding checks above validate this copy.
	return { ...request } as unknown as ProjectSettingsRecoveryRequest;
}
export function projectSettingsRecoveryChanges(
	request: ProjectSettingsRecoveryRequest,
): boolean {
	return !["list", "show", "inspect-recovery"].includes(request.op);
}

/** Trusted host context only. Returns a noncreating, CAS-checked disclosure before consent. */
export async function previewProjectSettingsRecoveryAction(
	ctx: HostApiContext,
	value: unknown,
) {
	const request = projectSettingsRecoveryRequest(value);
	assertActionAllowed(ctx, "profile");
	const changing = projectSettingsRecoveryChanges(request);
	const id = projectId(ctx.cwd);
	if (changing && ctx.readonly)
		throw new HostUsageError("Project settings are read-only");
	if (changing && request.projectId !== id)
		throw new HostUsageError("Project scope does not match the host project");
	const options = { env: hostEnv(ctx) };
	let affected: unknown;
	if (request.op === "inspect-recovery" || request.op === "recover") {
		const inspected = await inspectProjectWorkflowSettingsRecovery(
			ctx.cwd,
			options,
		);
		if (request.op === "recover") {
			if (inspected.rawDigest !== request.rawDigest)
				throw new ProjectWorkflowSettingsConflict(
					"Raw project settings changed; inspect again",
				);
			if (!inspected.malformed)
				throw new HostUsageError(
					"Store is valid; use explicit clear-project instead",
				);
		}
		affected = inspected;
	} else if (request.op === "list" || request.op === "clear-project") {
		const listed = await listProjectWorkflowSettings(ctx.cwd, options);
		if (
			changing &&
			(listed.storeEpoch !== request.storeEpoch ||
				listed.rawDigest !== request.rawDigest)
		)
			throw new ProjectWorkflowSettingsConflict(
				"Project settings changed; list again",
			);
		affected = listed;
	} else {
		const read = await readProjectWorkflowSettingsEntry(
			ctx.cwd,
			request.key!,
			options,
		);
		if (
			changing &&
			(read.storeEpoch !== request.storeEpoch ||
				read.revision !== request.revision)
		)
			throw new ProjectWorkflowSettingsConflict(
				"Project settings entry changed; show again",
			);
		if (changing && !read.entry)
			throw new HostUsageError("Settings entry does not exist");
		affected = read;
		if (request.op === "clear-binding") {
			const binding =
				request.binding === "defaults"
					? read.entry!.intent.defaults
					: Object.hasOwn(read.entry!.intent.slots ?? {}, request.slot!)
						? read.entry!.intent.slots![request.slot!]
						: undefined;
			if (!binding) throw new HostUsageError("Selected binding does not exist");
			affected = {
				storeEpoch: read.storeEpoch,
				revision: read.revision,
				binding,
			};
		}
	}
	const data = {
		projectId: id,
		project: ctx.cwd,
		request,
		changing,
		affected,
		preservation:
			"Other projects and shared profiles/preferences are unchanged. Selected binding clear preserves sibling bindings. Reset retains an empty entry; purge removes it. Whole-project clear removes all local entries. Recovery backs up malformed bytes before replacement; none of these changes alter existing Runs.",
	};
	return result("profile", "success", data, JSON.stringify(data, null, 2));
}

/** Adapters must obtain explicit user consent before calling this changing action. CAS is rechecked. */
export async function projectSettingsRecoveryAction(
	ctx: HostApiContext,
	value: unknown,
) {
	const preview = await previewProjectSettingsRecoveryAction(ctx, value);
	const request = preview.data.request;
	if (!preview.data.changing) return preview;
	const options = { env: hostEnv(ctx) };
	let changed: unknown;
	switch (request.op) {
		case "clear-binding":
			changed = await clearProjectWorkflowSettingsBinding(
				ctx.cwd,
				request.key!,
				{ storeEpoch: request.storeEpoch!, revision: request.revision! },
				request.binding === "defaults"
					? { kind: "defaults" }
					: { kind: "slot", slot: request.slot! },
				options,
			);
			break;
		case "reset":
		case "purge":
			changed = await clearProjectWorkflowSettingsEntry(
				ctx.cwd,
				request.key!,
				{ storeEpoch: request.storeEpoch!, revision: request.revision! },
				request.op,
				options,
			);
			break;
		case "clear-project":
			changed = await clearProjectWorkflowSettings(
				ctx.cwd,
				{ storeEpoch: request.storeEpoch!, rawDigest: request.rawDigest! },
				options,
			);
			break;
		case "recover":
			changed = await recoverProjectWorkflowSettings(
				ctx.cwd,
				request.rawDigest!,
				options,
			);
			break;
		default:
			throw new HostUsageError("Not a changing operation");
	}
	const data = { ...preview.data, changed };
	return result("profile", "success", data, JSON.stringify(data, null, 2));
}
