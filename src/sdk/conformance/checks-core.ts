/**
 * Offline conformance checks: identity, probe, capabilities, idempotency (B3), effect-boundary
 * fencing (R#1), events (§2.3), usage honesty, approvals (R#4), cancel, reconcile, errors,
 * descriptor rediscovery (R#15).
 */
import { decideApproval } from "../approval.js";
import {
	mergeProbedCapabilities,
	validateCapabilities,
} from "../capabilities.js";
import {
	assertWorkflowExecutor,
	CANCEL_RESULTS,
	type CancelResult,
	type ExecRef,
	type ExecutorProbe,
	isContractCompatible,
	isReconcileUnknown,
	isVersionCompatible,
	type WorkflowExecutor,
} from "../contract.js";
import { loadExecutor } from "../descriptor.js";
import { type FailureClass, isSdkError } from "../errors.js";
import {
	type ApprovalRequestEvent,
	type ExecEvent,
	validateEventSequence,
} from "../events.js";
import { isJsonValue, type JsonValue } from "../json.js";
import type { CheckContext, FenceProbe } from "./context.js";
import type {
	CheckOutcome,
	ConformanceCheckInfo,
	ConformanceScenario,
	HarnessSession,
	LaunchRecord,
} from "./types.js";

/** Body of a check: violations (empty = pass) plus optional JSON details. */
export interface CheckBody {
	readonly violations: readonly string[];
	readonly details?: JsonValue;
}

export interface ConformanceCheck extends ConformanceCheckInfo {
	run(ctx: CheckContext): Promise<CheckBody | CheckOutcome>;
}

export function body(violations: readonly string[], details?: JsonValue) {
	return details === undefined ? { violations } : { violations, details };
}

const errorText = (error: unknown) =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const jsonRoundTrips = (value: unknown) => {
	if (!isJsonValue(value)) return false;
	try {
		return (
			JSON.stringify(JSON.parse(JSON.stringify(value))) ===
			JSON.stringify(value)
		);
	} catch {
		return false;
	}
};

/** argv lines then stdin lines of one launch (permission settings may travel on either). */
const invocationText = (launch: LaunchRecord) =>
	[...launch.argv, ...(launch.stdin ?? [])].join("\n");

const sameRef = (a: ExecRef, b: ExecRef) =>
	a.executorId === b.executorId &&
	a.attemptKey === b.attemptKey &&
	a.handle === b.handle &&
	a.sessionId === b.sessionId;

/** Submit a scenario run with a fresh fence probe and drain it to terminal. */
export async function runScenario(
	ctx: CheckContext,
	scenario: ConformanceScenario,
	options: {
		readonly session?: HarnessSession;
		readonly onApproval?: (
			event: ApprovalRequestEvent,
			executor: WorkflowExecutor,
			ref: ExecRef,
		) => Promise<void>;
		readonly request?: Parameters<CheckContext["request"]>[2];
		readonly graceMs?: number;
	} = {},
) {
	const session = options.session ?? (await ctx.open(scenario));
	const executor = session.executor;
	const probe = ctx.fence(session, ctx.key(scenario));
	const req = await ctx.request(probe, scenario, options.request);
	const ref = await ctx.call(executor.submit(req), "submit");
	const onApproval = options.onApproval;
	const drained = await ctx.drain(executor, ref, {
		...(onApproval === undefined
			? {}
			: { onApproval: (event) => onApproval(event, executor, ref) }),
		...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
	});
	return { session, executor, probe, req, ref, ...drained };
}

function streamProblems(drained: {
	timedOut: boolean;
	error?: string;
	terminal: ExecEvent | undefined;
}): string[] {
	const problems: string[] = [];
	if (drained.timedOut)
		problems.push("event stream did not reach a terminal event in time");
	if (drained.error !== undefined)
		problems.push(`observe failed: ${drained.error}`);
	return problems;
}

function fenceViolations(
	probe: FenceProbe,
	effects: number,
	label: string,
): string[] {
	const violations: string[] = [];
	if (effects > 0 && probe.released() === 0)
		violations.push(
			`${label}: ${effects} effect(s) without a released authority consume`,
		);
	for (const record of probe.consumes)
		if (record.effectsBefore > 0)
			violations.push(
				`${label}: consume() called after ${record.effectsBefore} effect(s) — must precede the first effect`,
			);
	if (probe.released() > 1)
		violations.push(`${label}: authority released more than once`);
	return violations;
}

const FAIL_SCENARIOS: readonly [ConformanceScenario, FailureClass][] = [
	["fail_transient", "transient"],
	["fail_rate_limit", "rate_limit"],
	["fail_auth", "auth"],
	["fail_config", "config"],
	["fail_permanent", "permanent"],
];

function probeShapeProblems(probe: ExecutorProbe): string[] {
	const problems: string[] = [];
	if (typeof probe.installed !== "boolean")
		problems.push("probe.installed must be boolean");
	if (probe.cliVersion !== null && typeof probe.cliVersion !== "string")
		problems.push("probe.cliVersion must be string|null");
	if (!["ok", "missing", "expired", "unknown"].includes(probe.auth))
		problems.push("probe.auth must be ok|missing|expired|unknown");
	const limit = probe.mcpOutputLimitChars;
	if (
		limit !== undefined &&
		limit !== null &&
		!(Number.isInteger(limit) && limit > 0)
	)
		problems.push(
			"probe.mcpOutputLimitChars must be a positive integer, null or absent",
		);
	const notice = probe.mcpOutputNoticeChars;
	if (
		notice !== undefined &&
		notice !== null &&
		!(Number.isInteger(notice) && notice >= 0)
	)
		problems.push(
			"probe.mcpOutputNoticeChars must be a non-negative integer, null or absent",
		);
	if (
		probe.notes !== undefined &&
		!(
			Array.isArray(probe.notes) &&
			probe.notes.every((note) => typeof note === "string")
		)
	)
		problems.push("probe.notes must be string[]");
	if (!jsonRoundTrips(probe))
		problems.push("probe result must be JSON-serializable");
	return problems;
}

export const CORE_CHECKS: readonly ConformanceCheck[] = [
	{
		id: "identity.shape",
		tier: "offline",
		area: "identity",
		title:
			"Executor exposes id, semver version, compatible contractVersion and all contract methods",
		refs: ["plan §2.1", "B1"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const violations: string[] = [];
			try {
				assertWorkflowExecutor(session.executor);
			} catch (error) {
				violations.push(errorText(error));
			}
			if (!isContractCompatible(session.executor.contractVersion))
				violations.push(
					`contractVersion ${session.executor.contractVersion} is not compatible`,
				);
			if (session.restart) {
				const again = await session.restart();
				if (again.id !== session.executor.id)
					violations.push("id changed across restart");
				if (!isVersionCompatible(session.executor.version, again.version))
					violations.push("version incompatible across restart");
			}
			return body(violations, {
				id: session.executor.id,
				version: session.executor.version,
				contractVersion: session.executor.contractVersion,
			});
		},
	},
	{
		id: "probe.shape",
		tier: "offline",
		area: "probe",
		title: "probe() resolves a well-formed, JSON-serializable readiness result",
		refs: ["plan §2.1", "prior-art §3 #9", "D1"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const probe = await ctx.call(session.executor.probe(), "probe");
			const violations = probeShapeProblems(probe);
			return body(violations, {
				installed: probe.installed,
				cliVersion: probe.cliVersion,
				auth: probe.auth,
				mcpOutputLimitChars: probe.mcpOutputLimitChars ?? null,
			});
		},
	},
	{
		id: "probe.side_effect_free",
		tier: "offline",
		area: "probe",
		title:
			"probe()/capabilities() never consume authority and never cause effects",
		refs: ["plan §2.1", "R#1", "D1"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const violations: string[] = [];
			const before = await session.effectCount();
			await ctx.call(session.executor.probe(), "probe");
			session.executor.capabilities();
			if ((await session.effectCount()) !== before)
				violations.push("probe() before any submit caused an effect");
			const run = await runScenario(ctx, "complete", { session });
			const effects = await session.effectCount();
			const consumes = run.probe.consumes.length;
			await ctx.call(session.executor.probe(), "probe");
			session.executor.capabilities();
			if (run.probe.consumes.length !== consumes)
				violations.push(
					"probe() called consume() on a previously submitted attempt's authority",
				);
			if ((await session.effectCount()) !== effects)
				violations.push("probe() after a submit caused an effect");
			return body(violations);
		},
	},
	{
		id: "capabilities.valid",
		tier: "offline",
		area: "capabilities",
		title: "capabilities() is a valid, stable, JSON-serializable table",
		refs: ["plan §2.2", "B4"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const first = session.executor.capabilities();
			const second = session.executor.capabilities();
			const violations = validateCapabilities(first).map(
				(problem) => `capabilities: ${problem}`,
			);
			if (!jsonRoundTrips(first))
				violations.push("capabilities must be JSON-serializable");
			if (JSON.stringify(first) !== JSON.stringify(second))
				violations.push("capabilities() must be stable across calls");
			return body(violations);
		},
	},
	{
		id: "capabilities.probe_merge",
		tier: "offline",
		area: "capabilities",
		title: "probe() capability rows merge into a valid table",
		refs: ["plan §2.2", "prior-art §3 #3"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const probe = await ctx.call(session.executor.probe(), "probe");
			const violations: string[] = [];
			try {
				mergeProbedCapabilities(
					session.executor.capabilities(),
					probe.capabilities,
				);
			} catch (error) {
				violations.push(errorText(error));
			}
			return body(violations, {
				probedRows: Object.keys(probe.capabilities ?? {}),
			});
		},
	},
	{
		id: "submit.idempotent_sequential",
		tier: "offline",
		area: "idempotency",
		title:
			"Re-submitting the same attemptKey returns the same ExecRef with no second effect",
		refs: ["plan §2.1", "B3"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete");
			const violations = streamProblems(run);
			const again = await ctx.call(run.executor.submit(run.req), "resubmit");
			if (!sameRef(run.ref, again))
				violations.push("second submit returned a different ExecRef");
			const effects = await run.session.effectCount(run.req.attemptKey);
			if (effects !== 1)
				violations.push(
					`expected exactly 1 effect for the attempt, saw ${effects}`,
				);
			violations.push(...fenceViolations(run.probe, effects, "resubmit"));
			return body(violations, { effects, consumes: run.probe.consumes.length });
		},
	},
	{
		id: "submit.idempotent_concurrent",
		tier: "offline",
		area: "idempotency",
		title: "Concurrent submits with the same attemptKey share one launch",
		refs: ["plan §2.1", "B3"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const probe = ctx.fence(session, ctx.key("concurrent"));
			const req = await ctx.request(probe, "complete");
			const settled = await ctx.call(
				Promise.allSettled([
					session.executor.submit(req),
					session.executor.submit(req),
				]),
				"concurrent submit",
			);
			const violations: string[] = [];
			const refs = settled.flatMap((entry) =>
				entry.status === "fulfilled" ? [entry.value] : [],
			);
			if (refs.length === 0) violations.push("both concurrent submits failed");
			if (refs.length === 2 && !sameRef(refs[0] as ExecRef, refs[1] as ExecRef))
				violations.push("concurrent submits returned different ExecRefs");
			const first = refs[0];
			if (first !== undefined)
				violations.push(
					...streamProblems(await ctx.drain(session.executor, first)),
				);
			const effects = await session.effectCount(req.attemptKey);
			if (effects !== 1)
				violations.push(`expected exactly 1 effect, saw ${effects}`);
			violations.push(...fenceViolations(probe, effects, "concurrent"));
			return body(violations, { effects, fulfilled: refs.length });
		},
	},
	{
		id: "submit.idempotent_after_restart",
		tier: "offline",
		area: "idempotency",
		title:
			"A restarted executor returns the recorded ExecRef for a known attemptKey without a new effect",
		refs: ["plan §2.1", "B3", "R#15"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			if (session.restart === undefined)
				return ctx.skip("harness cannot simulate a restart");
			const run = await runScenario(ctx, "complete", { session });
			const violations = streamProblems(run);
			const restarted = await session.restart();
			const again = await ctx.call(
				restarted.submit(run.req),
				"resubmit after restart",
			);
			if (!sameRef(run.ref, again))
				violations.push("restarted executor returned a different ExecRef");
			const replay = await ctx.drain(restarted, again);
			violations.push(...streamProblems(replay));
			const effects = await session.effectCount(run.req.attemptKey);
			if (effects !== 1)
				violations.push(`expected exactly 1 effect, saw ${effects}`);
			return body(violations, { effects });
		},
	},
	{
		id: "submit.rejects_invalid",
		tier: "offline",
		area: "idempotency",
		title:
			"Invalid requests (authority for another attempt, empty cwd) are refused before any effect",
		refs: ["plan §2.1", "R#1"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const violations: string[] = [];
			const other = ctx.fence(session, ctx.key("other"));
			const target = ctx.key("mismatch");
			const base = await ctx.request(other, "complete");
			const cases = [
				{
					label: "authority for another attempt",
					req: { ...base, attemptKey: target },
				},
				{ label: "empty cwd", req: { ...base, cwd: "" } },
			];
			for (const { label, req } of cases) {
				const outcome = await ctx
					.call(session.executor.submit(req), `submit(${label})`)
					.then(
						() => "resolved",
						(error: unknown) => (isSdkError(error) ? error.code : "rejected"),
					);
				if (outcome === "resolved")
					violations.push(`submit with ${label} must be refused`);
			}
			if (other.consumes.length > 0)
				violations.push("invalid submit consumed the authority");
			const effects = await session.effectCount();
			if (effects !== 0)
				violations.push(`invalid submits caused ${effects} effect(s)`);
			return body(violations);
		},
	},
	{
		id: "fencing.consume_before_effect",
		tier: "offline",
		area: "fencing",
		title:
			"Authority is consumed exactly once, released, and before the first effect",
		refs: ["plan §2.1", "R#1", "design §8.6"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete");
			const violations = streamProblems(run);
			const effects = await run.session.effectCount(run.req.attemptKey);
			if (effects === 0)
				violations.push("harness observed no effect for a successful submit");
			if (run.probe.consumes.length === 0)
				violations.push("submit never called authority.consume()");
			violations.push(...fenceViolations(run.probe, effects, "submit"));
			return body(violations, {
				effects,
				consumes: run.probe.consumes.map((entry) => entry.outcome),
			});
		},
	},
	{
		id: "fencing.revoked_before_consume",
		tier: "offline",
		area: "fencing",
		title:
			"Stop before consume: revoked authority ⇒ no effect, no ExecRef, reconcile not found",
		refs: ["plan §2.1", "R#1"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const probe = ctx.fence(session, ctx.key("revoked"));
			probe.revoke("conformance stop before consume");
			const req = await ctx.request(probe, "complete");
			const violations: string[] = [];
			const outcome = await ctx
				.call(session.executor.submit(req), "submit")
				.then(
					() => "resolved",
					(error: unknown) =>
						isSdkError(error) ? error.code : errorText(error),
				);
			if (outcome === "resolved")
				violations.push(
					"submit returned an ExecRef although authority was revoked",
				);
			const effects = await session.effectCount(req.attemptKey);
			if (effects !== 0)
				violations.push(`revoked attempt caused ${effects} effect(s)`);
			const reconciled = await ctx.call(
				session.executor.reconcile(req.attemptKey),
				"reconcile",
			);
			if ("found" in reconciled)
				violations.push("reconcile reports found for a revoked attempt");
			return body(violations, {
				submit: outcome,
				reconcile: Object.keys(reconciled)[0] ?? null,
			});
		},
	},
	{
		id: "fencing.crash_after_consume",
		tier: "offline",
		area: "fencing",
		title:
			"Crash after consume: no duplicate effect on resubmit (same or restarted executor)",
		refs: ["plan §2.1", "R#1", "B3"],
		scenarios: ["crash_after_consume"],
		async run(ctx) {
			const session = await ctx.open("crash_after_consume");
			const probe = ctx.fence(session, ctx.key("crash"));
			const req = await ctx.request(probe, "crash_after_consume");
			const violations: string[] = [];
			const first = await ctx.call(session.executor.submit(req), "submit").then(
				() => "resolved",
				() => "rejected",
			);
			if (probe.released() !== 1)
				violations.push(
					"crash scenario did not consume the authority exactly once",
				);
			const executors: WorkflowExecutor[] = [session.executor];
			if (session.restart) executors.push(await session.restart());
			const effectsAfterCrash = await session.effectCount(req.attemptKey);
			for (const executor of executors) {
				await ctx.call(executor.submit(req), "resubmit").catch(() => undefined);
			}
			const effects = await session.effectCount(req.attemptKey);
			if (effects > effectsAfterCrash)
				violations.push(
					`resubmit after consume-crash caused ${effects - effectsAfterCrash} new effect(s)`,
				);
			if (effects > 1) violations.push(`attempt has ${effects} effects`);
			return body(violations, {
				firstSubmit: first,
				effects,
				restarts: executors.length - 1,
			});
		},
	},
	{
		id: "events.sequence",
		tier: "offline",
		area: "events",
		title:
			"Event stream is valid: started first, one terminal event last, nothing after terminal",
		refs: ["plan §2.3"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete", { graceMs: 100 });
			const violations = streamProblems(run);
			violations.push(...validateEventSequence(run.events));
			if (run.terminal?.type !== "completed")
				violations.push("complete scenario must end with completed");
			return body(violations, {
				events: run.events.map((event) => event.type),
			});
		},
	},
	{
		id: "events.json_serializable",
		tier: "offline",
		area: "events",
		title:
			"Every event survives a JSON round trip (events are persisted as run evidence)",
		refs: ["plan §2.3", "D3"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete");
			const violations = streamProblems(run);
			run.events.forEach((event, index) => {
				if (!jsonRoundTrips(event))
					violations.push(`#${index} (${event.type}) is not JSON-serializable`);
			});
			if (!jsonRoundTrips(run.ref))
				violations.push("ExecRef is not JSON-serializable");
			return body(violations);
		},
	},
	{
		id: "events.observe_replay",
		tier: "offline",
		area: "events",
		title: "observe() after completion replays the same full stream and ends",
		refs: ["plan §2.3", "R#15"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete");
			const violations = streamProblems(run);
			const replay = await ctx.drain(run.executor, run.ref);
			violations.push(
				...streamProblems(replay).map((problem) => `replay: ${problem}`),
			);
			if (JSON.stringify(replay.events) !== JSON.stringify(run.events))
				violations.push("replayed stream differs from the original stream");
			return body(violations);
		},
	},
	{
		id: "events.unknown_ref",
		tier: "offline",
		area: "events",
		title:
			"observe() of an unknown ExecRef rejects instead of hanging or yielding events",
		refs: ["plan §2.1"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const ref: ExecRef = {
				executorId: session.executor.id,
				attemptKey: ctx.key("unknown"),
				handle: "conformance-unknown-handle",
			};
			const drained = await ctx.drain(session.executor, ref, {
				timeoutMs: ctx.timeouts.callMs,
			});
			const violations: string[] = [];
			if (drained.timedOut) violations.push("observe(unknown ref) hung");
			if (drained.events.length > 0)
				violations.push("observe(unknown ref) yielded events");
			if (!drained.timedOut && drained.error === undefined)
				violations.push("observe(unknown ref) ended without an error");
			return body(violations, { error: drained.error ?? null });
		},
	},
	{
		id: "events.partial_stream",
		tier: "offline",
		area: "events",
		title:
			"Declared partialStream emits message_delta before the terminal event",
		refs: ["plan §2.2", "plan §2.3"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			if (session.executor.capabilities().partialStream.level === "none")
				ctx.skip("partialStream declared none");
			const run = await runScenario(ctx, "complete", { session });
			const violations = streamProblems(run);
			if (!run.events.some((event) => event.type === "message_delta"))
				violations.push(
					"partialStream declared but no message_delta was emitted",
				);
			return body(violations);
		},
	},
	{
		id: "usage.cost_honesty",
		tier: "offline",
		area: "usage",
		title:
			"Unknown cost is null with source unknown — never 0; no cost when usage.detail ≠ cost",
		refs: ["plan §2.3", "prior-art §3 #5", "prior-art §5"],
		scenarios: ["usage_unknown", "complete"],
		async run(ctx) {
			const violations: string[] = [];
			const checked: string[] = [];
			if (ctx.supports("usage_unknown")) {
				const run = await runScenario(ctx, "usage_unknown");
				checked.push("usage_unknown");
				violations.push(...streamProblems(run));
				for (const event of run.events)
					if (
						event.type === "usage" &&
						(event.cost !== null || event.source !== "unknown")
					)
						violations.push(
							`usage_unknown: cost ${String(event.cost)} (source ${event.source}) where the CLI reported no cost — must be cost null, source unknown`,
						);
			}
			if (ctx.supports("complete")) {
				const run = await runScenario(ctx, "complete");
				checked.push("complete");
				violations.push(...streamProblems(run));
				const detail = run.executor.capabilities().usage.detail;
				if (detail !== "cost")
					for (const event of run.events)
						if (event.type === "usage" && event.cost !== null)
							violations.push(
								`usage.detail is ${detail} but a usage event carries cost ${event.cost}`,
							);
			}
			if (checked.length === 0) ctx.skip("no usage scenario supported");
			return body(violations, { scenarios: checked });
		},
	},
	{
		id: "approval.allow",
		tier: "offline",
		area: "approval",
		title:
			"approval_request answered allow ⇒ respond accepted and the run completes",
		refs: ["plan §2.1", "R#4", "D2"],
		scenarios: ["approval"],
		async run(ctx) {
			const answers: string[] = [];
			const run = await runScenario(ctx, "approval", {
				onApproval: async (event, executor, ref) => {
					answers.push(
						await ctx.call(
							executor.respond(ref, event.requestId, "allow"),
							"respond",
						),
					);
				},
			});
			const violations = streamProblems(run);
			if (answers.length === 0)
				violations.push("approval scenario emitted no approval_request");
			if (answers.some((answer) => answer !== "accepted"))
				violations.push(`respond(allow) returned ${answers.join(",")}`);
			if (run.terminal?.type !== "completed")
				violations.push("allowed approval run did not complete");
			violations.push(...validateEventSequence(run.events));
			return body(violations, { answers });
		},
	},
	{
		id: "approval.deny",
		tier: "offline",
		area: "approval",
		title:
			"approval_request answered deny ⇒ the requested action never completes",
		refs: ["plan §2.1", "R#4", "D2"],
		scenarios: ["approval"],
		async run(ctx) {
			const answers: string[] = [];
			const run = await runScenario(ctx, "approval", {
				onApproval: async (event, executor, ref) => {
					answers.push(
						await ctx.call(
							executor.respond(ref, event.requestId, "deny"),
							"respond",
						),
					);
				},
			});
			const violations = streamProblems(run);
			if (answers.some((answer) => answer !== "accepted"))
				violations.push(`respond(deny) returned ${answers.join(",")}`);
			violations.push(...deniedActionViolations(run.events));
			violations.push(...validateEventSequence(run.events));
			return body(violations, { answers });
		},
	},
	{
		id: "approval.respond_unknown",
		tier: "offline",
		area: "approval",
		title: "respond() distinguishes unknown_request and too_late",
		refs: ["plan §2.1", "R#4"],
		scenarios: ["approval"],
		async run(ctx) {
			const results: Record<string, string> = {};
			let answered: string | undefined;
			const run = await runScenario(ctx, "approval", {
				onApproval: async (event, executor, ref) => {
					results.unknown = await ctx.call(
						executor.respond(
							ref,
							`${event.requestId}-conformance-unknown`,
							"deny",
						),
						"respond(unknown)",
					);
					results.first = await ctx.call(
						executor.respond(ref, event.requestId, "deny"),
						"respond",
					);
					answered = event.requestId;
				},
			});
			const violations = streamProblems(run);
			// Answer again once the run has terminated: the request is settled, so it is too_late.
			if (answered !== undefined)
				results.second = await ctx.call(
					run.executor.respond(run.ref, answered, "allow"),
					"respond(again)",
				);
			if (results.unknown !== "unknown_request")
				violations.push(`respond(unknown id) returned ${results.unknown}`);
			if (results.first !== "accepted")
				violations.push(`first respond returned ${results.first}`);
			if (results.second !== "too_late")
				violations.push(
					`second respond returned ${results.second}, expected too_late`,
				);
			violations.push(...deniedActionViolations(run.events));
			return body(violations, results);
		},
	},
	{
		id: "approval.timeout_fail_closed",
		tier: "offline",
		area: "approval",
		title:
			"Unanswered approval with a non-interactive policy fails closed (deny on timeout)",
		refs: ["plan §2.1", "R#4", "D2"],
		scenarios: ["approval"],
		async run(ctx) {
			const run = await runScenario(ctx, "approval", {
				request: {
					approvalPolicy: { allowKinds: [], interactive: false, timeoutMs: 50 },
				},
			});
			const violations = streamProblems(run);
			const request = run.events.find(
				(event): event is ApprovalRequestEvent =>
					event.type === "approval_request",
			);
			if (request === undefined) violations.push("no approval_request emitted");
			else if (
				decideApproval(run.req.approvalPolicy, request, run.req) !== "deny"
			)
				violations.push("kit policy should deny this request (kit bug)");
			violations.push(...deniedActionViolations(run.events));
			return body(violations);
		},
	},
	{
		id: "permission.mode_mapping",
		tier: "offline",
		area: "permission",
		title:
			"free and safe map to distinct documented launch settings; a readOnly stage gets no free-mode setting",
		refs: ["D2 revised", "WP4e"],
		scenarios: ["complete"],
		async run(ctx) {
			const documented = ctx.harness.permissionModes;
			if (documented === undefined)
				return ctx.skip(
					"harness documents no permission-mode settings (harness.permissionModes)",
				);
			const runs: Record<string, string> = {};
			const violations: string[] = [];
			for (const [label, overrides] of [
				["free", { permissionMode: "free", readOnly: false }],
				["safe", { permissionMode: "safe", readOnly: false }],
				["free-readOnly", { permissionMode: "free", readOnly: true }],
			] as const) {
				const run = await runScenario(ctx, "complete", {
					request: { ...overrides, tools: ["read", "bash"] },
				});
				violations.push(...streamProblems(run).map((p) => `${label}: ${p}`));
				if (run.session.launches === undefined)
					return ctx.skip("harness records no launches (session.launches)");
				const launches = await run.session.launches(run.req.attemptKey);
				if (launches.length === 0)
					violations.push(`${label}: no launch recorded`);
				runs[label] = launches.map(invocationText).join("\n---\n");
			}
			const free = new Set(documented.free);
			const safe = new Set(documented.safe);
			const freeOnly = [...free].filter((setting) => !safe.has(setting));
			const safeOnly = [...safe].filter((setting) => !free.has(setting));
			const same = freeOnly.length === 0 && safeOnly.length === 0;
			if (same && documented.equivalent === undefined)
				violations.push(
					"free and safe document the same settings; set harness.permissionModes.equivalent with the documented reason",
				);
			if (!same && documented.equivalent !== undefined)
				violations.push(
					"permissionModes.equivalent is set but free and safe document different settings",
				);
			const missing = (label: string, settings: Iterable<string>) => {
				for (const setting of settings)
					if (!(runs[label] ?? "").includes(setting))
						violations.push(
							`${label} launch lacks documented setting ${JSON.stringify(setting)}`,
						);
			};
			const present = (label: string, settings: Iterable<string>) => {
				for (const setting of settings)
					if ((runs[label] ?? "").includes(setting))
						violations.push(
							`${label} launch has setting ${JSON.stringify(setting)} of the other mode`,
						);
			};
			missing("free", free);
			missing("safe", safe);
			present("free", safeOnly);
			present("safe", freeOnly);
			// readOnly stays read-only in free mode: none of the free-only settings.
			present("free-readOnly", freeOnly);
			missing("free-readOnly", documented.readOnly ?? []);
			return body(violations, {
				free: [...free],
				safe: [...safe],
				readOnly: [...(documented.readOnly ?? [])],
				...(documented.equivalent === undefined
					? {}
					: { equivalent: documented.equivalent }),
			});
		},
	},
	{
		id: "cancel.active",
		tier: "offline",
		area: "cancel",
		title:
			"cancel(turn) of a running attempt resolves promptly and the stream terminates honestly",
		refs: ["plan §2.1", "prior-art §3 #4"],
		scenarios: ["slow"],
		async run(ctx) {
			const session = await ctx.open("slow");
			const probe = ctx.fence(session, ctx.key("cancel"));
			const req = await ctx.request(probe, "slow");
			const executor = session.executor;
			const ref = await ctx.call(executor.submit(req), "submit");
			const started = await ctx.drain(executor, ref, {
				until: (event) => event.type === "started",
			});
			const violations = streamProblems({
				...started,
				terminal: started.events[0],
			});
			const declared = executor.capabilities().cancel.level;
			const result = await ctx
				.call(executor.cancel(ref, "turn"), "cancel")
				.catch((error: unknown) => `threw: ${errorText(error)}`);
			if (!(CANCEL_RESULTS as readonly string[]).includes(result))
				violations.push(`cancel returned ${result}`);
			if (declared === "none" && result !== "unsupported")
				violations.push(`cancel declared none but returned ${result}`);
			if (
				declared !== "none" &&
				(result === "unsupported" || result === "no_active")
			)
				violations.push(
					`cancel declared ${declared} but returned ${result} for a running attempt`,
				);
			const rest = await ctx.drain(executor, ref);
			violations.push(...streamProblems(rest));
			if (
				result === "cancelled" &&
				rest.terminal?.type === "failed" &&
				rest.terminal.class !== "cancelled"
			)
				violations.push(
					`cancelled run failed with class ${rest.terminal.class}, expected cancelled`,
				);
			if (result === "cancelled" && rest.terminal?.type === "completed")
				violations.push("cancel returned cancelled but the run completed");
			if (result === "uncertain") {
				const reconciled = await ctx.call(
					executor.reconcile(req.attemptKey),
					"reconcile",
				);
				if ("absent" in reconciled)
					violations.push("cancel uncertain but reconcile reports absent");
			}
			return body(violations, {
				declared,
				result,
				terminal: rest.terminal?.type ?? null,
			});
		},
	},
	{
		id: "cancel.declared_matches",
		tier: "offline",
		area: "cancel",
		title:
			"cancel() honours the declared cancel capability within the call timeout, for both scopes",
		refs: ["plan §2.1", "plan §2.2"],
		scenarios: ["slow", "complete"],
		async run(ctx) {
			const scenario: ConformanceScenario = ctx.supports("slow")
				? "slow"
				: "complete";
			const violations: string[] = [];
			const results: Record<string, string> = {};
			for (const scope of ["turn", "owned"] as const) {
				const session = await ctx.open(scenario);
				const probe = ctx.fence(session, ctx.key(`scope-${scope}`));
				const req = await ctx.request(probe, scenario);
				const ref = await ctx.call(session.executor.submit(req), "submit");
				const declared = session.executor.capabilities().cancel.level;
				let result: CancelResult | string;
				try {
					result = await ctx.call(
						session.executor.cancel(ref, scope),
						`cancel(${scope})`,
					);
				} catch (error) {
					result = `error: ${errorText(error)}`;
				}
				results[scope] = result;
				if (declared === "none" && result !== "unsupported")
					violations.push(
						`cancel(${scope}) declared none but resolved ${result}`,
					);
				if (declared !== "none" && result === "unsupported")
					violations.push(
						`cancel(${scope}) declared ${declared} but resolved unsupported`,
					);
			}
			return body(violations, results);
		},
	},
	{
		id: "cancel.inactive",
		tier: "offline",
		area: "cancel",
		title:
			"cancel() after terminal is too_late|no_active; cancel of an unknown attempt is no_active",
		refs: ["plan §2.1", "prior-art §3 #4"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete");
			const violations = streamProblems(run);
			const declared = run.executor.capabilities().cancel.level;
			const after = await ctx.call(
				run.executor.cancel(run.ref, "turn"),
				"cancel",
			);
			const allowed =
				declared === "none"
					? ["unsupported", "too_late", "no_active"]
					: ["too_late", "no_active"];
			if (!allowed.includes(after))
				violations.push(`cancel after terminal returned ${after}`);
			const unknown = await ctx.call(
				run.executor.cancel(
					{
						executorId: run.executor.id,
						attemptKey: ctx.key("nothing"),
						handle: "none",
					},
					"turn",
				),
				"cancel(unknown)",
			);
			if (
				unknown !== "no_active" &&
				!(declared === "none" && unknown === "unsupported")
			)
				violations.push(`cancel of an unknown attempt returned ${unknown}`);
			return body(violations, { afterTerminal: after, unknown });
		},
	},
	{
		id: "reconcile.found",
		tier: "offline",
		area: "reconcile",
		title:
			"reconcile(attemptKey) of a launched attempt returns found with the same ExecRef",
		refs: ["plan §2.1", "B3"],
		scenarios: ["complete"],
		async run(ctx) {
			const run = await runScenario(ctx, "complete");
			const violations = streamProblems(run);
			const result = await ctx.call(
				run.executor.reconcile(run.req.attemptKey),
				"reconcile",
			);
			if (!("found" in result))
				violations.push(`reconcile returned ${JSON.stringify(result)}`);
			else if (!sameRef(result.found, run.ref))
				violations.push("reconcile found a different ExecRef");
			if (run.session.restart) {
				const restarted = await run.session.restart();
				const again = await ctx.call(
					restarted.reconcile(run.req.attemptKey),
					"reconcile after restart",
				);
				if (!("found" in again) || !sameRef(again.found, run.ref))
					violations.push(
						"restarted executor did not reconcile the launched attempt",
					);
			}
			return body(violations);
		},
	},
	{
		id: "reconcile.absent",
		tier: "offline",
		area: "reconcile",
		title: "reconcile() of a never-submitted attemptKey returns absent",
		refs: ["plan §2.1", "B3"],
		scenarios: ["complete"],
		async run(ctx) {
			const session = await ctx.open("complete");
			const result = await ctx.call(
				session.executor.reconcile(ctx.key("never")),
				"reconcile",
			);
			return body(
				"absent" in result
					? []
					: [`reconcile returned ${JSON.stringify(result)}`],
			);
		},
	},
	{
		id: "reconcile.unknown",
		tier: "offline",
		area: "reconcile",
		title:
			"Consumed authority without launch evidence reconciles as unknown — never absent",
		refs: ["plan §2.1", "B3", "R#1"],
		scenarios: ["crash_after_consume"],
		async run(ctx) {
			const session = await ctx.open("crash_after_consume");
			const probe = ctx.fence(session, ctx.key("crash"));
			const req = await ctx.request(probe, "crash_after_consume");
			await ctx
				.call(session.executor.submit(req), "submit")
				.catch(() => undefined);
			const violations: string[] = [];
			const executors: WorkflowExecutor[] = [session.executor];
			if (session.restart) executors.push(await session.restart());
			for (const [index, executor] of executors.entries()) {
				const result = await ctx.call(
					executor.reconcile(req.attemptKey),
					"reconcile",
				);
				const label = index === 0 ? "reconcile" : "reconcile after restart";
				if ("absent" in result)
					violations.push(
						`${label} returned absent after a consumed authority (would allow a duplicate launch)`,
					);
				else if (
					"found" in result &&
					(await session.effectCount(req.attemptKey)) === 0
				)
					violations.push(`${label} returned found without any effect`);
				else if (!isReconcileUnknown(result) && !("found" in result))
					violations.push(`${label} returned ${JSON.stringify(result)}`);
			}
			return body(violations);
		},
	},
	{
		id: "errors.failure_classes",
		tier: "offline",
		area: "errors",
		title: "CLI failures map to the normalized failure classes",
		refs: ["plan §2.3", "design §8.3"],
		scenarios: FAIL_SCENARIOS.map(([scenario]) => scenario),
		async run(ctx) {
			const violations: string[] = [];
			const classes: Record<string, string> = {};
			for (const [scenario, expected] of FAIL_SCENARIOS) {
				if (!ctx.supports(scenario)) continue;
				const run = await runScenario(ctx, scenario);
				violations.push(
					...streamProblems(run).map((problem) => `${scenario}: ${problem}`),
				);
				violations.push(
					...validateEventSequence(run.events).map(
						(problem) => `${scenario}: ${problem}`,
					),
				);
				const terminal = run.terminal;
				classes[scenario] =
					terminal?.type === "failed"
						? terminal.class
						: (terminal?.type ?? "none");
				if (terminal?.type !== "failed")
					violations.push(`${scenario}: expected a failed event`);
				else if (terminal.class !== expected)
					violations.push(
						`${scenario}: class ${terminal.class}, expected ${expected}`,
					);
			}
			if (Object.keys(classes).length === 0)
				ctx.skip("no failure scenario supported");
			return body(violations, classes);
		},
	},
	{
		id: "errors.unknown_class",
		tier: "offline",
		area: "errors",
		title:
			"Unrecognized CLI errors are classified unknown (never guessed transient)",
		refs: ["plan §2.3", "B3"],
		scenarios: ["fail_unknown"],
		async run(ctx) {
			const run = await runScenario(ctx, "fail_unknown");
			const violations = streamProblems(run);
			const terminal = run.terminal;
			if (terminal?.type !== "failed")
				violations.push("expected a failed event");
			else if (terminal.class !== "unknown")
				violations.push(`unrecognized error classified ${terminal.class}`);
			return body(violations);
		},
	},
	{
		id: "descriptor.reload",
		tier: "offline",
		area: "descriptor",
		title:
			"The executor's descriptor reloads an executor with the same id and a compatible version",
		refs: ["plan §2.1", "R#15"],
		scenarios: ["complete"],
		async run(ctx) {
			const describe = ctx.harness.descriptor;
			if (describe === undefined)
				return ctx.skip("harness provides no descriptor");
			const session = await ctx.open("complete");
			const { descriptor, registry } = await describe.call(ctx.harness);
			const violations: string[] = [];
			if (!jsonRoundTrips(descriptor))
				violations.push("descriptor is not JSON-serializable");
			try {
				const loaded = await ctx.call(
					loadExecutor(descriptor, registry === undefined ? {} : { registry }),
					"loadExecutor",
				);
				if (loaded.id !== session.executor.id)
					violations.push(`reloaded id ${loaded.id} ≠ ${session.executor.id}`);
				if (!isVersionCompatible(session.executor.version, loaded.version))
					violations.push("reloaded version is incompatible");
			} catch (error) {
				violations.push(`loadExecutor failed: ${errorText(error)}`);
			}
			return body(violations, { module: descriptor.module });
		},
	},
];

/** After a deny/timeout, the requested kind must not show a completed tool call. */
export function deniedActionViolations(events: readonly ExecEvent[]): string[] {
	const violations: string[] = [];
	const index = events.findIndex((event) => event.type === "approval_request");
	if (index < 0) return ["no approval_request emitted"];
	const request = events[index] as ApprovalRequestEvent;
	for (const event of events.slice(index + 1))
		if (
			event.type === "tool_call" &&
			event.kind === request.kind &&
			event.status === "completed"
		)
			violations.push(
				`denied ${request.kind} tool ${event.name} still completed`,
			);
	if (
		!events
			.slice(index + 1)
			.some((event) => event.type === "completed" || event.type === "failed")
	)
		violations.push("run did not terminate after the denied approval");
	return violations;
}
