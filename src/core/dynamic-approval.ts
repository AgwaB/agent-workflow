// New in agent-workflow (WP29, parity row 43): dynamic-controller approval outside the scheduler's
// own prompt. pi-workflow 0.16.4 (b83cc4f) only approved a dynamic controller (`dynamic.permissions.
// approval: "ask"`) through the Pi UI of the process that scheduled it (`ctx.ui.confirm`, see
// dynamic-controller-policy.ts); a run without that UI blocked as `dynamic_ui_unavailable` until an
// interactive Pi session resumed it. agent-workflow hosts (CLI, host MCP server, detached
// supervisors) often have no UI where the scheduler runs, so a blocked approval can be answered
// later from any host: the pending request (the `approval.pending` dynamic event the policy already
// records) is listed here, and a decision is appended as the matching `approval.resolved` event
// under the run lease. The scheduler then honors it on resume exactly like a prompt answer: an
// approval lets the controller run without asking again, a rejection blocks it as
// `dynamic_approval_rejected` for good (the pi-workflow semantics of a declined confirm). The
// decision records the deciding host id and how it was made (`decidedBy`), never a secret.
import { readDynamicEvents } from "./dynamic-events.js";
import {
	recordDynamicControllerStatus,
	recordDynamicEventAndUpdateState,
} from "./dynamic-state.js";
import {
	readRunRecord,
	withRunLeaseAfterSupervisorExit,
	writeRunRecord,
} from "./store.js";
import type { WorkflowRunRecord } from "./types.js";

/** Title of every dynamic-controller approval question (pi-workflow's confirm title). */
export const DYNAMIC_APPROVAL_TITLE = "Run dynamic workflow controller?";

/** pi-workflow's prompt bound: an unanswered approval question gives up after 5 minutes. */
export const DYNAMIC_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Blocked-task details of a controller whose approval is still open (resume re-asks). */
export const DYNAMIC_APPROVAL_PENDING_DETAILS: ReadonlySet<string> = new Set([
	"dynamic_ui_unavailable",
	"dynamic_approval_timeout",
]);

/** The message a rejection leaves on the controller task (as a rejected prompt). */
export const DYNAMIC_APPROVAL_REJECTED_MESSAGE =
	"dynamic controller approval was rejected; this run will not re-prompt on resume. Start a new workflow run if you want to approve it later.";

/** Who answered an approval: the host id (`pi`, `cli`, `claude-code`, …) and the surface. */
export interface DynamicApprovalDecidedBy {
	host: string;
	/** `prompt`: the scheduler's own question; `approve`: a later approve command/tool. */
	via: "prompt" | "approve";
}

export interface PendingDynamicApproval {
	/** Request id: the approval request digest (the `approval.pending` request hash). */
	requestId: string;
	controllerSpecId: string;
	taskId: string;
	title: string;
	/** The approval question (scope, budget, helpers; no secrets: the task text preview only). */
	message: string;
	requestedAt: string;
}

/**
 * Persisted hint naming every approve path. Run/task messages are read later by any host, so they
 * carry the CLI command plus the Pi and MCP forms.
 */
export function persistedApproveHint(runId: string): string {
	return `agent-workflow approve ${runId} (Pi: /aw approve ${runId}; MCP: workflow_approve)`;
}

function approvalOpId(controllerSpecId: string): string {
	return `${controllerSpecId}:approval:controller`;
}

/**
 * A controller task of the run is blocked on its approval (asked, or answered and not yet resumed).
 * Its supervisor stopped there, and hosts answer and resume right after the block notice.
 */
export function runBlockedOnDynamicApproval(run: WorkflowRunRecord): boolean {
	return (
		run.status === "blocked" &&
		run.tasks.some(
			(task) =>
				task.status === "blocked" &&
				DYNAMIC_APPROVAL_PENDING_DETAILS.has(String(task.statusDetail)),
		)
	);
}

/**
 * Open approvals of one run: controller tasks blocked on approval whose `approval.pending` request
 * has no `approval.resolved` answer yet. Empty for a run without dynamic approvals.
 */
export async function pendingDynamicApprovals(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<PendingDynamicApproval[]> {
	const blocked = run.tasks.filter(
		(task) =>
			task.status === "blocked" &&
			DYNAMIC_APPROVAL_PENDING_DETAILS.has(String(task.statusDetail)),
	);
	if (blocked.length === 0) return [];
	const events = await readDynamicEvents(cwd, run.runId).catch(() => []);
	const pending: PendingDynamicApproval[] = [];
	for (const task of blocked) {
		const opId = approvalOpId(task.specId);
		const own = events.filter((event) => event.opId === opId);
		const request = own
			.filter((event) => event.type === "approval.pending")
			.at(-1);
		if (!request) continue;
		if (
			own.some(
				(event) =>
					event.type === "approval.resolved" &&
					event.requestHash === request.requestHash,
			)
		)
			continue;
		pending.push({
			requestId: request.requestHash,
			controllerSpecId: task.specId,
			taskId: task.taskId,
			title: DYNAMIC_APPROVAL_TITLE,
			message:
				typeof request.payload.message === "string"
					? request.payload.message
					: `Approve dynamic controller ${task.specId} of run ${run.runId}.`,
			requestedAt: request.timestamp,
		});
	}
	return pending;
}

/** Pick the approval a caller means: by request id (or a unique prefix), else the only one. */
export function selectPendingDynamicApproval(
	pending: readonly PendingDynamicApproval[],
	runId: string,
	requestId: string | undefined,
): PendingDynamicApproval {
	if (pending.length === 0)
		throw new Error(
			`Run ${runId} has no dynamic controller approval waiting for a decision`,
		);
	if (requestId === undefined) {
		if (pending.length === 1) return pending[0]!;
		throw new Error(
			`Run ${runId} has ${pending.length} pending approvals; name one with its request id: ${pending.map((entry) => `${entry.requestId} (${entry.controllerSpecId})`).join(", ")}`,
		);
	}
	const matches = pending.filter(
		(entry) =>
			entry.requestId === requestId ||
			(requestId.length >= 8 && entry.requestId.startsWith(requestId)),
	);
	if (matches.length === 1) return matches[0]!;
	throw new Error(
		`Run ${runId} has no pending approval with request id ${requestId}; pending: ${pending.map((entry) => `${entry.requestId} (${entry.controllerSpecId})`).join(", ")}`,
	);
}

/**
 * Record a decision on one pending approval, under the run lease so it never races the run's
 * supervisor. An approval only appends `approval.resolved {approved: true}` (the scheduler runs the
 * controller on the next resume); a rejection also settles the controller task as
 * `dynamic_approval_rejected` right away, without scheduling anything.
 */
export async function recordDynamicApprovalDecision(
	cwd: string,
	runIdOrPrefix: string,
	decision: {
		requestId: string;
		approved: boolean;
		decidedBy: DynamicApprovalDecidedBy;
	},
): Promise<{ run: WorkflowRunRecord; approval: PendingDynamicApproval }> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	// The run blocked on this approval, so a held lease is its supervisor shutting down: wait for it
	// (bounded) instead of asking the user to retry.
	const outcome = await withRunLeaseAfterSupervisorExit(
		cwd,
		current.runId,
		async (signal) => {
			const run = await readRunRecord(cwd, current.runId);
			const approval = selectPendingDynamicApproval(
				await pendingDynamicApprovals(cwd, run),
				run.runId,
				decision.requestId,
			);
			const scope = (await readDynamicEvents(cwd, run.runId))
				.filter(
					(event) =>
						event.type === "approval.pending" &&
						event.requestHash === approval.requestId,
				)
				.at(-1)?.payload.approvalScope;
			await recordDynamicEventAndUpdateState(cwd, run.runId, {
				controllerSpecId: approval.controllerSpecId,
				type: "approval.resolved",
				opId: approvalOpId(approval.controllerSpecId),
				requestHash: approval.requestId,
				payload: {
					approved: decision.approved,
					...(scope === undefined ? {} : { approvalScope: scope }),
					decidedBy: {
						host: decision.decidedBy.host,
						via: decision.decidedBy.via,
					},
				},
			});
			if (!decision.approved) {
				await recordDynamicControllerStatus(cwd, run.runId, {
					controllerSpecId: approval.controllerSpecId,
					status: "policy_blocked",
					message: DYNAMIC_APPROVAL_REJECTED_MESSAGE,
				}).catch(() => undefined);
				const task = run.tasks.find(
					(candidate) => candidate.taskId === approval.taskId,
				);
				if (task) {
					// The task is already blocked (terminal); only its reason changes.
					task.statusDetail = "dynamic_approval_rejected";
					task.lastMessage = DYNAMIC_APPROVAL_REJECTED_MESSAGE;
					await writeRunRecord(cwd, run, signal);
				}
			}
			return { run, approval };
		},
		async () => {
			const run = await readRunRecord(cwd, current.runId).catch(
				() => undefined,
			);
			return run !== undefined && runBlockedOnDynamicApproval(run);
		},
	);
	if (!outcome)
		throw new Error(
			`Could not record the approval decision for ${current.runId}: another supervisor is driving the run; try again in a few seconds`,
		);
	return outcome;
}
