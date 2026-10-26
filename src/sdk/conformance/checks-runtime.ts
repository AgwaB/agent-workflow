/**
 * Runtime-tier conformance checks (WP2b; were WP9a placeholders). They drive the real durable
 * runtime — launch barrier, detached durable worker, reconcile, control mailbox — against the
 * harness's `runtime(scenario)` stage, so every adapter (WP6–WP8) gets them for free:
 * - `runtime.durable_authority`: the fencing trio through a real worker (no effect while the barrier
 *   holds consume, then exactly one; engine revoke → no effect; SIGKILL after the effect → reconcile
 *   never claims `absent`, the attempt needs a decision, no relaunch);
 * - `runtime.detach_rediscovery`: launch from a process that exits, the worker reloads the adapter
 *   from its persisted descriptor, a fresh process reloads it again; an incompatible version is
 *   refused before any effect;
 * - `runtime.control_relay`: approvals (deny/allow) and cancel(owned) relayed through the control
 *   mailbox after the launching process exited.
 * The runtime is imported lazily, so the SDK's static module graph stays runtime-free.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CancelResult, CANCEL_RESULTS } from "../contract.js";
import { loadExecutor } from "../descriptor.js";
import type { ExecEvent } from "../events.js";
import type { ConformanceCheck } from "./checks-core.js";
import type { CheckContext } from "./context.js";
import type { ConformanceScenario, RuntimeStage } from "./types.js";

type Runtime = typeof import("../../runtime/index.js");

const runtimeUrl = new URL("../../runtime/index.js", import.meta.url).href;

async function loadRuntime(): Promise<Runtime> {
	return (await import(runtimeUrl)) as Runtime;
}

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Stages {
	open(scenario: ConformanceScenario): Promise<RuntimeStage>;
	dispose(): Promise<void>;
}

function stages(ctx: CheckContext): Stages {
	const opened: RuntimeStage[] = [];
	return {
		async open(scenario) {
			const runtime = ctx.harness.runtime;
			if (runtime === undefined)
				ctx.skip(
					"harness provides no runtime stage (an executor descriptor loadable in a fresh process)",
				);
			if (!ctx.supports(scenario))
				ctx.skip(`harness does not support scenario ${scenario}`);
			const stage = await runtime.call(ctx.harness, scenario, {
				workDir: await ctx.dir(`runtime-${scenario}`),
			});
			opened.push(stage);
			return stage;
		},
		async dispose() {
			for (const stage of opened) await stage.dispose?.().catch(() => {});
		},
	};
}

interface RunHandle {
	cwd: string;
	runId: string;
	attemptId: string;
	attemptKey: string;
}

function attemptDir(run: RunHandle): string {
	return join(
		run.cwd,
		".agent-workflow/runs",
		run.runId,
		"attempts",
		run.attemptId,
	);
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function execEvents(run: RunHandle): Promise<ExecEvent[]> {
	try {
		return (await readFile(join(attemptDir(run), "exec-events.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ExecEvent);
	} catch {
		return [];
	}
}

type RunOptions = Parameters<Runtime["runSubagent"]>[0];

function runInput(
	stage: RuntimeStage,
	cwd: string,
	attemptKey: string,
	extra: Partial<RunOptions> = {},
): RunOptions {
	return {
		...(stage.runInput as Partial<RunOptions> | undefined),
		cwd,
		executor: stage.descriptor,
		task: `conformance runtime check ${attemptKey}`,
		async: true,
		attemptKey,
		...extra,
	};
}

/** Start a detached run in-process (the check process is not the worker). */
async function startRun(
	rt: Runtime,
	ctx: CheckContext,
	stage: RuntimeStage,
	label: string,
	extra: Partial<RunOptions> = {},
): Promise<RunHandle> {
	const cwd = await ctx.dir(label);
	const attemptKey = ctx.key(label);
	const started = (await rt.runSubagent(
		runInput(stage, cwd, attemptKey, extra),
	)) as { runId: string; attemptId: string };
	return {
		cwd,
		runId: started.runId,
		attemptId: started.attemptId,
		attemptKey,
	};
}

/** Start a detached run from a separate launcher process that exits right away. */
async function launchFromExitedProcess(
	ctx: CheckContext,
	stage: RuntimeStage,
	label: string,
	extra: Partial<RunOptions> = {},
): Promise<RunHandle & { launcherPid: number }> {
	const cwd = await ctx.dir(label);
	const attemptKey = ctx.key(label);
	const input = runInput(stage, cwd, attemptKey, extra);
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { runSubagent } = await import(${JSON.stringify(runtimeUrl)});
const run = await runSubagent(${JSON.stringify(input)});
process.stdout.write(JSON.stringify({ runId: run.runId, attemptId: run.attemptId, pid: process.pid }));`,
		],
		{ stdio: ["ignore", "pipe", "pipe"], env: process.env },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve) =>
		child.once("exit", (exitCode) => resolve(exitCode)),
	);
	if (code !== 0)
		throw new Error(`launcher process exited ${code}: ${stderr.slice(-500)}`);
	let parsed: { runId: string; attemptId: string; pid: number };
	try {
		parsed = JSON.parse(stdout) as typeof parsed;
	} catch {
		throw new Error(
			`launcher process printed no run reference: ${stdout.slice(-300)}`,
		);
	}
	return {
		cwd,
		runId: parsed.runId,
		attemptId: parsed.attemptId,
		attemptKey,
		launcherPid: parsed.pid,
	};
}

interface Settled {
	status: string;
	failureKind: string | null;
	result?: {
		status: string;
		failureKind: string | null;
		metadata?: {
			executor?: {
				authority?: string;
				fenceViolation?: string;
				termination?: string;
				cancelResult?: string;
				approvals?: { requestId: string; decision: string; by?: string }[];
			};
		};
	};
}

/** Wait for the terminal registry state and the finalizer's events (cleanup never races it). */
async function settle(
	rt: Runtime,
	ctx: CheckContext,
	run: RunHandle,
): Promise<Settled | undefined> {
	const waited = await rt.waitForSubagent({
		cwd: run.cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		timeoutMs: ctx.timeouts.streamMs,
		pollIntervalMs: 25,
	});
	if (waited.status !== "completed" || waited.snapshot === null)
		return undefined;
	const deadline = Date.now() + ctx.timeouts.streamMs;
	while (Date.now() < deadline) {
		const events = await rt.readRunEvents(
			{ cwd: run.cwd, runId: run.runId },
			Number.POSITIVE_INFINITY,
		);
		if (events.some((event) => event.type === `run.${waited.snapshot?.status}`))
			break;
		await sleep(25);
	}
	return {
		status: waited.snapshot.status,
		failureKind: waited.snapshot.failureKind,
		result: await readJson(join(attemptDir(run), "result.json")),
	};
}

function describe(settled: Settled | undefined): string {
	if (settled === undefined) return "no terminal state in time";
	const violation = settled.result?.metadata?.executor?.fenceViolation;
	return `${settled.status}/${settled.failureKind}${violation === undefined ? "" : ` (${violation})`}`;
}

function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

async function durableAuthority(ctx: CheckContext) {
	const rt = await loadRuntime();
	const opened = stages(ctx);
	const violations: string[] = [];
	const details: Record<string, string | number | null> = {};
	try {
		// (1) No effect while the barrier holds consume; exactly one after release.
		const complete = await opened.open("complete");
		const barrier = await rt.createDurableLaunchBarrierV2({
			directory: join(await ctx.dir("barriers"), "release"),
			subjectSha256: sha256(`${ctx.checkId}:release`),
			timeoutMs: ctx.timeouts.streamMs,
			pollIntervalMs: 10,
		});
		const released = await startRun(rt, ctx, complete, "release", {
			durableLaunchBarrier: barrier,
		});
		const ready = rt.waitForDurableLaunchBarrierV2Ready(barrier).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		let readyState: Awaited<typeof ready> | undefined;
		void ready.then((state) => {
			readyState = state;
		});
		let earlyEffects = 0;
		while (readyState === undefined) {
			earlyEffects = await complete.effectCount(released.attemptKey);
			if (earlyEffects > 0) break;
			await sleep(20);
		}
		if (earlyEffects > 0)
			violations.push(
				`release: ${earlyEffects} effect(s) while the launch barrier still held the authority (effect without a released consume)`,
			);
		if (readyState !== undefined && "value" in readyState) {
			const effectsAtReady = await complete.effectCount(released.attemptKey);
			if (effectsAtReady > 0 && earlyEffects === 0)
				violations.push(
					`release: ${effectsAtReady} effect(s) before the barrier released consume`,
				);
			await rt.resolveDurableLaunchBarrierV2Release(
				barrier,
				readyState.value,
				sha256(`release:${readyState.value.readySha256}`),
			);
		} else if (earlyEffects === 0)
			violations.push(
				"release: the worker never reached the barrier (consume was never called)",
			);
		const releasedState = await settle(rt, ctx, released);
		details.release = describe(releasedState);
		if (releasedState?.status !== "completed")
			violations.push(
				`release: attempt ended ${describe(releasedState)}, expected completed`,
			);
		const releasedEffects = await complete.effectCount(released.attemptKey);
		if (releasedEffects !== 1)
			violations.push(
				`release: expected exactly 1 effect, saw ${releasedEffects}`,
			);
		const authority = await readJson<{ phase?: string }>(
			join(attemptDir(released), "authority.json"),
		);
		if (earlyEffects === 0 && authority?.phase !== "released")
			violations.push(
				`release: authority.json phase ${authority?.phase ?? "missing"}, expected released`,
			);

		// (2) Engine revoke before consume: no effect, cancelled/revoked.
		const revokeBarrier = await rt.createDurableLaunchBarrierV2({
			directory: join(await ctx.dir("barriers"), "revoke"),
			subjectSha256: sha256(`${ctx.checkId}:revoke`),
			timeoutMs: ctx.timeouts.streamMs,
			pollIntervalMs: 10,
		});
		await rt.revokeDurableLaunchBarrierV2(revokeBarrier, {
			cancellationId: "conformance-revoke",
			reasonSha256: sha256("conformance revoke"),
		});
		const revoked = await startRun(rt, ctx, complete, "revoke", {
			durableLaunchBarrier: revokeBarrier,
		});
		const revokedState = await settle(rt, ctx, revoked);
		details.revoke = describe(revokedState);
		if (
			revokedState?.status !== "cancelled" ||
			revokedState.failureKind !== "revoked"
		)
			violations.push(
				`revoke: attempt ended ${describe(revokedState)}, expected cancelled/revoked`,
			);
		const revokedEffects = await complete.effectCount(revoked.attemptKey);
		if (revokedEffects !== 0)
			violations.push(
				`revoke: revoked attempt caused ${revokedEffects} effect(s)`,
			);

		// (3) Worker killed after the effect: reconcile never claims absent, no relaunch.
		if (process.platform === "win32")
			details.kill = "skipped on win32 (no process groups)";
		else if (!ctx.supports("slow"))
			details.kill = "skipped: harness does not support scenario slow";
		else {
			const slow = await opened.open("slow");
			const killed = await startRun(rt, ctx, slow, "kill");
			const deadline = Date.now() + ctx.timeouts.streamMs;
			while (
				Date.now() < deadline &&
				(await slow.effectCount(killed.attemptKey)) === 0
			)
				await sleep(20);
			const status = await rt.getSubagentStatus({
				cwd: killed.cwd,
				runId: killed.runId,
			});
			const attempt = status?.attempts?.find(
				(candidate) => candidate.attemptId === killed.attemptId,
			);
			const group = attempt?.workerProcessGroupId ?? attempt?.workerPid;
			if (
				(await slow.effectCount(killed.attemptKey)) === 0 ||
				group === undefined
			)
				violations.push(
					"kill: the attempt produced no effect (or no worker) to kill",
				);
			else {
				try {
					process.kill(-group, "SIGKILL");
				} catch {
					// already gone
				}
				const goneBy = Date.now() + ctx.timeouts.callMs;
				while (Date.now() < goneBy && !processGone(attempt?.workerPid ?? group))
					await sleep(20);
				const reconciled = await rt.reconcileSubagentRun({
					cwd: killed.cwd,
					runId: killed.runId,
					staleAfterMs: 1,
					adoptTimeoutMs: 0,
				});
				const outcome = reconciled.executorReconcile?.outcome ?? null;
				details.kill = `${reconciled.status}/${outcome}`;
				if (outcome === "absent")
					violations.push(
						"kill: executor.reconcile returned absent after an effect (B3: unknown ≠ not run)",
					);
				else if (outcome === "error" || outcome === null)
					violations.push(
						`kill: executor.reconcile failed (${reconciled.status}, ${reconciled.executorReconcile?.reason ?? "no executor reconcile"})`,
					);
				if (reconciled.status !== "marked-needs-decision")
					violations.push(
						`kill: reconcile ${reconciled.status}, expected marked-needs-decision (adoption off)`,
					);
				const again = await rt.reconcileSubagentRun({
					cwd: killed.cwd,
					runId: killed.runId,
					staleAfterMs: 1,
					adoptTimeoutMs: 0,
				});
				if (again.status !== "already-terminal")
					violations.push(
						`kill: second reconcile ${again.status}, expected already-terminal`,
					);
				const killedEffects = await slow.effectCount(killed.attemptKey);
				if (killedEffects !== 1)
					violations.push(
						`kill: expected exactly 1 effect (never relaunched), saw ${killedEffects}`,
					);
			}
		}
	} finally {
		await opened.dispose();
	}
	return { violations, details };
}

async function detachRediscovery(ctx: CheckContext) {
	const rt = await loadRuntime();
	const opened = stages(ctx);
	const violations: string[] = [];
	const details: Record<string, string | number | null> = {};
	try {
		const stage = await opened.open("complete");
		const run = await launchFromExitedProcess(ctx, stage, "detach");
		if (!processGone(run.launcherPid))
			violations.push("the launcher process is still alive");
		const settled = await settle(rt, ctx, run);
		details.detach = describe(settled);
		if (settled?.status !== "completed")
			violations.push(
				`detached attempt ended ${describe(settled)}, expected completed`,
			);
		const effects = await stage.effectCount(run.attemptKey);
		if (effects !== 1)
			violations.push(`expected exactly 1 effect, saw ${effects}`);
		const record = await readJson<{
			descriptor?: unknown;
			attemptKey?: string;
		}>(join(attemptDir(run), "executor.json"));
		if (JSON.stringify(record?.descriptor) !== JSON.stringify(stage.descriptor))
			violations.push(
				"executor.json does not hold the descriptor the run was launched with",
			);
		if (record?.attemptKey !== run.attemptKey)
			violations.push("executor.json does not hold the run's attemptKey");
		// A fresh process reloads the adapter from the persisted descriptor.
		const reload = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const { readFile } = await import("node:fs/promises");
const { loadExecutor } = await import(${JSON.stringify(new URL("../descriptor.js", import.meta.url).href)});
const record = JSON.parse(await readFile(${JSON.stringify(join(attemptDir(run), "executor.json"))}, "utf8"));
const executor = await loadExecutor(record.descriptor);
process.stdout.write(JSON.stringify({ id: executor.id, version: executor.version, pid: process.pid }));`,
			],
			{ stdio: ["ignore", "pipe", "pipe"], env: process.env },
		);
		let stdout = "";
		let stderr = "";
		reload.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		reload.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const code = await new Promise<number | null>((resolve) =>
			reload.once("exit", (exitCode) => resolve(exitCode)),
		);
		if (code !== 0)
			violations.push(
				`a fresh process could not reload the descriptor: ${stderr.slice(-300)}`,
			);
		else {
			let reloaded: { id: string; version: string } = { id: "?", version: "?" };
			try {
				reloaded = JSON.parse(stdout) as typeof reloaded;
			} catch {
				violations.push(`fresh-process reload printed ${stdout.slice(-200)}`);
			}
			if (reloaded.id !== stage.descriptor.id)
				violations.push(
					`fresh-process reload built ${reloaded.id}, expected ${stage.descriptor.id}`,
				);
			details.reloaded = `${reloaded.id}@${reloaded.version}`;
		}
		// An incompatible recorded version is refused before any effect.
		const mismatch = await startRun(
			rt,
			ctx,
			{
				...stage,
				descriptor: { ...stage.descriptor, version: "999.0.0" },
			},
			"mismatch",
		);
		const refused = await settle(rt, ctx, mismatch);
		details.mismatch = describe(refused);
		if (refused?.status !== "failed" || refused.failureKind !== "guard_failure")
			violations.push(
				`version mismatch: attempt ended ${describe(refused)}, expected failed/guard_failure`,
			);
		const refusedEffects = await stage.effectCount(mismatch.attemptKey);
		if (refusedEffects !== 0)
			violations.push(
				`version mismatch: ${refusedEffects} effect(s) despite the refusal`,
			);
	} finally {
		await opened.dispose();
	}
	return { violations, details };
}

async function controlRelay(ctx: CheckContext) {
	const rt = await loadRuntime();
	const opened = stages(ctx);
	const violations: string[] = [];
	const details: Record<string, string | number | null> = {};
	let exercised = 0;
	try {
		if (ctx.supports("approval")) {
			const stage = await opened.open("approval");
			for (const decision of ["deny", "allow"] as const) {
				exercised += 1;
				const run = await launchFromExitedProcess(
					ctx,
					stage,
					`approval-${decision}`,
					{
						readOnly: false,
						approvalPolicy: {
							interactive: true,
							timeoutMs: ctx.timeouts.streamMs,
						},
					},
				);
				const ref = {
					cwd: run.cwd,
					runId: run.runId,
					attemptId: run.attemptId,
				};
				const deadline = Date.now() + ctx.timeouts.streamMs;
				let pending: Awaited<ReturnType<Runtime["listPendingApprovals"]>> = [];
				while (Date.now() < deadline && pending.length === 0) {
					pending = await rt.listPendingApprovals(ref);
					if (pending.length === 0) await sleep(20);
				}
				const request = pending[0];
				if (request === undefined) {
					violations.push(
						`${decision}: no pending approval_request reached the control channel`,
					);
					await rt.requestCancel(ref, "owned", {
						ackTimeoutMs: ctx.timeouts.callMs,
					});
					await settle(rt, ctx, run);
					continue;
				}
				const answered = await rt.respondApproval(
					ref,
					request.requestId,
					decision,
					{
						ackTimeoutMs: ctx.timeouts.callMs,
					},
				);
				if (answered.status !== "acked" || answered.result !== "accepted")
					violations.push(
						`${decision}: the relayed answer was ${answered.status}${answered.status === "acked" ? `/${answered.result}` : ""}, expected acked/accepted`,
					);
				const settled = await settle(rt, ctx, run);
				details[`approval_${decision}`] = describe(settled);
				const events = await execEvents(run);
				const executed = events.some(
					(event) =>
						event.type === "tool_call" &&
						event.kind === "execute" &&
						event.status === "completed",
				);
				if (decision === "deny" && executed)
					violations.push(
						"deny: a denied execute tool still completed (the relayed deny was not applied)",
					);
				if (decision === "allow" && settled?.status !== "completed")
					violations.push(
						`allow: attempt ended ${describe(settled)}, expected completed`,
					);
				const recorded = settled?.result?.metadata?.executor?.approvals?.find(
					(approval) => approval.requestId === request.requestId,
				);
				if (recorded?.by !== "host" || recorded.decision !== decision)
					violations.push(
						`${decision}: the result records ${recorded === undefined ? "no decision" : `${recorded.decision} by ${recorded.by}`}, expected ${decision} by host`,
					);
			}
		}
		if (ctx.supports("slow")) {
			const stage = await opened.open("slow");
			const executor = await loadExecutor(stage.descriptor);
			if (executor.capabilities().cancel.level === "none")
				details.cancel = "skipped: capabilities declare cancel none";
			else {
				exercised += 1;
				const run = await launchFromExitedProcess(ctx, stage, "cancel");
				const ref = {
					cwd: run.cwd,
					runId: run.runId,
					attemptId: run.attemptId,
				};
				const deadline = Date.now() + ctx.timeouts.streamMs;
				while (
					Date.now() < deadline &&
					!(await execEvents(run)).some((event) => event.type === "started")
				)
					await sleep(20);
				const cancelled = await rt.requestCancel(ref, "owned", {
					ackTimeoutMs: ctx.timeouts.callMs,
					signalFallback: false,
				});
				if (cancelled.via !== "mailbox")
					violations.push(
						`cancel(owned) was not acknowledged through the mailbox (${cancelled.via})`,
					);
				else if (
					!(CANCEL_RESULTS as readonly string[]).includes(cancelled.result)
				)
					violations.push(`cancel(owned) acked with ${cancelled.result}`);
				const settled = await settle(rt, ctx, run);
				details.cancel = `${cancelled.via === "mailbox" ? (cancelled.result as CancelResult) : cancelled.via} → ${describe(settled)}`;
				if (
					settled?.status !== "cancelled" ||
					settled.failureKind !== "user_cancelled"
				)
					violations.push(
						`cancel(owned): attempt ended ${describe(settled)}, expected cancelled/user_cancelled`,
					);
				if (settled?.result?.metadata?.executor?.termination !== "confirmed")
					violations.push(
						"cancel(owned): no terminal event after cancel(owned) within the grace (termination unconfirmed)",
					);
				const late = await rt.requestCancel(ref, "owned", {
					ackTimeoutMs: ctx.timeouts.callMs,
					signalFallback: false,
				});
				if (late.via !== "mailbox" || late.result !== "no_active")
					violations.push(
						`cancel after terminal: ${late.via}${late.via === "mailbox" ? `/${late.result}` : ""}, expected no_active`,
					);
			}
		}
		if (exercised === 0)
			ctx.skip(
				"harness supports neither scenario approval nor a cancellable slow",
			);
	} finally {
		await opened.dispose();
	}
	return { violations, details };
}

export const RUNTIME_CHECKS: readonly ConformanceCheck[] = [
	{
		id: "runtime.durable_authority",
		tier: "runtime",
		area: "runtime",
		title:
			"Durable launch authority through a real worker: no effect before the barrier releases consume, revoke → no effect, SIGKILL after the effect → reconcile never absent, no relaunch",
		refs: ["plan §2.1", "R#1", "B3", "WP2a-2", "WP2b"],
		scenarios: ["complete", "slow"],
		run: durableAuthority,
	},
	{
		id: "runtime.detach_rediscovery",
		tier: "runtime",
		area: "runtime",
		title:
			"Detach from a launcher that exits; the worker and a fresh process reload the adapter from its descriptor; an incompatible version is refused before any effect",
		refs: ["plan §2.1", "R#15", "WP2a-2", "WP2b"],
		scenarios: ["complete"],
		run: detachRediscovery,
	},
	{
		id: "runtime.control_relay",
		tier: "runtime",
		area: "runtime",
		title:
			"Approvals (deny/allow) and cancel(owned) relay through the control mailbox after the launching host exits",
		refs: ["R#2", "R#4", "D2", "WP2b"],
		scenarios: ["approval", "slow"],
		run: controlRelay,
	},
];
