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
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatRehearsal(data: RehearseData): string {
	const lines = [
		`Rehearsal of ${data.workflow}: ${data.ok ? "wiring OK" : "wiring problems found"} (run ${data.status}; items ${data.options.items}, loop ${data.options.loop})`,
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
			lines.push(
				`    gate: ${gate.task} declared ${gate.status}${gate.reasons.length > 0 ? ` — ${gate.reasons.join("; ")}` : ""} (a content check synthetic output cannot satisfy)`,
			);
	}
	for (const loop of data.loops)
		lines.push(
			`Loop ${loop.loop}: ${loop.status} after ${loop.maxRounds === null ? plural(loop.rounds, "round") : `${loop.rounds} of ${plural(loop.maxRounds, "round")}`}`,
		);
	const gated = data.stages.some((stage) => stage.gates.length > 0);
	lines.push(
		`Final report: ${data.finalReportRendered ? "rendered" : gated ? "not rendered (a helper declared failed; see gate)" : "not rendered"}`,
	);
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
	};
	return result(
		"rehearse",
		data.ok ? "success" : "failed",
		data,
		formatRehearsal(data),
	);
}
