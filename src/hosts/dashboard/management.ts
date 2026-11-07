// Dashboard transport only: shared host actions own all catalog, profile and retention policy.
import { createHash } from "node:crypto";
import { clearExecutorProbeCache } from "../../core/executor-default.js";
import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import { isValidWorkflowName } from "../../core/workflow-specs.js";
import { workflowExecutorRegistration } from "../../core/executor-registry.js";
import { EFFORT_LEVELS, WorkflowValidationError } from "../../core/types.js";
import { HostUsageError } from "../args.js";
import {
	listWorkflowsAction,
	showWorkflowSpecAction,
	workflowRolesAction,
	validateWorkflowAction,
	listAgentsAction,
	profileAction,
	workflowPreferenceAction,
} from "../catalog.js";
import { checkWorkflowAction } from "../launch.js";
import { doctorAction } from "../doctor.js";
import { executorModelsAction } from "../executor-models.js";
import { noticesAction, pruneAction } from "../runs.js";
import {
	assertUserProfileName,
	validateUserProfileValues,
} from "../user-profiles.js";
import type { HostApiContext } from "../types.js";
import { validRunId } from "./security.js";

export class DashboardHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
interface Reply {
	status: number;
	value: unknown;
}
interface Options {
	context: HostApiContext;
	project(id: string): Promise<HostApiContext>;
	body(request: IncomingMessage): Promise<Record<string, unknown>>;
	now(): number;
}
function bad(message: string): never {
	throw new DashboardHttpError(400, message);
}
function name(value: string): string {
	if (value.length > 200 || !isValidWorkflowName(value))
		bad("invalid workflow name");
	return value;
}
function executor(value: string): string {
	// Reuse the profile executor syntax validator; descriptors, never request paths, select adapters.
	validateUserProfileValues({ executor: value });
	if (!workflowExecutorRegistration(value)?.descriptor)
		bad("unknown or unavailable executor");
	return value;
}
function fields(body: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(body).some((key) => !allowed.includes(key)))
		bad("unknown request field");
}
function text(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > 1000)
		bad(`invalid ${key}`);
	return value;
}
function record(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		bad("expected an object");
	return value as Record<string, unknown>;
}
function unset(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string")
	)
		bad("unset must be a string array");
	return value;
}
function bounded(
	body: Record<string, unknown>,
	key: string,
	max: number,
): number | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > max
	)
		bad(`${key} must be an integer from 0 to ${max}`);
	return value;
}
// Stable across directory enumeration order, but includes every preview/protection and parameter.
function canonical(value: unknown): unknown {
	if (Array.isArray(value))
		return value
			.map(canonical)
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}
export function createDashboardManagement(options: Options) {
	// A bounded queue prevents concurrent dashboard probes/prunes (including user-level adapter state).
	let tail: Promise<unknown> = Promise.resolve();
	let queued = 0;
	async function serial<T>(action: () => Promise<T>): Promise<T> {
		if (queued >= 8)
			throw new DashboardHttpError(429, "management queue is full; try again");
		queued++;
		const next = tail.then(action);
		tail = next.catch(() => undefined);
		try {
			return await next;
		} finally {
			queued--;
		}
	}
	let doctorCache:
		| { at: number; result: Awaited<ReturnType<typeof doctorAction>> }
		| undefined;
	async function workflow(ctx: HostApiContext, ref: string): Promise<string> {
		name(ref);
		const catalog = await listWorkflowsAction(ctx);
		const entry = catalog.data.workflows.find((entry) => entry.name === ref);
		if (!entry) throw new DashboardHttpError(404, "workflow not found");
		// Resolve only the server-discovered path, not a request-controlled file reference.
		return resolve(ctx.cwd, entry.specPath);
	}
	return async (
		request: IncomingMessage,
		url: URL,
		parts: string[],
	): Promise<Reply | undefined> => {
		const method = request.method;
		const ok = (value: unknown): Reply => ({ status: 200, value });
		const ctx = options.context;
		try {
			if (parts[0] !== "api") return undefined;
			if (parts[1] === "profiles" && parts.length <= 3) {
				const id = parts[2];
				if (!id && method === "GET")
					return ok(await profileAction(ctx, { op: "list" }));
				if (id === "presets" && method === "GET")
					return ok(await profileAction(ctx, { op: "presets" }));
				if (id) {
					assertUserProfileName(id);
					if (method === "GET")
						return ok(await profileAction(ctx, { op: "show", name: id }));
					if (method === "DELETE")
						return ok(await profileAction(ctx, { op: "delete", name: id }));
					if (method === "PUT") {
						const body = await options.body(request);
						fields(body, ["values", "unset", "preset", "makeDefault"]);
						if (
							body.makeDefault !== undefined &&
							typeof body.makeDefault !== "boolean"
						)
							bad("invalid makeDefault");
						return ok(
							await profileAction(ctx, {
								op: "set",
								name: id,
								values: record(body.values),
								unset: unset(body.unset),
								preset: text(body, "preset"),
								makeDefault: body.makeDefault as boolean | undefined,
							}),
						);
					}
				}
			}
			if (
				parts[1] === "profiles-default" &&
				parts.length === 2 &&
				method === "PUT"
			) {
				const body = await options.body(request);
				fields(body, ["name"]);
				if (body.name !== null) assertUserProfileName(body.name);
				return ok(await profileAction(ctx, { op: "default", name: body.name }));
			}
			if (parts[1] === "workflow-preferences" && parts.length <= 3) {
				if (parts.length === 2 && method === "GET")
					return ok(await workflowPreferenceAction(ctx, { op: "list" }));
				if (parts[2]) {
					const project = url.searchParams.get("project");
					const selected = project ? await options.project(project) : ctx;
					const ref = await workflow(selected, parts[2]);
					if (method === "GET")
						return ok(
							await workflowPreferenceAction(selected, {
								op: "show",
								workflow: ref,
							}),
						);
					if (method === "DELETE")
						return ok(
							await workflowPreferenceAction(selected, {
								op: "clear",
								workflow: ref,
							}),
						);
					if (method === "PUT") {
						const body = await options.body(request);
						fields(body, ["profile", "roles", "unset"]);
						return ok(
							await workflowPreferenceAction(selected, {
								op: "set",
								workflow: ref,
								profile: text(body, "profile"),
								roles: record(body.roles),
								unset: unset(body.unset),
							}),
						);
					}
				}
			}
			if (url.pathname === "/api/executors/models" && method === "GET") {
				const id = url.searchParams.get("executor");
				if (id !== null) executor(id);
				return ok(
					await serial(() =>
						executorModelsAction(ctx, {
							...(id ? { executors: [id] } : {}),
							timeoutMs: 30_000,
						}),
					),
				);
			}
			if (url.pathname === "/api/doctor" && method === "GET") {
				if (
					url.searchParams.has("refresh") &&
					url.searchParams.get("refresh") !== "1"
				)
					bad("refresh must be 1");
				return ok(
					await serial(async () => {
						if (
							!doctorCache ||
							url.searchParams.get("refresh") === "1" ||
							options.now() - doctorCache.at >= 60_000
						) {
							if (url.searchParams.get("refresh") === "1")
								clearExecutorProbeCache();
							doctorCache = {
								at: options.now(),
								result: await doctorAction(ctx, { probeTimeoutMs: 30_000 }),
							};
						}
						return doctorCache.result;
					}),
				);
			}
			if (
				parts[1] !== "projects" ||
				!["workflows", "agents", "prune", "notices"].includes(parts[3] ?? "")
			)
				return undefined;
			const selected = await options.project(parts[2] ?? "");
			const resource = parts[3];
			if (resource === "agents" && parts.length === 4 && method === "GET")
				return ok(await listAgentsAction(selected));
			if (resource === "workflows") {
				if (parts.length === 4 && method === "GET")
					return ok(await listWorkflowsAction(selected));
				if (!parts[4]) return undefined;
				const ref = await workflow(selected, parts[4]);
				if (parts.length === 5 && method === "GET") {
					const spec = await showWorkflowSpecAction(selected, {
						workflow: ref,
					});
					// Keep a malformed workflow inspectable with an inline validation error.
					const validate = async () => {
						try {
							return await validateWorkflowAction(selected, { workflow: ref });
						} catch (error) {
							return {
								error: error instanceof Error ? error.message : String(error),
							};
						}
					};
					return ok({
						spec,
						roles: await workflowRolesAction(selected, { workflow: ref }),
						validation: await validate(),
					});
				}
				if (parts.length === 6 && parts[5] === "check" && method === "POST") {
					const body = await options.body(request);
					fields(body, [
						"executor",
						"profile",
						"model",
						"effort",
						"permissionMode",
					]);
					const id = text(body, "executor");
					if (id) executor(id);
					const effort = text(body, "effort");
					if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort))
						bad("invalid effort");
					const permissionMode = text(body, "permissionMode");
					if (
						permissionMode &&
						permissionMode !== "free" &&
						permissionMode !== "safe"
					)
						bad("invalid permissionMode");
					const profile = text(body, "profile");
					if (profile) assertUserProfileName(profile);
					return ok(
						await serial(() =>
							checkWorkflowAction(selected, {
								workflow: ref,
								executor: id,
								profile,
								model: text(body, "model"),
								effort: effort as (typeof EFFORT_LEVELS)[number] | undefined,
								permissionMode: permissionMode as "free" | "safe" | undefined,
							}),
						),
					);
				}
			}
			if (
				resource === "prune" &&
				method === "POST" &&
				(parts.length === 4 || (parts.length === 5 && parts[4] === "preview"))
			) {
				const body = await options.body(request);
				fields(body, ["keep", "olderThanDays", "digest"]);
				const params = {
					keep: bounded(body, "keep", 100_000),
					olderThanDays: bounded(body, "olderThanDays", 36_500),
				};
				if (
					parts.length === 4 &&
					(typeof body.digest !== "string" ||
						!/^[a-f0-9]{64}$/.test(body.digest))
				)
					bad("a preview digest is required");
				return await serial(async () => {
					const preview = await pruneAction(selected, params);
					const digest = createHash("sha256")
						.update(
							JSON.stringify(
								canonical({ project: parts[2], params, data: preview.data }),
							),
						)
						.digest("hex");
					if (parts.length === 5) return ok({ ...preview, digest });
					if (body.digest !== digest)
						return {
							status: 409,
							value: {
								error:
									"Prune preview changed. Review the new preview before deleting.",
								preview: { ...preview, digest },
							},
						};
					return ok(await pruneAction(selected, { ...params, yes: true }));
				});
			}
			if (resource === "notices") {
				if (parts.length === 4 && method === "GET")
					return ok(
						await noticesAction(selected, { argv: ["list", "--json"] }),
					);
				if (
					parts.length === 6 &&
					method === "POST" &&
					["acknowledge", "clear"].includes(parts[5]!)
				) {
					const run = parts[4]!;
					if (!validRunId(run)) bad("invalid run id");
					const body = await options.body(request);
					fields(body, parts[5] === "clear" ? [] : ["state", "reason"]);
					const argv = [parts[5]!, run];
					if (parts[5] === "acknowledge") {
						if (
							typeof body.state !== "string" ||
							!/^[a-f0-9]{64}$/.test(body.state)
						)
							bad("invalid notice state");
						const reason = text(body, "reason");
						if (!reason) bad("a reason is required");
						argv.push("--state", body.state, "--reason", reason);
					}
					return ok(await noticesAction(selected, { argv }));
				}
			}
			return undefined;
		} catch (error) {
			if (error instanceof DashboardHttpError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (
				/no saved profile named|unknown profile.*default|run.*not found|ENOENT/i.test(
					message,
				)
			)
				throw new DashboardHttpError(404, message);
			if (/Run state changed/.test(message))
				throw new DashboardHttpError(409, message);
			if (
				error instanceof HostUsageError ||
				error instanceof WorkflowValidationError
			)
				throw new DashboardHttpError(400, message);
			throw error;
		}
	};
}
