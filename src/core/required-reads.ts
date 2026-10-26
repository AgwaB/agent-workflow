// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/subagent-backend.ts lines 5443-5725 (required artifact reads against the read ledger). MIT, same author. Changes: ledger rows marked deliveryUnverified: true (R#9, written by the WP5 MCP server) never satisfy a required read or projection policy.
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
	const missing = requiredReads
		.filter(
			(required) => !requiredArtifactReadSatisfied(required, attemptLedger),
		)
		.map(formatRequiredArtifactRead);
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
	return { missing, projectionFailures };
}

function requiredArtifactReadSatisfied(
	required: ArtifactGraphRequiredRead,
	ledger: readonly WorkflowArtifactReadLedgerRecord[],
): boolean {
	const normalized = normalizeRequiredArtifactRead(required);
	if (!normalized) return false;
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
	return normalized.count === undefined
		? matches.length > 0
		: matches.length === normalized.count;
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
	if (check.projectionFailures.length > 0) {
		parts.push(
			`required workflow artifact read projection policy failures: ${check.projectionFailures.join(", ")}`,
		);
	}
	return parts.join("; ");
}
