// Unverified delivery never satisfies a required read or projection policy.
// Verified pages of one content hash satisfy a whole-artifact read only when they cover [0, totalChars).
import { join } from "node:path";
import {
	type ArtifactGraphRequiredRead,
	type RequiredWorkflowArtifactReadPolicy,
} from "./types.js";
import {
	type WorkflowArtifactReadLedgerRecord,
	readWorkflowArtifactReadLedger,
} from "./workflow-artifact-tool.js";

export interface RequiredArtifactReadCheckResult {
	missing: string[];
	projectionFailures: string[];
	ledgerError?: string;
	/**
	 * WP5b: for missing whole-artifact reads that were paged but not completely, one line each
	 * naming the missing char ranges (`<source>.<artifact>: paged read incomplete, missing chars …`).
	 * Absent when empty.
	 */
	incompleteCoverage?: string[];
}

export async function checkRequiredArtifactReads(
	taskDir: string,
	requiredReads: readonly ArtifactGraphRequiredRead[],
	requiredReadPolicy: readonly RequiredWorkflowArtifactReadPolicy[] = [],
	options: { startedAt?: string } = {},
): Promise<RequiredArtifactReadCheckResult> {
	if (requiredReads.length === 0 && requiredReadPolicy.length === 0) {
		return { missing: [], projectionFailures: [] };
	}
	let ledger: WorkflowArtifactReadLedgerRecord[];
	try {
		ledger = await readWorkflowArtifactReadLedger(
			join(taskDir, "read-ledger.jsonl"),
		);
	} catch (error) {
		return {
			missing: [
				...requiredReads.map(formatRequiredArtifactRead),
				...requiredReadPolicy.map(formatRequiredReadPolicyName),
			],
			projectionFailures: [],
			ledgerError: error instanceof Error ? error.message : String(error),
		};
	}
	const attemptStartedAt =
		options.startedAt === undefined ? NaN : Date.parse(options.startedAt);
	// R#9: a read whose delivery to the worker could not be verified (the MCP client may have
	// truncated the result) is not evidence that the worker read the artifact.
	const deliveredLedger = ledger.filter(
		(entry) => entry.deliveryUnverified !== true,
	);
	const attemptLedger = Number.isFinite(attemptStartedAt)
		? deliveredLedger.filter((entry) => {
				const readAt = Date.parse(entry.at);
				return Number.isFinite(readAt) && readAt >= attemptStartedAt;
			})
		: deliveredLedger;
	const missing: string[] = [];
	const incompleteCoverage: string[] = [];
	for (const required of requiredReads) {
		const status = requiredArtifactReadStatus(required, attemptLedger);
		if (status.satisfied) continue;
		missing.push(formatRequiredArtifactRead(required));
		if (status.coverageGap !== undefined)
			incompleteCoverage.push(status.coverageGap);
	}
	const projectionFailures: string[] = [];
	for (const policy of requiredReadPolicy) {
		const name = `${policy.source}.${policy.artifact}`;
		const sourceArtifactRows = attemptLedger.filter(
			(entry) =>
				entry.source === policy.source && entry.artifact === policy.artifact,
		);
		if (sourceArtifactRows.length === 0) {
			if (!missing.includes(name)) missing.push(name);
			continue;
		}
		if (
			!sourceArtifactRows.some((entry) =>
				requiredReadPolicyMatches(entry, policy),
			)
		) {
			projectionFailures.push(formatRequiredReadPolicyName(policy));
		}
	}
	return {
		missing,
		projectionFailures,
		...(incompleteCoverage.length === 0 ? {} : { incompleteCoverage }),
	};
}

function requiredArtifactReadStatus(
	required: ArtifactGraphRequiredRead,
	ledger: readonly WorkflowArtifactReadLedgerRecord[],
): { satisfied: boolean; coverageGap?: string } {
	const normalized = normalizeRequiredArtifactRead(required);
	if (!normalized) return { satisfied: false };
	const matches = ledger.filter(
		(entry) =>
			!entry.truncated &&
			entry.source === normalized.source &&
			entry.artifact === normalized.artifact &&
			requiredArtifactReadPathSatisfied(normalized, entry.path) &&
			(normalized.maxChars === undefined ||
				entry.maxChars === normalized.maxChars) &&
			(normalized.maxItems === undefined ||
				entry.maxItems === normalized.maxItems),
	);
	// WP5b: page coverage applies to whole-artifact requirements only (pages carry no path).
	const coverage =
		normalized.path === undefined &&
		normalized.maxChars === undefined &&
		normalized.maxItems === undefined
			? pagedReadCoverage(normalized.source, normalized.artifact, ledger)
			: { complete: 0, gap: undefined };
	const reads = matches.length + coverage.complete;
	const satisfied =
		normalized.count === undefined ? reads > 0 : reads === normalized.count;
	return satisfied || coverage.gap === undefined || coverage.complete > 0
		? { satisfied }
		: { satisfied, coverageGap: coverage.gap };
}

/**
 * WP5b coverage rule. Verified partial page rows (`deliveryUnverified: false`, page range fields,
 * `truncated: true`) are grouped by artifact version (`contentSha256` + `totalChars`); a group whose
 * ranges cover `[0, totalChars)` (any order, overlaps allowed) counts as one whole read. A single
 * page covering the whole artifact has `truncated: false` and already counts as a whole-read row.
 * Unverified, cut or projected rows never count, and pages of different versions never combine.
 */
function pagedReadCoverage(
	source: string,
	artifact: string,
	ledger: readonly WorkflowArtifactReadLedgerRecord[],
): { complete: number; gap?: string } {
	const groups = new Map<
		string,
		{ total: number; ranges: Array<[number, number]> }
	>();
	for (const entry of ledger) {
		if (
			entry.source !== source ||
			entry.artifact !== artifact ||
			entry.deliveryUnverified !== false ||
			entry.truncated !== true ||
			entry.path !== undefined ||
			entry.rangeStart === undefined ||
			entry.rangeEnd === undefined ||
			entry.totalChars === undefined ||
			entry.contentSha256 === undefined
		)
			continue;
		const key = `${entry.contentSha256}:${entry.totalChars}`;
		const group = groups.get(key) ?? { total: entry.totalChars, ranges: [] };
		group.ranges.push([entry.rangeStart, entry.rangeEnd]);
		groups.set(key, group);
	}
	let complete = 0;
	let best: { covered: number; gaps: Array<[number, number]>; total: number } =
		{ covered: -1, gaps: [], total: 0 };
	for (const group of groups.values()) {
		const gaps = coverageGaps(group.ranges, group.total);
		if (gaps.length === 0) {
			complete += 1;
			continue;
		}
		const covered =
			group.total - gaps.reduce((sum, [start, end]) => sum + end - start, 0);
		if (covered > best.covered) best = { covered, gaps, total: group.total };
	}
	if (complete > 0 || best.covered < 0) return { complete };
	const versions =
		groups.size > 1
			? ` (pages of ${groups.size} artifact versions; pages of different versions do not combine)`
			: "";
	return {
		complete,
		gap: `${source}.${artifact}: paged read incomplete, missing chars ${best.gaps
			.map(([start, end]) => `${start}–${end}`)
			.join(", ")} of ${best.total}${versions}`,
	};
}

/** Uncovered sub-ranges of `[0, total)` given half-open `ranges`. */
function coverageGaps(
	ranges: ReadonlyArray<readonly [number, number]>,
	total: number,
): Array<[number, number]> {
	const sorted = [...ranges]
		.filter(([start, end]) => end > start)
		.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	const gaps: Array<[number, number]> = [];
	let covered = 0;
	for (const [start, end] of sorted) {
		if (start > covered) gaps.push([covered, Math.min(start, total)]);
		covered = Math.max(covered, end);
		if (covered >= total) break;
	}
	if (covered < total) gaps.push([covered, total]);
	return gaps;
}

function requiredArtifactReadPathSatisfied(
	required: {
		source: string;
		artifact: string;
		path?: string;
	},
	entryPath: string | undefined,
): boolean {
	if (required.path === undefined) return true;
	if (entryPath === undefined) return false;
	return requiredArtifactReadPathCandidates(
		required.path,
		required.source,
		required.artifact,
	).includes(entryPath);
}

function requiredArtifactReadPathCandidates(
	path: string,
	source: string,
	artifact: string,
): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const queue = [path];
	for (let index = 0; index < queue.length && index < 32; index += 1) {
		const candidate = queue[index];
		if (candidate === undefined || seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
		for (const next of [
			stripRequiredReadSourcePathPrefix(candidate, source),
			stripRequiredReadArtifactPathPrefix(candidate, artifact),
			applyRequiredReadJsonPathSegmentAliases(candidate),
		]) {
			if (next !== candidate && !seen.has(next)) queue.push(next);
		}
	}
	return candidates;
}

function stripRequiredReadSourcePathPrefix(
	path: string,
	source: string,
): string {
	const sourcePrefix = `$.${source}.`;
	if (!path.startsWith(sourcePrefix)) return path;
	return `$.${path.slice(sourcePrefix.length)}`;
}

function stripRequiredReadArtifactPathPrefix(
	path: string,
	artifact: string,
): string {
	const artifactPath = `$.${artifact}`;
	if (path === artifactPath) return "$";
	const artifactPrefix = `${artifactPath}.`;
	if (!path.startsWith(artifactPrefix)) return path;
	return `$.${path.slice(artifactPrefix.length)}`;
}

const REQUIRED_READ_JSON_PATH_SEGMENT_ALIASES: Record<string, string> = {
	axes: "researchAxes",
	claimVerdicts: "claimVerdictLedger",
	factSlot: "factSlots",
	gaps: "remainingGaps",
	primarySources: "sourcePolicy",
	priorities: "verificationPriorities",
	questions: "researchQuestions",
	requiredSources: "sourcePolicy",
	scope: "researchScope",
	slots: "factSlots",
	sourceQualityRules: "sourcePolicy",
	sourceRequirements: "sourcePolicy",
	verification: "verificationPriorities",
	verificationPriority: "verificationPriorities",
	verdicts: "claimVerdictLedger",
};

function applyRequiredReadJsonPathSegmentAliases(path: string): string {
	if (path === "$") return path;
	const segments = path.slice(2).split(".");
	const aliased = segments.map(
		(segment) => REQUIRED_READ_JSON_PATH_SEGMENT_ALIASES[segment] ?? segment,
	);
	if (aliased.every((segment, index) => segment === segments[index]))
		return path;
	return `$.${aliased.join(".")}`;
}

function normalizeRequiredArtifactRead(required: ArtifactGraphRequiredRead): {
	source: string;
	artifact: string;
	path?: string;
	maxChars?: number;
	maxItems?: number;
	count?: number;
} | null {
	if (typeof required === "string") {
		const match = required.match(
			/^([A-Za-z0-9_.-]+)\.(control|analysis|refs|raw)$/,
		);
		if (!match) return null;
		return { source: match[1]!, artifact: match[2]! };
	}
	return required;
}

export function formatRequiredArtifactRead(
	required: ArtifactGraphRequiredRead,
): string {
	return typeof required === "string"
		? required
		: [
				`${required.source}.${required.artifact}`,
				required.path === undefined ? undefined : `path=${required.path}`,
				required.maxChars === undefined
					? undefined
					: `maxChars=${required.maxChars}`,
				required.maxItems === undefined
					? undefined
					: `maxItems=${required.maxItems}`,
				required.count === undefined ? undefined : `count=${required.count}`,
			]
				.filter(Boolean)
				.join(" ");
}

function requiredReadPolicyMatches(
	entry: WorkflowArtifactReadLedgerRecord,
	policy: RequiredWorkflowArtifactReadPolicy,
): boolean {
	if (entry.truncated) return false;
	if (
		policy.path === undefined &&
		(policy.maxItems !== undefined || policy.maxChars !== undefined)
	) {
		return false;
	}
	if (policy.path !== undefined) {
		if (entry.path === undefined) return false;
		if (
			!requiredArtifactReadPathCandidates(
				policy.path,
				policy.source,
				policy.artifact,
			).includes(entry.path)
		) {
			return false;
		}
	}
	if (policy.maxItems !== undefined && entry.maxItems !== policy.maxItems)
		return false;
	if (policy.maxChars !== undefined && entry.maxChars !== policy.maxChars)
		return false;
	if (
		policy.minReturnedBytes !== undefined &&
		entry.returnedBytes < policy.minReturnedBytes
	) {
		return false;
	}
	return true;
}

export function formatRequiredReadPolicyName(
	policy: RequiredWorkflowArtifactReadPolicy,
): string {
	const constraints = [
		policy.path === undefined ? undefined : `path=${policy.path}`,
		policy.maxItems === undefined ? undefined : `maxItems=${policy.maxItems}`,
		policy.maxChars === undefined ? undefined : `maxChars=${policy.maxChars}`,
		policy.mustNotTruncate === undefined
			? undefined
			: `mustNotTruncate=${policy.mustNotTruncate}`,
		policy.minReturnedBytes === undefined
			? undefined
			: `minReturnedBytes=${policy.minReturnedBytes}`,
	].filter(Boolean);
	return constraints.length === 0
		? `${policy.source}.${policy.artifact}`
		: `${policy.source}.${policy.artifact} (${constraints.join(", ")})`;
}

export function formatRequiredReadFailureMessage(
	check: RequiredArtifactReadCheckResult,
): string {
	const parts: string[] = [];
	if (check.missing.length > 0) {
		parts.push(
			`missing required workflow artifact reads: ${check.missing.join(", ")}`,
		);
	}
	if (
		check.incompleteCoverage !== undefined &&
		check.incompleteCoverage.length > 0
	) {
		parts.push(
			`incomplete paged reads (read the missing ranges with offset): ${check.incompleteCoverage.join("; ")}`,
		);
	}
	if (check.projectionFailures.length > 0) {
		parts.push(
			`required workflow artifact read projection policy failures: ${check.projectionFailures.join(", ")}`,
		);
	}
	return parts.join("; ");
}

/** `control.inputIntegrity.reason` values the read ledger can disprove. */
const LEDGER_DISPROVABLE_READ_CLAIMS = new Set([
	"truncated_read",
	"missing_read",
]);

/**
 * 2026-11-01: a worker may withhold its result because it believes a required read was truncated
 * or missing (`control.inputIntegrity = { status: "blocked", reason: "truncated_read" }`). Called
 * only after `checkRequiredArtifactReads` passed, which counts a read only when it was delivered
 * complete (not truncated, delivery verified) in this attempt — so such a claim contradicts the
 * ledger. Returns the retry instruction, or undefined when there is nothing to contradict.
 * Claims the ledger cannot judge (`inconsistent_input`, `budget_block`) are accepted.
 */
export function inputIntegrityContradiction(
	control: Record<string, unknown> | undefined,
	requiredReadCount: number,
): string | undefined {
	if (requiredReadCount === 0) return undefined;
	const integrity = control?.inputIntegrity;
	if (!integrity || typeof integrity !== "object" || Array.isArray(integrity))
		return undefined;
	const { status, reason, detail } = integrity as Record<string, unknown>;
	if (status !== "blocked" || typeof reason !== "string") return undefined;
	if (!LEDGER_DISPROVABLE_READ_CLAIMS.has(reason)) return undefined;
	const claim =
		typeof detail === "string" && detail.trim()
			? ` (${JSON.stringify(detail.trim().slice(0, 300))})`
			: "";
	return [
		`Your control reported inputIntegrity.status="blocked" with reason="${reason}"${claim}, but the engine's read ledger shows all ${requiredReadCount} required workflow_artifact reads of that attempt were delivered complete: none truncated (every projection had charsTruncated=false) and none missing.`,
		'Do not report truncated or missing reads. Read the required paths again and build the output from their full content; report inputIntegrity.status="complete".',
		'Only if the content itself is inconsistent (for example a header count that does not match the entries on the pages), report inputIntegrity.status="blocked" with reason="inconsistent_input" and name the exact field and the two counts in detail.',
	].join(" ");
}

export interface AcceptedInputIntegrityBlock {
	reason: string;
	detail?: string;
	message: string;
}

/**
 * 2026-11-08 (K3): a worker that reports `inputIntegrity.status="blocked"` with a reason the read
 * ledger cannot disprove (`inconsistent_input`, `budget_block`, or one the ledger did not judge)
 * has withheld its result: the stage must not complete on that output. Call after
 * `inputIntegrityContradiction` returned undefined. Returns the block, or undefined when the
 * control reports no block.
 */
export function acceptedInputIntegrityBlock(
	control: Record<string, unknown> | undefined,
): AcceptedInputIntegrityBlock | undefined {
	const integrity = control?.inputIntegrity;
	if (!integrity || typeof integrity !== "object" || Array.isArray(integrity))
		return undefined;
	const { status, reason, detail } = integrity as Record<string, unknown>;
	if (status !== "blocked") return undefined;
	const reasonText =
		typeof reason === "string" && reason.trim() ? reason.trim() : "unspecified";
	const detailText =
		typeof detail === "string" && detail.trim()
			? detail.trim().slice(0, 600)
			: undefined;
	return {
		reason: reasonText,
		...(detailText === undefined ? {} : { detail: detailText }),
		message: `worker reported inputIntegrity.status="blocked" with reason="${reasonText}"${detailText ? ` (${JSON.stringify(detailText)})` : ""}; the engine cannot disprove a content claim, so the stage is not completed on this output. Resume reruns the stage; a repeated block points at the stage's input.`,
	};
}
