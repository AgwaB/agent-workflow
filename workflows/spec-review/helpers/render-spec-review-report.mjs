// Deterministic completion renderer for spec-review.
//
// partition-findings is the canonical ledger. The model-authored report is a
// bounded narrative overlay and cannot add, remove, or reclassify findings.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	auditPartitionEvidence,
	sourceStatusComplete,
	specReviewVerdict,
} from "./spec-evidence-gate.mjs";
import { rendererCandidateUniverse } from "./spec-requirement-source.mjs";

import { readerDiagnostic } from "./reader-diagnostics.mjs";

const REPORT_VERDICTS = new Set([
	"CONFORMS",
	"GAPS_FOUND",
	"NEEDS_HUMAN",
	"INCONCLUSIVE",
]);

import {
	escapeMarkdownText, escapeTableCell, fold, reportActions, reportLocale, reportSection, reportStatus, shortNarrative,
} from "./report-markdown.mjs";

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {})
		.filter(([specId]) => specId === stageId || specId.startsWith(`${stageId}.`))
		.sort(([a], [b]) => a.localeCompare(b));
	if (matches.length > 1) {
		throw new Error(
			`spec-review renderer: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		// Only before punctuation that ends a word: ".agent-workflow/…", " .env" keep their space (2026-11-04).
		.replace(/\s+([,.;:!?])(?=\s|$)/g, "$1")
		.trim();
}

// Preserve the existing machine/Markdown completion-summary bytes.
function completionInline(value) {
	return cleanText(value)
		.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]{}#+|>])/g, "\\$1")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function completionText(value, maxChars, t) {
	const sanitized = completionInline(value)
		// agent-workflow 2026-11-04 (live runs: "workflow-stop.ts" became t("[run omitted]", "[실행 ID 생략]"), a reviewed
		// file's "control.json" became t("[artifact omitted]", "[자료 생략]")): only this engine's own names are hidden —
		// paths under .agent-workflow/workflows, run ids (workflow_<id>_<hex6>), task ids (task-<n>),
		// sidecar names, and refs/control JSON only as a stage-qualified or path-qualified name.
		.replace(
			/(?<![\w-])\.agent-workflow[\\/]workflows(?:[\\/][^\s]*)?/gi,
			t("[artifact omitted]", "[자료 생략]"),
		)
		.replace(/\b(?:final-report|audit|executive)\.md\b/gi, t("[artifact omitted]", "[자료 생략]"))
		.replace(/(?<=[.\\/])(?:refs|control)\.json\b/gi, t("[artifact omitted]", "[자료 생략]"))
		.replace(/\brelated[\s-]+artifacts\b/gi, t("[section title omitted]", "[절 제목 생략]"))
		.replace(/\bworkflow\\?_[a-z0-9]+\\?_[a-f0-9]{6}\b/gi, t("[run omitted]", "[실행 ID 생략]"))
		.replace(/\btask-\d+\b/gi, t("[task omitted]", "[작업 ID 생략]"));
	const chars = Array.from(sanitized);
	return chars.length <= maxChars
		? sanitized
		: `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function fenced(value, info = "text") {
	const text = typeof value === "string" ? value : stableStringify(value);
	const longestRun = Math.max(
		0,
		...[...String(text).matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return [`${fence}${info}`, String(text), fence];
}

function rowIdentity(row, prefix, index) {
	const id = cleanText(row?.id ?? row?.findingId ?? "");
	return id || `${prefix}-row-${String(index + 1).padStart(3, "0")}`;
}

function rowTitle(row, fallback) {
	return cleanText(
		row?.title ?? row?.finding ?? row?.claim ?? row?.question ?? fallback,
	);
}

function reportAvailable(report) {
	return Boolean(
		isRecord(report) &&
			cleanText(report.summary) &&
			REPORT_VERDICTS.has(cleanText(report.verdict)) &&
			Array.isArray(report.ownerLedger) &&
			isRecord(report.ownerLedgerReconciliation) &&
			Array.isArray(report.risks) &&
			cleanText(report.recommendedNextAction),
	);
}

function partitionSourceCoverageComplete(partition) {
	return sourceStatusComplete(partition?.sourceStatusSummary);
}

const FINAL_SOURCE_STAGES = ["partition-findings", "report"];

function canonicalFinalSourceStage(value, stageId) {
	const text = cleanText(value);
	return text === stageId || text.startsWith(`${stageId}.`) ? stageId : "";
}

function finalSourceCoverageComplete(context) {
	if (!Array.isArray(context?.sourceStatuses)) return false;
	const statuses = context.sourceStatuses.filter(isRecord);
	if (statuses.length !== context.sourceStatuses.length) return false;

	const taskOwners = new Map();
	for (const status of statuses) {
		const taskId = typeof status.taskId === "string" ? status.taskId.trim() : "";
		if (!taskId) continue;
		const owners = taskOwners.get(taskId) ?? [];
		owners.push(status);
		taskOwners.set(taskId, owners);
	}
	if ([...taskOwners.values()].some((owners) => owners.length !== 1))
		return false;

	const assigned = new Set();
	for (const stageId of FINAL_SOURCE_STAGES) {
		const matches = statuses
			.map((status, index) => ({ status, index }))
			.filter(
				({ status }) =>
					canonicalFinalSourceStage(status.stageId, stageId) === stageId &&
					canonicalFinalSourceStage(status.source, stageId) === stageId &&
					canonicalFinalSourceStage(status.specId, stageId) === stageId,
			);
		if (matches.length !== 1) return false;
		const [{ status, index }] = matches;
		if (
			assigned.has(index) ||
			cleanText(status.stageId) !== stageId ||
			cleanText(status.status) !== "completed" ||
			typeof status.taskId !== "string" ||
			!status.taskId.trim()
		)
			return false;
		assigned.add(index);
	}

	// Only the two canonical final-stage sources may participate in this join.
	// A completed but unrelated status is an orphan, not harmless extra context.
	return assigned.size === statuses.length;
}

function setEquals(left, right) {
	if (left.size !== right.size) return false;
	return [...left].every((item) => right.has(item));
}

function ownerKey(owner) {
	return [
		owner?.source,
		owner?.stageId,
		owner?.specId,
		owner?.taskId,
		owner?.itemIdentity,
		owner?.placeholderSpecId,
		owner?.batchId ?? "",
		owner?.status,
	]
		.map((value) => String(value ?? ""))
		.join("\u001f");
}

/**
 * agent-workflow 2026-11-04 (live claude/haiku spec-review: the report stage copied the first owner
 * row with source "verify-findings.finding-001", its real alias is the bare stage id
 * "verify-findings", and a correct GAPS_FOUND review failed): the report's copy of the owner ledger
 * is compared on the identity fields, without the source alias. The alias is a routing name, not
 * identity; the partition's own ledger, which the report renders from, is still checked with it
 * against the runtime source statuses (verifierOwnerLedgerComplete).
 */
function ownerIdentityRows(rows) {
	return Array.isArray(rows)
		? rows.map((row) => {
				if (!isRecord(row)) return row;
				const { source, ...identity } = row;
				void source;
				return identity;
			})
		: rows;
}

function exactOwnerShape(owner) {
	return (
		isRecord(owner) &&
		[
			"source",
			"stageId",
			"specId",
			"taskId",
			"itemIdentity",
			"placeholderSpecId",
			"status",
		].every((field) => typeof owner[field] === "string" && owner[field].trim()) &&
		owner.status === "completed" &&
		(typeof owner.batchId === "undefined" ||
			(typeof owner.batchId === "string" && owner.batchId.trim())) &&
		owner.specId ===
			`${owner.stageId}.${String(owner.batchId ?? owner.itemIdentity).toLowerCase()}` &&
		owner.placeholderSpecId === `${owner.stageId}.item` &&
		(owner.batchId === undefined || owner.itemIdentity === owner.batchId)
	);
}

function verifierOwnerLedgerComplete(partition) {
	const coverage = partition?.verifierCoverage;
	if (
		!isRecord(coverage) ||
		!Array.isArray(coverage.ownerLedger) ||
		!Array.isArray(coverage.verifierRows) ||
		!isRecord(coverage.ownerLedgerReconciliation)
	)
		return false;
	const owners = coverage.ownerLedger;
	const rows = coverage.verifierRows;
	const reconciliation = coverage.ownerLedgerReconciliation;
	// A zero-candidate review has a valid empty ownership join only when every
	// cardinality field is genuinely zero. A non-empty candidate universe still
	// requires positive owner/verifier reconciliation.
	const emptyJoin =
		owners.length === 0 &&
		rows.length === 0 &&
		coverage.candidateCount === 0 &&
		coverage.uniqueCandidateCount === 0 &&
		coverage.verifierCount === 0 &&
		coverage.uniqueVerifierCount === 0 &&
		reconciliation.ownerRowCount === 0 &&
		reconciliation.verifierRowCount === 0 &&
		Array.isArray(reconciliation.ownerIds) &&
		reconciliation.ownerIds.length === 0 &&
		Array.isArray(reconciliation.verifierIds) &&
		reconciliation.verifierIds.length === 0;
	if (emptyJoin)
		return (
			reconciliation.cardinalityPassed === true &&
			reconciliation.passed === true &&
			asArray(reconciliation.duplicateOwnerIds).length === 0 &&
			asArray(reconciliation.duplicateVerifierIds).length === 0 &&
			asArray(reconciliation.missingOwnerRows).length === 0 &&
			asArray(reconciliation.orphanOwnerRows).length === 0 &&
			asArray(reconciliation.statusMismatches).length === 0
		);
	if (owners.length < 1 || rows.length < 1) return false;
	if (
		reconciliation.ownerRowCount !== owners.length ||
		reconciliation.verifierRowCount !== rows.length ||
		reconciliation.cardinalityPassed !== true ||
		reconciliation.passed !== true
	)
		return false;
	if (
		!Array.isArray(reconciliation.ownerIds) ||
		!Array.isArray(reconciliation.verifierIds) ||
		reconciliation.ownerIds.some((id) => typeof id !== "string" || !id.trim()) ||
		reconciliation.verifierIds.some(
			(id) => typeof id !== "string" || !id.trim(),
		) ||
		asArray(reconciliation.duplicateOwnerIds).length > 0 ||
		asArray(reconciliation.duplicateVerifierIds).length > 0 ||
		asArray(reconciliation.missingOwnerRows).length > 0 ||
		asArray(reconciliation.orphanOwnerRows).length > 0 ||
		asArray(reconciliation.statusMismatches).length > 0
	)
		return false;
	const ownerKeys = new Set();
	const ownerIds = [];
	for (const owner of owners) {
		if (!exactOwnerShape(owner)) return false;
		const key = ownerKey(owner);
		const id = cleanText(owner.batchId ?? owner.itemIdentity);
		if (!key || ownerKeys.has(key) || !id || ownerIds.includes(id)) return false;
		ownerKeys.add(key);
		ownerIds.push(id);
	}
	const verifierIds = [];
	for (const row of rows) {
		const id = cleanText(row?.id);
		if (
			!id ||
			verifierIds.includes(id) ||
			!exactOwnerShape(row?.owner) ||
			!ownerKeys.has(ownerKey(row.owner))
		)
			return false;
		verifierIds.push(id);
		// Singleton ownership is one-to-one. A batch carrier is the only
		// permitted many-to-one owner relationship.
		if (!row.owner.batchId && cleanText(row.owner.itemIdentity) !== id)
			return false;
	}
	return (
		setEquals(new Set(reconciliation.ownerIds), new Set(ownerIds)) &&
		setEquals(new Set(reconciliation.verifierIds), new Set(verifierIds)) &&
		reconciliation.ownerIds.length === ownerIds.length &&
		reconciliation.verifierIds.length === verifierIds.length
	);
}

function candidateUniverseMatches(partition, runtimeUniverse) {
	const declared = partition?.verifierCoverage?.candidateUniverse;
	if (!isRecord(declared) || !isRecord(runtimeUniverse)) return false;
	if (
		declared.count !== runtimeUniverse.count ||
		declared.uniqueCount !== runtimeUniverse.uniqueCount ||
		stableStringify(declared.ids) !== stableStringify(runtimeUniverse.ids) ||
		stableStringify(declared.duplicateIds) !== stableStringify(runtimeUniverse.duplicateIds) ||
		declared.invalidRowCount !== runtimeUniverse.invalidRowCount ||
		stableStringify(declared.proof) !== stableStringify(runtimeUniverse.proof)
	)
		return false;
	const reconciliation = partition.candidateUniverseReconciliation ?? partition.verifierCoverage.candidateUniverseReconciliation;
	return isRecord(reconciliation) && reconciliation.passed === true &&
		stableStringify(reconciliation.runtimeIds) === stableStringify(runtimeUniverse.ids);
}

function needsHumanRowComplete(row) {
	return isRecord(row) &&
		typeof row.source === "string" && row.source.trim() &&
		Array.isArray(row.requirementIds) &&
		isRecord(row.origin) && typeof row.origin.kind === "string" && row.origin.kind.trim() &&
		typeof row.reason === "string" && row.reason.trim() &&
		typeof row.uncertainty === "string" && row.uncertainty.trim() &&
		typeof row.finalClaim === "string" && row.finalClaim.trim() &&
		typeof row.recommendedAction === "string" && row.recommendedAction.trim();
}

function verifierCoverageComplete(partition, runtimeUniverse) {
	const coverage = partition?.verifierCoverage;
	const counts = partition?.verdictCounts;
	if (!candidateUniverseMatches(partition, runtimeUniverse)) return false;
	if (asArray(partition?.needsHuman).some((row) => !needsHumanRowComplete(row))) return false;
	if (!verifierOwnerLedgerComplete(partition)) return false;
	if (!isRecord(coverage) || !isRecord(counts) || coverage.complete !== true)
		return false;
	const candidateCount = coverage.candidateCount;
	const uniqueCandidateCount = coverage.uniqueCandidateCount;
	const verifierCount = coverage.verifierCount;
	const uniqueVerifierCount = coverage.uniqueVerifierCount;
	const verifiedCandidateCount = coverage.verifiedCandidateCount;
	if (
		![
			candidateCount,
			uniqueCandidateCount,
			verifierCount,
			uniqueVerifierCount,
			verifiedCandidateCount,
		].every((value) => Number.isInteger(value) && value >= 0)
	)
		return false;
	const missingIds = asArray(coverage.missingIds).map(cleanText).filter(Boolean);
	const missingRows = asArray(partition.missingVerifications)
		.map((row) => cleanText(row?.id))
		.filter(Boolean);
	const orphanIds = asArray(coverage.orphanVerifierIds)
		.map(cleanText)
		.filter(Boolean);
	const orphanRows = asArray(partition.orphanVerifierResults)
		.map((row) => cleanText(row?.id))
		.filter(Boolean);
	const batchIssues = asArray(partition.batchIntegrityIssues);
	const finalFindings = asArray(partition.finalFindings);
	const actualKeep = finalFindings.filter(
		(row) => cleanText(row?.verdict) === "KEEP",
	).length;
	const actualWeaken = finalFindings.filter(
		(row) => cleanText(row?.verdict) === "WEAKEN",
	).length;
	const countFields = [
		"keep",
		"weaken",
		"drop",
		"needsHuman",
		"missingVerification",
		"invalidVerifier",
		"orphanVerifier",
	];
	if (
		!countFields.every(
			(field) => Number.isInteger(counts[field]) && counts[field] >= 0,
		)
	)
		return false;
	const candidateNeedsHumanSources = new Set([
		"candidate-findings",
		"evidence-gate",
		"verifier",
		"invalid-verdict",
		"missing-verification",
		"batch-integrity",
		"verifier-integrity",
	]);
	const candidateNeedsHumanRows = asArray(partition.needsHuman).filter((row) =>
		candidateNeedsHumanSources.has(cleanText(row?.source)),
	).length;
	const canonicalCandidateDispositions =
		finalFindings.length +
		asArray(partition.droppedFindings).length +
		candidateNeedsHumanRows;
	if (canonicalCandidateDispositions !== uniqueCandidateCount) return false;
	const candidateDispositionRows = [
		...finalFindings,
		...asArray(partition.droppedFindings),
		...asArray(partition.needsHuman).filter((row) =>
			candidateNeedsHumanSources.has(cleanText(row?.source)),
		),
	];
	const candidateIds = candidateDispositionRows.map((row) => cleanText(row?.id));
	const verifierRows = asArray(coverage.verifierRows);
	const verifierIds = verifierRows.map((row) => cleanText(row?.id));
	if (
		candidateIds.some((id) => !id) ||
		new Set(candidateIds).size !== candidateIds.length ||
		verifierIds.some((id) => !id) ||
		new Set(verifierIds).size !== verifierIds.length ||
		candidateIds.length !== uniqueCandidateCount ||
		verifierIds.length !== uniqueVerifierCount ||
		!setEquals(new Set(candidateIds), new Set(verifierIds)) ||
		!setEquals(new Set(candidateIds), new Set(runtimeUniverse.ids))
	)
		return false;
	return (
		candidateCount === uniqueCandidateCount &&
		verifierCount === verifierRows.length &&
		verifierCount === uniqueCandidateCount &&
		uniqueVerifierCount === uniqueCandidateCount &&
		verifiedCandidateCount + new Set(missingIds).size === uniqueCandidateCount &&
		setEquals(new Set(missingIds), new Set(missingRows)) &&
		setEquals(new Set(orphanIds), new Set(orphanRows)) &&
		asArray(coverage.duplicateCandidateIds).length === 0 &&
		asArray(coverage.duplicateVerifierIds).length === 0 &&
		missingIds.length === 0 &&
		orphanIds.length === 0 &&
		asArray(partition.invalidVerifierResults).length === 0 &&
		batchIssues.length === 0 &&
		counts.keep === actualKeep &&
		counts.weaken === actualWeaken &&
		counts.drop === asArray(partition.droppedFindings).length &&
		counts.needsHuman === asArray(partition.needsHuman).length &&
		counts.missingVerification === missingRows.length &&
		counts.invalidVerifier === asArray(partition.invalidVerifierResults).length &&
		counts.orphanVerifier === orphanRows.length &&
		(!Object.hasOwn(counts, "batchIntegrity") ||
			(Number.isInteger(counts.batchIntegrity) &&
				counts.batchIntegrity >= 0 &&
				counts.batchIntegrity === batchIssues.length))
	);
}

function duplicateCanonicalIds(finalFindings, needsHuman, droppedFindings) {
	const seen = new Set();
	const duplicates = new Set();
	for (const row of [...finalFindings, ...needsHuman, ...droppedFindings]) {
		const id = cleanText(row?.id ?? row?.findingId ?? "");
		if (!id) continue;
		if (seen.has(id)) duplicates.add(id);
		else seen.add(id);
	}
	return [...duplicates].sort();
}

function requiredVerdict(
	partition,
	sourceCoverageComplete,
	verifierCoverageIsComplete,
	requirementReconciliation,
	gapsGrounded,
) {
	const coverage = partition?.verifierCoverage ?? {};
	return specReviewVerdict({
		sourceCoverageComplete,
		verifierCoverageComplete: verifierCoverageIsComplete,
		requirementReconciliation,
		gapsGrounded,
		finalCount: asArray(partition?.finalFindings).length,
		integrityRows:
			asArray(partition?.missingVerifications).length +
			asArray(partition?.invalidVerifierResults).length +
			asArray(partition?.orphanVerifierResults).length +
			asArray(partition?.batchIntegrityIssues).length +
			asArray(coverage.duplicateCandidateIds).length +
			asArray(coverage.duplicateVerifierIds).length,
		unresolvedRows: asArray(partition?.needsHuman).length,
	});
}

function renderEvidence(evidence, t) {
	return reportSection(5, t("Evidence excerpts", "근거 인용"), asArray(evidence).flatMap((row) => [
		...fenced(row, isRecord(row) ? "json" : "text"), "",
	]));
}

function renderFindingRows(rows, prefix, t) {
	const status = (value) => escapeMarkdownText(reportStatus(value, t));
	return rows.flatMap((input, index) => {
		const row = input ?? {};
		const id = rowIdentity(row, prefix, index);
		const title = rowTitle(row, row.reason ?? row.message ?? t("Untitled finding", "제목 없는 발견"));
		const bucket = { "needs-human": "NEEDS_HUMAN", dropped: "DROP" }[prefix];
		const disposition = bucket ?? row.verdict ?? "unknown";
		const historical = bucket ? [...new Set([row.originalVerdict, row.verdict].filter((value) => value && value !== bucket))] : [];
		const claim = row.claim ?? row.reason ?? row.message;
		const body = [
			...(historical.length ? [`- ${t("Historical verifier verdict", "이전 검증 판정")}: ${historical.map(status).join(" · ")}`] : []),
			...(row.finalClaim ? [`- ${t("Final claim", "최종 주장")}: ${escapeMarkdownText(readerDiagnostic(row.finalClaim, t))}`] : []),
			...(row.origin ? [`- ${t("Origin", "발생 경위")}: ${escapeMarkdownText(isRecord(row.origin) ? stableStringify(row.origin) : row.origin)}`] : []),
			...(row.evidenceStatus ? [`- ${t("Evidence status", "근거 상태")}: ${status(row.evidenceStatus)}`] : []),
			...(claim && claim !== title ? [`- ${t("Claim", "주장")}: ${escapeMarkdownText(readerDiagnostic(claim, t))}`] : []),
			...(row.reason && row.reason !== claim && row.reason !== title ? [`- ${t("Reason", "이유")}: ${escapeMarkdownText(readerDiagnostic(row.reason, t))}`] : []),
			...(row.source ? [`- ${t("Source", "출처")}: ${escapeMarkdownText(row.source)}`] : []),
			...(asArray(row.requirementIds).length ? [`- ${t("Requirements", "요구사항")}: ${row.requirementIds.map((value) => escapeMarkdownText(value)).join(", ")}`] : []),
			...(row.uncertainty ? [`- ${t("Uncertainty", "불확실성")}: ${escapeMarkdownText(readerDiagnostic(row.uncertainty, t))}`] : []),
			...(prefix === "dropped" && row.recommendedAction ? [`- ${t("Recorded action", "기록된 조치")}: ${escapeMarkdownText(readerDiagnostic(row.recommendedAction, t))}`] : []),
			"", ...renderEvidence(row.evidence, t),
			...reportSection(5, t("Counter-evidence", "반증"), asArray(row.counterEvidence).flatMap((item) => [...fenced(item, isRecord(item) ? "json" : "text"), ""])),
			...(row.verifierResult ? reportSection(5, t("Verifier record", "검증 기록"), fenced(row.verifierResult, "json")) : []),
			...(row.originalCandidate ? reportSection(5, t("Original candidate", "검토 후보 원본"), fenced(row.originalCandidate, "json")) : []),
		];
		return [
			`#### **${status(disposition)}**${row.severity ? ` **${status(row.severity)}**` : ""} — ${escapeMarkdownText(id)} · ${escapeMarkdownText(row.title ? title : readerDiagnostic(title, t))}`,
			"",
			...(body.some(Boolean) ? [...fold(t("Evidence", "근거 보기"), body), ""] : []),
		];
	});
}

function renderRequirementCoverage(rows, boundCoverage, t) {
	if (!rows.length) return [];
	const status = (value) => escapeTableCell(reportStatus(value ?? "unknown", t));
	const cells = (input) => {
		const row = input ?? {};
		const reason = row.reason ?? row.note ?? row.summary ?? "";
		const recheck = isRecord(row.recheck) ? row.recheck : null;
		const checked = recheck ? `${t("Re-checked", "재확인")}: ${status(recheck.from ?? row.status)} → ${status(recheck.status)}${recheck.reason ? ` — ${escapeTableCell(recheck.reason)}` : ""}` : "";
		return `| ${escapeTableCell(row.requirementId ?? row.id ?? "unknown")} | ${status(row.status)} | ${[escapeTableCell(reason), checked].filter(Boolean).join(" · ")} |`;
	};
	return reportSection(3, t("Requirement coverage", "요구사항 검토 범위"), [
		t("| Requirement | Status | Notes |", "| 요구사항 | 상태 | 메모 |"), "|---|---|---|", ...rows.map(cells),
		"",
		...rows.flatMap((row, index) => {
			const checked = boundCoverage[index];
			// Only a recomputed, bound audit of this exact citation (not a legacy
			// locator or its corrected replacement) already shows it as evidence.
			const evidence = asArray(row?.evidence).filter((citation, citationIndex) => {
				const audit = checked?.index === index && checked.id === row?.requirementId
					? checked.rows[citationIndex]
					: undefined;
				return !(audit?.field === "evidence" && audit.index === citationIndex && audit.status === "verified" &&
					stableStringify(audit.citation) === stableStringify(citation));
			});
			return evidence.length ? reportSection(4,
				`${t("Coverage citations (display-only; not byte verification)", "검토 범위 인용(참고용, 원문 미검증)")} — ${escapeMarkdownText(row?.requirementId ?? row?.id ?? "unknown")}`,
				evidence.flatMap((citation) => [...fenced(citation, isRecord(citation) ? "json" : "text"), ""]),
			) : [];
		}),
	]);
}

function renderEvidenceCorrections(partition, t) {
	const corrections = [
		...asArray(partition.evidenceCorrections),
		...asArray(partition.evidenceGate?.coverage).flatMap((row) => asArray(row?.corrections)),
	].filter(isRecord);
	return reportSection(3, t("Evidence corrections", "근거 위치 보정"), corrections.map((row) =>
		`- ${escapeMarkdownText(row.id)} ${escapeMarkdownText(row.field)}: ${escapeMarkdownText(row.file)} ${t("lines", "줄")} ${escapeMarkdownText(row.cited)} → ${escapeMarkdownText(row.actual)} (${row.reason === "whitespace" ? t("matches except whitespace or quote/dash characters", "공백 또는 인용 부호·대시를 빼면 일치함") : t("the quote occurs once in the file, at these lines", "파일에서 이 줄에만 인용이 있음")})`,
	));
}

function renderVerifierIntegrity(partition, t) {
	const coverage = partition.verifierCoverage ?? {};
	return reportSection(3, t("Verifier integrity", "검증 무결성"), [
		`- ${t("Candidates total/unique", "검토 후보 전체/고유")}: ${Number(coverage.candidateCount ?? 0)}/${Number(coverage.uniqueCandidateCount ?? 0)}`,
		`- ${t("Verifier rows total/unique", "검증 항목 전체/고유")}: ${Number(coverage.verifierCount ?? 0)}/${Number(coverage.uniqueVerifierCount ?? 0)}`,
		...[
			[t("Missing verification rows", "누락된 검증 항목"), partition.missingVerifications],
			[t("Orphan verifier rows", "후보가 없는 검증 항목"), partition.orphanVerifierResults],
			[t("Invalid verifier rows", "유효하지 않은 검증 항목"), partition.invalidVerifierResults],
			[t("Batch-integrity rows", "일괄 검증 무결성 문제"), partition.batchIntegrityIssues],
		].map(([label, rows]) => `- ${label}: ${asArray(rows).length}`),
		`- ${t("Owner ledger", "담당자 원장")}: ${asArray(coverage.ownerLedger).length}/${asArray(coverage.verifierRows).length} · ${coverage.ownerLedgerReconciliation?.passed === true ? t("Passed", "통과") : t("Failed", "실패")}`,
		...[ [t("Duplicate candidate IDs", "중복 후보 ID"), coverage.duplicateCandidateIds], [t("Duplicate verifier IDs", "중복 검증 ID"), coverage.duplicateVerifierIds] ]
			.filter(([, rows]) => asArray(rows).length).map(([label, rows]) => `- ${label}: ${rows.map((value) => escapeMarkdownText(value)).join(", ")}`),
		"", ...reportSection(4, t("Invalid verifier details", "유효하지 않은 검증 상세"), asArray(partition.invalidVerifierResults).flatMap((row) => [...fenced(row, "json"), ""])),
	]);
}

function limitationRows({
	sourceCoverageComplete,
	coverageComplete,
	duplicates,
	evidenceComplete,
	reportPresent,
	verdictConsistent,
	reportOwnerLedgerConsistent,
	gapsStand = false,
	partition = {},
	requirementReconciliation = {},
	narrativeVerdict = "",
	verdict = "",
	t = (en) => en,
}) {
	const rows = [];
	if (!sourceCoverageComplete)
		rows.push(
			t("Source lifecycle metadata is missing, partial, or inconsistent; complete conformance cannot be claimed.", "출처 상태 정보가 불완전해 요구사항을 모두 충족한다고 볼 수 없습니다."),
		);
	if (!coverageComplete)
		rows.push(
			t("Candidate-to-verifier coverage or verifier integrity is incomplete or inconsistent.", "검토 후보에 대한 검증 범위 또는 검증 무결성이 불완전합니다."),
		);
	if (duplicates.length > 0)
		rows.push(
			t(`Canonical disposition IDs are duplicated: ${duplicates.join(", ")}.`, `중복 판정 ID: ${duplicates.join(", ")}.`),
		);
	if (!evidenceComplete && gapsStand) {
		const statusOf = new Map(
			asArray(partition.requirementCoverage).map((row) => [
				cleanText(row?.requirementId),
				`${cleanText(row?.status) || "unknown"}${isRecord(row?.recheck) && row.recheck.from !== "unclear" ? `, re-checked: ${cleanText(row.recheck.status) || "unknown"}` : ""}`,
			]),
		);
		const unresolved = asArray(requirementReconciliation.unresolvedIds)
			.map(cleanText)
			.filter(Boolean);
		if (unresolved.length > 0)
			rows.push(
				t(`Requirements not settled by this review: ${unresolved
					.slice(0, 16)
					.map((id) => `${id} (${statusOf.get(id) ?? "unresolved"})`)
					.join(", ")}${unresolved.length > 16 ? `, and ${unresolved.length - 16} more` : ""}. The confirmed gaps stand; whether these requirements are met was not decided.`, `이번 검토에서 결론을 내리지 못한 요구사항: ${unresolved.slice(0, 16).join(", ")}${unresolved.length > 16 ? ` 외 ${unresolved.length - 16}개` : ""}. 확인된 차이의 판정은 유지됩니다.`),
			);
		const needsHuman = asArray(partition.needsHuman).length;
		if (needsHuman > 0)
			rows.push(
				t(`${needsHuman} needs-human row(s) remain unresolved (see Needs human review).`, `사람 검토가 필요한 항목 ${needsHuman}건이 미해결 상태입니다.`),
			);
		if (unresolved.length === 0 && needsHuman === 0)
			rows.push(
				t("Some evidence rows outside the confirmed gaps are incomplete or unverified; the confirmed gaps stand.", "확인된 차이 외의 일부 근거가 불완전하거나 미검증입니다. 확인된 차이의 판정은 유지됩니다."),
			);
	} else if (!evidenceComplete)
		rows.push(
			t("Local byte evidence or exact extracted-requirement reconciliation is incomplete, changed, or unverified; legacy locators cannot establish support or justify removal.", "파일 원문 또는 추출된 요구사항 대조가 불완전합니다. 이전 위치 정보만으로는 일치하거나 제외할 근거가 되지 않습니다."),
		);
	if (!reportPresent)
		rows.push(t("The narrative report synthesis is absent or malformed.", "종합 의견이 없거나 형식이 잘못되었습니다."));
	else if (!reportOwnerLedgerConsistent)
		rows.push(
			t("The narrative report owner ledger or reconciliation does not match the canonical partition ledger.", "종합 의견의 담당자 원장 또는 대조 결과가 원본 판정 원장과 일치하지 않습니다."),
		);
	else if (!verdictConsistent)
		rows.push(
			t(`The narrative report gave verdict ${narrativeVerdict || "none"}, which the deterministic ledger does not support; the report uses ${verdict}.`, `원장으로 뒷받침되지 않는 종합 판정(${reportStatus(narrativeVerdict || "none", t)}) 대신 ${reportStatus(verdict, t)} 판정을 적용합니다.`),
		);
	return rows;
}

function renderCompletionSummary({ verdict, report, partition, limitations, t }) {
	const finalFindings = asArray(partition.finalFindings);
	const needsHuman = asArray(partition.needsHuman);
	const keyRows = [
		...finalFindings.map((row) => ({ label: row.verdict, row })),
		...needsHuman.map((row) => ({ label: "NEEDS_HUMAN", row })),
	].slice(0, 4);
	const out = [
		`## ${t("Core conclusion", "핵심 결론")}`,
		"",
		`${t("Verdict", "판정")}: **${verdict}**. ${completionText(report.summary, 800, t)}`,
		"",
		`## ${t("Key gaps and actions", "주요 차이와 조치")}`,
		"",
	];
	if (keyRows.length === 0)
		out.push(`- ${t("No actionable or unresolved finding disposition remains.", "조치가 필요하거나 미해결인 발견 사항이 없습니다.")}`);
	else {
		for (const { label, row } of keyRows) {
			const action = cleanText(readerDiagnostic(row?.recommendedAction ?? row?.reason ?? "", t));
			out.push(
				`- **${completionInline(label)}:** ${completionText(rowTitle(row, t("Unresolved item", "미해결 항목")), 220, t)}${action ? ` — ${t("Action", "조치")}: ${completionText(action, 240, t)}` : ""}`,
			);
		}
		out.push(
			`- **${t("Next action", "다음 조치")}:** ${completionText(report.recommendedNextAction, 350, t)}`,
		);
		const omitted = finalFindings.length + needsHuman.length - keyRows.length;
		if (omitted > 0)
			out.push(
				`- ${t(`${omitted} additional disposition row(s) are covered in the full report.`, `나머지 판정 ${omitted}건은 전체 보고서에 있습니다.`)}`,
			);
	}
	out.push(
		"",
		`## ${t("Evidence level", "근거 수준")}`,
		"",
		`- ${t(`${finalFindings.length} actionable, ${needsHuman.length} needs-human, and ${asArray(partition.droppedFindings).length} dropped canonical disposition row(s).`, `원장 집계: 조치 필요 ${finalFindings.length}건, 사람 검토 ${needsHuman.length}건, 제외 ${asArray(partition.droppedFindings).length}건.`)}`,
		`- ${t("Source lifecycle and candidate/verifier accounting passed deterministic completeness checks.", "출처 상태와 검토 후보·검증 항목이 완전성 검사를 통과했습니다.")}`,
		"",
		`## ${t("Important limitations", "중요한 한계")}`,
		"",
	);
	const reportRisks = asArray(report.risks).map(cleanText).filter(Boolean);
	const scopeLimitations = asArray(partition.scopeLimitations)
		.filter((row) => row?.kind === "NONBLOCKING" && cleanText(row?.text))
		.map((row) => `${t("NONBLOCKING scope limitation", "비차단 범위 제한")}: ${cleanText(row.text)}`);
	const combined = [...limitations, ...scopeLimitations, ...reportRisks];
	if (combined.length === 0)
		out.push(
			`- ${t("No source-coverage or renderer-integrity limitation was recorded.", "출처 범위나 보고서 무결성 한계가 기록되지 않았습니다.")}`,
		);
	else
		for (const row of combined.slice(0, 6))
			out.push(`- ${completionText(row, 220, t)}`);
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderMarkdown({ verdict, report, partition, limitations, verdictConsistent, evidenceComplete, sourceCoverageComplete, verifiedCoverage, boundCoverage, t }) {
	const final = asArray(partition.finalFindings);
	const needs = asArray(partition.needsHuman);
	const dropped = asArray(partition.droppedFindings);
	const reqs = asArray(partition.requirementCoverage);
	const narrative = verdictConsistent && report.verdict === verdict ? shortNarrative(report.summary) : [];
	const outcome = {
		CONFORMS: t("The reviewed implementation meets the checked requirements.", "검토한 구현은 확인한 요구사항을 충족합니다."),
		GAPS_FOUND: t("The review confirmed gaps between the requirements and implementation.", "요구사항과 구현 사이의 차이가 확인되었습니다."),
		NEEDS_HUMAN: t("Unresolved items require human review.", "미해결 항목은 사람의 검토가 필요합니다."),
		INCONCLUSIVE: t("The evidence does not establish conformance.", "현재 근거로는 요구사항 충족 여부를 판단할 수 없습니다."),
	}[verdict];
	const coverage = verifiedCoverage
		? t(`${verifiedCoverage.covered}/${verifiedCoverage.total} requirements covered`, `요구사항 ${verifiedCoverage.total}개 중 ${verifiedCoverage.covered}개 충족`)
		: t("requirement coverage unproven", "요구사항 충족 범위 미입증");
	const actions = [
		{ label: t("Recommendation", "권고"), value: report.recommendedNextAction ?? t("Resolve renderer blockers, then rerun the spec review.", "보고서를 막는 문제를 해결한 뒤 명세 검토를 다시 실행하세요.") },
		...[[final, "finding"], [needs, "needs-human"]].flatMap(([rows, prefix]) => rows.map((row, index) => ({ label: rowIdentity(row, prefix, index), value: readerDiagnostic(row?.recommendedAction, t) }))),
	];
	const caveats = [
		...asArray(partition.scopeLimitations).filter((row) => isRecord(row) && row.text).map((row) => row.kind === "NONBLOCKING" ? `${t("NONBLOCKING scope limitation", "비차단 범위 제한")}: ${row.text}` : row.text),
		...asArray(report.risks).map((risk) => typeof risk === "string" ? risk : stableStringify(risk)),
		...limitations,
	];
	return [
		`# ${t("Spec review report", "명세 검토 보고서")}`, "",
		t(`Evidence: ${coverage} · ${final.length} actionable gaps · ${needs.length} need human review · byte checks ${evidenceComplete ? "complete" : "incomplete"}`, `근거: ${coverage} · 수정할 차이 ${final.length}건 · 사람 검토 ${needs.length}건 · 원문 대조 ${evidenceComplete ? "완료" : "미완료"}`), "",
		`## ${t("Conclusion", "결론")}`, "",
		`${t("Verdict", "판정")}: **${escapeMarkdownText(reportStatus(verdict, t))}**.`, "",
		...(narrative.length ? narrative : [outcome, ""]),
		...reportSection(3, t("Key points", "핵심 포인트"), [
			`- **${t("Source coverage", "출처 범위")}** — ${sourceCoverageComplete ? t("Complete", "완료") : t("Incomplete", "미완료")}`,
			`- **${t("Requirements not verified covered", "충족이 확인되지 않은 요구사항")}** — ${verifiedCoverage ? verifiedCoverage.total - verifiedCoverage.covered : t("Unproven", "미입증")}`,
		]),
		...reportSection(2, t("Limitations", "알아둘 한계"), [...new Set(caveats)].map((limit) => `- ${escapeMarkdownText(limit)}`)),
		...reportActions(t("Actions", "할 일"), actions),
		...reportSection(2, t("Conformance gaps", "요구사항과의 차이"), renderFindingRows(final, "finding", t)),
		...reportSection(2, t("Needs human review", "사람 검토 필요"), renderFindingRows(needs, "needs-human", t)),
		...reportSection(2, t("Appendix", "부록"), fold(t("Conformance review records", "명세 검토 기록"), [
			...(!narrative.length && report.summary ? reportSection(3, t("Synthesis narrative", "종합 의견 원문"), [escapeMarkdownText(report.summary)]) : []),
			...renderRequirementCoverage(reqs, boundCoverage, t),
			...reportSection(3, t("Ignored rechecks", "반영하지 않은 재확인"), asArray(partition.requirementRechecks?.ignored).flatMap((row) => [...fenced(row, "json"), ""])),
			...reportSection(3, t("Dropped findings", "제외한 발견 사항"), renderFindingRows(dropped, "dropped", t)),
			...reportSection(3, t("Preliminary no-issue observations (unverified)", "문제가 없다는 예비 관찰(미확인)"), asArray(partition.noIssueNotes).map((row) => `- ${escapeMarkdownText(typeof row === "string" ? row : stableStringify(row))}`)),
			...renderVerifierIntegrity(partition, t), ...renderEvidenceCorrections(partition, t),
			...reportSection(3, t("Byte evidence audit", "원문 대조 감사"), [
				`- ${partition.testExecutionAttested === false ? t("Tests were not run (read-only inspection).", "읽기 전용 검토로 테스트를 실행하지 않았습니다.") : t("Test execution was not attested.", "테스트 실행은 검증되지 않았습니다.")}`,
				"", ...fenced(partition.evidenceGate ?? { complete: false, reason: t("legacy partition has no byte gate", "이전 원장에 원문 대조 기록이 없습니다.") }, "json"),
			]),
			...reportSection(3, t("Related artifacts", "관련 자료"), [
				`- [${t("Machine-readable renderer control", "기계 판독용 보고서")}](control.json)`,
				`- [${t("Structured source references", "구조화된 출처")}](refs.json)`,
				`- [${t("Canonical disposition ledger", "판정 원장")}](source-ledger.json)`,
			]),
		])),
	].join("\n").trim(); // Never normalize newlines inside fenced evidence.
}

function blockedResult(reason) {
	return {
		schema: "spec-review-render-v1",
		digest: `Spec review rendering blocked: ${reason}.`,
		status: "blocked",
		blockers: [reason],
		completionSummaryMarkdown: "",
		markdown: "",
		verdict: "INCONCLUSIVE",
		findingSummary: { final: 0, needsHuman: 0, dropped: 0 },
		scopeLimitations: [],
		testExecutionAttested: false,
		renderedFindingIds: [],
		renderedNeedsHumanIds: [],
		renderedDroppedFindingIds: [],
		sourceArtifacts: [],
		gates: {
			partitionAvailable: false,
			reportSynthesisAvailable: false,
			ownerLedgerReconciliationPassed: false,
			sourceCoverageComplete: false,
			verifierCoverageComplete: false,
			reportVerdictConsistent: false,
			renderedAllCanonicalRows: false,
			duplicateCanonicalIds: [],
			actionableEvidenceComplete: false,
			passed: false,
		},
	};
}

export default async function renderSpecReviewReport({
	sources,
	context = {},
}) {
	let partition;
	let report;
	try {
		partition = findSource(sources, "partition-findings");
		report = findSource(sources, "report");
	} catch (error) {
		return blockedResult(error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(partition))
		return blockedResult("missing partition-findings control source");
	const reportPresent = reportAvailable(report);
	const finalFindings = asArray(partition.finalFindings);
	const needsHuman = asArray(partition.needsHuman);
	const droppedFindings = asArray(partition.droppedFindings);
	const renderedFindingIds = finalFindings.map((row, index) =>
		rowIdentity(row, "finding", index),
	);
	const renderedNeedsHumanIds = needsHuman.map((row, index) =>
		rowIdentity(row, "needs-human", index),
	);
	const renderedDroppedFindingIds = droppedFindings.map((row, index) =>
		rowIdentity(row, "dropped", index),
	);
	const missingRequiredIds = [
		...finalFindings.filter((row) => !cleanText(row?.id)),
		...droppedFindings.filter((row) => !cleanText(row?.id)),
	].length;
	const duplicates = duplicateCanonicalIds(
		finalFindings,
		needsHuman,
		droppedFindings,
	);
	const renderedAllCanonicalRows =
		missingRequiredIds === 0 &&
		renderedFindingIds.length === finalFindings.length &&
		renderedNeedsHumanIds.length === needsHuman.length &&
		renderedDroppedFindingIds.length === droppedFindings.length;
	const sourceCoverageComplete =
		partitionSourceCoverageComplete(partition) &&
		finalSourceCoverageComplete(context);
	const ownerLedgerReconciliationPassed = verifierOwnerLedgerComplete(partition);
	const runtimeCandidateUniverse = await rendererCandidateUniverse(context);
	const coverageComplete = verifierCoverageComplete(partition, runtimeCandidateUniverse);
	const evidenceAudit = await auditPartitionEvidence(partition, context);
	const evidenceComplete = evidenceAudit.evidenceComplete;
	const requirementReconciliation = evidenceAudit.requirementReconciliation;
	const reportOwnerLedgerConsistent =
		reportPresent &&
		stableStringify(ownerIdentityRows(report.ownerLedger)) ===
			stableStringify(ownerIdentityRows(partition.verifierCoverage?.ownerLedger)) &&
		stableStringify(report.ownerLedgerReconciliation) ===
			stableStringify(partition.verifierCoverage?.ownerLedgerReconciliation);
	const ledgerVerdict = requiredVerdict(
		partition,
		sourceCoverageComplete,
		coverageComplete,
		requirementReconciliation,
		evidenceAudit.gapsGrounded,
	);
	// agent-workflow 2026-11-04: confirmed gaps on an intact ledger pass with the unresolved
	// requirements and needs-human rows listed as limitations (specReviewVerdict).
	const gapsStand = ledgerVerdict === "GAPS_FOUND" && evidenceAudit.gapsGrounded;
	const deterministicVerdict =
		!evidenceComplete && ledgerVerdict === "CONFORMS"
			? "INCONCLUSIVE"
			: ledgerVerdict;
	const narrativeVerdictMatches =
		reportPresent && cleanText(report.verdict) === deterministicVerdict;
	// 2026-11-10 (owner): a narrative verdict that differs from the ledger's is a warning, not a failed render. The
	// ledger verdict stands, except that CONFORMS needs the narrative's agreement (else INCONCLUSIVE).
	const verdict =
		reportPresent && !narrativeVerdictMatches && deterministicVerdict === "CONFORMS"
			? "INCONCLUSIVE"
			: deterministicVerdict;
	const verdictConsistent = narrativeVerdictMatches && reportOwnerLedgerConsistent;
	const limitationInputs = {
		sourceCoverageComplete,
		coverageComplete,
		duplicates,
		evidenceComplete,
		reportPresent,
		verdictConsistent,
		reportOwnerLedgerConsistent,
		gapsStand,
		partition,
		requirementReconciliation,
		narrativeVerdict: reportPresent ? cleanText(report.verdict) : "",
		verdict,
	};
	const limitations = limitationRows(limitationInputs);
	const passed =
		reportPresent &&
		sourceCoverageComplete &&
		coverageComplete &&
		reportOwnerLedgerConsistent &&
		renderedAllCanonicalRows &&
		duplicates.length === 0 &&
		(evidenceComplete || gapsStand);
	const t = reportLocale(report?.summary, context.runtimeTask, ...finalFindings.map((row) => rowTitle(row, "")), ...needsHuman.map((row) => rowTitle(row, "")));
	const readerLimitations = limitationRows({ ...limitationInputs, t });
	const completionSummaryMarkdown = passed
		? renderCompletionSummary({ verdict, report, partition, limitations: readerLimitations, t })
		: "";
	const markdown = renderMarkdown({
		verdict,
		report: report ?? {},
		partition,
		limitations: readerLimitations,
		verdictConsistent, evidenceComplete, sourceCoverageComplete, verifiedCoverage: evidenceAudit.verifiedCoverage, boundCoverage: evidenceAudit.boundCoverage, t,
	});
	const blockers = limitations.slice(0, 32);
	const controlForDigest = {
		verdict,
		findingSummary: {
			final: finalFindings.length,
			needsHuman: needsHuman.length,
			dropped: droppedFindings.length,
		},
		renderedFindingIds,
		renderedNeedsHumanIds,
		renderedDroppedFindingIds,
		scopeLimitations: asArray(partition.scopeLimitations),
		testExecutionAttested: false,
		passed,
		markdown,
	};

	let sidecarPath;
	let ledgerSidecarPath;
	let sidecarFailure = null;
	try {
		if (context.cwd && context.runId && context.taskId) {
			const taskDir = join(
				context.stateCwd ?? context.cwd,
				".agent-workflow",
				"workflows",
				context.runId,
				"tasks",
				context.taskId,
			);
			await mkdir(taskDir, { recursive: true });
			await writeFile(join(taskDir, "final-report.md"), `${markdown}\n`, "utf8");
			await writeFile(
				join(taskDir, "source-ledger.json"),
				`${stableStringify({ schema: "spec-review-source-ledger-v1", partition, report: report ?? null })}\n`,
				"utf8",
			);
			sidecarPath = "final-report.md";
			ledgerSidecarPath = "source-ledger.json";
		}
	} catch (error) {
		// Sidecar publication is part of the documented delivery contract.
		sidecarFailure = `sidecar publication failed (${error?.code ?? "unknown_error"})`;
	}
	const effectivePassed = passed && !sidecarFailure;
	const effectiveBlockers = [
		...blockers,
		...(sidecarFailure ? [sidecarFailure] : []),
	].slice(0, 32);

	return {
		schema: "spec-review-render-v1",
		digest: `sha256:${createHash("sha256").update(stableStringify(controlForDigest)).digest("hex")}`,
		status: effectivePassed ? "passed" : "failed",
		...(effectiveBlockers.length > 0 ? { blockers: effectiveBlockers } : {}),
		completionSummaryMarkdown: effectivePassed ? completionSummaryMarkdown : "",
		markdown,
		verdict,
		findingSummary: controlForDigest.findingSummary,
		scopeLimitations: asArray(partition.scopeLimitations),
		testExecutionAttested: false,
		renderedFindingIds,
		renderedNeedsHumanIds,
		renderedDroppedFindingIds,
		sourceArtifacts: [
			"partition-findings.control.json",
			...(reportPresent ? ["report.control.json"] : []),
		],
		gates: {
			partitionAvailable: true,
			reportSynthesisAvailable: reportPresent,
			sourceCoverageComplete,
			verifierCoverageComplete: coverageComplete,
			ownerLedgerReconciliationPassed,
			reportVerdictConsistent: verdictConsistent,
			renderedAllCanonicalRows,
			duplicateCanonicalIds: duplicates,
			actionableEvidenceComplete: evidenceComplete,
			passed: effectivePassed,
		},
		...(sidecarPath ? { sidecarPath } : {}),
		...(ledgerSidecarPath ? { ledgerSidecarPath } : {}),
	};
}
