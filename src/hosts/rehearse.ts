// `rehearse`: run a workflow through the real engine with a synthetic worker (src/core/rehearsal.ts).
// No model, no network, no run state in the project or the user's home. Terminal CLI only.
import {
	REHEARSAL_DEFAULT_ITEMS,
	type RehearsalLoopMode,
	type RehearsalReport,
	rehearseWorkflow,
	validateRehearsalOptions,
} from "../core/rehearsal.js";
import { HostUsageError } from "./args.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	result,
} from "./types.js";

export interface RehearseRequest {
	workflow: string;
	task?: string;
	items?: number;
	loop?: RehearsalLoopMode;
	keep?: boolean;
	signal?: AbortSignal;
}

export interface RehearseData extends RehearsalReport {
	/** Kept temporary state root (`--keep` only). */
	stateRoot?: string;
	/** Temporary root that could not be removed; safe to delete by hand. */
	leftover?: string;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatRehearsal(data: RehearseData): string {
	const verdict = !data.ok
		? "wiring problems found"
		: data.status === "content-gates"
			? "wiring OK so far, but a helper declared failed/blocked on the synthetic data (read the reason below)"
			: "wiring OK";
	const lines = [
		`Rehearsal of ${data.workflow}: ${verdict} (run ${data.runStatus}; items ${data.options.items}, loop ${data.options.loop})`,
		"No model was called; run state was temporary.",
	];
	if (data.stages.length > 0) lines.push("Stages:");
	for (const stage of data.stages) {
		const parts = [
			`${stage.kind}`,
			plural(stage.tasks, "task"),
			Object.entries(stage.statuses)
				.map(([status, count]) => `${count} ${status}`)
				.join(", "),
		];
		if (stage.items !== undefined) parts.push(plural(stage.items, "item"));
		if (
			stage.declaredSources.length > 0 &&
			stage.sourcesReceived.withSources + stage.sourcesReceived.withoutSources >
				0
		)
			parts.push(
				`sources ${stage.declaredSources.join("+")} received by ${stage.sourcesReceived.withSources}/${stage.sourcesReceived.withSources + stage.sourcesReceived.withoutSources}`,
			);
		const unmet = stage.requiredReads.filter((read) => !read.satisfied).length;
		if (stage.requiredReads.length > 0)
			parts.push(
				`required reads ${stage.requiredReads.length - unmet}/${stage.requiredReads.length}`,
			);
		lines.push(`  ${stage.stage}: ${parts.join("; ")}`);
		for (const gate of stage.gates)
			lines.push(`    ${gate.task} declared ${gate.status} on synthetic data`);
	}
	for (const loop of data.loops)
		lines.push(
			`Loop ${loop.loop}: ${loop.status} after ${loop.maxRounds === null ? plural(loop.rounds, "round") : `${loop.rounds} of ${plural(loop.maxRounds, "round")}`}`,
		);
	const gates = data.stages.flatMap((stage) =>
		stage.gates.map((gate) => ({ stage: stage.stage, ...gate })),
	);
	lines.push(
		`Final report: ${data.finalReportRendered ? "rendered" : gates.length > 0 ? "not rendered (stopped at a declared failed/blocked; see below)" : "not rendered"}`,
	);
	if (gates.length > 0) {
		lines.push(
			data.ok
				? "Declared failed/blocked on synthetic data (a helper's own checks of evidence, counts or files rejected the placeholder output; the rehearsal cannot tell a content check from a setup problem):"
				: "Declared failed/blocked on synthetic data (a helper's own checks rejected the placeholder output; the findings below are separate):",
		);
		for (const gate of gates)
			lines.push(
				`- ${gate.task} (stage ${gate.stage}) declared ${gate.status} on synthetic data: ${gate.reasons.length > 0 ? gate.reasons.join("; ") : "no reason given"} — expected for a content check; if it names a missing source or setup, it is a wiring problem`,
			);
		if (data.skippedAfterGates.length > 0)
			lines.push(
				`  Stages skipped after the gate: ${data.skippedAfterGates.join(", ")}. Rehearsal cannot show whether real outputs would pass the gate.`,
			);
		else
			lines.push(
				"  Rehearsal cannot show whether real outputs would pass the gate.",
			);
	}
	if (data.warnings.length > 0) {
		lines.push("Warnings (same as validate):");
		for (const warning of data.warnings) lines.push(`- ${warning}`);
	}
	if (data.findings.length > 0) {
		lines.push("Findings:");
		for (const finding of data.findings) lines.push(`- ${finding}`);
	}
	if (data.stateRoot !== undefined)
		lines.push(`State kept at ${data.stateRoot}`);
	if (data.leftover !== undefined)
		lines.push(
			`Temporary state could not be fully removed: ${data.leftover} (safe to delete by hand)`,
		);
	return lines.join("\n");
}

export async function rehearseAction(
	ctx: HostApiContext,
	request: RehearseRequest,
): Promise<HostResult<RehearseData>> {
	assertActionAllowed(ctx, "rehearse");
	const problems = validateRehearsalOptions(request);
	if (problems.length > 0) throw new HostUsageError(problems.join("; "));
	const rehearsed = await rehearseWorkflow(ctx.cwd, {
		...request,
		items: request.items ?? REHEARSAL_DEFAULT_ITEMS,
	});
	const data: RehearseData = {
		...rehearsed.report,
		...(rehearsed.stateRoot === undefined
			? {}
			: { stateRoot: rehearsed.stateRoot }),
		...(rehearsed.leftover === undefined
			? {}
			: { leftover: rehearsed.leftover }),
	};
	return result(
		"rehearse",
		data.ok ? "success" : "failed",
		data,
		formatRehearsal(data),
	);
}
