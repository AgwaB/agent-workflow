// Deterministic evidence-backed renderer for deep-review.
//
// Finding cards are rendered from partition-verdicts.control.json, the
// deterministic post-processing ledger. The model-authored report stage is used
// only for narrative summary/verdict/risk fields.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	asArray,
	hasPartialFailures,
	requiredReportVerdict,
} from "./review-verdict.mjs";

import {
	escapeCompletionText, escapeMarkdownText, escapeTableCell, fold, inlineCode, reportActions, reportLocale, reportSection, reportStatus, shortNarrative,
} from "./report-markdown.mjs";

import { readerCoverageDetail, readerDiagnostic } from "./reader-diagnostics.mjs";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info", "unknown"];
const REPORT_VERDICTS = new Set([
	"REVIEW_COMPLETE",
	"NEEDS_WORK",
	"PARTIAL_REVIEW",
]);

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {}).filter(
		([specId]) => specId === stageId || specId.startsWith(`${stageId}.`),
	);
	if (matches.length > 1) {
		throw new Error(
			`deep-review renderer: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalJsonValue(value[key])]),
	);
}

function sha256Json(value) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalJsonValue(value)))
		.digest("hex");
}

function sameMultiset(left, right) {
	const counts = (values) => {
		const map = new Map();
		for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
		return map;
	};
	const a = counts(left);
	const b = counts(right);
	return (
		a.size === b.size && [...a].every(([key, count]) => b.get(key) === count)
	);
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		// Only before punctuation that ends a word: ".agent-workflow/…", " .env" keep their space (2026-11-04).
		.replace(/\s+([,.;:!?])(?=\s|$)/g, "$1")
		.trim();
}

function evidenceText(value) {
	return String(value ?? "");
}

const escapeHeadingText = escapeMarkdownText;

function completionText(value, t) {
	const withoutArtifactPaths = cleanText(value)
		// agent-workflow 2026-11-04 (live runs: "workflow-stop.ts" became t("[run omitted]", "[실행 ID 생략]"), a reviewed
		// file's "control.json" became t("[artifact omitted]", "[자료 생략]")): only this engine's own names are hidden —
		// paths under .agent-workflow/workflows, run ids (workflow_<id>_<hex6>), task ids (task-<n>),
		// sidecar names, and refs/control JSON only as a stage-qualified or path-qualified name.
		.replace(
			/(?<![\w-])\.agent-workflow[\\/]workflows(?:[\\/][^\s]*)?/gi,
			t("[artifact omitted]", "[자료 생략]"),
		)
		.replace(/\b(?:final-report|audit)\.md\b/gi, t("[artifact omitted]", "[자료 생략]"))
		.replace(
			/\b(?:partition-verdicts\.control|report\.control)\.json\b|(?<=[.\\/])(?:refs|control)\.json\b/gi,
			t("[artifact omitted]", "[자료 생략]"),
		)
		.replace(/\bworkflow\\?_[a-z0-9]+\\?_[a-f0-9]{6}\b/gi, t("[run omitted]", "[실행 ID 생략]"))
		.replace(/\btask-\d+\b/gi, t("[task omitted]", "[작업 ID 생략]"));
	return cleanText(withoutArtifactPaths)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/([\\`*_[\]{}#+|])/g, "\\$1");
}

function severityOf(finding) {
	const raw = cleanText(finding?.severity).toLowerCase();
	if (SEVERITY_ORDER.includes(raw)) return raw;
	return raw || "unknown";
}

function severityRank(severity) {
	const index = SEVERITY_ORDER.indexOf(severityOf({ severity }));
	return index === -1 ? SEVERITY_ORDER.length : index;
}

function titleOf(finding) {
	return cleanText(
		finding?.title ?? finding?.finding ?? finding?.summary ?? "Untitled finding",
	);
}

/** The title a reader sees: the verifier's translation into the task's language, else the original. */
function readerTitleOf(finding) {
	return cleanText(finding?.readerTitle) || titleOf(finding);
}

function findingIdOf(finding, index) {
	return cleanText(
		finding?.findingId ??
			finding?.id ??
			`finding-${String(index + 1).padStart(3, "0")}`,
	);
}

function rootCauseIdOf(finding) {
	return cleanText(finding?.rootCauseId ?? "");
}

function exactDevilAdvocateStatus(status, identity) {
	return Boolean(
		status &&
			status.status === "completed" &&
			status.stageId === "devil-advocate" &&
			typeof status.specId === "string" &&
			status.specId.startsWith("devil-advocate.") &&
			status.itemIdentity === identity &&
			status.placeholderSpecId === "devil-advocate.item" &&
			typeof status.taskId === "string" &&
			status.taskId.trim(),
	);
}

function locationKey(location) {
	return `${location.file ?? ""}|${location.line ?? ""}|${location.lineEnd ?? ""}|${location.symbol ?? ""}`;
}

function normalizeLocation(location) {
	if (!location || typeof location !== "object") return null;
	const file = cleanText(location.file);
	if (!file) return null;
	const line = Number.isFinite(Number(location.line))
		? Number(location.line)
		: undefined;
	const lineEnd = Number.isFinite(Number(location.lineEnd))
		? Number(location.lineEnd)
		: undefined;
	const symbol = cleanText(location.symbol);
	return {
		file,
		...(line === undefined ? {} : { line }),
		...(lineEnd === undefined ? {} : { lineEnd }),
		...(symbol ? { symbol } : {}),
	};
}

function locationsOf(finding) {
	const seen = new Set();
	const out = [];
	for (const raw of asArray(finding?.locations)) {
		const location = normalizeLocation(raw);
		if (!location) continue;
		const key = locationKey(location);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(location);
	}
	return out;
}

function evidenceQuotesOf(finding) {
	const seen = new Set();
	const out = [];
	for (const quote of asArray(finding?.evidenceQuotes)) {
		const text = evidenceText(quote);
		if (!text.trim() || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function reviewerEvidenceQuotesOf(finding) {
	return evidenceQuotesOf({
		evidenceQuotes:
			finding?.reviewerEvidenceQuotes ?? finding?.evidenceQuotes ?? [],
	});
}

function verifierEvidenceQuotesOf(finding) {
	return evidenceQuotesOf({ evidenceQuotes: finding?.verifierEvidence ?? [] });
}

function mergedLineageOf(finding) {
	const declared =
		Array.isArray(finding?.mergedFindings) && finding.mergedFindings.length > 0
			? finding.mergedFindings
			: finding?.mergedLineage;
	return asArray(declared)
		.filter((entry) => entry && typeof entry === "object")
		.flatMap((entry) => [entry, ...mergedLineageOf(entry)]);
}

function ledgerIdAudit(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const topLevel = [
		...asArray(ledger?.keep),
		...asArray(ledger?.weaken),
		...asArray(ledger?.drop),
		...asArray(ledger?.needsHuman),
	];
	const strictId = (finding) =>
		typeof finding?.findingId === "string" && finding.findingId.trim()
			? finding.findingId.trim()
			: typeof finding?.id === "string" && finding.id.trim()
				? finding.id.trim()
				: "";
	const topLevelIds = topLevel.map(strictId);
	const supportNotes = asArray(partition?.supportNotes);
	const supportIds = supportNotes.map(strictId);
	const lineage = [
		...topLevel.flatMap((finding) => mergedLineageOf(finding)),
		...supportNotes.flatMap((note) => mergedLineageOf(note)),
	];
	const lineageIds = lineage.map(strictId);
	// Support cards are first-class ledger rows. Include their own IDs in the
	// same occurrence ledger as dispositions and recursive merged members.
	const allIds = [...topLevelIds, ...supportIds, ...lineageIds];
	const uniqueIds = new Set(allIds.filter(Boolean));
	const duplicateIds = allIds
		.filter((id) => !id)
		.concat(allIds.filter((id, index) => id && allIds.indexOf(id) !== index));
	const reviewerLedger = partition?.reviewerLedger;
	const dedupSummary = partition?.dedupSummary;
	const verifier = partition?.verifierCoverage;
	const requiredLedgersPresent = [reviewerLedger, dedupSummary, verifier].every(
		(value) => value && typeof value === "object" && !Array.isArray(value),
	);
	const ledgerCompleteness =
		requiredLedgersPresent &&
		reviewerLedger.complete === true &&
		dedupSummary.complete === true &&
		verifier.complete === true;
	const duplicateLedger = asArray(dedupSummary?.duplicates);
	const duplicateCount = Number(dedupSummary?.duplicateCount);
	const duplicateLedgerKeys = new Set();
	const duplicateLedgerIssues = [];
	for (const duplicate of duplicateLedger) {
		const keptFindingId =
			typeof duplicate?.keptFindingId === "string"
				? duplicate.keptFindingId.trim()
				: "";
		const droppedFindingId =
			typeof duplicate?.droppedFindingId === "string"
				? duplicate.droppedFindingId.trim()
				: "";
		const key = `${keptFindingId}|${droppedFindingId}`;
		if (!keptFindingId || !droppedFindingId || keptFindingId === droppedFindingId)
			duplicateLedgerIssues.push({
				duplicate,
				reason: "duplicate_ledger_row_missing_distinct_finding_ids",
			});
		else if (duplicateLedgerKeys.has(key))
			duplicateLedgerIssues.push({
				duplicate,
				reason: "duplicate_ledger_row_repeated",
			});
		else if (asArray(dedupSummary?.dedupFindingIds).includes(keptFindingId))
			duplicateLedgerKeys.add(key);
		else
			duplicateLedgerIssues.push({
				duplicate,
				reason: "duplicate_ledger_kept_id_not_in_dedup_ledger",
			});
	}
	const rawReviewerIdSet = new Set(
		asArray(reviewerLedger?.rawFindingIds).filter(
			(id) => typeof id === "string" && id.trim(),
		),
	);
	const rawReviewerIdsForAudit = asArray(reviewerLedger?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const removedRawIds = rawReviewerIdsForAudit.filter(
		(id) => !asArray(reviewerLedger?.dedupFindingIds).includes(id),
	);
	const duplicateLedgerDroppedIds = duplicateLedger
		.map((duplicate) =>
			typeof duplicate?.droppedFindingId === "string"
				? duplicate.droppedFindingId.trim()
				: "",
		)
		.filter(Boolean);
	const rawDuplicateIdsMissing = duplicateLedgerDroppedIds.filter(
		(id) => !rawReviewerIdSet.has(id),
	);
	const removedRawIdSet = new Set(removedRawIds);
	const duplicateLineageCounts = new Map();
	for (const id of lineageIds) {
		if (removedRawIdSet.has(id))
			duplicateLineageCounts.set(id, (duplicateLineageCounts.get(id) ?? 0) + 1);
	}
	const rawDuplicateLineageIssues = removedRawIds.filter(
		(id) => duplicateLineageCounts.get(id) !== 1,
	);
	const independentlyDispositionedRawDuplicates = removedRawIds.filter(
		(id) => topLevelIds.includes(id) || supportIds.includes(id),
	);
	const duplicateLedgerRawIdsMismatch = !sameMultiset(
		removedRawIds,
		duplicateLedgerDroppedIds,
	);
	const duplicateCountAndShapeReconciled =
		Number.isSafeInteger(duplicateCount) &&
		duplicateCount >= 0 &&
		duplicateCount === duplicateLedger.length &&
		duplicateLedgerIssues.length === 0 &&
		rawDuplicateIdsMissing.length === 0 &&
		!duplicateLedgerRawIdsMismatch &&
		rawDuplicateLineageIssues.length === 0 &&
		independentlyDispositionedRawDuplicates.length === 0;
	const duplicateCountMismatch = !duplicateCountAndShapeReconciled;
	const rawReviewerIds = asArray(reviewerLedger?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const dedupIds = asArray(reviewerLedger?.dedupFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const sameIdSequence = (left, right) =>
		left.length === right.length &&
		left.every((id, index) => id === right[index]);
	const ledgerRawIds = asArray(reviewerLedger?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const summaryRawIds = asArray(dedupSummary?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const ledgerDedupIds = asArray(reviewerLedger?.dedupFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const summaryDedupIds = asArray(dedupSummary?.dedupFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const rawReviewerIdsMismatch =
		Boolean(reviewerLedger && dedupSummary) &&
		(!Array.isArray(reviewerLedger.rawFindingIds) ||
			!Array.isArray(dedupSummary.rawFindingIds) ||
			!sameIdSequence(ledgerRawIds, summaryRawIds));
	const dedupIdsMismatch =
		Boolean(reviewerLedger && dedupSummary) &&
		(!Array.isArray(reviewerLedger.dedupFindingIds) ||
			!Array.isArray(dedupSummary.dedupFindingIds) ||
			!sameIdSequence(ledgerDedupIds, summaryDedupIds));
	const rawCountMismatch =
		dedupSummary &&
		Number.isSafeInteger(Number(dedupSummary.rawCount)) &&
		Number(dedupSummary.rawCount) !== rawReviewerIds.length;
	const uniqueCountMismatch =
		dedupSummary &&
		Number.isSafeInteger(Number(dedupSummary.uniqueCount)) &&
		Number(dedupSummary.uniqueCount) !== dedupIds.length;
	const dedupDroppedIdSet = new Set(
		rawReviewerIds.filter((id) => !dedupIds.includes(id)),
	);
	// A later partition pass may legitimately reparent a dedup survivor under
	// another verified root. Reconcile duplicate pairs through that root, while
	// rejecting a pair whose kept and dropped members no longer share one final
	// root. This makes the pair gate authoritative without penalising a real
	// second-phase merge.
	const finalRootById = new Map();
	const indexFinalRoot = (root) => {
		const rootId = strictId(root);
		if (!rootId) return;
		finalRootById.set(rootId, rootId);
		for (const member of mergedLineageOf(root)) {
			const memberId = strictId(member);
			if (memberId) finalRootById.set(memberId, rootId);
		}
	};
	for (const root of [...topLevel, ...supportNotes]) indexFinalRoot(root);
	const actualDedupPairs = [...topLevel, ...supportNotes].flatMap((root) => {
		const rootId = strictId(root);
		return rootId
			? mergedLineageOf(root)
					.filter((member) => dedupDroppedIdSet.has(strictId(member)))
					.map((member) => `${rootId}|${strictId(member)}`)
			: [];
	});
	const duplicateLedgerPairs = duplicateLedger.map((duplicate) => {
		const keptId = String(duplicate?.keptFindingId ?? "").trim();
		const droppedId = String(duplicate?.droppedFindingId ?? "").trim();
		const keptRoot = finalRootById.get(keptId);
		const droppedRoot = finalRootById.get(droppedId);
		if (!keptRoot || keptRoot !== droppedRoot)
			return `invalid|${keptId}|${droppedId}`;
		return `${keptRoot}|${droppedId}`;
	});
	const duplicateLedgerPairsMismatch = !sameMultiset(
		actualDedupPairs,
		duplicateLedgerPairs,
	);
	const duplicateLedgerReconciled =
		duplicateCountAndShapeReconciled && !duplicateLedgerPairsMismatch;
	const dispositionIdSet = new Set(allIds.filter(Boolean));
	const rawReviewerIdsMissing = [
		...new Set(rawReviewerIds.filter((id) => !dispositionIdSet.has(id))),
	];
	const dedupIdsMissing = [
		...new Set(dedupIds.filter((id) => !dispositionIdSet.has(id))),
	];
	const verifierRows = asArray(verifier?.rows).filter(
		(row) => row && typeof row === "object",
	);
	const verifierRowIds = verifierRows
		.map((row) => (typeof row.findingId === "string" ? row.findingId.trim() : ""))
		.filter(Boolean);
	const expectedVerifierIds = asArray(verifier?.expectedFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const expectedVerifierSet = new Set(expectedVerifierIds);
	const verifierRowSet = new Set(verifierRowIds);
	const verifierMissingIds = expectedVerifierIds.filter(
		(id) => !verifierRowSet.has(id),
	);
	const verifierOrphanIds = verifierRowIds.filter(
		(id) => !expectedVerifierSet.has(id),
	);
	const verifierDuplicateIds = verifierRowIds.filter(
		(id, index) => verifierRowIds.indexOf(id) !== index,
	);
	const verifierOwnershipIssues = verifierRows.filter((row) => {
		const owner = row.owner;
		if (
			!owner ||
			![
				owner.source,
				owner.specId,
				owner.taskId,
				owner.itemIdentity,
				owner.placeholderSpecId,
			].every((value) => typeof value === "string" && value.trim())
		)
			return true;
		const statuses = asArray(verifier?.sourceStatuses).filter(
			(status) =>
				status &&
				(status.source === row.sourceId || status.specId === row.sourceId),
		);
		if (statuses.length !== 1) return true;
		const status = statuses[0];
		const identity = row.batchId ?? row.findingId;
		if (!exactDevilAdvocateStatus(status, identity)) return true;
		return (
			owner.source !== status.source ||
			owner.specId !== status.specId ||
			owner.taskId !== status.taskId ||
			owner.itemIdentity !== status.itemIdentity ||
			owner.placeholderSpecId !== status.placeholderSpecId
		);
	});
	const verifierExpectedMismatch = !sameMultiset(expectedVerifierIds, dedupIds);
	const verifierStatusIssues = asArray(verifier?.sourceStatuses)
		.filter(
			(status) =>
				status?.stageId === "devil-advocate" ||
				String(status?.specId ?? "").startsWith("devil-advocate.") ||
				String(status?.source ?? "").startsWith("devil-advocate."),
		)
		.filter((status) => {
			const identity = String(status?.itemIdentity ?? "").trim();
			return (
				!identity ||
				!(
					(expectedVerifierIds.includes(identity) ||
						asArray(verifier?.rows).some((row) => row?.batchId === identity)) &&
					exactDevilAdvocateStatus(status, identity)
				)
			);
		})
		.map((status) => ({
			sourceId: status.source ?? status.specId ?? "",
			itemIdentity: status.itemIdentity ?? "",
			reason: "verifier status is not an exact completed devil-advocate owner",
		}));
	const verifierDeclaredRowsMismatch = !sameMultiset(
		asArray(verifier?.verdictFindingIds),
		verifierRowIds,
	);
	const partitionVerdictsReceived = Number(
		partition?.partitionSummary?.verdictsReceived,
	);
	const verifierVerdictsReceived = Number(verifier?.verdictsReceived);
	const verdictsReceivedMismatch =
		!Number.isSafeInteger(partitionVerdictsReceived) ||
		partitionVerdictsReceived < 0 ||
		!Number.isSafeInteger(verifierVerdictsReceived) ||
		verifierVerdictsReceived < 0 ||
		partitionVerdictsReceived !== verifierVerdictsReceived ||
		verifierVerdictsReceived !== verifierRows.length;
	const reviewerOwnerMapIssues = asArray(reviewerLedger?.ownerMap).filter(
		(owner) => {
			const statuses = asArray(reviewerLedger?.sourceStatuses).filter(
				(status) =>
					status?.source === owner?.source || status?.specId === owner?.source,
			);
			if (statuses.length !== 1) return true;
			const status = statuses[0];
			return (
				!owner ||
				owner.source !== status.source ||
				owner.specId !== status.specId ||
				owner.taskId !== status.taskId ||
				owner.itemIdentity !== status.itemIdentity ||
				owner.placeholderSpecId !== status.placeholderSpecId ||
				status.status !== "completed"
			);
		},
	);
	const verifierDigestMatches =
		requiredLedgersPresent &&
		typeof verifier.digest === "string" &&
		verifier.digest ===
			sha256Json({
				expectedFindingIds: asArray(verifier.expectedFindingIds),
				verdictFindingIds: asArray(verifier.verdictFindingIds),
				rows: verifierRows,
			});
	const verifierCoverageExact =
		requiredLedgersPresent &&
		ledgerCompleteness &&
		!verifierExpectedMismatch &&
		verifierDigestMatches &&
			!verdictsReceivedMismatch &&
			!verifierDeclaredRowsMismatch &&
			verifierStatusIssues.length === 0 &&
			verifierMissingIds.length === 0 &&
			verifierOrphanIds.length === 0 &&
			verifierDuplicateIds.length === 0 &&
		verifierOwnershipIssues.length === 0;
	const plannedLensIds = asArray(reviewerLedger?.plannedLensIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const materializedReviewerIds = asArray(
		reviewerLedger?.materializedReviewerIds,
	).filter((id) => typeof id === "string" && id.trim());
	const reviewerMissingLensIds = plannedLensIds.filter(
		(id) => !materializedReviewerIds.includes(id),
	);
	const reviewerUnexpectedIds = materializedReviewerIds.filter(
		(id) => plannedLensIds.length > 0 && !plannedLensIds.includes(id),
	);
	const reviewerDuplicateIds = materializedReviewerIds.filter(
		(id, index) => materializedReviewerIds.indexOf(id) !== index,
	);
	const attestedLensIds = asArray(reviewerLedger?.attestedLensIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const reviewerMissingAttestedLensIds = plannedLensIds.filter(
		(id) => !attestedLensIds.includes(id),
	);
	const reviewerUnexpectedAttestedIds = attestedLensIds.filter(
		(id) => !plannedLensIds.includes(id),
	);
	const reviewerCoverageReconciled =
		requiredLedgersPresent &&
		ledgerCompleteness &&
		Array.isArray(reviewerLedger.plannedLensIds) &&
		Array.isArray(reviewerLedger.materializedReviewerIds) &&
		Array.isArray(reviewerLedger.attestedLensIds) &&
		sameMultiset(plannedLensIds, materializedReviewerIds) &&
		sameMultiset(plannedLensIds, attestedLensIds) &&
		reviewerMissingLensIds.length === 0 &&
		reviewerUnexpectedIds.length === 0 &&
		reviewerDuplicateIds.length === 0 &&
		reviewerMissingAttestedLensIds.length === 0 &&
		reviewerUnexpectedAttestedIds.length === 0;
	const supportLedgerIds = asArray(dedupSummary?.supportFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const declaredDispositionIds = asArray(
		dedupSummary?.dispositionFindingIds,
	).filter((id) => typeof id === "string" && id.trim());
	const declaredLineageIds = asArray(dedupSummary?.lineageFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const actualSupportIds = supportIds.filter(Boolean);
	const behavioralRoots = [
		...asArray(ledger?.keep),
		...asArray(ledger?.weaken),
	].filter((finding) => {
		const classification = String(
			finding?.classification ?? finding?.supportClassification ?? "",
		)
			.trim()
			.toLowerCase();
		return (
			classification === "" ||
			classification === "behavioral" ||
			classification === "material"
		);
	});
	const behavioralRootIds = new Set(
		behavioralRoots.map(strictId).filter(Boolean),
	);
	const behavioralRootCauseIds = new Set(
		behavioralRoots
			.filter(
				(finding) =>
					typeof finding?.rootCauseId === "string" &&
					finding.rootCauseId.trim() &&
					((typeof finding.explicitRootCauseId === "string" &&
						finding.explicitRootCauseId.trim() === finding.rootCauseId.trim()) ||
						(!finding.explicitRootCauseId && finding.generatedRootCauseId !== true)),
			)
			.map((finding) => finding.rootCauseId.trim()),
	);
	const supportRelationIssues = supportNotes.filter((note) => {
		const supportingId =
			typeof note?.supportingFindingId === "string"
				? note.supportingFindingId.trim()
				: "";
		return (
			!supportingId ||
			(!behavioralRootIds.has(supportingId) &&
				!behavioralRootCauseIds.has(supportingId))
		);
	});
	const supportProvenanceIssues = supportNotes.filter((note) => {
		const owner = note?.reviewerIdentity;
		const ownerComplete =
			owner &&
			[
				owner.source,
				owner.specId,
				owner.taskId,
				owner.itemIdentity,
				owner.placeholderSpecId,
			].every((value) => typeof value === "string" && value.trim());
		const verifierOwner = note?.verifierOwner;
		const verifierOwnerComplete =
			verifierOwner &&
			[
				verifierOwner.source,
				verifierOwner.specId,
				verifierOwner.taskId,
				verifierOwner.itemIdentity,
				verifierOwner.placeholderSpecId,
			].every((value) => typeof value === "string" && value.trim());
		const verifierRowsForNote = verifierRows.filter(
			(row) => row.findingId === strictId(note),
		);
		const verifierBindingValid =
			verifierRowsForNote.length === 1 &&
			verifierOwnerComplete &&
			verifierRowsForNote[0].owner &&
			["source", "specId", "taskId", "itemIdentity", "placeholderSpecId"].every(
				(key) => verifierRowsForNote[0].owner[key] === verifierOwner[key],
			);
		const declaredMerged = asArray(note?.mergedFindings);
		const declaredMergedLineage = asArray(note?.mergedLineage);
		const mergedDeclarationsAgree =
			!Array.isArray(note?.mergedFindings) ||
			!Array.isArray(note?.mergedLineage) ||
			JSON.stringify(
				mergedLineageOf({ mergedFindings: declaredMerged }).map(strictId),
			) ===
				JSON.stringify(
					mergedLineageOf({ mergedFindings: declaredMergedLineage }).map(strictId),
				);
		const lineageComplete = mergedLineageOf(note).every((member) => {
			const memberOwner = member?.reviewerIdentity;
			return (
				strictId(member) &&
				typeof member?.originalFindingId === "string" &&
				member.originalFindingId.trim() &&
				typeof member?.rootCauseId === "string" &&
				member.rootCauseId.trim() &&
				typeof member?.source === "string" &&
				member.source.trim() &&
				Array.isArray(member?.sourceLineage) &&
				member.sourceLineage.length > 0 &&
				memberOwner &&
				[
					memberOwner.source,
					memberOwner.specId,
					memberOwner.taskId,
					memberOwner.itemIdentity,
					memberOwner.placeholderSpecId,
				].every((value) => typeof value === "string" && value.trim())
			);
		});
		return (
			!strictId(note) ||
			typeof note?.originalFindingId !== "string" ||
			!note.originalFindingId.trim() ||
			typeof note?.rootCauseId !== "string" ||
			!note.rootCauseId.trim() ||
			typeof note?.source !== "string" ||
			!note.source.trim() ||
			!Array.isArray(note?.sourceLineage) ||
			note.sourceLineage.length === 0 ||
			!ownerComplete ||
			!verifierOwnerComplete ||
			!verifierBindingValid ||
			!mergedDeclarationsAgree ||
			!lineageComplete
		);
	});
	const actualLineageIds = lineageIds.filter(Boolean);
	const provenanceOwnerIssues = [
		...topLevel.flatMap((finding) => [finding, ...mergedLineageOf(finding)]),
		...supportNotes.flatMap((note) => [note, ...mergedLineageOf(note)]),
	].filter((finding) => {
		const owner = finding?.reviewerIdentity;
		return (
			owner !== undefined &&
			(!owner ||
				![
					owner.source,
					owner.specId,
					owner.taskId,
					owner.itemIdentity,
					owner.placeholderSpecId,
				].every((value) => typeof value === "string" && value.trim()))
		);
	});
	const reviewerOwnerBySource = new Map(
		asArray(reviewerLedger?.ownerMap).map((owner) => [owner?.source, owner]),
	);
	const reviewerFindingOwnerIssues = [
		...topLevel.flatMap((finding) => [finding, ...mergedLineageOf(finding)]),
		...asArray(partition?.supportNotes).flatMap((note) => [
			note,
			...mergedLineageOf(note),
		]),
	].filter((finding) => {
		const id = strictId(finding);
		if (!id || !dedupIds.includes(id)) return false;
		const owner = finding?.reviewerIdentity;
		const expectedOwner = reviewerOwnerBySource.get(finding?.source);
		return (
			!owner ||
			!expectedOwner ||
			!sameMultiset(
				[
					owner.source,
					owner.specId,
					owner.taskId,
					owner.itemIdentity,
					owner.placeholderSpecId,
				],
				[
					expectedOwner.source,
					expectedOwner.specId,
					expectedOwner.taskId,
					expectedOwner.itemIdentity,
					expectedOwner.placeholderSpecId,
				],
			)
		);
	});
	// Raw reviewer rows are conserved by the final top-level rows plus every
	// recursive lineage member. Dedup IDs are a separate boundary: a merged
	// member already represented by the dedup ledger is not counted twice.
	const dedupLineageIds = actualLineageIds.filter((id) => dedupIds.includes(id));
	const idLedgerExact =
		requiredLedgersPresent &&
		sameMultiset(rawReviewerIds, [
			...topLevelIds.filter(Boolean),
			...actualSupportIds,
			...actualLineageIds,
		]) &&
		sameMultiset(dedupIds, [
			...declaredDispositionIds.filter((id) => dedupIds.includes(id)),
			...supportLedgerIds,
			...dedupLineageIds,
		]) &&
		sameMultiset(declaredDispositionIds, topLevelIds.filter(Boolean)) &&
		sameMultiset(supportLedgerIds, actualSupportIds) &&
		sameMultiset(declaredLineageIds, actualLineageIds) &&
		sameMultiset(
			reviewerLedger.dispositionFindingIds,
			topLevelIds.filter(Boolean),
		) &&
		sameMultiset(reviewerLedger.supportFindingIds, actualSupportIds) &&
		sameMultiset(reviewerLedger.lineageFindingIds, actualLineageIds) &&
		sameMultiset(reviewerLedger.provenanceOwnerFindingIds, [
			...topLevelIds.filter(Boolean),
			...actualSupportIds,
			...actualLineageIds,
		]) &&
		provenanceOwnerIssues.length === 0 &&
		supportRelationIssues.length === 0 &&
		supportProvenanceIssues.length === 0 &&
		reviewerOwnerMapIssues.length === 0 &&
		reviewerFindingOwnerIssues.length === 0;
	const reviewerDedupReconciled =
		requiredLedgersPresent &&
		idLedgerExact &&
		rawReviewerIdsMissing.length === 0 &&
			dedupIdsMissing.length === 0 &&
			!rawReviewerIdsMismatch &&
			!dedupIdsMismatch &&
			!rawCountMismatch &&
		!uniqueCountMismatch;
	const summary = partition?.partitionSummary;
	const expectedMerged = Number(summary?.mergedFindings);
	const mergedCountMismatch =
		!Number.isSafeInteger(expectedMerged) ||
		expectedMerged < 0 ||
		expectedMerged !== lineage.length;
	const expectedCounts = {
		keep: Number(summary?.keep),
		weaken: Number(summary?.weaken),
		drop: Number(summary?.drop),
		needsHuman: Number(summary?.needsHuman),
	};
	const actualCounts = {
		keep: asArray(ledger?.keep).length,
		weaken: asArray(ledger?.weaken).length,
		drop: asArray(ledger?.drop).length,
		needsHuman: asArray(ledger?.needsHuman).length,
	};
	const topLevelCountMismatch = Object.keys(expectedCounts).some(
		(key) =>
			!Number.isSafeInteger(expectedCounts[key]) ||
			expectedCounts[key] < 0 ||
			expectedCounts[key] !== actualCounts[key],
	);
	return {
		topLevelIds,
		supportIds,
		lineageIds,
		uniqueIds,
		duplicateIds: [...new Set(duplicateIds)],
		mergedCount: lineage.length,
		expectedMerged,
		mergedCountMismatch,
		topLevelCountMismatch,
		rawReviewerIds,
		dedupIds,
		rawReviewerIdsMissing,
		dedupIdsMissing,
		rawReviewerIdsMismatch,
		dedupIdsMismatch,
		rawCountMismatch,
		uniqueCountMismatch,
		duplicateCountMismatch,
		duplicateLedgerReconciled,
		duplicateLedgerPairsMismatch,
		duplicateLedgerIssues,
		rawDuplicateIdsMissing,
		rawDuplicateLineageIssues,
		independentlyDispositionedRawDuplicates,
		duplicateLedgerRawIdsMismatch,
		verdictsReceivedMismatch,
		partitionVerdictsReceived,
		verifierVerdictsReceived,
		reviewerCoverageReconciled,
		reviewerMissingLensIds,
		reviewerUnexpectedIds,
		reviewerDuplicateIds,
		reviewerDedupReconciled,
		verifierCoverageExact,
		verifierDigestMatches,
		expectedVerifierIds,
		verifierDeclaredRowsMismatch,
		verifierStatusIssues,
		reviewerOwnerMapIssues,
		verifierOwnerIssues: verifierOwnershipIssues,
		verifierRowIds,
		verifierMissingIds,
		verifierOrphanIds,
		verifierDuplicateIds,
		verifierOwnershipIssues,
		verifierExpectedMismatch,
		ledgerCompleteness,
		requiredLedgersPresent,
		idLedgerExact,
		provenanceOwnerIssues,
		supportRelationIssues,
		supportProvenanceIssues,
		reviewerFindingOwnerIssues,
		reviewerMissingAttestedLensIds,
		reviewerUnexpectedAttestedIds,
		reviewerFindingOwnerIssues,
	};
}

function markdownFenceInfo(quote) {
	if (
		/^\s*(const|let|var|function|export|import|await|return|if|for|while)\b/.test(
			quote,
		)
	)
		return "ts";
	if (/^\s*(FROM|ENV|RUN|CMD|COPY|WORKDIR|EXPOSE)\b/i.test(quote))
		return "dockerfile";
	if (/^\s*[{}[]/.test(quote)) return "json";
	return "text";
}

function renderLocationsTable(locations, t) {
	if (locations.length === 0) return [t("Locations: _not provided_", "위치: _자료 없음_"), ""];
	return [
		t("Locations:", "위치:"),
		"",
		t("| File | Line | Symbol |", "| 파일 | 줄 | 심볼 |"),
		"|---|---:|---|",
		...locations.map((location) => {
			const line =
				location.line === undefined
					? "—"
					: location.lineEnd !== undefined && location.lineEnd !== location.line
						? `${location.line}-${location.lineEnd}`
						: `${location.line}`;
			return `| ${inlineCode(location.file, { table: true })} | ${escapeTableCell(line)} | ${location.symbol ? inlineCode(location.symbol, { table: true }) : "—"} |`;
		}),
		"",
	];
}

function renderEvidenceQuotes(quotes, label = "Evidence") {
	if (quotes.length === 0) return [];
	const out = [`${label}:`, ""];
	for (const quote of quotes) {
		const info = markdownFenceInfo(quote);
		const runs = String(quote).match(/`+/g) ?? [];
		const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
		out.push(`${fence}${info}`);
		out.push(quote);
		out.push(fence, "");
	}
	return out;
}

function renderMergedProvenance(finding, t) {
	const lineage = mergedLineageOf(finding);
	if (lineage.length === 0) return [];
	const out = [t("Merged provenance:", "병합 출처:"), ""];
	for (const [index, member] of lineage.entries()) {
		const id = findingIdOf(member, index);
		const title = titleOf(member);
		const verdict = cleanText(
			member.originalVerdict ?? member.verdict ?? "unknown",
		);
		const severity = severityOf(member);
		out.push(
			`- ${inlineCode(id)} — ${escapeMarkdownText(readerDiagnostic(title, t))} (${t("original verdict", "원래 판정")}: **${escapeMarkdownText(reportStatus(verdict, t))}**, ${t("original severity", "원래 심각도")}: **${escapeMarkdownText(reportStatus(member.originalSeverity ?? severity, t))}**)`,
		);
		out.push(`  ${exactField(t("Finding ID", "발견 ID"), id)}`);
		out.push(`  ${exactField(t("Original finding ID", "원래 발견 ID"), member.originalFindingId)}`);
		out.push(`  ${exactField(t("Root cause ID", "근본 원인 ID"), member.rootCauseId)}`);
		if (member.reviewerIdentity) {
			out.push(`  ${t("Reviewer source", "검토자 출처")}: ${inlineCode(member.reviewerIdentity.source)}`);
			out.push(`  ${t("Reviewer task", "검토자 작업")}: ${inlineCode(member.reviewerIdentity.taskId)}`);
		}
		if (member.source || asArray(member.sourceLineage).length > 0) {
			const lineageSources = asArray(member.sourceLineage).filter(
				(value) => typeof value === "string",
			);
			out.push(`  ${t("Source", "출처")}: ${inlineCode(member.source ?? "")}`);
			out.push(
				`  ${t("Source lineage", "출처 이력")}: ${lineageSources.map((value) => inlineCode(value)).join(", ")}`,
			);
		}
		for (const location of locationsOf(member)) {
			const line =
				location.line === undefined
					? "—"
					: location.lineEnd !== undefined && location.lineEnd !== location.line
						? `${location.line}-${location.lineEnd}`
						: `${location.line}`;
			out.push(
				`  ${t("Location", "위치")}: ${inlineCode(location.file)}:${escapeTableCell(line)}`,
			);
		}
		for (const quote of evidenceQuotesOf(member)) {
			const info = markdownFenceInfo(quote);
			const runs = String(quote).match(/`+/g) ?? [];
			const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
			out.push(
				`  ${t("Evidence", "근거")} (${info}):`,
				`  ${fence}${info}`,
				`  ${String(quote).replace(/\n/g, "\n  ")}`,
				`  ${fence}`,
			);
		}
		const action = cleanText(member.recommendedAction);
		if (action) out.push(`  ${t("Action", "조치")}: ${escapeMarkdownText(action)}`);
		for (const counter of asArray(member.counterEvidence)) {
			const text = cleanText(
				typeof counter === "string" ? counter : JSON.stringify(counter),
			);
			if (text) out.push(`  ${t("Counter-evidence", "반증")}: ${escapeMarkdownText(text)}`);
		}
	}
	out.push("");
	return out;
}

function renderCounterEvidence(finding, t) {
	const counter = asArray(finding?.counterEvidence)
		.map((item) =>
			typeof item === "string"
				? item
				: (item?.evidence ?? item?.reason ?? item?.note ?? JSON.stringify(item)),
		)
		.map((item) => escapeHeadingText(item))
		.filter(Boolean);
	if (counter.length === 0 && !finding?.note) return [];
	return [
		t("Caveat / counter-evidence:", "주의 사항과 반증:"),
		"",
		...(finding?.note ? [`- ${escapeHeadingText(readerDiagnostic(finding.note, t))}`] : []),
		...counter.map((item) => `- ${item}`),
		"",
	];
}

function normalizeFinding(finding, index, verdict) {
	return {
		...finding,
		findingId: findingIdOf(finding, index),
		rootCauseId: rootCauseIdOf(finding),
		title: titleOf(finding),
		severity: severityOf(finding),
		verdict,
	};
}

function partitionFindings(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const keep = asArray(ledger?.keep).map((finding, index) =>
		normalizeFinding(finding, index, "KEEP"),
	);
	const weaken = asArray(ledger?.weaken).map((finding, index) =>
		normalizeFinding(finding, keep.length + index, "WEAKEN"),
	);
	return { keep, weaken, all: [...keep, ...weaken] };
}

function expectedFindingCount(partition, allFindings) {
	const summary = partition?.partitionSummary;
	const keep = Number(summary?.keep);
	const weaken = Number(summary?.weaken);
	if (Number.isFinite(keep) || Number.isFinite(weaken)) {
		return (
			(Number.isFinite(keep) ? keep : 0) + (Number.isFinite(weaken) ? weaken : 0)
		);
	}
	return allFindings.length;
}

function severityCounts(findings) {
	const counts = {};
	for (const finding of findings) {
		const severity = severityOf(finding);
		counts[severity] = (counts[severity] ?? 0) + 1;
	}
	return counts;
}

function renderFindingCard(finding, t, actionInList = true) {
	const verifierQuotes = verifierEvidenceQuotesOf(finding);
	const reason = cleanText(finding.evidenceUnavailableReason);
	const rationale = finding.readerRationale ?? finding.rationale;
	const sources = [finding.source, ...asArray(finding.sourceLineage)].filter((value) => cleanText(value));
	const action = finding.recommendedAction ?? finding.concreteFix;
	const body = [
		...(finding.rootCauseId ? [`${t("Root cause", "근본 원인")}: ${inlineCode(finding.rootCauseId)}`, ""] : []),
		...(finding.verdict === "NEEDS_HUMAN" && finding.needsHumanCause ? [
			`${t("Needs-human cause", "사람 검토가 필요한 이유")}: ${needsHumanCauseCode(cleanText(finding.needsHumanCause))} — ${needsHumanCauseLabel(cleanText(finding.needsHumanCause), t)}`, "",
		] : []),
		...renderLocationsTable(locationsOf(finding), t),
		...(sources.length ? [`${t("Sources", "출처")}: ${[...new Set(sources)].map((value) => escapeMarkdownText(value)).join(" · ")}`, ""] : []),
		...renderEvidenceQuotes(reviewerEvidenceQuotesOf(finding), t("Reviewer/source evidence", "검토자 근거")),
		...renderEvidenceQuotes(verifierQuotes, t("Verifier evidence", "검증자 근거")),
		...(finding.verdict === "NEEDS_HUMAN" && !verifierQuotes.length ? [t("Verifier evidence: unavailable.", "검증자 근거: 자료 없음."), ""] : []),
		...(reason ? [`${t("Reason", "이유")}: ${escapeMarkdownText(reason)}`, ""] : []),
		...(rationale ? [t("Rationale:", "판단 이유:"), "", escapeMarkdownText(rationale), ""] : []),
		...(!actionInList && action ? [t("Recorded action:", "기록된 조치:"), "", escapeMarkdownText(action), ""] : []),
		...renderMergedProvenance(finding, t),
		...renderCounterEvidence(finding, t),
	];
	return [
		`### ${escapeHeadingText(finding.findingId)} — ${escapeHeadingText(readerDiagnostic(readerTitleOf(finding), t))}`, "",
		`${t("Severity", "심각도")}: **${escapeMarkdownText(reportStatus(finding.severity, t))}**  `,
		`${t("Verifier verdict", "검증 판정")}: **${escapeMarkdownText(reportStatus(finding.verdict, t))}**`, "",
		...fold(t("Evidence", "근거 보기"), body), "",
	];
}

function renderFindings(findings, t) {
	return {
		lines: reportSection(2, t("Findings", "발견 사항"), findings.flatMap((finding) => renderFindingCard(finding, t))),
		representedIds: findings.map((finding) => finding.findingId),
	};
}

function renderDropped(partition, t) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const items = asArray(ledger?.drop);
	if (items.length === 0) return { lines: [], representedIds: [] };
	const out = [`### ${t("Dropped findings", "제외한 발견 사항")}`, ""];
	const representedIds = [];
	for (const [index, raw] of items.entries()) {
		const finding = normalizeFinding(raw, index, "DROP");
		representedIds.push(finding.findingId);
		out.push(...renderFindingCard(finding, t, false));
	}
	out.push("");
	return { lines: out, representedIds };
}

const NEEDS_HUMAN_CAUSE_LABELS = {
	verifier_missing: "verifier never returned a verdict (not reviewed)",
	verifier_output_invalid: "verifier output malformed or duplicated (not reviewed)",
	verifier_evidence_ungrounded: "verifier evidence not grounded in the source",
	source_coverage_incomplete: "originating reviewer did not complete source coverage",
	batch_evidence_demoted: "batched verdict demoted for weak evidence",
	evidence_insufficient: "verdict lacked required evidence",
	coverage_gap: "planned review coverage is missing",
	support_unassociated: "support-only finding with no proven root",
	verifier_needs_human: "verifier judged it ambiguous",
};

function needsHumanCauseCode(cause) {
	return /^[a-z_]+$/u.test(cause) ? `\`${cause}\`` : inlineCode(cause);
}

function needsHumanCauseLabel(cause, t) {
	const ko = {
		verifier_missing: "검증 판정이 돌아오지 않음", verifier_output_invalid: "검증 결과의 형식 오류 또는 중복",
		verifier_evidence_ungrounded: "검증 근거가 출처에서 확인되지 않음", source_coverage_incomplete: "검토자가 필수 자료를 다 확인하지 못함",
		batch_evidence_demoted: "일괄 판정의 근거 부족", evidence_insufficient: "판정에 필요한 근거 부족",
		coverage_gap: "계획한 검토 범위 누락", support_unassociated: "연결된 근본 원인을 확인하지 못함",
		verifier_needs_human: "검증자가 모호하다고 판단함",
	};
	return Object.hasOwn(ko, cause) ? t(NEEDS_HUMAN_CAUSE_LABELS[cause], ko[cause]) : t("cause not recorded", "이유가 기록되지 않음");
}

function renderNeedsHumanBreakdown(items, t) {
	const counts = new Map();
	for (const item of items) {
		const cause = cleanText(item?.needsHumanCause) || "unspecified";
		counts.set(cause, (counts.get(cause) ?? 0) + 1);
	}
	if (counts.size === 0 || (counts.size === 1 && counts.has("unspecified"))) {
		return [];
	}
	return [
		t("Causes:", "원인별 집계:"),
		"",
		...[...counts].map(
			([cause, count]) =>
				`- ${count} × ${needsHumanCauseCode(cause)} — ${needsHumanCauseLabel(cause, t)}`,
		),
		"",
	];
}

function renderNeedsHuman(partition, t) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const items = asArray(ledger?.needsHuman);
	if (items.length === 0) return { lines: [], representedIds: [] };
	const out = [`## ${t("Needs human review", "사람 검토 필요")}`, ""];
	const representedIds = [];
	for (const [index, raw] of items.entries()) {
		const finding = normalizeFinding(raw, index, "NEEDS_HUMAN");
		representedIds.push(finding.findingId);
		out.push(...renderFindingCard(finding, t));
	}
	return { lines: out, representedIds };
}

function needsHumanCounts(partition) {
	const partitionsPresent = Boolean(
		partition?.partitions &&
			typeof partition.partitions === "object" &&
			Array.isArray(partition.partitions.needsHuman),
	);
	const ledger = partition?.partitions ?? partition?.reportContext;
	const actual = asArray(ledger?.needsHuman).length;
	const summary = partition?.partitionSummary;
	const summaryCountPresent = Boolean(
		summary &&
			typeof summary === "object" &&
			Object.hasOwn(summary, "needsHuman") &&
			Number.isFinite(Number(summary.needsHuman)),
	);
	return {
		actual,
		expected: summaryCountPresent ? Number(summary.needsHuman) : actual,
		metadataMissing: !partitionsPresent || !summaryCountPresent,
		incompleteEvidence: asArray(ledger?.needsHuman).filter(
			(finding) =>
				locationsOf(finding).length === 0 ||
				reviewerEvidenceQuotesOf(finding).length === 0 ||
				verifierEvidenceQuotesOf(finding).length === 0,
		).length,
		verifierEvidenceIncomplete: asArray(ledger?.needsHuman).filter(
			(finding) => verifierEvidenceQuotesOf(finding).length === 0,
		).length,
		verifierEvidenceUnavailable: asArray(ledger?.needsHuman).filter(
			(finding) =>
			verifierEvidenceQuotesOf(finding).length === 0 &&
			Boolean(cleanText(finding?.evidenceUnavailableReason)),
		).length,
	};
}

function exactField(label, value) {
	const text = String(value ?? "");
	return `${label}: ${inlineCode(text)}`;
}

function renderReviewerOwner(owner, t) {
	if (!owner || typeof owner !== "object")
		return [t("Reviewer owner: _not provided_", "검토 담당: _자료 없음_"), ""];
	return [
		t("Reviewer owner:", "검토 담당:"),
		"",
		exactField(t("- source", "- 출처"), owner.source),
		exactField("- specId", owner.specId),
		exactField("- taskId", owner.taskId),
		exactField("- itemIdentity", owner.itemIdentity),
		exactField("- placeholderSpecId", owner.placeholderSpecId),
		"",
	];
}

function renderSupportProvenance(note, t) {
	const sourceLineage = asArray(note?.sourceLineage).filter(
		(value) => typeof value === "string",
	);
	return [
		t("Support provenance:", "보조 관찰 출처:"),
		"",
		exactField(t("Finding ID", "발견 ID"), note?.findingId),
		exactField(t("Original finding ID", "원래 발견 ID"), note?.originalFindingId),
		exactField(t("Root cause ID", "근본 원인 ID"), note?.rootCauseId),
		...renderReviewerOwner(note?.reviewerIdentity, t),
		...(note?.verifierOwner
			? [t("Verifier owner:", "검증 담당:"), ...renderReviewerOwner(note.verifierOwner, t)]
			: []),
		exactField(t("Source", "출처"), note?.source),
		`${t("Source lineage", "출처 이력")}: ${sourceLineage.length > 0 ? sourceLineage.map((value) => inlineCode(value)).join(", ") : t("_not provided_", "_자료 없음_")}`,
		exactField(t("Supporting finding ID", "보조 발견 ID"), note?.supportingFindingId),
		`${t("Merged lineage", "병합 이력")}: ${
			mergedLineageOf(note).length > 0
				? mergedLineageOf(note)
						.map((member, index) => inlineCode(findingIdOf(member, index)))
						.join(", ")
				: t("_none_", "_없음_")
		}`,
		"",
	];
}

function supportEmissionRow(note, index) {
	const id = findingIdOf(note, index);
	return {
		kind: "support",
		id,
		findingId: id,
		originalFindingId: String(note?.originalFindingId ?? ""),
		rootCauseId: String(note?.rootCauseId ?? ""),
		source: String(note?.source ?? ""),
		sourceLineage: asArray(note?.sourceLineage).map(String),
		reviewerIdentity:
			note?.reviewerIdentity && typeof note.reviewerIdentity === "object"
				? { ...note.reviewerIdentity }
				: null,
		verifierOwner:
			note?.verifierOwner && typeof note.verifierOwner === "object"
				? { ...note.verifierOwner }
				: null,
		supportingFindingId: String(note?.supportingFindingId ?? ""),
		mergedLineage: mergedLineageOf(note).map((member, memberIndex) => ({
			findingId: findingIdOf(member, memberIndex),
			originalFindingId: String(member?.originalFindingId ?? ""),
			rootCauseId: String(member?.rootCauseId ?? ""),
			source: String(member?.source ?? ""),
			sourceLineage: asArray(member?.sourceLineage).map(String),
			reviewerIdentity:
				member?.reviewerIdentity && typeof member.reviewerIdentity === "object"
					? { ...member.reviewerIdentity }
					: null,
			verifierOwner:
				member?.verifierOwner && typeof member.verifierOwner === "object"
					? { ...member.verifierOwner }
					: null,
		})),
	};
}

function renderSupportNotes(partition, t) {
	const notes = asArray(partition?.supportNotes);
	if (notes.length === 0) return { lines: [], representedRows: 0 };
	const out = [`### ${t("Supporting observations", "보조 관찰")}`, ""];
	let representedRows = 0;
	for (const note of notes) {
		representedRows += 1;
		const noteId = findingIdOf(note, 0);
		out.push(
			`### ${noteId ? `${inlineCode(noteId)} — ` : ""}${escapeMarkdownText(readerDiagnostic(readerTitleOf(note), t))}`,
			"",
			`${t("Severity", "심각도")}: **${escapeMarkdownText(reportStatus(severityOf(note), t))}**  `,
		);
		const reason = cleanText(note?.reason);
		if (reason) out.push(`${t("Reason", "이유")}: ${escapeMarkdownText(readerDiagnostic(reason, t))}  `);
		const rationale = escapeMarkdownText(
			note?.readerRationale ?? note?.rationale ?? "",
		);
		if (rationale) out.push(t("Rationale:", "판단 이유:"), "", rationale, "");
		const related = cleanText(note?.supportingFindingOf);
		if (related) out.push(`${t("Supports", "관련 발견")}: ${escapeMarkdownText(related)}  `);
		out.push(
			"",
			...renderSupportProvenance(note, t),
			...renderLocationsTable(locationsOf(note), t),
			...renderEvidenceQuotes(evidenceQuotesOf(note), t("Evidence", "근거")),
			...renderMergedProvenance(note, t),
		);
	}
	return { lines: out, representedRows };
}
function structuredEmissionRows(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const rows = [];
	for (const [kind, findings] of [
		["top-level", asArray(ledger?.keep)],
		["top-level", asArray(ledger?.weaken)],
		["top-level", asArray(ledger?.drop)],
		["top-level", asArray(ledger?.needsHuman)],
	]) {
		for (const [index, finding] of findings.entries()) {
			const id = findingIdOf(finding, index);
			if (id) rows.push({ kind, id });
			for (const member of mergedLineageOf(finding)) {
				const lineageId = findingIdOf(member, index);
				if (lineageId) rows.push({ kind: "lineage", id: lineageId });
			}
		}
	}
	for (const [index, note] of asArray(partition?.supportNotes).entries()) {
		const id = findingIdOf(note, index);
		if (id) rows.push(supportEmissionRow(note, index));
		for (const member of mergedLineageOf(note)) {
			const lineageId = findingIdOf(member, index);
			if (lineageId) rows.push({ kind: "lineage", id: lineageId });
		}
	}
	return rows;
}

function sameEmissionRows(expected, emitted) {
	// IDs are the identity key for ordinary rows, but support rows also carry
	// authoritative provenance. Compare the complete canonical row so a support
	// ID cannot survive while its owner/source/target silently drifts.
	const key = (row) => JSON.stringify(canonicalJsonValue(row));
	return sameMultiset(expected.map(key), emitted.map(key));
}

function supportNoteCounts(partition) {
	const notesPresent = Array.isArray(partition?.supportNotes);
	const notes = asArray(partition?.supportNotes);
	const summary = partition?.partitionSummary;
	const summaryCountPresent = Boolean(
		summary &&
			typeof summary === "object" &&
			Object.hasOwn(summary, "supportNotes") &&
			Number.isFinite(Number(summary.supportNotes)),
	);
	const declared = summaryCountPresent
		? Number(summary.supportNotes)
		: notes.length;
	return {
		actual: notes.length,
		expected: declared,
		metadataMissing: !notesPresent || !summaryCountPresent,
		incompleteEvidence: notes.filter(
			(note) =>
				locationsOf(note).length === 0 || evidenceQuotesOf(note).length === 0,
		).length,
	};
}

function renderRisks(report, partition, t) {
	const risks = asArray(report?.risks).map((risk) =>
		typeof risk === "string"
			? risk
			: (risk?.risk ?? risk?.note ?? risk?.summary ?? JSON.stringify(risk)),
	);
	// The same failed source is carried by both summaries; list it once.
	const seenFailures = new Set();
	const partialFailures = [
		...asArray(partition?.sourceStatusSummary?.partialFailures),
		...asArray(partition?.reportContext?.partialFailures),
	].filter((failure) => {
		const key = `${failure?.specId ?? ""}|${failure?.taskId ?? ""}|${failure?.source ?? ""}|${failure?.status ?? ""}|${failure?.displayName ?? ""}`;
		if (seenFailures.has(key)) return false;
		seenFailures.add(key);
		return true;
	});
	const notes = asArray(partition?.normalizationNotes).map((note) =>
		typeof note === "string" ? note : JSON.stringify(note),
	);
	if (risks.length === 0 && partialFailures.length === 0 && notes.length === 0)
		return [];
	const out = [];
	for (const risk of risks) out.push(`- ${escapeMarkdownText(risk)}`);
	for (const failure of partialFailures) {
		out.push(
			`- ${t("Partial source", "불완전한 출처")}: ${escapeMarkdownText(failure.displayName ?? failure.specId ?? failure.source ?? JSON.stringify(failure))} (${escapeMarkdownText(reportStatus(failure.status ?? "unknown", t))})`,
		);
	}
	for (const note of notes)
		out.push(`- ${t("Normalization note", "정규화 메모")}: ${escapeMarkdownText(readerDiagnostic(note, t))}`);
	out.push("");
	return out;
}

function hasReportSynthesis(report) {
	return Boolean(
		report &&
			typeof report === "object" &&
			cleanText(report.summary) &&
			REPORT_VERDICTS.has(cleanText(report.verdict)),
	);
}


function sourceCoverageGaps(partition) {
	const rows = [
		...asArray(partition?.sourceStatusSummary?.partialFailures),
		...asArray(partition?.reportContext?.partialFailures),
	].filter(
		(row) =>
			row?.status === "source_coverage_incomplete" ||
			row?.errorType === "source_coverage",
	);
	const seen = new Set();
	return rows.filter((row) => {
		const key = `${row.source ?? row.specId ?? ""}|${row.sourcePath ?? ""}|${row.coverageStatus ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function renderSourceCoverageGaps(partition, t) {
	const gaps = sourceCoverageGaps(partition);
	if (gaps.length === 0) return [];
	const lines = [
		`### ${t("Required source coverage gaps", "누락된 필수 출처")}`,
		"",
		t("| Reviewer source | Required source | Status | Extraction artifact | Detail |", "| 검토자 출처 | 필수 출처 | 상태 | 추출 자료 | 상세 |"),
		"|---|---|---|---|---|",
	];
	for (const gap of gaps) {
		lines.push(
			`| ${escapeTableCell(gap.displayName ?? gap.specId ?? gap.source ?? "unknown")} | ${escapeTableCell(gap.sourcePath ?? "unknown")} | ${escapeTableCell(reportStatus(gap.coverageStatus ?? gap.status ?? "unknown", t))} | ${escapeTableCell(gap.extractionArtifact ?? "—")} | ${escapeTableCell(readerCoverageDetail(gap.statusDetail, t) ?? t("Required source content was not read.", "필수 출처에 있는 내용을 읽지 못했습니다."))} |`,
		);
	}
	lines.push("");
	return lines;
}


function deterministicSummary(partition, findings, t) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const needsHuman = asArray(ledger?.needsHuman).length;
	if (hasPartialFailures(partition)) {
		return t(`Review coverage is partial. The deterministic ledger contains ${findings.length} kept or weakened findings and ${needsHuman} needs-human items.`, `검토 범위가 일부에 그쳤습니다. 원장에 유지·완화된 발견 사항 ${findings.length}건과 사람 검토 항목 ${needsHuman}건이 있습니다.`);
	}
	if (findings.length > 0 || needsHuman > 0) {
		return t(`The deterministic ledger contains ${findings.length} kept or weakened findings and ${needsHuman} needs-human items.`, `원장에 유지·완화된 발견 사항 ${findings.length}건과 사람 검토 항목 ${needsHuman}건이 있습니다.`);
	}
	return t("The deterministic ledger contains no kept, weakened, or needs-human findings.", "원장에 유지·완화되었거나 사람 검토가 필요한 발견 사항이 없습니다.");
}

function deterministicNextAction(verdict) {
	if (verdict === "PARTIAL_REVIEW")
		return "Complete failed or missing review work, then rerun the review before release.";
	if (verdict === "NEEDS_WORK")
		return "Address kept or weakened findings and resolve needs-human items before release.";
	return "No reportable remediation remains in the deterministic review ledger.";
}

function completionLimitations({
	_reportAvailable,
	reportVerdictConsistent,
	narrativeVerdict,
	effectiveVerdict,
	t = (en) => en,
	rendererIntegrityFailed,
	partition,
	findingCountMismatch,
	needsHumanCountMismatch,
	needsHumanMetadataMissing,
	needsHumanEvidenceIncomplete,
	supportNoteCountMismatch,
	supportNoteMetadataMissing,
	supportNoteEvidenceIncomplete,
}) {
	const limitations = [
		t("Evidence and quotes are bound to the reviewed snapshot available to the partition stage; final rendering does not re-read repository files and therefore does not attest current-tree bytes.", "근거와 인용은 검토 당시의 스냅샷을 기준으로 합니다. 보고서를 만들 때 현재 파일을 다시 확인하지 않았습니다."),
	];
	if (rendererIntegrityFailed)
		limitations.push(
			t("Renderer integrity checks failed, so counts, provenance, or canonical ledgers must be repaired before relying on the conclusion.", "보고서 무결성 검사에 실패했습니다. 결론을 사용하기 전에 건수, 출처 또는 원장을 확인하세요."),
		);
	if (hasPartialFailures(partition))
		limitations.push(
			t("Review coverage is partial because a task did not complete or required source content was unavailable.", "일부 작업이 끝나지 않았거나 필요한 자료를 읽지 못했습니다."),
		);
	const synthesisAvailable = Boolean(_reportAvailable);
	if (!synthesisAvailable)
		limitations.push(
			t("Executive synthesis was unavailable, so no complete review conclusion can be claimed.", "종합 의견이 없어 검토가 완전하다고 볼 수 없습니다."),
		);
	else if (!reportVerdictConsistent)
		limitations.push(
			t(`The executive synthesis gave verdict ${cleanText(narrativeVerdict) || "none"}, which the deterministic ledger does not support; the report uses ${cleanText(effectiveVerdict)}.`, `종합 의견의 판정(${reportStatus(narrativeVerdict || "none", t)})을 원장에서 뒷받침하지 않습니다. 보고서 판정은 ${reportStatus(effectiveVerdict, t)}입니다.`),
		);
	if (findingCountMismatch)
		limitations.push(
			t("The declared finding count does not match the available finding rows.", "기록된 발견 건수가 실제 항목 수와 일치하지 않습니다."),
		);
	if (needsHumanMetadataMissing || needsHumanCountMismatch)
		limitations.push(
			t("Needs-human metadata or row counts are incomplete or inconsistent.", "사람 검토 항목의 상세 정보나 건수가 누락되었거나 일치하지 않습니다."),
		);
	if (needsHumanEvidenceIncomplete)
		limitations.push(
			t("At least one needs-human row lacks verifier evidence; any reviewer/source quote shown for it is not verifier evidence.", "일부 사람 검토 항목에 검증자 근거가 없습니다. 검토자가 제시한 인용은 검증자 근거가 아닙니다."),
		);
	if (supportNoteMetadataMissing || supportNoteCountMismatch)
		limitations.push(
			t("Supporting-observation metadata or row counts are incomplete or inconsistent.", "보조 관찰의 상세 정보나 건수가 누락되었거나 일치하지 않습니다."),
		);
	if (supportNoteEvidenceIncomplete)
		limitations.push(
			t("At least one supporting observation lacks complete location or quote evidence.", "일부 보조 관찰에 위치 또는 인용 근거가 없습니다."),
		);
	return [...new Set(limitations)];
}

function renderCompletionSummary({
	effectiveVerdict,
	partition,
	findings,
	limitations,
	t,
}) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const needsHuman = asArray(ledger?.needsHuman);
	const supportNotes = asArray(partition?.supportNotes);
	const keyRows = [
		...findings.map((finding) => ({
			label: finding.verdict,
			severity: finding.severity,
			title: readerTitleOf(finding),
		})),
		...needsHuman.map((finding) => ({
			label: "NEEDS_HUMAN",
			severity: severityOf(finding),
			title: readerTitleOf(finding),
		})),
	].slice(0, 6);
	const out = [
		`## ${t("Core conclusion", "핵심 결론")}`,
		"",
		`${t("Verdict", "판정")}: **${cleanText(effectiveVerdict)}**. ${completionText(deterministicSummary(partition, findings, t), t)}`,
		"",
		`## ${t("Key findings", "주요 발견 사항")}`,
		"",
	];
	if (keyRows.length === 0) {
		out.push(`- ${t("No kept, weakened, or needs-human findings were present.", "유지, 완화 또는 사람 검토가 필요한 발견 사항이 없습니다.")}`);
	} else {
		for (const row of keyRows) {
			out.push(
				`- **${escapeCompletionText(row.severity)} / ${escapeCompletionText(row.label)}:** ${completionText(readerDiagnostic(row.title, t), t)}`,
			);
		}
		const omitted = findings.length + needsHuman.length - keyRows.length;
		if (omitted > 0)
			out.push(
				`- ${t(`${omitted} additional finding row(s) are included in the full report.`, `나머지 발견 사항 ${omitted}건은 전체 보고서에 있습니다.`)}`,
			);
	}
	out.push(
		"",
		`## ${t("Evidence level", "근거 수준")}`,
		"",
		`- ${t(`Canonical rows: ${findings.length} kept or weakened findings, ${needsHuman.length} needs-human items, and ${supportNotes.length} supporting observations.`, `원장 집계: 유지·완화 ${findings.length}건, 사람 검토 ${needsHuman.length}건, 보조 관찰 ${supportNotes.length}건.`)}`,
		`- ${t(`Coverage: ${hasPartialFailures(partition) ? "partial" : "complete according to source-status accounting"}.`, `검토 범위: ${hasPartialFailures(partition) ? "일부" : "출처 상태 집계 기준 완료"}.`)}`,
		"",
		`## ${t("Important limitations", "중요한 한계")}`,
		"",
	);
	if (limitations.length === 0) {
		out.push(
			`- ${t("No incomplete source coverage or renderer integrity limitation was recorded.", "불완전한 출처 범위나 보고서 무결성 한계가 기록되지 않았습니다.")}`,
		);
	} else {
		for (const limitation of limitations.slice(0, 8)) {
			out.push(`- ${completionText(limitation, t)}`);
		}
		if (limitations.length > 8)
			out.push(
				`- ${t(`${limitations.length - 8} additional limitation(s) are detailed in the full report.`, `나머지 한계 ${limitations.length - 8}건은 전체 보고서에 있습니다.`)}`,
			);
	}
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * agent-workflow 2026-11-01: evidence the pipeline matched with a correction (finding-pipeline
 * `evidenceCorrections`): cited lines off by at most ten, a planned range ending past the file, or
 * whitespace / quote and dash characters. The stored evidence is the reviewed file's own text.
 */
function renderEvidenceCorrections(partition, t) {
	const corrections = asArray(partition?.evidenceCorrections).filter(
		(correction) => correction && typeof correction === "object",
	);
	if (corrections.length === 0) return [];
	const why = (correction) => {
		if (correction.kind === "planned-range-end")
			return t(`the planned range ends past the file (${correction.fileLines} lines)`, `계획 범위가 파일 끝(${correction.fileLines}줄)을 넘음`);
		if (correction.kind === "blank-planned-range")
			return t("the planned lines are blank, so there was nothing to quote", "계획한 줄이 비어 있어 인용할 내용이 없음");
		if (correction.reason === "whitespace")
			return t("matches the file except whitespace or quote/dash characters; the file's text is stored", "공백 또는 인용 부호·대시를 빼면 일치해 파일 원문을 보존함");
		return correction.kind === "coverage-quote"
			? t("the quote is a few lines outside the planned range", "인용이 계획 범위와 몇 줄 차이 남")
			: t("the quote occurs once in the file, at these lines", "파일에서 이 줄에만 인용이 있음");
	};
	const lines = [
		`### ${t("Evidence corrections", "근거 위치 보정")}`,
		"",
		t("Evidence that differed from the reviewed file only in cited lines or whitespace was matched against the file; the stored evidence is the file's own text.", "인용 위치나 공백만 다른 근거는 검토한 파일과 대조했습니다. 보존된 근거는 파일의 원문입니다."),
		"",
		t("| Stage | File | Lines given | Lines checked | Why |", "| 단계 | 파일 | 제시한 줄 | 확인한 줄 | 이유 |"),
		"|---|---|---|---|---|",
	];
	for (const correction of corrections) {
		const pointer = /^(.*):(\d+(?:-\d+)?)$/u.exec(String(correction.path ?? ""));
		const isPlan =
			correction.kind === "planned-range-end" ||
			correction.kind === "coverage-quote" ||
			correction.kind === "blank-planned-range";
		const stage = isPlan
			? t(`${correction.kind === "coverage-quote" ? "reviewer" : "triage plan"} for ${correction.lens || correction.source || "unknown"}`, `${correction.lens || correction.source || "알 수 없는 관점"} ${correction.kind === "coverage-quote" ? "검토자" : "검토 계획"}`)
			: `${t("Verifier", "검증자")}: ${correction.findingId || correction.source || "unknown"}`;
		const file = isPlan ? (pointer?.[1] ?? correction.path ?? "unknown") : (correction.file ?? "unknown");
		const given = isPlan ? (pointer?.[2] ?? t("whole file", "파일 전체")) : (correction.cited ?? "");
		const checked =
			correction.kind === "planned-range-end"
				? correction.checked
				: correction.kind === "blank-planned-range"
					? "—"
					: correction.actual;
		lines.push(
			`| ${escapeTableCell(stage)} | ${escapeTableCell(file)} | ${escapeTableCell(given)} | ${escapeTableCell(checked ?? "")} | ${escapeTableCell(why(correction))} |`,
		);
	}
	lines.push("");
	return lines;
}

function renderRelatedArtifacts(t) {
	return reportSection(3, t("Related artifacts", "관련 자료"), [
		`- [${t("Machine-readable report", "기계 판독용 보고서")}](control.json)`,
		`- [${t("Structured source references", "구조화된 출처")}](refs.json)`,
		`- [${t("Legacy compatibility report", "이전 형식 호환 보고서")}](review.md)`,
	]);
}

// agent-workflow 2026-11-17 (owner "다 진행"): the narrative is written before the renderer's integrity checks.
// When the final verdict differs from the verdict the narrative was written for, say so next to the narrative.
// A narrative the ledger already contradicts gets the separate warning below, so this covers the consistent case.
function narrativeVerdictNoteReasons(partition) {
	const summary = partition?.partitionSummary ?? {};
	const reasons = [];
	const missing = Math.max(
		Number(summary.missingVerdicts) || 0,
		asArray(partition?.verifierCoverage?.missingFindingIds).length,
	);
	if (missing > 0) reasons.push(`${missing} verifier verdict(s) are missing`);
	if (hasPartialFailures(partition))
		reasons.push("review coverage is partial");
	return reasons;
}

function renderNarrativeVerdictNote(report, effectiveVerdict, partition, t) {
	const narrativeVerdict = cleanText(report?.verdict);
	if (!narrativeVerdict || narrativeVerdict === effectiveVerdict) return [];
	const reasons = narrativeVerdictNoteReasons(partition);
	const reason = reasons.length
		? reasons.join("; ")
		: "the renderer's integrity checks did not pass";
	return [
		t(`> Verdict note: this narrative was written for verdict ${inlineCode(narrativeVerdict)}, but the final report verdict is ${inlineCode(effectiveVerdict)} (${reason}). Where the narrative describes review coverage or integrity, the final verdict and the limitations above take precedence.`, `> 종합 의견은 ${escapeMarkdownText(reportStatus(narrativeVerdict, t))} 판정을 기준으로 작성되었습니다. 위의 최종 판정과 한계를 우선하세요.`),
		"",
	];
}

function renderMarkdown({
	runtimeTask,
	report,
	reportAvailable,
	reportVerdictConsistent,
	rendererIntegrityFailed = false,
	effectiveVerdict,
	partition,
	findingCountMismatch,
	needsHumanCountMismatch,
	needsHumanMetadataMissing,
	needsHumanEvidenceIncomplete,
	supportNoteCountMismatch,
	supportNoteMetadataMissing,
	supportNoteEvidenceIncomplete,
}) {
	const { all } = partitionFindings(partition);
	const sortedFindings = all.sort(
		(a, b) =>
			severityRank(a.severity) - severityRank(b.severity) ||
			a.findingId.localeCompare(b.findingId),
	);
	const ledger = partition?.partitions ?? partition?.reportContext;
	const needsHuman = asArray(ledger?.needsHuman);
	const supportNotes = asArray(partition?.supportNotes);
	const t = reportLocale(report?.summary, runtimeTask, ...sortedFindings.map(readerTitleOf), ...needsHuman.map(readerTitleOf));
	const rendered = renderFindings(sortedFindings, t);
	const representedIds = rendered.representedIds ?? [];
	const renderedNeedsHuman = renderNeedsHuman(partition, t);
	const renderedDropped = renderDropped(partition, t);
	const renderedSupportNotes = renderSupportNotes(partition, t);
	const limitationInputs = {
		_reportAvailable: reportAvailable,
		reportVerdictConsistent,
		narrativeVerdict: report?.verdict,
		effectiveVerdict,
		rendererIntegrityFailed,
		partition,
		findingCountMismatch,
		needsHumanCountMismatch,
		needsHumanMetadataMissing,
		needsHumanEvidenceIncomplete,
		supportNoteCountMismatch,
		supportNoteMetadataMissing,
		supportNoteEvidenceIncomplete,
	};
	const caveats = completionLimitations({ ...limitationInputs, t });
	const completionSummaryMarkdown = renderCompletionSummary({
		reportAvailable,
		effectiveVerdict,
		partition,
		findings: sortedFindings,
		limitations: caveats,
		t,
	});
	const partial = hasPartialFailures(partition) || rendererIntegrityFailed;
	const risks = renderRisks(report, partition, t);
	const outcome = {
		NEEDS_WORK: t("Resolve the findings or open questions before release.", "배포 전에 발견 사항이나 미해결 질문을 처리하세요."),
		PARTIAL_REVIEW: t("Some review work could not be completed reliably.", "일부 검토 작업을 신뢰할 수 있는 수준으로 마치지 못했습니다."),
		REVIEW_COMPLETE: t("No findings require remediation or further review.", "수정하거나 추가로 검토할 발견 사항이 없습니다."),
	}[effectiveVerdict];
	const narrative = reportVerdictConsistent && report.verdict === effectiveVerdict ? shortNarrative(report.summary) : [];
	const severity = severityCounts(sortedFindings);
	const keyPoints = [
		...Object.entries(severity).filter(([, count]) => count).map(([level, count]) =>
			`- **${escapeMarkdownText(reportStatus(level, t))}** — ${t(`${count} findings`, `발견 ${count}건`)}`),
		...(needsHuman.length ? [`- **${t("Needs human review", "사람 검토 필요")}** — ${needsHuman.length}`] : []),
		...(report?.risks?.length ? [`- **${t("Main risk", "주요 위험")}** — ${escapeMarkdownText(typeof report.risks[0] === "string" ? report.risks[0] : report.risks[0]?.risk ?? report.risks[0]?.note ?? report.risks[0]?.summary ?? "")}`] : []),
	].slice(0, 6);
	const actions = [
		...(effectiveVerdict === "REVIEW_COMPLETE" ? [] : [{ label: t("Review decision", "검토 결과에 따른 조치"), value: effectiveVerdict === "PARTIAL_REVIEW" ? t(deterministicNextAction(effectiveVerdict), "빠졌거나 실패한 검토를 마친 뒤 배포 전에 다시 검토하세요.") : t(deterministicNextAction(effectiveVerdict), "유지되거나 완화된 발견 사항을 처리하고 사람이 검토할 항목을 해결하세요.") }]),
		...(report?.recommendedNextAction ? [{ label: t("Synthesis recommendation", "종합 의견의 권고"), value: report.recommendedNextAction }] : []),
		...([sortedFindings, needsHuman, supportNotes].flatMap((group) => group.map((row, idx) => ({ label: findingIdOf(row, idx), value: row.recommendedAction ?? row.concreteFix })))),
	];
	const appendix = [
		...(!narrative.length && report?.summary ? reportSection(3, t("Synthesis narrative", "종합 의견 원문"), [
			...renderNarrativeVerdictNote(report, effectiveVerdict, partition, t), `${t("Summary", "요약")}: ${escapeMarkdownText(report.summary)}`,
		]) : []),
		...renderedDropped.lines,
		...renderedSupportNotes.lines,
		...reportSection(3, t("Needs-human causes", "사람 검토가 필요한 이유"), renderNeedsHumanBreakdown(needsHuman, t)),
		...renderSourceCoverageGaps(partition, t),
		...renderEvidenceCorrections(partition, t),
		...renderRelatedArtifacts(t),
	];
	const lines = [
		`# ${t("Deep review report", "심층 검토 보고서")}`, "",
		t(`Evidence: ${sortedFindings.length} kept or weakened findings · ${needsHuman.length} needs human review · ${supportNotes.length} supporting observations · coverage ${partial ? "partial" : "complete"}`, `근거: 유지·완화 ${sortedFindings.length}건 · 사람 검토 ${needsHuman.length}건 · 보조 관찰 ${supportNotes.length}건 · 검토 범위 ${partial ? "일부" : "완료"}`), "",
		`## ${t("Conclusion", "결론")}`, "",
		`${t("Verdict", "판정")}: **${escapeMarkdownText(reportStatus(effectiveVerdict, t))}**.`, "",
		...(narrative.length ? narrative : [outcome, ""]),
		...reportSection(3, t("Key points", "핵심 포인트"), keyPoints.length ? keyPoints : [
			`- **${t("Source coverage", "출처 범위")}** — ${partial ? t("Partial", "일부") : t("Complete", "완료")}`,
		]),
		...reportSection(2, t("Limitations", "알아둘 한계"), [...risks.filter(Boolean), ...caveats.slice(1).map((value) => `- ${escapeMarkdownText(value)}`)]),
		...reportActions(t("Actions", "할 일"), actions),
		...rendered.lines, ...renderedNeedsHuman.lines,
		...reportSection(2, t("Appendix", "부록"), fold(t("Review records", "검토 기록"), [
			`- ${escapeMarkdownText(caveats[0])}`, "", ...appendix,
		])),
	];
	return {
		// Do not normalize the completed document: evidence fences contain exact
		// reviewed quote bytes, including repeated LF and CRLF sequences.
		markdown: lines.join("\n").trim(),
		completionSummaryMarkdown,
		representedIds,
		representedNeedsHumanIds: renderedNeedsHuman.representedIds,
		representedDroppedIds: renderedDropped.representedIds,
		representedSupportRows: renderedSupportNotes.representedRows,
		emissionRows: structuredEmissionRows(partition),
	};
}

function blockedRenderResult(reason) {
	return {
		schema: "deep-review-render-v1",
		digest: `Deep review rendering blocked: ${reason}`,
		status: "blocked",
		verdict: "PARTIAL_REVIEW",
		blockers: [reason],
		markdown: "",
		completionSummaryMarkdown: "",
		findingSummary: { total: 0, bySeverity: {} },
		renderedFindingIds: [],
		renderedNeedsHumanIds: [],
		sourceArtifacts: [],
		gates: {
			renderedAllFindings: false,
			renderedAllNeedsHuman: false,
			renderedAllSupportNotes: false,
			findingCountMismatch: true,
			needsHumanCountMismatch: true,
			needsHumanMetadataMissing: true,
			needsHumanEvidenceIncomplete: true,
			reportSynthesisAvailable: false,
			reportVerdictConsistent: false,
			supportNoteCountMismatch: true,
			supportNoteMetadataMissing: true,
			supportNoteEvidenceIncomplete: true,
			supportProvenanceValid: false,
			passed: false,
		},
	};
}

export default async function renderReviewReport({ sources, context = {} }) {
	let partition;
	let report;
	try {
		partition = findSource(sources, "partition-verdicts");
		report = findSource(sources, "report");
	} catch (error) {
		return blockedRenderResult(
			error instanceof Error ? error.message : String(error),
		);
	}
	const reportAvailable = hasReportSynthesis(report);
	if (!partition || typeof partition !== "object") {
		return {
			schema: "deep-review-render-v1",
			digest:
				"Deep review rendering failed: missing partition-verdicts control source.",
			status: "blocked",
			verdict: "PARTIAL_REVIEW",
			blockers: ["missing partition-verdicts control source"],
			markdown: "",
			completionSummaryMarkdown: "",
			findingSummary: { total: 0, bySeverity: {} },
			renderedFindingIds: [],
			renderedNeedsHumanIds: [],
			sourceArtifacts: [],
			gates: {
				renderedAllFindings: false,
				renderedAllNeedsHuman: false,
				renderedAllSupportNotes: false,
				findingCountMismatch: true,
				needsHumanCountMismatch: true,
				needsHumanMetadataMissing: true,
				needsHumanEvidenceIncomplete: true,
				reportSynthesisAvailable: false,
				reportVerdictConsistent: false,
				supportNoteCountMismatch: true,
				supportNoteMetadataMissing: true,
				supportNoteEvidenceIncomplete: true,
				supportProvenanceValid: false,
				passed: false,
			},
		};
	}

	const { all } = partitionFindings(partition);
	const idAudit = ledgerIdAudit(partition);
	const {
		rawReviewerIds,
		dedupIds,
		rawReviewerIdsMissing,
		dedupIdsMissing,
		rawReviewerIdsMismatch,
		dedupIdsMismatch,
		rawCountMismatch,
		uniqueCountMismatch,
		reviewerCoverageReconciled,
		reviewerMissingLensIds,
		reviewerUnexpectedIds,
		reviewerDuplicateIds,
		verifierCoverageExact,
		verifierDigestMatches,
		verifierRowIds,
		verifierMissingIds,
		verifierOrphanIds,
		verifierDuplicateIds,
		verifierOwnershipIssues,
		duplicateCountMismatch,
		duplicateLedgerReconciled,
		duplicateLedgerPairsMismatch,
		duplicateLedgerIssues,
		rawDuplicateIdsMissing,
		rawDuplicateLineageIssues,
		independentlyDispositionedRawDuplicates,
		duplicateLedgerRawIdsMismatch,
		verdictsReceivedMismatch,
		partitionVerdictsReceived,
		verifierVerdictsReceived,
		reviewerDedupReconciled,
		expectedVerifierIds,
		verifierExpectedMismatch,
		ledgerCompleteness,
		requiredLedgersPresent,
		idLedgerExact,
		provenanceOwnerIssues,
		supportRelationIssues,
		reviewerMissingAttestedLensIds,
		reviewerUnexpectedAttestedIds,
		verifierDeclaredRowsMismatch,
		verifierStatusIssues,
		reviewerOwnerMapIssues,
		reviewerFindingOwnerIssues,
		supportProvenanceIssues,
	} = idAudit;
	const expected = expectedFindingCount(partition, all);
	const findingCountMismatch = expected !== all.length;
	const needsHuman = needsHumanCounts(partition);
	const needsHumanCountMismatch = needsHuman.expected !== needsHuman.actual;
	const needsHumanMetadataMissing = needsHuman.metadataMissing;
	const needsHumanEvidenceIncomplete = needsHuman.incompleteEvidence > 0;
	const supportNotes = supportNoteCounts(partition);
	const supportNoteCountMismatch = supportNotes.expected !== supportNotes.actual;
	const supportNoteMetadataMissing = supportNotes.metadataMissing;
	const supportNoteEvidenceIncomplete = supportNotes.incompleteEvidence > 0;
	let effectiveVerdict = requiredReportVerdict(partition, all.length);
	const reportVerdictConsistent =
		reportAvailable && cleanText(report.verdict) === effectiveVerdict;
	// 2026-11-10 (owner): a narrative verdict that differs from the ledger's is a warning, not a failed render. The
	// ledger verdict stands, except that REVIEW_COMPLETE needs the narrative's agreement (else PARTIAL_REVIEW).
	const verdictDowngraded =
		reportAvailable &&
		!reportVerdictConsistent &&
		effectiveVerdict === "REVIEW_COMPLETE";
	if (verdictDowngraded) effectiveVerdict = "PARTIAL_REVIEW";
	let rendererIntegrityFailed = false;
	const renderCurrentVerdict = () =>
		renderMarkdown({
			runtimeTask: context.runtimeTask,
			report: report ?? {},
			reportAvailable,
			reportVerdictConsistent,
			rendererIntegrityFailed,
			effectiveVerdict,
			partition,
			findingCountMismatch,
			needsHumanCountMismatch,
			needsHumanMetadataMissing,
			needsHumanEvidenceIncomplete,
			supportNoteCountMismatch,
			supportNoteMetadataMissing,
			supportNoteEvidenceIncomplete,
		});
	let rendered = renderCurrentVerdict();
	const bySeverity = severityCounts(all);
	const renderedAllFindings = rendered.representedIds.length === all.length;
	const renderedAllNeedsHuman =
		rendered.representedNeedsHumanIds.length === needsHuman.actual;
	const renderedAllSupportNotes =
		rendered.representedSupportRows === supportNotes.actual;
	const droppedCount = asArray(
		(partition.partitions ?? partition.reportContext)?.drop,
	).length;
	const renderedAllDropped =
		rendered.representedDroppedIds.length === droppedCount;
	const renderedDispositionIds = [
		...rendered.representedIds,
		...rendered.representedDroppedIds,
		...rendered.representedNeedsHumanIds,
	];
	const renderedAllTopLevel =
		renderedDispositionIds.length === idAudit.topLevelIds.length &&
		renderedDispositionIds.every((id) => idAudit.topLevelIds.includes(id));
	const renderedLineageIds = idAudit.lineageIds.filter((id) => Boolean(id));
	const expectedEmissionRows = [
		...idAudit.topLevelIds
			.filter(Boolean)
			.map((id) => ({ kind: "top-level", id })),
		...idAudit.lineageIds.filter(Boolean).map((id) => ({ kind: "lineage", id })),
		...(supportNotes.actual > 0
			? asArray(partition.supportNotes)
					.map((note, index) => supportEmissionRow(note, index))
					.filter((row) => row.id)
			: []),
	];
	const emittedEmissionRows = rendered.emissionRows ?? [];
	const renderedAllLineage = sameEmissionRows(
		expectedEmissionRows.filter((row) => row.kind === "lineage"),
		emittedEmissionRows.filter((row) => row.kind === "lineage"),
	);
	const uniqueLedgerIds =
		idAudit.uniqueIds.size ===
		idAudit.topLevelIds.length +
			idAudit.supportIds.length +
			idAudit.lineageIds.length;
	const renderIntegrityPassed =
		!findingCountMismatch &&
		!idAudit.topLevelCountMismatch &&
		!idAudit.mergedCountMismatch &&
		!duplicateCountMismatch &&
		duplicateLedgerReconciled &&
		!verdictsReceivedMismatch &&
		sameEmissionRows(expectedEmissionRows, emittedEmissionRows) &&
		idAudit.duplicateIds.length === 0 &&
		uniqueLedgerIds &&
		reviewerDedupReconciled &&
		!rawReviewerIdsMismatch &&
		!dedupIdsMismatch &&
		!rawCountMismatch &&
		!uniqueCountMismatch &&
		requiredLedgersPresent &&
		ledgerCompleteness &&
		idLedgerExact &&
		reviewerCoverageReconciled &&
		verifierCoverageExact &&
		renderedAllLineage &&
		renderedAllTopLevel &&
		renderedAllDropped &&
		!needsHumanCountMismatch &&
		!needsHumanMetadataMissing &&
		!supportNoteCountMismatch &&
		!supportNoteMetadataMissing &&
		!supportNoteEvidenceIncomplete &&
		supportProvenanceIssues.length === 0 &&
		renderedAllFindings &&
		renderedAllNeedsHuman &&
		renderedAllSupportNotes &&
		reportAvailable;
	if (!renderIntegrityPassed) {
		rendererIntegrityFailed = true;
		if (effectiveVerdict !== "PARTIAL_REVIEW") {
			effectiveVerdict = "PARTIAL_REVIEW";
		}
		rendered = renderCurrentVerdict();
	}
	const passed =
		renderIntegrityPassed &&
		(effectiveVerdict !== "PARTIAL_REVIEW" || verdictDowngraded);

	let sidecarPath;
	let sidecarError;
	const sidecarsRequested = Boolean(
		context.cwd && context.runId && context.taskId,
	);
	try {
		if (sidecarsRequested) {
			const taskDir = join(
				context.stateCwd ?? context.cwd,
				".agent-workflow",
				"workflows",
				context.runId,
				"tasks",
				context.taskId,
			);
			await mkdir(taskDir, { recursive: true });
			const payload = `${rendered.markdown}\n`;
			await writeFile(join(taskDir, "final-report.md"), payload, "utf8");
			await writeFile(join(taskDir, "review.md"), payload, "utf8");
			sidecarPath = "final-report.md";
		}
	} catch (error) {
		// The sidecar is not canonical ledger input, but a requested publication
		// failure must be visible and cannot be reported as a successful render.
		sidecarError = error instanceof Error ? error.message : String(error);
	}
	const sidecarWriteFailed = sidecarsRequested && Boolean(sidecarError);
	const outputPassed = passed && !sidecarWriteFailed;
	if (sidecarWriteFailed) {
		rendered.markdown += `\n\n## Renderer warning\n\nRequested report sidecar publication failed; the machine result is degraded and must not be treated as a published report. (${escapeMarkdownText(sidecarError)})`;
	}

	return {
		schema: "deep-review-render-v1",
		digest: `Rendered ${all.length} findings: ${
			Object.entries(bySeverity)
				.sort(([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b))
				.map(([severity, count]) => `${severity}=${count}`)
				.join(", ") || "none"
		}.`,
		status: outputPassed ? "passed" : "failed",
		verdict: sidecarWriteFailed ? "PARTIAL_REVIEW" : effectiveVerdict,
		completionSummaryMarkdown: outputPassed
			? rendered.completionSummaryMarkdown
			: "",
		...(sidecarError ? { sidecarError } : {}),
		markdown: rendered.markdown,
		findingSummary: { total: all.length, bySeverity },
		renderedFindingIds: rendered.representedIds,
		renderedNeedsHumanIds: rendered.representedNeedsHumanIds,
		renderedDroppedIds: rendered.representedDroppedIds,
		renderedLineageIds,
		emissionRows: emittedEmissionRows,
		expectedEmissionRows,
		expectedFindingCount: expected,
		rawReviewerFindingIds: rawReviewerIds,
		dedupFindingIds: dedupIds,
		rawDuplicateLineageIssues,
		independentlyDispositionedRawDuplicates,
		duplicateLedgerRawIdsMismatch,
		verdictsReceived: verifierVerdictsReceived,
		verifierCoverage: {
			expectedFindingIds: expectedVerifierIds,
			verdictFindingIds: verifierRowIds,
			missingFindingIds: [...new Set(verifierMissingIds)],
			orphanFindingIds: [...new Set(verifierOrphanIds)],
			duplicateFindingIds: [...new Set(verifierDuplicateIds)],
			ownershipIssues: verifierOwnershipIssues.map((row) => row.sourceId ?? ""),
			statusIssues: verifierStatusIssues.map(
				(status) => status.source ?? status.specId ?? "",
			),
		},
		expectedMergedFindingCount: idAudit.expectedMerged,
		mergedFindingCount: idAudit.mergedCount,
		needsHumanSummary: {
			...needsHuman,
			verifierEvidenceIncomplete: needsHuman.verifierEvidenceIncomplete,
			verifierEvidenceUnavailable: needsHuman.verifierEvidenceUnavailable,
		},
		supportNoteSummary: supportNotes,
		sourceArtifacts: [
			"partition-verdicts.control.json",
			...(reportAvailable ? ["report.control.json"] : []),
		],
		gates: {
			renderedAllFindings,
			renderedAllNeedsHuman,
			renderedAllSupportNotes,
			findingCountMismatch,
			duplicateCountMismatch,
			duplicateLedgerReconciled,
			duplicateLedgerPairsMismatch,
			duplicateLedgerIssues,
			rawDuplicateIdsMissing,
			rawDuplicateLineageIssues,
			independentlyDispositionedRawDuplicates,
			duplicateLedgerRawIdsMismatch,
			verdictsReceivedMismatch,
			partitionVerdictsReceived,
			verifierVerdictsReceived,
			ledgerTopLevelCountMismatch: idAudit.topLevelCountMismatch,
			uniqueLedgerIds,
			duplicateLedgerIds: idAudit.duplicateIds,
			mergedFindingCountMismatch: idAudit.mergedCountMismatch,
			rawReviewerFindingIdsMissing: rawReviewerIdsMissing,
			dedupFindingIdsMissing: dedupIdsMissing,
			rawReviewerIdsMismatch,
			dedupIdsMismatch,
			rawCountMismatch,
			uniqueCountMismatch,
			reviewerCoverageReconciled,
			requiredLedgersPresent,
			ledgerCompleteness,
			idLedgerExact,
			provenanceOwnerIssues: provenanceOwnerIssues.map((finding) =>
				findingIdOf(finding, 0),
			),
			supportRelationIssues: supportRelationIssues.map((finding) =>
				findingIdOf(finding, 0),
			),
			reviewerFindingOwnerIssues: reviewerFindingOwnerIssues.map((finding) =>
				findingIdOf(finding, 0),
			),
			verifierExpectedMismatch,
			verifierDeclaredRowsMismatch,
			verifierStatusIssues: verifierStatusIssues.map(
				(status) => status.source ?? status.specId ?? "",
			),
			reviewerOwnerMapIssues: reviewerOwnerMapIssues.map(
				(owner) => owner?.source ?? "",
			),
			reviewerMissingAttestedLensIds,
			reviewerUnexpectedAttestedIds,
			reviewerMissingLensIds,
			reviewerUnexpectedIds,
			reviewerDuplicateIds,
			verifierCoverageExact,
			verifierDigestMatches,
			verifierExpectedMismatch,
			verifierDeclaredRowsMismatch,
			verifierMissingIds: [...new Set(verifierMissingIds)],
			verifierOrphanIds: [...new Set(verifierOrphanIds)],
			verifierDuplicateIds: [...new Set(verifierDuplicateIds)],
			verifierOwnershipIssues: verifierOwnershipIssues.map(
				(row) => row.sourceId ?? "",
			),
			renderedAllLineage,
			renderedAllTopLevel,
			renderedAllDropped,
			needsHumanCountMismatch,
			needsHumanMetadataMissing,
			needsHumanEvidenceIncomplete,
			needsHumanEvidenceUnavailable:
				needsHuman.verifierEvidenceUnavailable > 0,
			reportSynthesisAvailable: reportAvailable,
			reportVerdictConsistent,
			supportNoteCountMismatch,
			supportNoteMetadataMissing,
			supportNoteEvidenceIncomplete,
			supportProvenanceIssues: supportProvenanceIssues.map((finding) =>
				findingIdOf(finding, 0),
			),
			supportProvenanceValid: supportProvenanceIssues.length === 0,
			reviewedSnapshotOnly: true,
			currentTreeBytesAttested: false,
			sidecarWriteFailed,
			passed: outputPassed,
		},
		...(sidecarPath ? { sidecarPath } : {}),
	};
}
