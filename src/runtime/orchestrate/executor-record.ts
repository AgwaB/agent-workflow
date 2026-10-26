// New in agent-workflow (WP2a-2): the per-attempt executor record (`executor.json`) that lets a
// later process (reconcile, terminal finalizer, resumed supervisor) reload the executor from its
// descriptor (R#15) and ask it about the attempt by its attemptKey (B3).
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalPolicy } from "../../sdk/approval.js";
import {
	type ExecutorDescriptor,
	validateExecutorDescriptor,
} from "../../sdk/descriptor.js";
import { isPlainObject } from "../../sdk/json.js";

export const EXECUTOR_RECORD_FILE = "executor.json";
export const EXECUTOR_RECORD_SCHEMA = "agent-workflow-attempt-executor-v1";

export interface AttemptExecutorRecord {
	schema: typeof EXECUTOR_RECORD_SCHEMA;
	descriptor: ExecutorDescriptor;
	attemptKey: string;
	readOnly: boolean;
	approvalPolicy: ApprovalPolicy;
	/** SHA-256 of the execution plan the attempt was prepared with. */
	executionPlanSha256: string;
}

export async function writeAttemptExecutorRecord(
	attemptDir: string,
	record: Omit<AttemptExecutorRecord, "schema">,
): Promise<void> {
	const path = join(attemptDir, EXECUTOR_RECORD_FILE);
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(
		temp,
		`${JSON.stringify({ schema: EXECUTOR_RECORD_SCHEMA, ...record }, null, 2)}\n`,
	);
	await rename(temp, path);
}

/**
 * Read `executor.json`; falls back to the `executor` field of a durable `worker.json`.
 * Returns undefined when neither exists (attempts created before WP2a-2 or by hand), and
 * `{ invalid }` when a record exists but cannot be trusted.
 */
export async function readAttemptExecutorRecord(
	attemptDir: string,
	runId: string,
	attemptId: string,
): Promise<AttemptExecutorRecord | { invalid: string } | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(
			await readFile(join(attemptDir, EXECUTOR_RECORD_FILE), "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
			return {
				invalid: `executor.json is unreadable: ${(error as Error).message}`,
			};
		try {
			const payload: unknown = JSON.parse(
				await readFile(join(attemptDir, "worker.json"), "utf8"),
			);
			if (!isPlainObject(payload) || payload.executor === undefined)
				return undefined;
			const input = isPlainObject(payload.input) ? payload.input : {};
			raw = {
				schema: EXECUTOR_RECORD_SCHEMA,
				descriptor: payload.executor,
				attemptKey:
					typeof input.attemptKey === "string"
						? input.attemptKey
						: `${runId}:${attemptId}`,
				readOnly: input.readOnly === true,
				approvalPolicy: input.approvalPolicy,
				executionPlanSha256: "",
			};
		} catch {
			return undefined;
		}
	}
	if (!isPlainObject(raw) || raw.schema !== EXECUTOR_RECORD_SCHEMA)
		return { invalid: "executor record has an unknown schema" };
	const problems = validateExecutorDescriptor(raw.descriptor);
	if (problems.length > 0)
		return {
			invalid: `executor descriptor is invalid: ${problems.join("; ")}`,
		};
	if (typeof raw.attemptKey !== "string" || raw.attemptKey.length === 0)
		return { invalid: "executor record attemptKey is missing" };
	const policy = isPlainObject(raw.approvalPolicy) ? raw.approvalPolicy : {};
	return {
		schema: EXECUTOR_RECORD_SCHEMA,
		descriptor: raw.descriptor as ExecutorDescriptor,
		attemptKey: raw.attemptKey,
		readOnly: raw.readOnly === true,
		approvalPolicy: {
			allowKinds: Array.isArray(policy.allowKinds)
				? (policy.allowKinds as ApprovalPolicy["allowKinds"])
				: [],
			interactive: false,
			timeoutMs:
				typeof policy.timeoutMs === "number" ? policy.timeoutMs : 60_000,
		},
		executionPlanSha256:
			typeof raw.executionPlanSha256 === "string"
				? raw.executionPlanSha256
				: "",
	};
}
