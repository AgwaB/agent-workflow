// Answer blocked dynamic-controller approvals from any host and record the decision durably.
// Yes runs the controller; no permanently rejects it for this run; cancel, error, or timeout
// changes nothing. Approval resumes the run without relaunching completed tasks, unless
// other failed, interrupted, or decision-blocked tasks require an explicit resume.
import {
	DYNAMIC_APPROVAL_PENDING_DETAILS,
	DYNAMIC_APPROVAL_TIMEOUT_MS,
	DYNAMIC_APPROVAL_TITLE,
	type PendingDynamicApproval,
	pendingDynamicApprovals,
	recordDynamicApprovalDecision,
	selectPendingDynamicApproval,
} from "../core/dynamic-approval.js";
import { readRunRecord } from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";
import { HostUsageError } from "./args.js";
import { hostCommandHints } from "./hints.js";
import { type ResumeData, resumeAction } from "./runs.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	result,
} from "./types.js";

/** Title of the confirmation of a rejection (an approval asks DYNAMIC_APPROVAL_TITLE). */
export const DYNAMIC_REJECT_TITLE = "Reject dynamic workflow controller?";

export interface ApproveRequest {
	runId: string;
	/** Request id (or a unique prefix of at least 8 characters); optional with one open approval. */
	requestId?: string;
	decision: "approve" | "reject";
	/**
	 * Ask the user before anything is recorded (Pi dialog, CLI y/n, MCP elicitation). `true`: as
	 * decided; `false`: an approval question answered no is a rejection, a rejection question
	 * answered no changes nothing; `undefined` (cancelled, failed): nothing changes. Without it the
	 * caller's explicit decision is final (CLI `--yes`).
	 */
	confirm?: (title: string, message: string) => Promise<boolean | undefined>;
	/** Resume after an approval in a background supervisor (MCP default). */
	detach?: boolean;
}

export interface ApproveData {
	runId: string;
	requestId: string;
	controllerSpecId: string;
	/** `unanswered`: the confirmation was not answered; nothing was recorded. */
	decision: "approved" | "rejected" | "unanswered";
	status: WorkflowRunRecord["status"];
	/** Who the decision is recorded for (`via: "approve"`). */
	decidedBy?: { host: string; via: "approve" };
	/** The resume after an approval. */
	resumed?: ResumeData;
	/** Tasks that keep the run from resuming automatically after an approval. */
	otherBlockers?: string[];
}

function requireRunRef(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.startsWith("-"))
		throw new HostUsageError("approve needs a run id (or unambiguous prefix)");
	return value.trim();
}

/** The confirmation, bounded like the scheduler's prompt; a timeout or error is no answer. */
async function boundedConfirm(
	confirm: NonNullable<ApproveRequest["confirm"]>,
	title: string,
	message: string,
): Promise<boolean | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), DYNAMIC_APPROVAL_TIMEOUT_MS);
		timer.unref?.();
	});
	try {
		return await Promise.race([
			Promise.resolve(confirm(title, message)).catch(() => undefined),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Tasks whose resume is a separate owner decision (resume would relaunch them). */
function otherBlockers(run: WorkflowRunRecord): string[] {
	return run.tasks
		.filter(
			(task) =>
				task.status === "failed" ||
				task.status === "interrupted" ||
				(task.status === "blocked" &&
					task.statusDetail !== "dynamic_approval_rejected" &&
					!DYNAMIC_APPROVAL_PENDING_DETAILS.has(String(task.statusDetail))),
		)
		.map((task) => `${task.specId} (${task.status}: ${task.statusDetail})`);
}

/** `approve <run> [--request <id>] [--reject]`: answer an open dynamic-controller approval. */
export async function approveAction(
	ctx: HostApiContext,
	request: ApproveRequest,
): Promise<HostResult<ApproveData>> {
	assertActionAllowed(ctx, "approve");
	if (request.decision !== "approve" && request.decision !== "reject")
		throw new HostUsageError('approve decision must be "approve" or "reject"');
	const run = await readRunRecord(ctx.cwd, requireRunRef(request.runId));
	let approval: PendingDynamicApproval;
	try {
		approval = selectPendingDynamicApproval(
			await pendingDynamicApprovals(ctx.cwd, run),
			run.runId,
			request.requestId,
		);
	} catch (error) {
		throw new HostUsageError(
			error instanceof Error ? error.message : String(error),
		);
	}
	const base = {
		runId: run.runId,
		requestId: approval.requestId,
		controllerSpecId: approval.controllerSpecId,
	};
	let approved = request.decision === "approve";
	if (request.confirm) {
		const answer = await boundedConfirm(
			request.confirm,
			approved ? DYNAMIC_APPROVAL_TITLE : DYNAMIC_REJECT_TITLE,
			approval.message,
		);
		if (answer === undefined || (!approved && answer === false))
			return result(
				"approve",
				"refused",
				{ ...base, decision: "unanswered", status: run.status },
				`Nothing recorded: the ${approved ? "approval" : "rejection"} of dynamic controller ${approval.controllerSpecId} (run ${run.runId}) was not confirmed. The run stays blocked waiting for approval.`,
			);
		if (answer === false) approved = false;
	}
	const decidedBy = { host: ctx.host ?? "cli", via: "approve" as const };
	const recorded = await recordDynamicApprovalDecision(ctx.cwd, run.runId, {
		requestId: approval.requestId,
		approved,
		decidedBy,
	});
	const hints = hostCommandHints(ctx.host);
	if (!approved)
		return result(
			"approve",
			"success",
			{
				...base,
				decision: "rejected",
				status: recorded.run.status,
				decidedBy,
			},
			`Rejected dynamic controller ${approval.controllerSpecId} of run ${run.runId} (recorded for host ${decidedBy.host}). The run stays blocked (dynamic_approval_rejected) and will not ask again; start a new run to approve it later.`,
		);
	const others = otherBlockers(recorded.run);
	if (others.length > 0)
		return result(
			"approve",
			"blocked",
			{
				...base,
				decision: "approved",
				status: recorded.run.status,
				decidedBy,
				otherBlockers: others,
			},
			`Approved dynamic controller ${approval.controllerSpecId} of run ${run.runId} (recorded for host ${decidedBy.host}). Not resumed: the run also has tasks whose resume is a separate decision (${others.join(", ")}). Resume it with ${hints.resume(run.runId)} when you want them relaunched too.`,
		);
	const resumed = await resumeAction(ctx, {
		runId: run.runId,
		...(request.detach ? { detach: true } : {}),
	});
	return {
		...resumed,
		action: "approve",
		data: {
			...base,
			decision: "approved",
			status: resumed.data.status,
			decidedBy,
			resumed: resumed.data,
		},
		text: `Approved dynamic controller ${approval.controllerSpecId} of run ${run.runId} (recorded for host ${decidedBy.host}); the run continues.\n${resumed.text}`,
	};
}
