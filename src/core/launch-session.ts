import { createHash } from "node:crypto";

import type { WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";

const MAX_WORKER_SESSION_ID_LENGTH = 64;

/**
 * Derives the task session from the authoritative retry/resume fields shared
 * by launch and launch-bootstrap provenance. It does not allocate a session.
 */
export function workflowTaskSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string | undefined {
	if (!task.artifactGraph?.enabled) return undefined;
	if (task.outputRetry?.sessionId) return task.outputRetry.sessionId;
	// Review 2026-11-09 (claude-fable-5-1): a rebuilt child's launch-retry/resume ids carry its
	// generation too, or gen-1's "launch-retry-1" reuses gen-0's session. Generation 0 is unchanged.
	const baseSessionId = generationBaseSessionId(
		run.runId,
		task.taskId,
		rematerializedGeneration(task),
	);
	const launchAttempt = task.launchRetry?.attempts ?? 0;
	if (launchAttempt > 0)
		return boundedWorkflowSessionId(
			`${baseSessionId}.launch-retry-${launchAttempt}`,
		);
	const resumeAttempt = task.resumeEvents?.length ?? 0;
	if (resumeAttempt > 0)
		return boundedWorkflowSessionId(`${baseSessionId}.resume-${resumeAttempt}`);
	return baseSessionId;
}

/**
 * 2026-11-08: a foreach child rebuilt by a resume invalidation is a new task record that may reuse its
 * task id (ids are stable per item) with fresh retry/resume counters, so without its source
 * generation it would repeat the previous generation's attempt identity and session id — the
 * executor then returned the old attempt (Codex: fence violation, every rebuilt child failed).
 * Generation 0 (and tasks without one) keep their identities unchanged.
 */
export function rematerializedGeneration(task: WorkflowTaskRunRecord): number {
	const generation =
		task.foreachGenerated !== undefined ? task.sourceGeneration : undefined;
	return typeof generation === "number" && Number.isSafeInteger(generation)
		? Math.max(0, generation)
		: 0;
}

export function workflowTaskAttemptIdentity(
	task: WorkflowTaskRunRecord,
	sessionId: string | undefined,
): string {
	return [
		`launch-retry:${task.launchRetry?.attempts ?? 0}`,
		`output-retry:${task.outputRetry?.attempts ?? 0}`,
		`resume:${task.resumeEvents?.length ?? 0}`,
		...(task.foreachBatch?.physicalAttempt === undefined
			? []
			: [`physical:${task.foreachBatch.physicalAttempt}`]),
		...(rematerializedGeneration(task) > 0
			? [`generation:${rematerializedGeneration(task)}`]
			: []),
		`session:${sessionId ?? "none"}`,
	].join(";");
}

export function retryWorkflowTaskSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	attempt: number,
): string {
	return boundedWorkflowSessionId(
		`${generationBaseSessionId(run.runId, task.taskId, rematerializedGeneration(task))}.retry-${attempt}`,
	);
}

export function isWorkflowTaskSessionIdentity(input: {
	runId: string;
	taskId: string;
	launchRetry: number;
	outputRetry: number;
	resume: number;
	sourceGeneration?: number;
	sessionId: string;
}): boolean {
	const generation = Math.max(0, input.sourceGeneration ?? 0);
	const base = generationBaseSessionId(input.runId, input.taskId, generation);
	if (input.outputRetry > 0) {
		return new Set([
			base,
			boundedWorkflowSessionId(`${base}.launch-retry-${input.launchRetry}`),
			boundedWorkflowSessionId(`${base}.resume-${input.resume}`),
			boundedWorkflowSessionId(`${base}.retry-${input.outputRetry}`),
		]).has(input.sessionId);
	}
	if (input.launchRetry > 0)
		return (
			input.sessionId ===
			boundedWorkflowSessionId(`${base}.launch-retry-${input.launchRetry}`)
		);
	if (input.resume > 0)
		return (
			input.sessionId ===
			boundedWorkflowSessionId(`${base}.resume-${input.resume}`)
		);
	return input.sessionId === base;
}

function workflowTaskBaseSessionId(runId: string, taskId: string): string {
	return boundedWorkflowSessionId(`agent-workflow.${runId}.${taskId}`);
}

function generationBaseSessionId(
	runId: string,
	taskId: string,
	generation: number,
): string {
	const base = workflowTaskBaseSessionId(runId, taskId);
	return generation > 0
		? boundedWorkflowSessionId(`${base}.gen-${generation}`)
		: base;
}

function boundedWorkflowSessionId(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-");
	if (sanitized.length <= MAX_WORKER_SESSION_ID_LENGTH) return sanitized;
	const digest = createHash("sha256")
		.update(sanitized)
		.digest("hex")
		.slice(0, 16);
	const suffix = sanitized.split(".").at(-1) || "session";
	const prefix = `awf.${digest}`;
	const maxSuffixLength = MAX_WORKER_SESSION_ID_LENGTH - prefix.length - 1;
	const boundedSuffix = suffix.slice(-Math.max(1, maxSuffixLength));
	return `${prefix}.${boundedSuffix}`;
}
