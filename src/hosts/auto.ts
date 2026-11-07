// Classify one immutable comparison packet, then launch the top recommendation through normal
// guards. Classifier failure, transmission restrictions and cancellation start nothing.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { discoverAgents } from "../core/agents.js";
import { probeWorkflowExecutor } from "../core/capability-negotiation.js";
import {
	cachedExecutorProber,
	resolveRunExecutorForHost,
} from "../core/executor-default.js";
import {
	executorDefaultRuntime,
	executorPolicy,
	overlayExecutorProfile,
	resolveExecutorDefaultProfile,
} from "../core/executor-policy.js";
import type {
	EffortLevel,
	WorkflowAutoConsentSource,
	WorkflowRoleMap,
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
import { HostUsageError, isEffortLevel } from "./args.js";
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
import {
	readUserProfiles,
	type UserProfile,
	type UserProfilesFile,
	userProfileFromFile,
} from "./user-profiles.js";

/** The executor and model the classifier call runs on . */
export interface AutoClassifierTarget {
	executor: string;
	/** How the executor was chosen (`run-flag`, `user-profile`, `host-default`, …). */
	source: string;
	/** Null: the executor's own default model. */
	model: string | null;
	effort: EffortLevel | null;
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
	/** The classifier's fit and reason (after comparison). */
	fit?: "complete" | "partial" | "not-fit";
	reason?: string;
	recommended?: boolean;
	/** How to start it directly on this host (the task as a placeholder). */
	command?: string;
}

export interface AutoRequest
	extends Omit<LaunchRequestBase, "autoSelection" | "task" | "profile"> {
	/** The task to compare workflows for (and to run with the chosen one). */
	task: string;
	/**
	 * A saved user profile name: its executor/model also select the classifier's (Q5), and the
	 * launch uses it like `run --profile`.
	 */
	profile?: string;
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
	 * (WP42) carried into the launch itself (profile chooser and engine fence).
	 */
	signal?: AbortSignal;
}

export type AutoPhase =
	/** The classifier executor could not be resolved: nothing was sent. */
	| "classifier-unavailable"
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
	/** After comparison: the classifier status (`recommendation`, `no-fit`, `routing-unavailable`, …). */
	status?: WorkflowAutoResult["status"];
	reason?: string;
	recommendation?: {
		candidateId: string;
		label: string;
		confidence: "high" | "medium" | "low";
		reason: string;
	};
	/** After comparison: the launchable candidates, recommended first. */
	ranked?: AutoCandidateView[];
	selected?: AutoCandidateView;
	launch?: LaunchData;
	/** How to run a workflow directly on this host. */
	next?: string[];
}

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
 * run flags, else the profile's, else the `default` role of that executor's default profile (the
 * host's current model with the saved executor profile's changes for the host's executor, Pi; the
 * built-in or edited one for codex/claude, with its fallback), else the executor's own.
 */
export async function resolveAutoClassifier(
	ctx: HostApiContext,
	request: Pick<AutoRequest, "executor" | "profile" | "model" | "effort">,
): Promise<AutoClassifierTarget> {
	let file: UserProfilesFile | undefined;
	let profile:
		| {
				name: string;
				executor?: string;
				model?: string;
				effort?: EffortLevel;
		  }
		| undefined;
	try {
		file = await readUserProfiles(hostEnv(ctx));
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
	const executorDefault = await classifierExecutorDefault(
		ctx,
		selection,
		file === undefined ? undefined : userProfileFromFile(file, selection.id),
	);
	const model =
		request.model ?? fromProfile?.model ?? executorDefault?.model ?? null;
	const effort =
		request.effort ?? fromProfile?.effort ?? executorDefault?.effort ?? null;
	return {
		executor: selection.id,
		source: selection.source,
		model,
		effort: effort && isEffortLevel(effort) ? effort : null,
	};
}

/** The `default` role of the classifier executor's default profile (see resolveAutoClassifier). */
async function classifierExecutorDefault(
	ctx: HostApiContext,
	selection: Awaited<ReturnType<typeof resolveRunExecutorForHost>>,
	saved: UserProfile | undefined,
): Promise<{ model?: string; effort?: EffortLevel } | undefined> {
	const host = ctx.runtimeDefaults;
	if (
		host &&
		(host.executor === undefined || host.executor === selection.id) &&
		(host.model !== undefined || host.effort !== undefined)
	) {
		const base: WorkflowRoleMap = {
			default: {
				...(host.model === undefined ? {} : { model: host.model }),
				...(host.effort === undefined ? {} : { effort: host.effort }),
			},
		};
		return executorDefaultRuntime(
			saved === undefined
				? base
				: overlayExecutorProfile(selection.id, base, saved),
			{},
		);
	}
	let listed: string[] | null = null;
	if (
		executorPolicy(selection.id).defaultPreset !== undefined &&
		selection.descriptor !== undefined
	)
		try {
			listed = (
				await probeWorkflowExecutor(selection.descriptor, {
					prober: cachedExecutorProber,
				})
			).models;
		} catch {
			// The comparison call reports an executor it cannot use.
		}
	return executorDefaultRuntime(
		resolveExecutorDefaultProfile(selection.id, listed, process.env, saved)
			?.roles,
		{},
	);
}

function describeClassifier(target: AutoClassifierTarget): string {
	return `${target.executor} (${target.source}), model ${target.model ?? "executor default"}${target.effort ? `, effort ${target.effort}` : ""}`;
}

function shortlistLines(shortlist: readonly AutoCandidateView[]): string[] {
	return shortlist.map(
		(candidate, index) =>
			`  ${index + 1}. ${candidate.label} [${candidate.kind}, ${candidate.scope}]${candidate.launchable ? "" : ` (not launchable${candidate.blockers?.length ? `: ${candidate.blockers.join(" ")}` : ""})`}${candidate.command ? `\n     ${candidate.command}` : ""}`,
	);
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function availableAgentNames(cwd: string): Promise<string[] | undefined> {
	try {
		return [...(await discoverAgents(cwd)).byAlias.keys()];
	} catch {
		// A malformed unrelated agent must not fail recommendation-only auto.
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
 * `auto "<task>"`: classify once and start the top recommendation without asking. See the module header.
 */
export async function autoAction(
	ctx: HostApiContext,
	request: AutoRequest,
): Promise<HostResult<AutoData>> {
	assertActionAllowed(ctx, "auto");
	const task = typeof request.task === "string" ? request.task.trim() : "";
	if (!task)
		throw new HostUsageError('auto needs a task: agent-workflow auto "<task>"');
	if (request.effort !== undefined && !isEffortLevel(request.effort))
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
					...(target.effort ? { effort: target.effort } : {}),
				}
			: undefined;
	// 2. WP42 (review round 1, finding 2): the classifier request is built once, locally, once (catalog scan, bounded descriptions, the packet).
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
	const consent: WorkflowAutoConsentSource = "command";
	// Exactly one classifier call on the resolved executor (behind the host's loader, if any).
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
				phase: "classifier-unavailable",
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
		phase: "classifier-unavailable",
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
	// Only a usable classifier recommendation may launch; never fall back on classifier failure.
	const chosen = ranked.find(
		(candidate) => candidate.candidateId === recommendation?.candidateId,
	);
	const source = compared.shortlist.find(
		(candidate) => candidate.candidateId === chosen?.candidateId,
	);
	if (!chosen || !source || request.signal?.aborted)
		return result(
			"auto",
			"refused",
			data,
			[...rankedText, "No workflow has been started."].join("\n"),
		);
	// A named workflow must be the exact spec that was compared.
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
	};
	const { compare: _compare, ...launchOptions } = request;
	// WP42 (review round 1, finding 1): the session signal stays on the launch request: the launch
	// path re-checks it after its profile chooser and the engine
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
			{
				...data,
				phase: "classifier-unavailable",
				selected: chosen,
				launch: launched.data,
			},
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
