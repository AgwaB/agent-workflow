// New in agent-workflow (WP32, owner decision Q5, parity row 21): the host API `auto` action, the
// host-neutral port of pi-workflow 0.16.4 (b83cc4f) src/extension.ts `handleWorkflowAutoRequest`
// (`/workflow auto`). Flow and consent semantics are pi-workflow's:
//   1. a local shortlist (no model call): the trusted dynamic workflow plus the bounded catalog of
//      named workflows, ranked by the task's words against each spec's `routing` hints; WP42: the
//      classifier request packet (task, these candidates, their bounded descriptions) is built
//      here, once (core `prepareWorkflowAutoComparison`, nothing sent);
//   2. explicit consent before anything leaves the machine: the host shows what would be sent (the
//      task text, the candidate workflows, the classifier executor and model; exactly the prepared
//      packet is transmitted, a catalog change during the dialog is not) and asks through its
//      own dialog (`consent.confirm`: CLI y/n on a terminal, Pi `ctx.ui.confirm`, MCP elicitation)
//      or passes an explicit user flag (`consent: { source: "flag" }`, CLI `--yes`). No consent
//      hook = no call (print/JSON mode, no terminal, an MCP client without elicitation): the
//      result is the local shortlist and the commands to run a workflow directly;
//   3. exactly one tool-less classifier call on the run's default executor (Q5: the same rule as a
//      run's executor: run flag > saved user profile > host override > host default, so Claude
//      Code → claude, Codex → codex, Pi → pi, the terminal CLI → the first installed and logged-in
//      of pi → claude → codex);
//   4. the ranked recommendation with the classifier's reasons, then the user's final choice among
//      the launchable candidates (`choose`; no hook = the ranking is returned and nothing starts);
//   5. the chosen workflow starts through the normal launch path (duplicate guard, profiles,
//      capability confirmation, dynamic approvals) and its launch capture records the selection
//      (`agent-workflow-run-launch-v2`: candidates, recommendation, choice, classifier executor and
//      model, consent source; the task only as a SHA-256, never classifier prose or secrets).
// Cancelling any step starts nothing; there is no hidden fallback and no current-conversation
// choice. WP38b: a host may run the comparison behind a cancellable loader (`compare`; Pi in the
// TUI): cancelling it aborts the in-flight classifier request and starts nothing, and `signal`
// (Pi: the session ended) cancels every step before the launch. Changes from pi-workflow: one action for every host (CLI, Pi, MCP) instead of a TUI-only
// slash command; the consent prompt names the classifier executor/model and shows the task; the
// final choice is a single host dialog (Pi adds a separate confirmation); the selected workflow's
// launch-binding capture (workflow-auto-binding.ts) is not applied, a stale named spec (changed
// since the comparison) is refused instead.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { discoverAgents } from "../core/agents.js";
import { resolveRunExecutorForHost } from "../core/executor-default.js";
import type {
	ThinkingLevel,
	WorkflowAutoConsentSource,
	WorkflowRunAutoCandidateRef,
	WorkflowRunHostAutoSelectionMetadata,
} from "../core/types.js";
import {
	type PreparedWorkflowAutoComparison,
	prepareWorkflowAutoComparison,
	recommendWorkflowAuto,
	sendPreparedWorkflowAutoComparison,
	type WorkflowAutoCandidate,
	type WorkflowAutoResult,
} from "../core/workflow-router.js";
import type { WorkflowRuntimeDefaults } from "../core/workflow-runtime.js";
import { HostUsageError, isThinkingLevel } from "./args.js";
import {
	LAUNCH_CANCELLED,
	type LaunchData,
	type LaunchRequestBase,
	runDynamicAction,
	runWorkflowAction,
} from "./launch.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	hostEnv,
	result,
} from "./types.js";
import { readUserProfiles, userProfileFromFile } from "./user-profiles.js";

/** The executor and model the classifier call runs on (shown before consent). */
export interface AutoClassifierTarget {
	executor: string;
	/** How the executor was chosen (`run-flag`, `user-profile`, `host-default`, …). */
	source: string;
	/** Null: the executor's own default model. */
	model: string | null;
	effort: ThinkingLevel | null;
}

/** One candidate as hosts show it (no paths). */
export interface AutoCandidateView {
	candidateId: string;
	kind: "named-workflow" | "direct-dynamic";
	label: string;
	scope: string;
	description: string;
	/** Launchable from this result (start allowed and in the compared shortlist). */
	launchable: boolean;
	/** Why it cannot start (when not launchable). */
	blockers?: string[];
	/** The classifier's fit and reason (after consent). */
	fit?: "complete" | "partial" | "not-fit";
	reason?: string;
	recommended?: boolean;
	/** How to start it directly on this host (the task as a placeholder). */
	command?: string;
}

/** What the consent dialog shows: exactly what would be sent. */
export interface AutoConsentPreview {
	title: string;
	message: string;
	classifier: AutoClassifierTarget;
	candidates: Array<Pick<AutoCandidateView, "label" | "kind">>;
	taskCharacters: number;
}

/** The final-choice dialog: the ranked launchable candidates, recommended first. */
export interface AutoChoicePrompt {
	title: string;
	message: string;
	choices: AutoCandidateView[];
	/** The recommended candidate when the classifier gave a usable one. */
	recommendedId?: string;
}

export type AutoConsent =
	| { source: "flag" }
	| {
			source: Exclude<WorkflowAutoConsentSource, "flag">;
			/**
			 * true = consent; false = the user declined; undefined = no answer from the user: the
			 * client cancelled the dialog or cannot ask here (e.g. Claude Code print mode). Nothing is
			 * sent unless true.
			 */
			confirm: (
				title: string,
				message: string,
				preview: AutoConsentPreview,
			) => Promise<boolean | undefined>;
	  };

export interface AutoRequest
	extends Omit<LaunchRequestBase, "autoSelection" | "task" | "profile"> {
	/** The task to compare workflows for (and to run with the chosen one). */
	task: string;
	/**
	 * A saved user profile name: its executor/model also select the classifier's (Q5), and the
	 * launch uses it like `run --profile`.
	 */
	profile?: string;
	/** How the user consents to the one classifier call; absent = no call. */
	consent?: AutoConsent;
	/** The final choice; resolves with a candidateId or undefined (start nothing). */
	choose?: (prompt: AutoChoicePrompt) => Promise<string | undefined>;
	/**
	 * WP38b: the host's foreground wrapper of the one classifier call (Pi: a cancellable loader).
	 * It runs `operation`, whose signal aborts the in-flight request (the executor's cancel), and
	 * resolves undefined when the user cancelled: nothing starts.
	 */
	compare?: (
		operation: (signal: AbortSignal | undefined) => Promise<WorkflowAutoResult>,
	) => Promise<WorkflowAutoResult | undefined>;
	/**
	 * Cancels the whole action (Pi: the session ended); checked at every step before the launch and
	 * (WP42) carried into the launch itself (profile chooser, capability confirm, engine fence).
	 */
	signal?: AbortSignal;
}

export type AutoPhase =
	/** No consent hook (no dialog, no terminal, no elicitation, no flag): nothing was sent. */
	| "consent-unavailable"
	/** The user declined the consent dialog: nothing was sent. */
	| "consent-declined"
	/**
	 * WP39b: the consent dialog got no answer from the user (the client cancelled it or cannot ask
	 * here, e.g. Claude Code print mode auto-cancels elicitations): nothing was sent.
	 */
	| "consent-cancelled"
	/** The classifier executor could not be resolved: nothing was sent. */
	| "classifier-unavailable"
	/** Ranked after consent; no choice hook, so nothing started. */
	| "ranked"
	/** The user cancelled the final choice: nothing started. */
	| "cancelled"
	/** The chosen workflow changed since the comparison: nothing started. */
	| "stale"
	/** The chosen workflow went through the launch path (see `launch`). */
	| "launched";

export interface AutoData {
	phase: AutoPhase;
	/** Exactly one classifier request was sent. */
	classifierCalled: boolean;
	classifier?: AutoClassifierTarget;
	consent?: WorkflowAutoConsentSource;
	/** The local, routing-only shortlist (always; no model call). */
	shortlist: AutoCandidateView[];
	/** After consent: the classifier status (`recommendation`, `no-fit`, `routing-unavailable`, …). */
	status?: WorkflowAutoResult["status"];
	reason?: string;
	recommendation?: {
		candidateId: string;
		label: string;
		confidence: "high" | "medium" | "low";
		reason: string;
	};
	/** After consent: the launchable candidates, recommended first. */
	ranked?: AutoCandidateView[];
	selected?: AutoCandidateView;
	launch?: LaunchData;
	/** How to run a workflow directly / to consent explicitly on this host. */
	next?: string[];
}

const DISPLAY_TASK_MAX = 2_000;
const REASON_MAX = 480;

function displayText(value: string, max: number): string {
	const points = Array.from(
		value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�"),
	);
	return points.length <= max
		? points.join("")
		: `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function oneLine(value: string, max: number): string {
	return displayText(value.replace(/\s+/g, " ").trim(), max);
}

function hostKind(ctx: HostApiContext): "cli" | "pi" | "mcp" {
	if (ctx.host === "pi") return "pi";
	if (
		ctx.host === "claude-code" ||
		ctx.host === "codex" ||
		ctx.host === "generic"
	)
		return "mcp";
	return "cli";
}

function isSafeRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!value.startsWith(".") &&
		/^[A-Za-z0-9_.-]+$/.test(value)
	);
}

/** The host's command to start one candidate directly (task as a placeholder, never echoed). */
function directCommand(
	ctx: HostApiContext,
	candidate: WorkflowAutoCandidate,
): string | undefined {
	const kind = hostKind(ctx);
	if (candidate.kind === "direct-dynamic") {
		if (kind === "mcp") return 'workflow_dynamic {"task":"<task>"}';
		return `${kind === "pi" ? "/aw" : "agent-workflow"} dynamic "<task>"`;
	}
	if (candidate.kind !== "named-workflow" || !isSafeRef(candidate.launchRef))
		return undefined;
	if (kind === "mcp")
		return `workflow_run {"workflow":"${candidate.launchRef}","task":"<task>"}`;
	return `${kind === "pi" ? "/aw" : "agent-workflow"} run ${candidate.launchRef} "<task>"`;
}

function candidateView(
	ctx: HostApiContext,
	candidate: WorkflowAutoCandidate,
	launchable: boolean,
): AutoCandidateView {
	const command = directCommand(ctx, candidate);
	const blockers = candidate.readiness.blockers.map((line) =>
		oneLine(line, 240),
	);
	return {
		candidateId: candidate.candidateId,
		kind: candidate.kind as AutoCandidateView["kind"],
		label: oneLine(candidate.label, 120),
		scope: candidate.scope,
		description: oneLine(
			candidate.kind === "direct-dynamic"
				? "Plans the steps as the task progresses."
				: candidate.description || "Runs this workflow.",
			240,
		),
		launchable,
		...(!launchable && blockers.length ? { blockers } : {}),
		...(command ? { command } : {}),
	};
}

/**
 * Q5: the classifier runs on the run's default executor: run flag > saved user profile (named, else
 * the default one) > host override > host default (probed on the terminal CLI). Model/effort: the
 * run flags, else the profile's, else the host's current model when it belongs to that executor
 * (Pi), else the executor's default.
 */
export async function resolveAutoClassifier(
	ctx: HostApiContext,
	request: Pick<AutoRequest, "executor" | "profile" | "model" | "effort">,
): Promise<AutoClassifierTarget> {
	let profile:
		| {
				name: string;
				executor?: string;
				model?: string;
				effort?: ThinkingLevel;
		  }
		| undefined;
	try {
		const file = await readUserProfiles(hostEnv(ctx));
		const name = request.profile ?? file.default;
		const saved = name ? userProfileFromFile(file, name) : undefined;
		if (saved)
			profile = {
				name: saved.name,
				...((saved.executor ?? saved.roles?.default?.executor)
					? { executor: saved.executor ?? saved.roles?.default?.executor }
					: {}),
				...((saved.model ?? saved.roles?.default?.model)
					? { model: saved.model ?? saved.roles?.default?.model }
					: {}),
				...((saved.effort ?? saved.roles?.default?.effort)
					? { effort: saved.effort ?? saved.roles?.default?.effort }
					: {}),
			};
	} catch {
		// An unreadable profile store blocks no comparison (launch reports it if it matters).
	}
	const selection = await resolveRunExecutorForHost({
		...(request.executor ? { runFlag: request.executor } : {}),
		...(profile?.executor
			? { userProfileName: profile.name, userProfileExecutor: profile.executor }
			: {}),
		...(ctx.defaultExecutor ? { defaultExecutor: ctx.defaultExecutor } : {}),
		...(ctx.host ? { host: ctx.host } : {}),
	});
	const fromProfile = profile?.executor === selection.id ? profile : undefined;
	const hostDefaults: WorkflowRuntimeDefaults | undefined =
		ctx.runtimeDefaults &&
		(ctx.runtimeDefaults.executor === undefined ||
			ctx.runtimeDefaults.executor === selection.id)
			? ctx.runtimeDefaults
			: undefined;
	const model =
		request.model ?? fromProfile?.model ?? hostDefaults?.model ?? null;
	const effort =
		request.effort ?? fromProfile?.effort ?? hostDefaults?.thinking ?? null;
	return {
		executor: selection.id,
		source: selection.source,
		model,
		effort: effort && isThinkingLevel(effort) ? effort : null,
	};
}

function describeClassifier(target: AutoClassifierTarget): string {
	return `${target.executor} (${target.source}), model ${target.model ?? "executor default"}${target.effort ? `, effort ${target.effort}` : ""}`;
}

function consentPreview(
	task: string,
	target: AutoClassifierTarget,
	shortlist: readonly AutoCandidateView[],
): AutoConsentPreview {
	const characters = Array.from(task).length;
	const shown = displayText(task, DISPLAY_TASK_MAX);
	const message = [
		"To recommend a workflow, agent-workflow sends one request to a classifier model. Nothing is sent and nothing starts unless you agree.",
		`Classifier: ${describeClassifier(target)}`,
		`Sent: your task (${characters} characters) and the bounded descriptions of ${shortlist.length} candidate workflow${shortlist.length === 1 ? "" : "s"}: ${shortlist.map((candidate) => candidate.label).join(", ")}.`,
		"Task:",
		...shown.split("\n").map((line) => `  ${line}`),
		...(characters > DISPLAY_TASK_MAX
			? [`  (showing ${DISPLAY_TASK_MAX} of ${characters} characters)`]
			: []),
		"After the comparison you choose the workflow (or nothing) before anything starts.",
	].join("\n");
	return {
		title: `Send this task to ${target.executor} to compare workflows?`,
		message,
		classifier: target,
		candidates: shortlist.map(({ label, kind }) => ({ label, kind })),
		taskCharacters: characters,
	};
}

function shortlistLines(shortlist: readonly AutoCandidateView[]): string[] {
	return shortlist.map(
		(candidate, index) =>
			`  ${index + 1}. ${candidate.label} [${candidate.kind}, ${candidate.scope}]${candidate.launchable ? "" : ` (not launchable${candidate.blockers?.length ? `: ${candidate.blockers.join(" ")}` : ""})`}${candidate.command ? `\n     ${candidate.command}` : ""}`,
	);
}

function consentNext(
	ctx: HostApiContext,
	phase: "consent-unavailable" | "consent-declined" | "consent-cancelled",
): string[] {
	const kind = hostKind(ctx);
	if (phase === "consent-cancelled" && kind !== "cli" && kind !== "pi")
		return [
			'The client cancelled the confirmation dialog without an answer from the user (or cannot ask in this mode, e.g. Claude Code print mode), so no comparison was sent. Start a workflow directly with the tool calls above, or run `agent-workflow auto "<task>"` in a terminal.',
		];
	if (kind === "cli")
		return [
			'Ask again on a terminal (agent-workflow auto "<task>"), or consent explicitly with --yes (agent-workflow auto "<task>" --yes) to send the one comparison request.',
		];
	if (kind === "pi")
		return [
			'Run /aw auto "<task>" in an interactive Pi session to be asked, or start a workflow directly with the commands above.',
		];
	return [
		'This MCP client cannot show confirmation dialogs (elicitation), so no comparison was sent. Start a workflow directly with the tool calls above, or run `agent-workflow auto "<task>"` in a terminal.',
	];
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function availableAgentNames(cwd: string): Promise<string[] | undefined> {
	try {
		return [...(await discoverAgents(cwd)).byAlias.keys()];
	} catch {
		// A malformed unrelated agent must not fail recommendation-only auto (pi-workflow).
		return undefined;
	}
}

/** Ranked launchable candidates: recommended first, then complete/partial fit, then shortlist order. */
function rankCandidates(
	ctx: HostApiContext,
	auto: WorkflowAutoResult,
): {
	ranked: AutoCandidateView[];
	recommendation: AutoData["recommendation"];
} {
	const comparison = auto.comparison;
	const assessments = new Map(
		(comparison?.assessments ?? []).map((item) => [item.candidateId, item]),
	);
	const localScope =
		auto.localChoiceScope ??
		(auto.transmission === "allowed" ? "all-safe" : "none");
	const launchable = auto.shortlist.filter(
		(candidate) =>
			localScope === "all-safe" &&
			candidate.readiness.startAllowed &&
			(candidate.kind === "named-workflow" ||
				candidate.kind === "direct-dynamic"),
	);
	const rec =
		auto.status === "recommendation" ? comparison?.recommendation : undefined;
	const recommended = rec
		? launchable.find((candidate) => candidate.candidateId === rec.candidateId)
		: undefined;
	const fitOrder = { complete: 0, partial: 1, "not-fit": 2 } as const;
	const order = (candidate: WorkflowAutoCandidate): number => {
		if (candidate === recommended) return -1;
		const fit = assessments.get(candidate.candidateId)?.fit;
		return fit ? fitOrder[fit] : 3;
	};
	const ranked = launchable
		.map((candidate, index) => ({ candidate, index }))
		.sort(
			(left, right) =>
				order(left.candidate) - order(right.candidate) ||
				left.index - right.index,
		)
		.map(({ candidate }) => {
			const view = candidateView(ctx, candidate, true);
			const assessment = assessments.get(candidate.candidateId);
			if (assessment) {
				view.fit = assessment.fit;
				view.reason = oneLine(assessment.reason, REASON_MAX);
			}
			if (candidate === recommended) view.recommended = true;
			return view;
		});
	return {
		ranked,
		recommendation:
			rec && recommended
				? {
						candidateId: recommended.candidateId,
						label: oneLine(recommended.label, 120),
						confidence: rec.confidence,
						reason: oneLine(rec.reason, REASON_MAX),
					}
				: undefined,
	};
}

function rankedLines(data: AutoData): string[] {
	const lines: string[] = [];
	if (data.recommendation)
		lines.push(
			`Recommended: ${data.recommendation.label} (confidence ${data.recommendation.confidence})`,
			`Reason: ${data.recommendation.reason}`,
		);
	else
		lines.push(
			`No recommendation (${data.status ?? "unavailable"}${data.reason ? `: ${oneLine(data.reason, REASON_MAX)}` : ""}). Choose a workflow yourself, or nothing.`,
		);
	if (data.ranked?.length) {
		lines.push("Candidates:");
		data.ranked.forEach((candidate, index) => {
			lines.push(
				`  ${index + 1}. ${candidate.label}${candidate.recommended ? " · recommended" : ""} [${candidate.kind}, ${candidate.scope}]${candidate.fit ? ` fit ${candidate.fit}` : ""}`,
			);
			if (candidate.reason) lines.push(`     ${candidate.reason}`);
			if (candidate.command) lines.push(`     ${candidate.command}`);
		});
	} else lines.push("No workflow can be started for this request.");
	return lines;
}

/**
 * `auto "<task>"`: compare workflows for a task (one classifier call, only after consent) and start
 * the one the user chooses. See the module header.
 */
export async function autoAction(
	ctx: HostApiContext,
	request: AutoRequest,
): Promise<HostResult<AutoData>> {
	assertActionAllowed(ctx, "auto");
	const task = typeof request.task === "string" ? request.task.trim() : "";
	if (!task)
		throw new HostUsageError('auto needs a task: agent-workflow auto "<task>"');
	if (request.effort !== undefined && !isThinkingLevel(request.effort))
		throw new HostUsageError("auto effort is not a known effort level");
	const agents = await availableAgentNames(ctx.cwd);
	const header = "Workflow auto selection";
	// 1. The classifier executor/model (Q5) for the preview.
	let target: AutoClassifierTarget;
	try {
		target = await resolveAutoClassifier(ctx, request);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Local routing-only shortlist: no transmission authorization, so no classifier call.
		const local = await recommendWorkflowAuto({
			cwd: ctx.cwd,
			task,
			transmissionPolicy: "needs-clarification",
			...(agents ? { availableAgentNames: agents } : {}),
		});
		const shortlist = local.shortlist.map((candidate) =>
			candidateView(ctx, candidate, candidate.readiness.startAllowed),
		);
		return result(
			"auto",
			"refused",
			{
				phase: "classifier-unavailable",
				classifierCalled: false,
				shortlist,
				reason: message,
			},
			[
				header,
				`No comparison was sent: the classifier executor is not available (${message}).`,
				"Local shortlist (by the workflows' routing hints, no model call):",
				...shortlistLines(shortlist),
			].join("\n"),
		);
	}
	const runtimeOverrides: WorkflowRuntimeDefaults | undefined =
		target.model || target.effort
			? {
					...(target.model ? { model: target.model } : {}),
					...(target.effort ? { thinking: target.effort } : {}),
				}
			: undefined;
	// 2. WP42 (review round 1, finding 2): the classifier request is built once, locally, before
	// consent (catalog scan, bounded descriptions, the packet). The preview shows its candidates
	// and the task; after consent exactly this frozen packet is sent (no rescan: a workflow added
	// or a description changed while the dialog is open is not transmitted).
	const prepared: PreparedWorkflowAutoComparison =
		await prepareWorkflowAutoComparison({
			cwd: ctx.cwd,
			task,
			executor: target.executor,
			...(runtimeOverrides ? { runtimeOverrides } : {}),
			...(ctx.availableModels ? { availableModels: ctx.availableModels } : {}),
			...(agents ? { availableAgentNames: agents } : {}),
			...(request.signal ? { signal: request.signal } : {}),
		});
	const shortlist = prepared.shortlist.map((candidate) =>
		candidateView(ctx, candidate, candidate.readiness.startAllowed),
	);
	const preview = consentPreview(task, target, shortlist);
	// 3. Consent (to exactly the prepared packet).
	const noCall = (
		phase: "consent-unavailable" | "consent-declined" | "consent-cancelled",
	): HostResult<AutoData> => {
		const next = consentNext(ctx, phase);
		return result(
			"auto",
			"refused",
			{
				phase,
				classifierCalled: false,
				classifier: target,
				shortlist,
				next,
			},
			[
				header,
				phase === "consent-declined"
					? "Not sent: you did not agree to the comparison request. No task was sent and no workflow has been started."
					: phase === "consent-cancelled"
						? "Not sent: the consent dialog was cancelled without an answer (the client cancelled it or cannot ask here), so no task was sent to a classifier and no workflow has been started."
						: "Not sent: agent-workflow could not ask for your consent here, so no task was sent to a classifier and no workflow has been started.",
				`The comparison would run on ${describeClassifier(target)}.`,
				"Local shortlist (ranked by the workflows' routing hints, no model call):",
				...shortlistLines(shortlist),
				...next,
			].join("\n"),
		);
	};
	if (!request.consent) return noCall("consent-unavailable");
	if (request.consent.source !== "flag") {
		let agreed: boolean | undefined;
		try {
			agreed = await request.consent.confirm(
				preview.title,
				preview.message,
				preview,
			);
		} catch {
			agreed = undefined;
		}
		if (agreed !== true || request.signal?.aborted)
			return noCall(
				agreed === false && !request.signal?.aborted
					? "consent-declined"
					: "consent-cancelled",
			);
	}
	const consent: WorkflowAutoConsentSource = request.consent.source;
	// 4. Exactly one classifier call on the resolved executor (behind the host's loader, if any).
	let pending: Promise<WorkflowAutoResult> | undefined;
	const compareOnce = (
		signal: AbortSignal | undefined,
	): Promise<WorkflowAutoResult> => {
		const signals = [request.signal, signal].filter(
			(item): item is AbortSignal => item !== undefined,
		);
		const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		pending = sendPreparedWorkflowAutoComparison(prepared, {
			cwd: ctx.cwd,
			task,
			transmissionPolicy: "allowed",
			executor: target.executor,
			...(runtimeOverrides ? { runtimeOverrides } : {}),
			...(ctx.availableModels ? { availableModels: ctx.availableModels } : {}),
			...(agents ? { availableAgentNames: agents } : {}),
			...(combined ? { signal: combined } : {}),
		});
		return pending;
	};
	let comparedOrCancelled: WorkflowAutoResult | undefined;
	try {
		comparedOrCancelled = request.compare
			? await request.compare(compareOnce)
			: await compareOnce(undefined);
	} catch (error) {
		if (!request.signal?.aborted) throw error;
	}
	if (!comparedOrCancelled || request.signal?.aborted) {
		// Cancelled during the comparison: the aborted request settles quickly when the executor
		// supports cancel; it was sent unless it stopped before dispatch.
		const settled = pending
			? await Promise.race([
					pending.catch(() => undefined),
					new Promise<"pending">((resolve) =>
						setTimeout(() => resolve("pending"), 2_000).unref(),
					),
				])
			: undefined;
		const sent =
			pending !== undefined &&
			(settled === "pending" ||
				settled === undefined ||
				!/^input-too-large|cancelled before provider dispatch|External model transmission/.test(
					settled.reason ?? "",
				));
		return result(
			"auto",
			"refused",
			{
				phase: "cancelled",
				classifierCalled: sent,
				classifier: target,
				consent,
				shortlist,
			},
			[
				header,
				sent
					? "Comparison cancelled; its request was aborted and any answer is discarded. No workflow has been started."
					: "Comparison cancelled before anything was sent. No workflow has been started.",
			].join("\n"),
		);
	}
	const compared = comparedOrCancelled;
	// The core sends nothing when the task's own wording forbids transmission or it is too large.
	const classifierCalled =
		compared.transmission === "allowed" &&
		!/^input-too-large|cancelled before provider dispatch/.test(
			compared.reason ?? "",
		);
	const { ranked, recommendation } = rankCandidates(ctx, compared);
	const data: AutoData = {
		phase: "ranked",
		classifierCalled,
		classifier: target,
		consent,
		shortlist,
		status: compared.status,
		...(compared.reason
			? { reason: oneLine(compared.reason, REASON_MAX) }
			: {}),
		...(recommendation ? { recommendation } : {}),
		ranked,
	};
	const rankedText = [
		header,
		`Compared on ${describeClassifier(target)} (consent: ${consent}).`,
		...rankedLines(data),
	];
	// 5. The final choice.
	if (!request.choose || ranked.length === 0)
		return result(
			"auto",
			"success",
			{
				...data,
				next: ranked.flatMap((candidate) =>
					candidate.command ? [candidate.command] : [],
				),
			},
			[...rankedText, "No workflow has been started."].join("\n"),
		);
	let chosenId: string | undefined;
	try {
		chosenId = await request.choose({
			title: "Choose the workflow to start",
			message: rankedText.slice(1).join("\n"),
			choices: ranked,
			...(recommendation ? { recommendedId: recommendation.candidateId } : {}),
		});
	} catch {
		chosenId = undefined;
	}
	const chosen = ranked.find((candidate) => candidate.candidateId === chosenId);
	const source = compared.shortlist.find(
		(candidate) => candidate.candidateId === chosenId,
	);
	if (!chosen || !source || request.signal?.aborted)
		return result(
			"auto",
			"refused",
			{ ...data, phase: "cancelled" },
			[
				...rankedText,
				"Auto selection cancelled. No workflow has been started.",
			].join("\n"),
		);
	// A named workflow must be the exact spec that was compared (pi-workflow's stale check).
	if (source.kind === "named-workflow") {
		let current: string | undefined;
		try {
			current = source.specPath
				? createHash("sha256")
						.update(await readFile(source.specPath))
						.digest("hex")
				: undefined;
		} catch {
			current = undefined;
		}
		if (!source.specPath || !source.specSha256 || current !== source.specSha256)
			return result(
				"auto",
				"refused",
				{ ...data, phase: "stale", selected: chosen },
				`Auto selection is stale: ${chosen.label} changed since the comparison. No workflow has been started; run auto again.`,
			);
	}
	// 6. The normal launch path, with the selection in the launch capture.
	const offered: WorkflowRunAutoCandidateRef[] = ranked.map((candidate) => ({
		candidateId: candidate.candidateId,
		kind: candidate.kind,
		label: candidate.label,
	}));
	const selection: WorkflowRunHostAutoSelectionMetadata = {
		candidates: offered,
		recommendation: recommendation
			? {
					candidateId: recommendation.candidateId,
					confidence: recommendation.confidence,
				}
			: null,
		selected: {
			candidateId: chosen.candidateId,
			kind: chosen.kind,
			label: chosen.label,
		},
		choseRecommendation: recommendation?.candidateId === chosen.candidateId,
		classifier: { executor: target.executor, model: target.model },
		consent,
		taskSha256: sha256(task),
		confirmed: true,
	};
	const {
		consent: _consent,
		choose: _choose,
		compare: _compare,
		...launchOptions
	} = request;
	// WP42 (review round 1, finding 1): the session signal stays on the launch request: the launch
	// path re-checks it after its own dialogs (profile chooser, capability confirm) and the engine
	// fences publication and the first dispatch with it.
	const launchRequest: LaunchRequestBase = {
		...launchOptions,
		task,
		autoSelection: selection,
	};
	const launched =
		source.kind === "named-workflow"
			? await runWorkflowAction(ctx, {
					...launchRequest,
					workflow: source.specPath!,
				})
			: await runDynamicAction(ctx, launchRequest);
	if (launched.data.refusal?.code === LAUNCH_CANCELLED && !launched.data.runId)
		return result(
			"auto",
			"refused",
			{ ...data, phase: "cancelled", selected: chosen, launch: launched.data },
			[
				...rankedText,
				`Selected: ${chosen.label}`,
				"Auto selection cancelled: the session ended before the launch was published. No workflow has been started.",
			].join("\n"),
		);
	return {
		...launched,
		action: "auto",
		data: {
			...data,
			phase: "launched",
			selected: chosen,
			launch: launched.data,
		},
		text: [
			header,
			`Compared on ${describeClassifier(target)} (consent: ${consent}).`,
			`Selected: ${chosen.label}${chosen.recommended ? " (recommended)" : ""}`,
			launched.text,
		].join("\n"),
	};
}
