// Dashboard transport only: shared host actions own all catalog, profile and retention policy.
import { createHash } from "node:crypto";
import { clearExecutorProbeCache } from "../../core/executor-default.js";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isValidWorkflowName } from "../../core/workflow-specs.js";
import { workflowExecutorRegistration } from "../../core/executor-registry.js";
import { EFFORT_LEVELS, WorkflowValidationError } from "../../core/types.js";
import { LEVEL_CAPABILITY_NAMES } from "../../sdk/capabilities.js";
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
import {
	readProjectWorkflowSettingsAction,
	previewProjectWorkflowSettingsAction,
	saveProjectWorkflowSettingsAction,
} from "../project-workflow-settings-actions.js";
import { ProjectWorkflowSettingsConflict } from "../project-workflow-settings.js";
import { doctorAction } from "../doctor.js";
import { executorModelsAction } from "../executor-models.js";
import { noticesAction, pruneAction, showRunAction } from "../runs.js";
import {
	assertUserProfileName,
	validateUserProfileValues,
} from "../user-profiles.js";
import type { HostApiContext } from "../types.js";
import { validRunId } from "./security.js";
import { workflowSettingsGraph } from "./workflow-graph.js";

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
type CanonicalData =
	| null
	| undefined
	| string
	| number
	| boolean
	| CanonicalData[]
	| { [key: string]: CanonicalData };
// Stable across directory enumeration order, but includes every preview/protection and parameter.
function canonical(value: unknown): CanonicalData {
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
	if (
		value === null ||
		value === undefined ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	)
		return value;
	throw new Error("management preview contains unsupported non-JSON data");
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
	async function workflow(
		ctx: HostApiContext,
		ref: string,
		keyOnly = false,
	): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(ref)) {
			if (keyOnly) throw new DashboardHttpError(404, "workflow key not found");
			name(ref);
		}
		const catalog = await listWorkflowsAction(ctx);
		const entry = catalog.data.workflows.find(
			(entry) => entry.workflowKey === ref || (!keyOnly && entry.name === ref),
		);
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
				if (!id && method === "GET") {
					const result = await profileAction(ctx, { op: "list" });
					return ok({
						...result,
						data: { ...result.data, capabilityNames: LEVEL_CAPABILITY_NAMES },
					});
				}
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
				![
					"workflows",
					"agents",
					"prune",
					"notices",
					"run-deletions",
					"runs",
				].includes(parts[3] ?? "")
			)
				return undefined;
			const selected = await options.project(parts[2] ?? "");
			const resource = parts[3];
			if (
				resource === "runs" &&
				parts.length === 6 &&
				parts[5] === "workflow-settings-target"
			) {
				if (method !== "GET")
					throw new DashboardHttpError(405, "method not allowed");
				const runId = parts[4]!;
				if (!validRunId(runId)) bad("invalid run id");
				if (url.search) bad("lookup accepts no query parameters");
				const shown = await showRunAction(selected, {
					runId,
					snapshot: true,
				}).catch(() => {
					throw new DashboardHttpError(404, "recorded run unavailable");
				});
				if (shown.data.run.runId !== runId)
					throw new DashboardHttpError(404, "exact run not found");
				const unavailable = (reason: string) =>
					ok({ runId, target: null, reason });
				const run = shown.data.run;
				const catalog = await listWorkflowsAction(selected);
				const capture = run.configuration?.capture;
				let matches: typeof catalog.data.workflows;
				if (capture !== undefined) {
					// A recorded capture is authoritative over the legacy specPath. Never fall back to a name.
					if (
						!capture?.identity ||
						typeof capture.key !== "string" ||
						!/^[a-f0-9]{64}$/.test(capture.key)
					)
						return unavailable("recorded-identity-insufficient");
					matches = catalog.data.workflows.filter(
						(entry) =>
							entry.workflowKey === capture.key &&
							JSON.stringify(canonical(entry.identity)) ===
								JSON.stringify(canonical(capture.identity)),
					);
				} else {
					if (typeof run.specPath !== "string" || !run.specPath.trim())
						return unavailable("recorded-source-missing");
					// Lexical comparison only for recorded data. All filesystem resolution is restricted
					// to current server-discovered sources, never an arbitrary recorded/client path.
					let recorded = resolve(selected.cwd, run.specPath);
					// The server's startup root can be a known lexical alias (e.g. /tmp on macOS)
					// of the registered physical root. Resolve only those trusted roots, not run.cwd.
					const startupRoot = await realpath(ctx.cwd).catch(() => undefined);
					const sameStartupProject =
						startupRoot !== undefined &&
						startupRoot ===
							(await realpath(selected.cwd).catch(() => undefined));
					const local = relative(ctx.cwd, recorded);
					if (
						sameStartupProject &&
						!isAbsolute(local) &&
						local !== ".." &&
						!local.startsWith(`..${sep}`)
					)
						recorded = resolve(selected.cwd, local);
					matches = [];
					for (const entry of catalog.data.workflows) {
						const source = resolve(selected.cwd, entry.specPath);
						const physical = await realpath(source).catch(() => undefined);
						if (recorded === source || recorded === physical)
							matches.push(entry);
					}
				}
				if (matches.length === 0) return unavailable("definition-unmatched");
				if (matches.length !== 1) return unavailable("definition-ambiguous");
				const entry = matches[0]!;
				if (!entry.workflowKey || !entry.identity)
					return unavailable("definition-unavailable");
				return ok({ runId, target: { workflowKey: entry.workflowKey } });
			}
			if (resource === "run-deletions") {
				if (method !== "POST")
					throw new DashboardHttpError(405, "method not allowed");
				if (
					!(
						parts.length === 4 ||
						(parts.length === 5 && parts[4] === "preview")
					)
				)
					throw new DashboardHttpError(404, "not found");
				const body = await options.body(request);
				fields(body, ["runIds", "digest"]);
				if (
					!Array.isArray(body.runIds) ||
					!body.runIds.length ||
					!body.runIds.every((id) => typeof id === "string" && validRunId(id))
				)
					bad("runIds must contain nonempty exact run ids");
				const runIds = [...new Set(body.runIds as string[])].sort();
				if (
					(parts.length === 4 || body.digest !== undefined) &&
					(typeof body.digest !== "string" ||
						!/^[a-f0-9]{64}$/.test(body.digest))
				)
					bad("a preview digest is required");
				const argv = runIds.flatMap((id) => ["--run", id]);
				return await serial(async () => {
					const preview = await pruneAction(selected, { argv });
					// A missing retention root can return an empty successful plan. It is not
					// confirmation of the requested exact selection, and must never dispatch deletion.
					const complete = runIds.every((id) =>
						preview.data.runs.some((run) => run.runId === id),
					);
					const digest = createHash("sha256")
						.update(
							JSON.stringify(
								canonical({
									operation: "run-deletions",
									project: { id: parts[2], cwd: selected.cwd },
									runIds,
									preview: { outcome: preview.outcome, data: preview.data },
								}),
							),
						)
						.digest("hex");
					const fresh = {
						...preview,
						runIds,
						digest,
						...(complete
							? {}
							: {
									outcome: "failed",
									error: "requested terminal runs unavailable",
								}),
					};
					if (parts.length === 5) return ok(fresh);
					if (
						body.digest !== digest ||
						preview.outcome !== "success" ||
						!complete
					)
						return {
							status: 409,
							value: {
								error:
									"Run deletion preview changed or failed. Review the fresh preview before deleting.",
								preview: fresh,
							},
						};
					return ok(await pruneAction(selected, { argv: [...argv, "--yes"] }));
				});
			}
			if (resource === "agents" && parts.length === 4 && method === "GET")
				return ok(await listAgentsAction(selected));
			if (resource === "workflows") {
				if (parts.length === 4 && method === "GET")
					return ok(await listWorkflowsAction(selected));
				if (!parts[4]) return undefined;
				const settingsRoute = parts[5] === "settings";
				const ref = await workflow(selected, parts[4], settingsRoute);
				if (settingsRoute) {
					if (parts.length === 6 && method === "GET")
						return ok(await readProjectWorkflowSettingsAction(selected, ref));
					if (
						(parts.length === 6 && method === "PUT") ||
						(parts.length === 7 &&
							["preview", "check"].includes(parts[6]!) &&
							method === "POST")
					) {
						const body = await options.body(request);
						fields(body, ["intent", "expected"]);
						if (method === "PUT")
							return ok(
								await serial(() =>
									saveProjectWorkflowSettingsAction(
										selected,
										ref,
										body.intent,
										body.expected,
									),
								),
							);
						return ok(
							await serial(() =>
								previewProjectWorkflowSettingsAction(
									selected,
									ref,
									body.intent,
									body.expected,
								),
							),
						);
					}
					throw new DashboardHttpError(405, "method not allowed");
				}
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
						roles: await workflowRolesAction(selected, { workflow: ref }).catch(
							(error) => ({
								error: error instanceof Error ? error.message : String(error),
							}),
						),
						validation: await validate(),
						graph: await workflowSettingsGraph(selected, ref),
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
			if (error instanceof ProjectWorkflowSettingsConflict)
				throw new DashboardHttpError(409, error.message);
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
