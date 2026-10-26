// New in agent-workflow (WP2a-2): the durable implementation of the SDK `ExecutionAuthority`.
// It moves the launch sequence of pi-subagent's src/workers/durable-worker.mjs (lines ~460–530 at
// ab91a74: barrier await → installDurableWorkerBinding → abort check →
// assertDurableLaunchBarrierV2ExecutionAuthorized → abort check) behind `consume()`, so an
// adapter calls it immediately before its first effect (stage-1 plan §2.1 R#1, design §8.6).
// WP2b: a consume that throws rewrites authority.json to phase "failed" (was left "consuming").
import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AuthorityDecision,
	ExecutionAuthority,
} from "../sdk/authority.js";
import { SdkError } from "../sdk/errors.js";
import {
	assertDurableLaunchBarrierAnyDescriptor,
	assertDurableLaunchBarrierV2ExecutionAuthorized,
	awaitDurableLaunchBarrier,
	awaitDurableLaunchBarrierV2,
	type DurableLaunchBarrierAck,
	type DurableLaunchBarrierDescriptor,
	type DurableLaunchBarrierV2Ack,
	type DurableLaunchBarrierV2Descriptor,
	durableLaunchBarrierDigest,
	isDurableLaunchBarrierError,
	isDurableLaunchBarrierRevokedError,
} from "./durable-launch-barrier.js";
import {
	DURABLE_WORKER_BINDING_ENV,
	type DurableWorkerBinding,
	type DurableWorkerBindingPayload,
	type DurableWorkerBindingPreflight,
	DurableWorkerGuardError,
	installDurableWorkerBinding,
	isDurableWorkerGuardError,
	prepareDurableWorkerBinding,
} from "./workers/durable-worker-binding.js";

/** File in the attempt directory that makes consumption single-use across processes. */
export const AUTHORITY_RECORD_FILE = "authority.json";
export const AUTHORITY_RECORD_SCHEMA = "agent-workflow-execution-authority-v1";

export type DurableAuthorityState =
	| "unconsumed"
	| "consuming"
	| "released"
	| "revoked"
	| "failed";

/** Integrity/guard failure inside `consume()` (failureKind `guard_failure`). */
export class DurableAuthorityError extends Error {
	readonly failureKind = "guard_failure" as const;

	constructor(message: string, options: { cause?: unknown } = {}) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "DurableAuthorityError";
	}
}

/** Guard/integrity failures raised on the way to `released` (all map to `guard_failure`). */
export function isDurableAuthorityError(error: unknown): boolean {
	return (
		error instanceof DurableAuthorityError ||
		isDurableLaunchBarrierError(error) ||
		isDurableWorkerGuardError(error)
	);
}

export interface DurableLaunchAuthorityOptions {
	attemptKey: string;
	runId: string;
	attemptId: string;
	/** Absolute attempt directory; holds `authority.json` (the single-use consumption record). */
	attemptDir: string;
	/**
	 * Launch payload (`worker.json`) fields the binding reads. Its `input.durableLaunchBarrier`
	 * selects the barrier; without one the authority is local (abort check + single-use record).
	 */
	payload?: DurableWorkerBindingPayload | null;
	/** SHA-256 of the payload file bytes. Required with a barrier. */
	launchPayloadSha256?: string;
	/** SHA-256 of the execution plan (see `buildExecutionPlan`). Required with a barrier. */
	executionPlanSha256?: string;
	/** Execution cwd bound into the worker binding (worktree path in worktree mode). */
	executionCwd?: string;
	workerProcessGroupId?: number;
	signal?: AbortSignal;
}

export interface DurableLaunchAuthority extends ExecutionAuthority {
	state(): DurableAuthorityState;
	/** The installed worker binding, available only after `released` (barrier runs only). */
	binding(): Readonly<DurableWorkerBinding> | undefined;
	/** Last decision returned by `consume()`. */
	decision(): AuthorityDecision | undefined;
	/** Error thrown by `consume()`, when it threw. */
	failure(): Error | undefined;
}

function barrierOf(
	payload: DurableWorkerBindingPayload | null | undefined,
):
	| DurableLaunchBarrierDescriptor
	| DurableLaunchBarrierV2Descriptor
	| undefined {
	const barrier: unknown = payload?.input?.durableLaunchBarrier;
	if (!barrier) return undefined;
	try {
		assertDurableLaunchBarrierAnyDescriptor(barrier);
	} catch (error) {
		throw new DurableWorkerGuardError(
			`durable launch barrier descriptor is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return barrier;
}

function isV2(
	barrier: DurableLaunchBarrierDescriptor | DurableLaunchBarrierV2Descriptor,
): barrier is DurableLaunchBarrierV2Descriptor {
	return barrier.schema === "pi-subagent-durable-launch-barrier-v2";
}

async function createConsumptionRecord(
	path: string,
	body: Record<string, unknown>,
): Promise<void> {
	let handle;
	try {
		handle = await open(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST")
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`execution authority for ${String(body.attemptKey)} was already consumed (${path} exists)`,
				{ subject: String(body.attemptKey) },
			);
		throw new DurableAuthorityError(
			`execution authority record could not be created: ${(error as Error).message}`,
			{ cause: error },
		);
	}
	try {
		await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function updateConsumptionRecord(
	path: string,
	body: Record<string, unknown>,
): Promise<void> {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

/**
 * Build the durable authority for one attempt. Preflight (binding shape, digests) runs here, so a
 * malformed payload fails before `submit` with a `DurableWorkerGuardError`.
 *
 * `consume()` order (single use):
 *   abort check → exclusive `authority.json` → barrier await (V2: READY with launchPayloadSha256 +
 *   executionPlanSha256, engine decision, ACK; V1: READY/RELEASE/ACK) → install worker binding →
 *   abort check → `assertDurableLaunchBarrierV2ExecutionAuthorized` (V2) → abort check →
 *   `released`.
 * A revoked barrier or an abort resolves `revoked` (no throw). Guard/integrity failures throw
 * (`DurableAuthorityError`, `DurableLaunchBarrierError`, `DurableWorkerGuardError`). A second
 * consume — in this process or any other for the same attempt directory — rejects with
 * `AUTHORITY_ALREADY_CONSUMED`; after `revoked` it resolves `revoked` again.
 */
export function createDurableLaunchAuthority(
	options: DurableLaunchAuthorityOptions,
): DurableLaunchAuthority {
	const { attemptKey, runId, attemptId, signal } = options;
	if (typeof attemptKey !== "string" || attemptKey.length === 0)
		throw new DurableWorkerGuardError(
			"execution authority attemptKey is required",
		);
	const barrier = barrierOf(options.payload);
	let preflight: Readonly<DurableWorkerBindingPreflight> | undefined;
	if (barrier !== undefined)
		preflight = prepareDurableWorkerBinding({
			payload: options.payload,
			launchPayloadSha256: options.launchPayloadSha256,
			executionPlanSha256: options.executionPlanSha256,
			executionCwd: options.executionCwd ?? options.payload?.cwd,
		});
	const recordPath = join(options.attemptDir, AUTHORITY_RECORD_FILE);
	let state: DurableAuthorityState = "unconsumed";
	let installed: Readonly<DurableWorkerBinding> | undefined;
	let lastDecision: AuthorityDecision | undefined;
	let lastFailure: Error | undefined;
	let recordCreated = false;
	const baseRecord = {
		schema: AUTHORITY_RECORD_SCHEMA,
		attemptKey,
		runId,
		attemptId,
		workerPid: process.pid,
		barrier:
			barrier === undefined
				? null
				: { schema: barrier.schema, identitySha256: barrier.identitySha256 },
		...(options.executionPlanSha256 === undefined
			? {}
			: { executionPlanSha256: options.executionPlanSha256 }),
	};

	async function revoke(reason: string): Promise<AuthorityDecision> {
		state = "revoked";
		lastDecision = { kind: "revoked", attemptKey, reason };
		await updateConsumptionRecord(recordPath, {
			...baseRecord,
			phase: "revoked",
			reason,
			decidedAt: new Date().toISOString(),
		}).catch(() => undefined);
		return lastDecision;
	}

	async function consumeOnce(): Promise<AuthorityDecision> {
		if (signal?.aborted)
			return await revoke(
				"aborted before the execution authority was consumed",
			);
		await createConsumptionRecord(recordPath, {
			...baseRecord,
			phase: "consuming",
			consumedAt: new Date().toISOString(),
		});
		recordCreated = true;
		let grantId: string;
		if (barrier === undefined) {
			grantId = durableLaunchBarrierDigest({ ...baseRecord, local: true });
		} else {
			if (
				options.launchPayloadSha256 === undefined ||
				options.executionPlanSha256 === undefined
			)
				throw new DurableAuthorityError(
					"durable launch barrier requires launch payload and execution plan digests",
				);
			let ack: DurableLaunchBarrierV2Ack | DurableLaunchBarrierAck;
			try {
				ack = isV2(barrier)
					? await awaitDurableLaunchBarrierV2({
							descriptor: barrier,
							runId,
							attemptId,
							launchPayloadSha256: options.launchPayloadSha256,
							executionPlanSha256: options.executionPlanSha256,
							workerProcessGroupId: options.workerProcessGroupId,
							signal,
						})
					: await awaitDurableLaunchBarrier({
							descriptor: barrier,
							runId,
							attemptId,
							launchPayloadSha256: options.launchPayloadSha256,
							executionPlanSha256: options.executionPlanSha256,
							workerProcessGroupId: options.workerProcessGroupId,
							signal,
						});
			} catch (error) {
				if (isDurableLaunchBarrierRevokedError(error))
					return await revoke(
						`durable launch barrier was revoked (cancellation ${error.decision.cancellationId})`,
					);
				if (signal?.aborted)
					return await revoke(
						"aborted while waiting for the durable launch barrier",
					);
				throw error;
			}
			installed = installDurableWorkerBinding({
				payload: options.payload,
				launchPayloadSha256: options.launchPayloadSha256,
				executionPlanSha256: options.executionPlanSha256,
				ack,
				preflight,
			});
			if (signal?.aborted)
				return await revoke("aborted after release acknowledgement");
			if (isV2(barrier)) {
				await assertDurableLaunchBarrierV2ExecutionAuthorized(
					barrier,
					ack as DurableLaunchBarrierV2Ack,
				);
				if (signal?.aborted)
					return await revoke("aborted before prepared execution");
				grantId = (ack as DurableLaunchBarrierV2Ack).decisionSha256;
			} else grantId = (ack as DurableLaunchBarrierAck).releaseSha256;
		}
		state = "released";
		lastDecision = { kind: "released", attemptKey, grantId };
		await updateConsumptionRecord(recordPath, {
			...baseRecord,
			phase: "released",
			grantId,
			decidedAt: new Date().toISOString(),
		});
		return lastDecision;
	}

	return {
		attemptKey,
		async consume() {
			if (state === "revoked" && lastDecision !== undefined)
				return lastDecision;
			if (state !== "unconsumed")
				throw new SdkError(
					"AUTHORITY_ALREADY_CONSUMED",
					`execution authority for ${attemptKey} was already consumed`,
					{ subject: attemptKey },
				);
			state = "consuming";
			try {
				return await consumeOnce();
			} catch (error) {
				state = "failed";
				lastFailure = error instanceof Error ? error : new Error(String(error));
				// WP2b terminal-last-write: a consume that throws (barrier timeout/integrity, guard) leaves
				// a decided record instead of "consuming", before the attempt's terminal result is
				// written. Only when this consume created the record (a second consumer must not
				// overwrite the first one's).
				if (recordCreated)
					await updateConsumptionRecord(recordPath, {
						...baseRecord,
						phase: "failed",
						reason: lastFailure.message,
						decidedAt: new Date().toISOString(),
					}).catch(() => undefined);
				throw error;
			}
		},
		state: () => state,
		binding: () => (state === "released" ? installed : undefined),
		decision: () => lastDecision,
		failure: () => lastFailure,
	};
}

/**
 * Environment entries an adapter adds to its child after `released`, so a durable child can
 * prove which launch it belongs to. WP6's Pi adapter must also set the legacy
 * `PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON` (see `LEGACY_PI_DURABLE_WORKER_BINDING_ENV`).
 */
export function durableWorkerBindingEnv(
	authority: ExecutionAuthority,
): Record<string, string> {
	const binding = (authority as Partial<DurableLaunchAuthority>).binding?.();
	return binding === undefined
		? {}
		: { [DURABLE_WORKER_BINDING_ENV]: JSON.stringify(binding) };
}
