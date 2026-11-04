// agent-workflow 2026-11-04: deep-review's deterministic verdict, shared by the partition (which
// puts it in the report packet for the report stage to copy) and the renderer (which recomputes it
// and rejects a report that differs). Moved out of render-review-report.mjs.

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

export function hasPartialFailures(partition) {
	const summaryCount = Number(partition?.partitionSummary?.partialFailures);
	const sourceStatus = partition?.sourceStatusSummary;
	const nonCompleted = Number(sourceStatus?.nonCompleted);
	const total = Number(sourceStatus?.total);
	const completed = Number(sourceStatus?.completed);
	return Boolean(
		asArray(sourceStatus?.partialFailures).length > 0 ||
			asArray(partition?.reportContext?.partialFailures).length > 0 ||
			(Number.isFinite(summaryCount) && summaryCount > 0) ||
			(Number.isFinite(nonCompleted) && nonCompleted > 0) ||
			(Number.isFinite(total) && Number.isFinite(completed) && completed < total),
	);
}

/**
 * agent-workflow 2026-11-04 (owner decision, live run of every workflow: a Codex review with 2
 * grounded KEEP findings read PARTIAL_REVIEW because two reviewers could not quote blank planned
 * lines): grounded KEEP/WEAKEN findings decide first. They stand on their own verified evidence
 * whatever the incomplete part of the review would add, so a partial review with confirmed
 * findings is NEEDS_WORK and the incomplete coverage is reported as a limitation. A partial review
 * without them stays PARTIAL_REVIEW; REVIEW_COMPLETE still needs complete coverage.
 */
export function requiredReportVerdict(partition, findingCount) {
	if (hasPartialFailures(partition)) return findingCount > 0 ? "NEEDS_WORK" : "PARTIAL_REVIEW";
	const requiredLedgers = [
		partition?.reviewerLedger,
		partition?.dedupSummary,
		partition?.verifierCoverage,
	];
	if (
		requiredLedgers.some(
			(ledger) =>
				!ledger || typeof ledger !== "object" || ledger.complete !== true,
		)
	)
		return "NEEDS_WORK";
	const ledger = partition?.partitions ?? partition?.reportContext;
	const summary = partition?.partitionSummary;
	const integrityCounts = [
		summary?.batchIntegrityIssues,
		summary?.verdictIntegrityIssues,
		summary?.reviewerCoverageIssues,
		summary?.missingVerdicts,
	].some((value) => Number(value) > 0);
	const reviewer = partition?.reviewerLedger;
	const reviewerGap =
		reviewer &&
		(asArray(reviewer.missingPlannedLensIds).length > 0 ||
			asArray(reviewer.unexpectedMaterializedReviewerIds).length > 0 ||
			asArray(reviewer.invalidAttestations).length > 0);
	const verifier = partition?.verifierCoverage;
	const verifierGap =
		verifier &&
		(asArray(verifier.missingFindingIds).length > 0 ||
			asArray(verifier.orphanFindingIds).length > 0 ||
			asArray(verifier.duplicateFindingIds).length > 0);
	if (integrityCounts || reviewerGap || verifierGap) return "NEEDS_WORK";
	if (findingCount > 0 || asArray(ledger?.needsHuman).length > 0)
		return "NEEDS_WORK";
	return "REVIEW_COMPLETE";
}
