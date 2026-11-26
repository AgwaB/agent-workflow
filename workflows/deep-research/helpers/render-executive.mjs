import { validateSynthesisPages } from "./synthesis-pages.mjs";

// Deterministic evidence-backed renderer for deep-research.
//
// Input: final-audit.control.json from the full deep-research final stage.
// Output: a parent-facing research report in executiveMarkdown plus sidecars.
//
// This intentionally treats final-audit.control.json as the source of truth and
// renders a bounded view. It does not re-verify or invent evidence.

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { structuredDatesIn } from "./slot-conflicts.mjs";
import { canonicalVerificationStatus } from "./verification-ontology.mjs";
import { findSource, asArray, stringOf } from "./source-access.mjs";

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function flattenItems(value) {
	if (Array.isArray(value)) return value.flatMap((item) => flattenItems(item));
	if (typeof value === "string") return value.trim() ? [value] : [];
	if (!isRecord(value)) return [];
	const renderFields = [
		"gap",
		"finding",
		"claim",
		"note",
		"reason",
		"nextStep",
		"evidenceState",
		"whyItMatters",
		"parentImpact",
		"recommendation",
		"action",
		"step",
	];
	if (
		renderFields.some(
			(field) => typeof value[field] === "string" && value[field].trim(),
		)
	) {
		return [value];
	}
	if (
		value.id ||
		value.gapId ||
		value.slotId ||
		Array.isArray(value.relatedFactSlotIds) ||
		Array.isArray(value.sourceUrls) ||
		Array.isArray(value.sourceRefs)
	) {
		return [value];
	}
	return Object.values(value).flatMap((item) => flattenItems(item));
}

function words(text) {
	return (
		String(text ?? "")
			.trim()
			.match(/\S+/g) ?? []
	);
}

function countWords(text) {
	return words(text).length;
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		// Only before punctuation that ends a word: ".agent-workflow/…", " .env" keep their space (2026-11-04).
		.replace(/\s+([,.;:!?])(?=\s|$)/g, "$1")
		.trim();
}

/**
 * 2026-11-23: a claim the sanitizer rewrote to its source quote is often a Markdown table row
 * ("Node.js — v26 | Lithium | May 05, 2026 | Nov 10, 2026 | LTS"); shown as a heading or list item the pipes
 * read as raw source markup. The same words are rendered from the row's cells. Anything that is not clearly a
 * row (inline code, `||`, a separator-only row, fewer than two cells) is left exactly as it was.
 */
function readableClaimText(value) {
	const text = cleanText(value);
	if (!text || /^[{[]/.test(text) || text.includes("`") || !/\S\s*\|\s*\S/.test(text)) return text;
	const cells = text
		.split(/(?<!\|)\|(?!\|)/)
		.map((cell) => cell.trim())
		.filter((cell) => cell && !/^:?-{2,}:?$/.test(cell));
	if (cells.length < 2 || /\|\|/.test(text)) return text;
	return cells.join(" · ");
}

function escapeMarkdownText(value) {
	return cleanText(value)
		.replace(/([\\`*_[\]{}#+!<>])/g, "\\$1")
		.replace(/^(\s*)([-+>]\s)/gm, "$1\\$2");
}

function completionText(value) {
	return cleanText(value)
		// agent-workflow 2026-11-04 (live runs: "workflow-stop.ts" became "[run omitted]", a reviewed
		// file's "control.json" became "[artifact omitted]"): only this engine's own names are hidden —
		// paths under .agent-workflow/workflows, run ids (workflow_<id>_<hex6>), task ids (task-<n>),
		// sidecar names, and refs/control JSON only as a stage-qualified or path-qualified name.
		.replace(
			/(?<![\w-])\.agent-workflow[\\/]workflows(?:[\\/][^\s]*)?/gi,
			"[artifact omitted]",
		)
		.replace(/\b(?:final-report|executive|audit)\.md\b/gi, "[artifact omitted]")
		.replace(/(?<=[.\\/])(?:refs|control)\.json\b/gi, "[artifact omitted]")
		.replace(/\brelated[\s-]+artifacts\b/gi, "[section title omitted]")
		.replace(/\bworkflow\\?_[a-z0-9]+\\?_[a-f0-9]{6}\b/gi, "[run omitted]")
		.replace(/\btask-\d+\b/gi, "[task omitted]")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/([\\`*_[\]{}#+|])/g, "\\$1");
}

function escapeTableCell(value) {
	return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

function stringifyItem(item) {
	if (typeof item === "string") return cleanText(item) || "(empty string)";
	try {
		const json = JSON.stringify(item);
		if (json) return cleanText(json);
	} catch {
		// Fall through to String below.
	}
	return cleanText(String(item)) || "(empty item)";
}

function summaryText(report, fallback) {
	const summary = report?.summary;
	if (typeof summary === "string" && summary.trim()) return cleanText(summary);
	if (isRecord(summary)) {
		const parts = [
			summary.directAnswer,
			summary.answer,
			summary.summary,
			summary.finding,
		]
			.filter((value) => typeof value === "string" && value.trim())
			.map(cleanText);
		const confidence = cleanText(summary.confidence ?? "");
		const caveat = cleanText(summary.keyCaveat ?? summary.caveat ?? "");
		return (
			[
				parts[0],
				confidence ? `Confidence: ${confidence}.` : undefined,
				caveat ? `Key caveat: ${caveat}.` : undefined,
			]
				.filter(Boolean)
				.join(" ") || stringifyItem(summary)
		);
	}
	return cleanText(fallback ?? "Research completed with audited evidence.");
}

function hasObjectSerializationArtifact(text) {
	return /\[object Object\]/.test(String(text ?? ""));
}

function truncateWords(text, maxWords) {
	const items = words(text);
	if (items.length <= maxWords) return cleanText(text);
	return `${items
		.slice(0, maxWords)
		.join(" ")
		.replace(/[,:;]$/, "")}…`;
}

function hostOf(url) {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "source";
	}
}

function normalizeUrl(url) {
	if (typeof url !== "string") return null;
	const trimmed = url.trim().replace(/[.,;:]+$/, "");
	if (!/^https?:\/\//i.test(trimmed)) return null;
	try {
		const parsed = new URL(trimmed);
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return trimmed;
	}
}

function collectStructuredUrls(value, urls = []) {
	if (!value || typeof value !== "object") return urls;
	if (Array.isArray(value)) {
		for (const item of value) collectStructuredUrls(item, urls);
		return urls;
	}
	for (const [key, item] of Object.entries(value)) {
		if (
			/^(sourceUrls?|evidenceUrls?|urls?|url|uri|href|links?|references?|refs?|basis|sources)$/i.test(
				key,
			)
		) {
			for (const candidate of asArray(item).length ? item : [item]) {
				const normalized = normalizeUrl(candidate);
				if (normalized) urls.push(normalized);
				else if (candidate && typeof candidate === "object") {
					collectStructuredUrls(candidate, urls);
				}
			}
			continue;
		}
		if (item && typeof item === "object") collectStructuredUrls(item, urls);
	}
	return urls;
}

function uniqueStructuredUrls(...values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		for (const url of collectStructuredUrls(value, [])) {
			if (seen.has(url)) continue;
			seen.add(url);
			out.push(url);
		}
	}
	return out;
}

function urlsOf(item, limit = 3) {
	return uniqueStructuredUrls(item).slice(0, limit);
}

function normalizeLocalRef(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text || /[\r\n`]/u.test(text) || /^https?:\/\//i.test(text) || isWorkflowSourceRefText(text))
		return null;
	const stripped = text.replace(/^(?:file|repo):/i, "");
	if (!/[\w./-]+\.[\w]+(?:#L\d+(?:-L?\d+)?)?$/i.test(stripped)) return null;
	return stripped;
}

function isWorkflowSourceRefText(value) {
	return /^wsrc_[a-z0-9]{16,}$/i.test(String(value ?? "").trim());
}

function collectLocalRefs(value, refs = []) {
	if (!value || typeof value !== "object") return refs;
	if (Array.isArray(value)) {
		for (const item of value) collectLocalRefs(item, refs);
		return refs;
	}
	for (const [key, item] of Object.entries(value)) {
		if (/^(files?|paths?|sourceRefs?|sourceUrls?|sources?)$/i.test(key)) {
			for (const candidate of asArray(item).length ? item : [item]) {
				const ref = normalizeLocalRef(candidate);
				if (ref) refs.push(ref);
				else if (candidate && typeof candidate === "object")
					collectLocalRefs(candidate, refs);
			}
			continue;
		}
		if (item && typeof item === "object") collectLocalRefs(item, refs);
	}
	return refs;
}

function localRefsOf(item, limit = 3) {
	const out = [];
	const seen = new Set();
	for (const ref of collectLocalRefs(item, [])) {
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push(ref);
		if (out.length >= limit) break;
	}
	return out;
}

function referenceList(item, limit = 3) {
	const urls = markdownLinkList(urlsOf(item, limit), limit);
	const localRefs = localRefsOf(item, limit)
		.map((ref) => `\`${ref}\``)
		.join(", ");
	return [urls, localRefs].filter(Boolean).join("; ");
}

function markdownLinkList(urls, maxItems = 3) {
	return urls
		.slice(0, maxItems)
		.map(
			(url) =>
				`[${escapeMarkdownText(hostOf(url))}](<${normalizeUrl(url) ?? ""}>)`,
		)
		.join(", ");
}

function itemText(item, fields, fallback = "") {
	if (typeof item === "string") return escapeMarkdownText(item) || fallback;
	if (!item || typeof item !== "object") return escapeMarkdownText(fallback);
	for (const field of fields) {
		if (typeof item[field] === "string" && item[field].trim()) {
			return escapeMarkdownText(item[field]);
		}
	}
	return escapeMarkdownText(fallback);
}

function evidenceStatusOf(item) {
	if (!item || typeof item !== "object") return "not specified";
	return cleanText(
		item.evidenceStatus ??
			item.status ??
			item.confidence ??
			item.sourceQuality ??
			"not specified",
	);
}

function finiteNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeClaimStatus(status) {
	const text = cleanText(status);
	const lower = text.toLowerCase();
	if (!text) return "";
	// Packet partitions use the public bucket spelling (for example,
	// verificationBlocked), while claim rows use the canonical snake-case
	// spelling. Normalize aliases before lower-casing so a blocked claim cannot
	// silently fall into the unverified bucket.
	const bucketAliases = {
		partiallysupported: "partially_supported",
		verificationblocked: "verification_blocked",
	};
	if (bucketAliases[lower]) return bucketAliases[lower];
	const canonical = canonicalVerificationStatus(text);
	if (canonical !== "unverified") return canonical;
	if (
		text === "unverified" ||
		text.includes("not verified") ||
		text.includes("not_verified")
	)
		return "unverified";
	if (
		text.includes("verification_blocked") ||
		text.includes("verification blocked")
	)
		return "verification_blocked";
	if (text.includes("conflict")) return "conflicting";
	if (text.includes("unsupported")) return "unsupported";
	if (text.includes("partial")) return "partially_supported";
	if (/\bverified\b/.test(text)) return "verified";
	return canonical;
}

function coverageCounts(coverage, fallback) {
	if (!coverage || typeof coverage !== "object") return null;
	const counts = {
		total: finiteNumber(coverage.verificationCandidates) ?? fallback.total,
		verified: finiteNumber(coverage.verified) ?? fallback.verified,
		partially_supported:
			finiteNumber(coverage.partiallySupported) ??
			finiteNumber(coverage.partially_supported) ??
			fallback.partially_supported,
		unsupported: finiteNumber(coverage.unsupported) ?? fallback.unsupported,
		conflicting: finiteNumber(coverage.conflicting) ?? fallback.conflicting,
		verification_blocked:
			finiteNumber(coverage.verificationBlocked) ??
			finiteNumber(coverage.verification_blocked) ??
			fallback.verification_blocked,
	};
	if (counts.total == null) {
		counts.total =
			counts.verified +
			counts.partially_supported +
			counts.unsupported +
			counts.conflicting +
			counts.verification_blocked;
	}
	return counts;
}

function packetVerdictCounts(packet, fallback) {
	const verdicts = packet?.verdictCounts;
	if (!isRecord(verdicts)) return null;
	const counts = coverageCounts(verdicts, fallback);
	if (!counts) return null;
	const auditedStatusTotal =
		counts.verified +
		counts.partially_supported +
		counts.unsupported +
		counts.conflicting +
		counts.verification_blocked;
	counts.total =
		finiteNumber(packet?.invariantChecks?.auditedClaimCount) ??
		auditedStatusTotal;
	return counts;
}

function claimCounts(control, packet) {
	const claims = asArray(control?.claimVerdictIndex?.claims);
	const counts = {
		total: claims.length,
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
		verification_blocked: 0,
	};
	for (const claim of claims) {
		const status = normalizeClaimStatus(claim?.status);
		if (status && Object.hasOwn(counts, status)) counts[status] += 1;
	}
	const packetCounts = packetVerdictCounts(packet, counts);
	if (packetCounts) return packetCounts;

	const coverage = coverageCounts(control?.finalReport?.coverageSummary, counts);
	if (claims.length === 0 && coverage) return coverage;
	if (!coverage) return counts;

	const mismatches = [];
	for (const key of [
		"total",
		"verified",
		"partially_supported",
		"unsupported",
		"conflicting",
		"verification_blocked",
	]) {
		if (coverage[key] !== counts[key]) {
			mismatches.push({
				field: key,
				claimVerdictIndex: counts[key],
				coverageSummary: coverage[key],
			});
		}
	}
	return mismatches.length > 0
		? { ...counts, coverageSummaryMismatch: mismatches }
		: counts;
}

function factSlotSummary(factSlots) {
	return {
		total: factSlots.length,
		filled: factSlots.filter((slot) => slot?.status === "filled").length,
		partial: factSlots.filter((slot) => slot?.status === "partial").length,
		missingOrConflicting: factSlots.filter((slot) =>
			["missing", "gap", "conflicting"].includes(slot?.status),
		).length,
	};
}

function stringArray(value, limit = Infinity) {
	const out = [];
	const seen = new Set();
	for (const item of asArray(value)) {
		if (typeof item !== "string") continue;
		const text = item.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function uniqueStrings(values, limit = Infinity) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function packetOf(packetSource) {
	return isRecord(packetSource?.packet) ? packetSource.packet : {};
}

function hasOwn(record, key) {
	return isRecord(record) && Object.prototype.hasOwnProperty.call(record, key);
}

function exactKeys(record, allowed) {
	return (
		isRecord(record) && Object.keys(record).every((key) => allowed.includes(key))
	);
}

function boundedString(value, minLength, maxLength) {
	const length = typeof value === "string" ? [...value].length : -1;
	return typeof value === "string" && length >= minLength && length <= maxLength;
}

function boundedArray(value, maxItems, itemCheck) {
	return (
		Array.isArray(value) && value.length <= maxItems && value.every(itemCheck)
	);
}

function boundedStringArray(value, maxItems) {
	return boundedArray(value, maxItems, (item) => typeof item === "string");
}

function modernComparisonValid(item) {
	return Boolean(
		isRecord(item) &&
			boundedString(item.area, 1, 200) &&
			boundedString(item.subjectStatus, 1, 800) &&
			boundedString(item.referencePattern, 1, 800) &&
			boundedString(item.assessment, 1, 800) &&
			boundedStringArray(item.supportingClaimIds, 8) &&
			(!hasOwn(item, "evidenceStatus") ||
				typeof item.evidenceStatus === "string"),
	);
}

function modernRecommendationValid(item) {
	return Boolean(
		isRecord(item) &&
			boundedString(item.recommendation, 1, 1200) &&
			boundedStringArray(item.supportingClaimIds, 8) &&
			(!hasOwn(item, "evidenceStatus") ||
				typeof item.evidenceStatus === "string") &&
			(!hasOwn(item, "rationale") || boundedString(item.rationale, 0, 1200)),
	);
}

function singleLine(value, maxLength) {
	return boundedString(value, 1, maxLength) && /\S/u.test(value) && !/[\r\n]/u.test(value);
}

export function synthesisSummary(synthesis) {
	return Array.isArray(synthesis?.conclusion) ? synthesis.conclusion.join(" ") : stringOf(synthesis?.bottomLine);
}

function synthesisConclusionValid(synthesis) {
	if (!hasOwn(synthesis, "conclusion") && !hasOwn(synthesis, "keyPoints"))
		return boundedString(synthesis?.bottomLine, 1, 4000);
	return !hasOwn(synthesis, "bottomLine") &&
		boundedArray(synthesis.conclusion, 3, (line) => singleLine(line, 220) && sentences(line).length === 1) &&
		synthesis.conclusion.length >= 2 &&
		boundedArray(synthesis.keyPoints, 6, (point) =>
			exactKeys(point, ["title", "text"]) && singleLine(point.title, 64) && singleLine(point.text, 160));
}

function modernActionValid(item) {
	return Boolean(
		isRecord(item) &&
			boundedString(item.action, 1, 1200) &&
			(!hasOwn(item, "recommendationNumbers") ||
				(boundedArray(item.recommendationNumbers, 12, (n) => Number.isInteger(n) && n >= 1 && n <= 12) &&
				new Set(item.recommendationNumbers).size === item.recommendationNumbers.length)) &&
			boundedStringArray(item.supportingClaimIds, 8) &&
			(!hasOwn(item, "evidenceStatus") || typeof item.evidenceStatus === "string"),
	);
}

function modernCaveatValid(item) {
	return Boolean(
		isRecord(item) &&
			boundedString(item.note, 1, 1200) &&
			(!hasOwn(item, "readerNote") || boundedString(item.readerNote, 1, 1200)) &&
			(!hasOwn(item, "relatedClaimIds") ||
				boundedStringArray(item.relatedClaimIds, 8)) &&
			(!hasOwn(item, "gapIds") || boundedStringArray(item.gapIds, 8)),
	);
}

function modernDecisionValid(item) {
	return Boolean(
		isRecord(item) &&
			boundedString(item.note, 1, 1200) &&
			boundedString(item.whyItMatters, 1, 1200) &&
			typeof item.evidenceStatus === "string" &&
			boundedString(item.suggestedParentDecision, 0, 1200) &&
			(!hasOwn(item, "supportingClaimIds") ||
				boundedStringArray(item.supportingClaimIds, 8)),
	);
}

/** 2026-11-03: the container must have its shape; single entries are checked when applied. */
function translationsValid(value) {
	return (
		exactKeys(value, ["claims", "factSlots"]) &&
		(!hasOwn(value, "claims") || boundedArray(value.claims, 96, isRecord)) &&
		(!hasOwn(value, "factSlots") || boundedArray(value.factSlots, 64, isRecord))
	);
}

/** 2026-11-01: v2 declares its packet intake; v1 and older v2 outputs carry none. */
function inputIntegrityValid(control) {
	if (!hasOwn(control, "inputIntegrity")) return true;
	const integrity = control.inputIntegrity;
	return (
		exactKeys(integrity, ["status", "reason", "detail"]) &&
		["complete", "blocked"].includes(integrity.status) &&
		(!hasOwn(integrity, "reason") ||
			[
				"truncated_read",
				"missing_read",
				"inconsistent_input",
				"budget_block",
			].includes(integrity.reason)) &&
		(!hasOwn(integrity, "detail") || boundedString(integrity.detail, 0, 600))
	);
}

function validModernFinalAudit(control) {
	const synthesis = control?.synthesis;
	const synthesisKeys = [
		"bottomLine",
		"conclusion",
		"keyPoints",
		"openQuestion",
		"comparisonRows",
		"keyFindingIds",
		"recommendations",
		"actionPlan",
		"caveatNotes",
		"parentDecisionNotes",
		"notableUnsupportedClaimIds",
		"contestedClaimIds",
		"translations",
	];
	const modernSchema =
		control?.schema === "deep-research-final-synthesis-v1" ||
		control?.schema === "deep-research-final-synthesis-v2";
	const comparisonRowsValid = hasOwn(synthesis, "comparisonRows")
		? boundedArray(synthesis.comparisonRows, 8, modernComparisonValid)
		: control?.schema === "deep-research-final-synthesis-v1";
	return Boolean(
		exactKeys(control, ["schema", "digest", "inputIntegrity", "synthesis"]) &&
			inputIntegrityValid(control) &&
			modernSchema &&
			boundedString(control.digest, 1, 1200) &&
			exactKeys(synthesis, synthesisKeys) &&
			synthesisConclusionValid(synthesis) &&
			(!hasOwn(synthesis, "openQuestion") || singleLine(synthesis.openQuestion, 180)) &&
			comparisonRowsValid &&
			boundedStringArray(synthesis.keyFindingIds, 12) &&
			boundedArray(synthesis.recommendations, 12, modernRecommendationValid) &&
			boundedArray(synthesis.actionPlan, 12, modernActionValid) &&
			boundedArray(synthesis.caveatNotes, 16, modernCaveatValid) &&
			boundedArray(synthesis.parentDecisionNotes, 12, modernDecisionValid) &&
			(!hasOwn(synthesis, "notableUnsupportedClaimIds") ||
				boundedStringArray(synthesis.notableUnsupportedClaimIds, 12)) &&
			(!hasOwn(synthesis, "contestedClaimIds") ||
				boundedStringArray(synthesis.contestedClaimIds, 12)) &&
			(!hasOwn(synthesis, "translations") ||
				translationsValid(synthesis.translations)),
	);
}

function validLegacyFinalAudit(control) {
	const report = control?.finalReport;
	return Boolean(
		isRecord(control) &&
			boundedString(control.schema, 1, Infinity) &&
			boundedString(control.digest, 1, Infinity) &&
			isRecord(report) &&
			[
				"researchMetadata",
				"coverageSummary",
				"recommendations",
				"actionPlan",
				"remainingGaps",
			].every((field) => hasOwn(report, field)) &&
			boundedArray(report.factSlotCoverage, 64, isRecord) &&
			boundedArray(report.mainFindings, 12, isRecord) &&
			boundedArray(report.parentDecisionNotes, 12, isRecord) &&
			boundedArray(report.unverifiedButRelevant, 16, isRecord) &&
			isRecord(control.claimVerdictIndex) &&
			boundedArray(control.claimVerdictIndex.claims, 64, isRecord),
	);
}

function validFinalAuditPacket(packetSource) {
	const packet = packetSource?.packet;
	const synthesisInput = packet?.synthesisInput;
	return Boolean(
		exactKeys(packetSource, ["schema", "digest", "packet"]) &&
			packetSource.schema === "deep-research-final-audit-packet-v1" &&
			boundedString(packetSource.digest, 1, 1200) &&
			isRecord(packet) &&
			[
				"researchMetadataSeed",
				"verdictCounts",
				"statusPartitions",
				"factSlotStatusCounts",
				"verifierIntegrity",
				"normalizerDiagnostics",
				"invariantChecks",
				"overflowLedger",
			].every((field) => isRecord(packet[field])) &&
			[
				"factSlotCoverage",
				"coverageGaps",
				"remainingGaps",
				"sourceRefJoinFailures",
				"claimVerdictLedger",
				"preservedClaims",
				"researchScopeCoverage",
			].every((field) => boundedArray(packet[field], Infinity, isRecord)) &&
			isRecord(synthesisInput),
	);
}

function claimIdOf(row) {
	return cleanText(row?.id ?? row?.claimId ?? "");
}

function gapIdOf(row) {
	return cleanText(row?.id ?? row?.gapId ?? "");
}

function claimLedger(packet, control) {
	const packetLedger = asArray(packet?.claimVerdictLedger);
	return packetLedger.length
		? packetLedger
		: asArray(control?.claimVerdictIndex?.claims);
}

function mapById(rows, idFn) {
	const out = new Map();
	for (const row of rows) {
		const id = idFn(row);
		if (id && !out.has(id)) out.set(id, row);
	}
	return out;
}

function numberedId(prefix, index) {
	return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function duplicateIds(rows, idFn) {
	const counts = new Map();
	for (const row of rows) {
		const id = idFn(row);
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => id);
}

function packetDuplicateIds(packet, control) {
	const ledger = claimLedger(packet, control);
	const gaps = packetGapRows(packet);
	return {
		claimIds: duplicateIds(ledger, claimIdOf),
		gapIds: duplicateIds(gaps, gapIdOf),
	};
}

function duplicateIdRenderResult(duplicates) {
	const blockers = [];
	if (duplicates.claimIds.length > 0)
		blockers.push(`duplicate claim IDs: ${duplicates.claimIds.join(", ")}`);
	if (duplicates.gapIds.length > 0)
		blockers.push(`duplicate gap IDs: ${duplicates.gapIds.join(", ")}`);
	return {
		schema: "deep-research-executive-render-v1",
		digest: `Research report rendering blocked: ${blockers.join("; ")}`,
		status: "failed",
		blockers,
		completionSummaryMarkdown: "",
		executiveMarkdown: "",
		reportMarkdown: "",
		auditMarkdown: "",
		wordCount: 0,
		sourceUrlCount: 0,
		totalSourceUrlCount: 0,
		sourceUrls: [],
		sourceIndex: [],
		claimSummary: {
			total: 0,
			verified: 0,
			partially_supported: 0,
			unsupported: 0,
			conflicting: 0,
			verification_blocked: 0,
		},
		factSlotSummary: { total: 0, filled: 0, partial: 0, missingOrConflicting: 0 },
		sectionCounts: {},
		renderWarnings: [],
		duplicateClaimIds: duplicates.claimIds,
		duplicateGapIds: duplicates.gapIds,
		gates: {
			renderedAllStructuredItems: false,
			duplicateClaimIds: duplicates.claimIds,
			duplicateGapIds: duplicates.gapIds,
			passed: false,
		},
		auditArtifact: "final-audit.control.json",
	};
}

function sameIdMultiset(left, right) {
	if (
		!Array.isArray(left) ||
		!Array.isArray(right) ||
		left.length !== right.length
	)
		return false;
	const counts = new Map();
	for (const id of left) counts.set(id, (counts.get(id) ?? 0) + 1);
	for (const id of right) {
		const count = counts.get(id) ?? 0;
		if (count === 0) return false;
		if (count === 1) counts.delete(id);
		else counts.set(id, count - 1);
	}
	return counts.size === 0;
}

function packetStatusKey(status) {
	const normalized = normalizeClaimStatus(status);
	return normalized || "unverified";
}

function packetCountMap(rows) {
	const counts = {
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
		verification_blocked: 0,
		unverified: 0,
	};
	for (const row of rows) {
		const status = packetStatusKey(row?.status ?? row?.verdict);
		if (Object.hasOwn(counts, status)) counts[status] += 1;
	}
	return counts;
}

function packetStatusIds(packet) {
	const partitions = packet?.statusPartitions;
	if (!isRecord(partitions)) return null;
	const result = {};
	for (const [key, value] of Object.entries(partitions)) {
		const status = packetStatusKey(key);
		if (!Array.isArray(value)) return { invalid: true };
		result[status] = [
			...(result[status] ?? []),
			...value.filter((id) => typeof id === "string" && id.trim()),
		];
	}
	return result;
}

function numberMatches(actual, expected) {
	return (
		Number.isSafeInteger(Number(actual)) &&
		Number(actual) >= 0 &&
		Number(actual) === Number(expected)
	);
}

function ownerKey(owner) {
	if (!isRecord(owner)) return "";
	return [
		owner.source,
		owner.stageId,
		owner.specId,
		owner.taskId,
		owner.itemIdentity,
		owner.placeholderSpecId,
		owner.batchId ?? "",
		owner.status,
	]
		.map((value) => String(value ?? ""))
		.join("\u001f");
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
		owner.specId === `${owner.stageId}.${owner.batchId ?? owner.itemIdentity}` &&
		owner.placeholderSpecId === `${owner.stageId}.item` &&
		(owner.batchId === undefined || owner.itemIdentity === owner.batchId)
	);
}

function reconcileVerifierOwners(packet, ledger) {
	const owners = asArray(packet?.verifierIntegrity?.verifierOwnerLedger);
	const blockers = [];
	const ownerByKey = new Map();
	for (const owner of owners) {
		const key = ownerKey(owner);
		if (!exactOwnerShape(owner))
			blockers.push(
				"verifier owner ledger contains an incomplete or non-completed owner",
			);
		if (!key) continue;
		if (ownerByKey.has(key))
			blockers.push("verifier owner ledger contains duplicate owners");
		ownerByKey.set(key, owner);
	}
	const claimOwners = [];
	for (const claim of ledger) {
		if (!isRecord(claim?.verifierOwner)) {
			blockers.push(`claim owner is missing: ${claimIdOf(claim) || "unknown"}`);
			continue;
		}
		const key = ownerKey(claim.verifierOwner);
		claimOwners.push(key);
		if (!ownerByKey.has(key))
			blockers.push(
				`claim owner is absent from owner ledger: ${claimIdOf(claim) || "unknown"}`,
			);
	}
	for (const key of ownerByKey.keys()) {
		if (!claimOwners.includes(key))
			blockers.push("verifier owner ledger contains an orphan owner");
	}
	if (ledger.length > 0 && owners.length === 0)
		blockers.push("verifier owner ledger is missing");
	return {
		passed: blockers.length === 0,
		blockers,
		checks: {
			ownerRowCount: owners.length,
			claimOwnerRowCount: claimOwners.length,
		},
	};
}

// A packet emitted by final-audit-packet has all of these ledgers. Older
// final-audit fixtures intentionally provide only a legacy report/claim index;
// retain their rendering behavior while making the real packet contract strict.
function packetHasCompleteContract(packet) {
	return (
		isRecord(packet) &&
		Array.isArray(packet.claimVerdictLedger) &&
		isRecord(packet.verdictCounts) &&
		isRecord(packet.statusPartitions) &&
		Array.isArray(packet.factSlotCoverage) &&
		isRecord(packet.factSlotStatusCounts) &&
		isRecord(packet.verifierIntegrity) &&
		Array.isArray(packet.verifierIntegrity.verifierOwnerLedger) &&
		Array.isArray(packet.verifierIntegrity.verifierOwnerIssues) &&
		Array.isArray(packet.verifierIntegrity.invalidNormalizedCandidateRows) &&
		isRecord(packet.invariantChecks) &&
		Array.isArray(packet.invariantChecks.candidateIds) &&
		Array.isArray(packet.invariantChecks.auditedClaimIds) &&
		isRecord(packet.overflowLedger)
	);
}

function reconcileFinalPacket(packet, control) {
	const blockers =
		validModernFinalAudit(control) ||
		packetHasCompleteContract(packet) ||
		packet?.synthesisInput
			? validateSynthesisPages(packet)
			: [];
	if (!packetHasCompleteContract(packet)) {
		return { strict: false, passed: blockers.length === 0, blockers, checks: {} };
	}
	const ledger = packet.claimVerdictLedger;
	const questionIntegrity =
		packet.researchQuestionIntegrity ??
		packet.invariantChecks?.researchQuestionIntegrity;
	if (
		isRecord(questionIntegrity) &&
		typeof questionIntegrity.passed === "boolean"
	) {
		if (questionIntegrity.passed !== true)
			blockers.push("research-question coverage is incomplete or inconsistent");
		for (const field of [
			"missingIds",
			"duplicateIds",
			"extraIds",
			"failedIds",
			"plannedDuplicateIds",
			"invalidOutputSourceIds",
		])
			if (asArray(questionIntegrity[field]).length > 0)
				blockers.push(`research-question ${field} are present`);
		if (Number(questionIntegrity.invalidPlannedQuestionCount ?? 0) > 0)
			blockers.push("research-question plan contains invalid identities");
	} else if (Number(packet.researchMetadataSeed?.researchQuestions ?? 0) > 0) {
		blockers.push("research-question integrity ledger is missing");
	}
	if (asArray(packet.invariantChecks?.droppedSlotIds).length > 0)
		blockers.push("planned fact slots were dropped from coverage");
	if (
		Number(
			packet.invariantChecks?.verifierIntegrity?.zeroCandidateFloorBlockers ?? 0,
		) > 0
	)
		blockers.push("verification floor blockers are present");
	const ledgerIds = ledger.map(claimIdOf);
	const ownerReconciliation = reconcileVerifierOwners(packet, ledger);
	if (!ownerReconciliation.passed)
		blockers.push(...ownerReconciliation.blockers);
	const ledgerIdSet = new Set(ledgerIds.filter(Boolean));
	if (ledgerIds.some((id) => !id) || ledgerIdSet.size !== ledgerIds.length)
		blockers.push("packet claim ledger has missing or duplicate IDs");
	const counts = packetCountMap(ledger);
	const packetCounts = packetVerdictCounts(packet, counts) ?? {};
	for (const key of [
		"verified",
		"partially_supported",
		"unsupported",
		"conflicting",
		"verification_blocked",
	]) {
		if (!numberMatches(packetCounts[key], counts[key]))
			blockers.push(`packet count mismatch: ${key}`);
	}
	const invariant = packet.invariantChecks;
	const auditedCount = Number(invariant.auditedClaimCount);
	const candidateCount = Number(invariant.candidateCount);
	const omitted = asArray(invariant.omittedCandidateIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	if (!numberMatches(auditedCount, ledger.length))
		blockers.push("audited claim count does not match claim ledger");
	if (
		!Number.isSafeInteger(candidateCount) ||
		candidateCount < ledger.length ||
		candidateCount !== ledger.length + omitted.length
	)
		blockers.push("candidate/audited/omitted counts do not reconcile");
	if (
		Array.isArray(invariant.auditedClaimIds) &&
		!sameIdMultiset(invariant.auditedClaimIds, ledgerIds)
	)
		blockers.push("audited claim IDs do not match claim ledger");
	if (Array.isArray(invariant.candidateIds)) {
		if (new Set(invariant.candidateIds).size !== invariant.candidateIds.length)
			blockers.push("candidate IDs are duplicated");
		if (invariant.candidateIds.length !== candidateCount)
			blockers.push("candidate ID count does not match candidate count");
		const candidateSet = new Set(invariant.candidateIds);
		if (ledgerIds.some((id) => !candidateSet.has(id)))
			blockers.push("audited claim is absent from candidate ledger");
	}
	const statusTotal = Object.values(counts).reduce(
		(total, count) => total + count,
		0,
	);
	if (statusTotal !== ledger.length)
		blockers.push("claim status counts do not sum to the claim ledger");
	const partitions = packetStatusIds(packet);
	if (!partitions || partitions.invalid)
		blockers.push("packet status partitions are malformed");
	else {
		if (isRecord(invariant.statusPartitionIds)) {
			const invariantPartitions = packetStatusIds({
				statusPartitions: invariant.statusPartitionIds,
			});
			const partitionKeys = new Set(Object.keys(partitions));
			const invariantKeys = new Set(Object.keys(invariantPartitions ?? {}));
			const sameKeys =
				partitionKeys.size === invariantKeys.size &&
				[...partitionKeys].every((key) => invariantKeys.has(key));
			if (
				!invariantPartitions ||
				invariantPartitions.invalid ||
				!sameKeys ||
				[...partitionKeys].some(
					(key) => !sameIdMultiset(invariantPartitions[key], partitions[key]),
				)
			)
				blockers.push("invariant status partitions do not match packet partitions");
		}
		const partitionIds = Object.values(partitions).flat();
		if (!sameIdMultiset(partitionIds, ledgerIds))
			blockers.push("status partitions do not cover the claim ledger");
		for (const [status, ids] of Object.entries(partitions)) {
			const expected = ledger
				.filter(
					(claim) => packetStatusKey(claim?.status ?? claim?.verdict) === status,
				)
				.map(claimIdOf);
			if (!sameIdMultiset(ids, expected))
				blockers.push(`status partition mismatch: ${status}`);
		}
	}
	const slots = packet.factSlotCoverage;
	const slotIds = slots.map((slot) => cleanText(slot?.slotId ?? slot?.id));
	if (slotIds.some((id) => !id) || new Set(slotIds).size !== slotIds.length)
		blockers.push("fact-slot ledger has missing or duplicate IDs");
	const slotCounts = {};
	for (const slot of slots) {
		const status = cleanText(slot?.status ?? "unknown") || "unknown";
		slotCounts[status] = (slotCounts[status] ?? 0) + 1;
	}
	for (const [status, count] of Object.entries(slotCounts)) {
		if (Number(packet.factSlotStatusCounts[status] ?? 0) !== count)
			blockers.push(`fact-slot count mismatch: ${status}`);
	}
	for (const [status, count] of Object.entries(packet.factSlotStatusCounts)) {
		if (Number(count) !== Number(slotCounts[status] ?? 0))
			blockers.push(`fact-slot count has extra status: ${status}`);
	}
	const candidateSet = new Set(
		Array.isArray(invariant.candidateIds) ? invariant.candidateIds : [],
	);
	const slotById = new Map(
		slots.map((slot) => [cleanText(slot?.slotId ?? slot?.id), slot]),
	);
	for (const slot of slots) {
		for (const candidateId of asArray(slot?.verificationCandidateIds)) {
			if (candidateSet.size > 0 && !candidateSet.has(candidateId))
				blockers.push(`fact-slot references unknown candidate: ${candidateId}`);
		}
	}
	for (const claim of ledger) {
		for (const slotId of asArray(claim?.factSlotIds)) {
			const slot = slotById.get(cleanText(slotId));
			if (!slot) blockers.push(`claim references unknown fact slot: ${slotId}`);
			else if (
				Array.isArray(slot.verificationCandidateIds) &&
				slot.verificationCandidateIds.length > 0 &&
				!slot.verificationCandidateIds.includes(claimIdOf(claim))
			)
				blockers.push(
					`fact-slot candidate mapping omits audited claim: ${claimIdOf(claim)}`,
				);
		}
	}
	const integrity = packet.verifierIntegrity;
	// Previously checked against the independently counted synthesis digest.
	// Lossless pages copy the full metadata, so retain this canonical count gate
	// directly rather than letting two identical contradictory copies agree.
	if (
		integrity.gateSummary?.sourceRefJoinFailures !== undefined &&
		!numberMatches(
			integrity.gateSummary.sourceRefJoinFailures,
			asArray(packet.sourceRefJoinFailures).length,
		)
	)
		blockers.push("gate source-ref count does not match rows");
	const invalidNormalizedRows = asArray(
		integrity.invalidNormalizedCandidateRows,
	);
	if (
		!numberMatches(
			integrity.invalidNormalizedCandidateCount,
			invalidNormalizedRows.length,
		)
	)
		blockers.push("invalid normalized candidate count does not match rows");
	if (
		!numberMatches(
			integrity.gateSummary?.invalidNormalizedCandidates,
			invalidNormalizedRows.length,
		)
	)
		blockers.push("gate invalid normalized candidate count does not match rows");
	if (invalidNormalizedRows.length > 0)
		blockers.push("invalid normalized candidate rows are present");
	if (
		!numberMatches(
			invariant.verifierIntegrity?.invalidNormalizedCandidateCount,
			invalidNormalizedRows.length,
		)
	)
		blockers.push(
			"invariant invalid normalized candidate count does not match rows",
		);
	const overflow = packet.overflowLedger;
	const overflowChecks = [
		["preservedClaimCount", asArray(packet.preservedClaims).length],
		["coverageGapCount", asArray(packet.coverageGaps).length],
		["remainingGapCount", asArray(packet.remainingGaps).length],
		["omittedVerificationCandidateCount", omitted.length],
		[
			"invalidVerifierRowCount",
			asArray(packet.verifierIntegrity.invalidVerifierRows).length,
		],
		[
			"duplicateVerifierRowCount",
			asArray(packet.verifierIntegrity.duplicateVerifierRows).length,
		],
		[
			"verifierOwnerIssueCount",
			asArray(packet.verifierIntegrity.verifierOwnerIssues).length,
		],
		["invalidNormalizedCandidateCount", invalidNormalizedRows.length],
	];
	for (const [field, expected] of overflowChecks)
		if (!numberMatches(overflow[field], expected))
			blockers.push(`overflow mismatch: ${field}`);
	const invIntegrity = isRecord(invariant.verifierIntegrity)
		? invariant.verifierIntegrity
		: {};
	for (const field of [
		"invalidVerifierRows",
		"duplicateVerifierRows",
		"verifierOwnerIssues",
		"missingVerifierResults",
		"zeroCandidateFloorBlockers",
	]) {
		const expected =
			field === "invalidVerifierRows"
				? asArray(integrity.invalidVerifierRows).length
				: field === "duplicateVerifierRows"
					? asArray(integrity.duplicateVerifierRows).length
					: field === "verifierOwnerIssues"
						? asArray(integrity.verifierOwnerIssues).length
						: Number(integrity.gateSummary?.[field] ?? 0);
		if (!numberMatches(invIntegrity[field], expected))
			blockers.push(`verifier integrity mismatch: ${field}`);
	}

	const finalClaims = asArray(control?.claimVerdictIndex?.claims);
	for (const row of finalClaims) {
		const id = claimIdOf(row);
		const packetRow = ledger.find((claim) => claimIdOf(claim) === id);
		if (
			!packetRow ||
			packetStatusKey(row?.status ?? row?.verdict) !==
				packetStatusKey(packetRow?.status ?? packetRow?.verdict)
		)
			blockers.push(`final claim ledger mismatch: ${id || "missing id"}`);
	}
	return {
		strict: true,
		passed: blockers.length === 0,
		blockers,
		checks: {
			candidateCount,
			auditedCount,
			omittedCount: omitted.length,
			ledgerCount: ledger.length,
			ownerReconciliation,
			invalidNormalizedCandidateCount: invalidNormalizedRows.length,
		},
	};
}

function packetGapRows(packet) {
	const remaining = asArray(packet?.remainingGaps).map((gap, index) => ({
		id: gapIdOf(gap) || numberedId("gap-remaining", index),
		kind: "Gap",
		...gap,
	}));
	const coverage = asArray(packet?.coverageGaps).map((gap, index) => ({
		id: gapIdOf(gap) || numberedId("gap-coverage", index),
		kind: "Coverage gap",
		...gap,
	}));
	const sourceRefJoinFailures = asArray(packet?.sourceRefJoinFailures).map(
		(gap, index) => ({
			id: gapIdOf(gap) || numberedId("gap-source-ref", index),
			kind: "Source reference gap",
			...gap,
		}),
	);
	return [...remaining, ...coverage, ...sourceRefJoinFailures];
}

function rowsForIds(ids, rowById, warnings, label) {
	const rows = [];
	for (const id of ids) {
		const row = rowById.get(id);
		if (row) {
			rows.push(row);
			continue;
		}
		warnings.push({
			section: "references",
			label,
			total: 1,
			rendered: 0,
			missingId: id,
		});
	}
	return rows;
}

function claimSourceUrls(rows, limit = 8) {
	return uniqueStrings(
		rows.flatMap((row) => [...asArray(row?.sourceUrls), ...urlsOf(row, limit)]),
		limit,
	);
}

function claimSourceRefs(rows, limit = 8) {
	return uniqueStrings(
		rows.flatMap((row) => asArray(row?.sourceRefs)),
		limit,
	);
}

function evidenceStrength(status) {
	switch (normalizeClaimStatus(status)) {
		case "verified":
			return 3;
		case "partially_supported":
			return 2;
		case "unsupported":
			return 1;
		case "conflicting":
		case "verification_blocked":
		case "unverified":
			return 0;
		default:
			return -1;
	}
}

function evidenceStatusFromRows(rows, fallback) {
	if (rows.length === 0) {
		const requested = normalizeClaimStatus(fallback);
		return requested === "verified"
			? "unverified"
			: cleanText(fallback) || "unverified";
	}
	let weakest = "verified";
	let weakestScore = Infinity;
	for (const row of rows) {
		const status = normalizeClaimStatus(row?.status ?? row?.verdict);
		const score = evidenceStrength(status);
		if (score >= 0 && score < weakestScore) {
			weakest = status;
			weakestScore = score;
		}
	}
	return weakestScore === Infinity
		? cleanText(fallback) || "not specified"
		: weakest;
}

function claimToFinding(row) {
	const localQuoteGate = asArray(row?.localQuoteGate);
	const evidence = asArray(row?.evidence).filter((_, index) => {
		const gate = localQuoteGate.find((item) => item?.index === index);
		return !gate || gate.status === "verified";
	});
	return {
		id: claimIdOf(row),
		finding: readableClaimText(row?.claim ?? row?.support ?? stringifyItem(row)),
		evidenceStatus: normalizeClaimStatus(row?.status) || row?.status,
		confidence: row?.confidence,
		sourceUrls: asArray(row?.sourceUrls),
		sourceRefs: asArray(row?.sourceRefs),
		evidence,
		rationale: row?.support,
		caveat: row?.caveat,
		correctionOrCounterclaim: row?.correctionOrCounterclaim,
	};
}

function evidenceCitationText(row, ko = false, quoteFirst = false) {
	if (!isRecord(row)) return "";
	const source = row.file ?? row.repo ?? row.sourceRef ?? row.source ?? row.url;
	const lineStart = Number(row.lineStart ?? row.line);
	const lineEnd = Number(row.lineEnd ?? row.lineStart ?? row.line);
	let location = cleanText(source);
	if (Number.isSafeInteger(lineStart) && lineStart > 0) {
		const range = `${lineStart}-${Number.isSafeInteger(lineEnd) && lineEnd > 0 ? lineEnd : lineStart}`;
		location += ko ? ` ${range}행` : ` lines ${range}`;
	} else if (row.excerptLocation) {
		location += ` ${cleanText(row.excerptLocation)}`;
	}
	const quote = typeof row.quote === "string" ? row.quote : "";
	const exactQuote = quote
		? JSON.stringify(quote)
				.replace(/([\\`*_[\\]{}#+!<>|])/g, "\\$1")
				.replace(/\r?\n/g, "\\n")
		: "";
	if (quoteFirst) return [exactQuote, escapeMarkdownText(location || (ko ? "출처" : "source"))].filter(Boolean).join(" — ");
	return [location || "source", exactQuote ? `quote ${exactQuote}` : ""]
		.filter(Boolean)
		.join(": ");
}

function supportingClaimIds(item) {
	return uniqueStrings([
		...asArray(item?.supportingClaimIds),
		...asArray(item?.claimIds),
		...asArray(item?.relatedClaimIds),
	]);
}

function withSupportingEvidence(item, claimRows) {
	const linkedStatus = evidenceStatusFromRows(claimRows, item?.evidenceStatus);
	const requestedStatus = normalizeClaimStatus(item?.evidenceStatus);
	// Linked claims establish provenance, not entailment of a recommendation or
	// decision. Keep positive overlays derived rather than falsely verified.
	const evidenceStatus =
		claimRows.length === 0
			? requestedStatus === "verified"
				? "unverified"
				: cleanText(item?.evidenceStatus) || "unverified"
			: linkedStatus === "verified"
				? "derived"
				: linkedStatus;
	return {
		...item,
		evidenceStatus,
		sourceUrls: uniqueStrings(
			[...asArray(item?.sourceUrls), ...claimSourceUrls(claimRows, Infinity)],
		),
		sourceRefs: uniqueStrings(
			[...asArray(item?.sourceRefs), ...claimSourceRefs(claimRows, Infinity)],
		),
	};
}

function coverageSummaryFromPacket(packet, fallback = {}) {
	const counts = packetVerdictCounts(packet, {
		total: 0,
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
		verification_blocked: 0,
	});
	if (!counts) return fallback;
	const schemaCapDrops =
		packet?.normalizerDiagnostics?.sanitizer?.schemaCapDrops;
	const omittedPreserved = Array.isArray(schemaCapDrops)
		? schemaCapDrops
				.filter((row) => cleanText(row?.path).endsWith("preservedClaims"))
				.reduce(
					(total, row) => total + (finiteNumber(row?.droppedCount) ?? 0),
					0,
				)
		: undefined;
	return {
		...fallback,
		verified: counts.verified,
		partiallySupported: counts.partially_supported,
		unsupported: counts.unsupported,
		conflicting: counts.conflicting,
		verificationBlocked: counts.verification_blocked,
		verificationCandidates: counts.total,
		depth: packet?.researchMetadataSeed?.depth ?? fallback.depth,
		researchQuestions:
			packet?.researchMetadataSeed?.researchQuestions ??
			fallback.researchQuestions,
		preserved: packet?.overflowLedger?.preservedClaimCount ?? fallback.preserved,
		omittedVerificationCandidates:
			packet?.overflowLedger?.omittedVerificationCandidateCount ??
			fallback.omittedVerificationCandidates,
		omittedPreserved:
			omittedPreserved ?? fallback.omittedPreserved,
		coverageGaps:
			packet?.overflowLedger?.coverageGapCount ?? fallback.coverageGaps,
	};
}

function translatedText(value, maxLength) {
	if (typeof value !== "string") return undefined;
	const text = cleanText(value);
	return text && [...text].length <= maxLength ? text : undefined;
}

/**
 * 2026-11-03 (owner decision): synthesis.translations puts the audit text the reader also sees —
 * claim text and support, lead text, fact-slot area and impact — into the task's language. It is
 * attached beside the original (readerText, readerExplanation, readerArea, readerImpact); section
 * titles, labels, statuses, quotes and sources stay as they are, and the audit keeps the original
 * rows. An entry with an unknown or repeated id or an empty or oversized text is ignored, so the
 * original shows.
 */
function readerTranslations(
	synthesis,
	claimIds,
	slotIds,
	sources = {},
	retranslations = new Map(),
	expectedClaimIds = [],
) {
	const claims = new Map();
	const factSlots = new Map();
	const ignored = [];
	const refused = [];
	const retranslated = [];
	// 2026-11-09: a translation must keep its source's numbers (recorded: 15 of 141 claim texts lost a
	// year such as "May 2023", 6 of 24 slot areas an RFC number). A field that drops one is not used,
	// so the original shows; the audit names it. 2026-11-10: the retranslate stage gets each refused
	// field once more; its text is used when it keeps every number.
	const faithful = (id, field, source, translated) => {
		const dropped = numbersDroppedBy(source, translated);
		if (dropped.length === 0) return translated;
		const key = translationKey(id, field);
		const retry = translatedText(retranslations.get(key), 2000);
		if (retry && numbersDroppedBy(source, retry).length === 0) {
			retranslated.push(key);
			return retry;
		}
		refused.push({ key, id, field: field || "text", source, translated, dropped });
		ignored.push(`${id}${field ? ` ${field}` : ""}: drops ${dropped.join(", ")}`);
		return undefined;
	};
	// Claim ids whose translation was checked (used or refused for its numbers).
	const attempted = new Set();
	for (const row of asArray(synthesis?.translations?.claims)) {
		const id = claimIdOf(row);
		const text = translatedText(row?.text, 2000);
		if (!claimIds.has(id) || !text || claims.has(id)) {
			ignored.push(id || "(no id)");
			continue;
		}
		attempted.add(id);
		const readerText = faithful(id, "", sources.claimText?.(id), text);
		if (!readerText) continue;
		claims.set(id, {
			readerText,
			readerExplanation: translatedText(row?.explanation, 2000),
		});
	}
	// 2026-11-10: a shown key finding or lead that the audit left untranslated while the report is in another
	// script (recorded: 81 of 109 English leads in Korean reports) is listed too; the retranslate stage translates it.
	const target = scriptOf(synthesisSummary(synthesis));
	if (target !== "latin" && synthesis?.translations)
		for (const id of new Set(expectedClaimIds)) {
			if (attempted.has(id) || !claimIds.has(id)) continue;
			const source = sources.claimText?.(id);
			if (!source || scriptOf(source) === target) continue;
			const key = translationKey(id, "");
			const retry = translatedText(retranslations.get(key), 2000);
			if (retry && numbersDroppedBy(source, retry).length === 0) {
				retranslated.push(key);
				claims.set(id, { readerText: retry });
				continue;
			}
			refused.push({ key, id, field: "text", source, translated: null, dropped: [] });
		}
	for (const row of asArray(synthesis?.translations?.factSlots)) {
		const id = cleanText(row?.id);
		const area = translatedText(row?.area, 400);
		if (!slotIds.has(id) || !area || factSlots.has(id)) {
			ignored.push(id || "(no id)");
			continue;
		}
		const slot = sources.slot?.(id);
		const readerArea = faithful(id, "area", slot?.label, area);
		if (!readerArea) continue;
		factSlots.set(id, {
			readerArea,
			readerImpact: faithful(
				id,
				"whyItMatters",
				slot?.parentImpact,
				translatedText(row?.whyItMatters, 2000),
			),
			readerGap: faithful(
				id,
				"gap",
				slot?.gapReason,
				translatedText(row?.gap, 2000),
			),
		});
	}
	return { claims, factSlots, ignored, refused, retranslated };
}

/** The writing system a text is mostly in: "hangul", "kana", "han", "cyrillic", or "latin" for anything else. */
function scriptOf(text) {
	const value = stringOf(text) ?? "";
	const counts = {
		hangul: (value.match(/[가-힣]/gu) ?? []).length,
		kana: (value.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length,
		han: (value.match(/\p{Script=Han}/gu) ?? []).length,
		cyrillic: (value.match(/\p{Script=Cyrillic}/gu) ?? []).length,
	};
	const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	if (count === 0) return "latin";
	// Japanese mixes kana with Han characters; any kana makes it Japanese.
	return counts.kana > 0 ? "kana" : best;
}

function translationKey(id, field) {
	return `${id}|${field || "text"}`;
}

/** The retranslate stage's texts by key ("claim-001|text", "slot-002|area"); the first one for a key wins. */
function retranslationsFrom(sources) {
	const texts = new Map();
	for (const [sourceId, control] of Object.entries(sources ?? {})) {
		if (sourceId !== "retranslate" && !sourceId.startsWith("retranslate."))
			continue;
		for (const row of asArray(control?.translations)) {
			const key = cleanText(row?.key);
			const text = stringOf(row?.text);
			if (key && text && !texts.has(key)) texts.set(key, text);
		}
	}
	return texts;
}

/**
 * Numbers of `source` (three or more digits, or with a decimal point; not part of a Latin identifier
 * such as "rq-007", "v1" or "claim-010") whose value `translated` does not keep. Values are compared
 * whole: thousands separators are dropped, another comma is a decimal comma, a dotted date
 * ("2023.5.12.") gives its parts, digits glued to Hangul count ("약3000건", "RFC9000은"), and a scale
 * word multiplies ("1.5 million" = "150만" = "1,500,000"). A sign may be said in words; its digits must
 * stay. Review 2026-11-09 found refusals of faithful Korean forms; the re-review found the substring
 * match then accepted changed values ("1000" kept by "0.1000" or "1000.5"). Korean compound numerals
 * count as one value too ("1천500" = 1,500, "3억 2천만" = 320,000,000).
 */
export function numbersDroppedBy(source, translated) {
	if (typeof source !== "string" || typeof translated !== "string") return [];
	const kept = numberValuesIn(translated);
	const dropped = [];
	for (const match of source.matchAll(/(?<![A-Za-z\d_./])(?<![A-Za-z\d]-)-?\d[\d,]*(?:\.\d+)?/g)) {
		const literal = match[0].replace(/,/g, "");
		const digits = literal.replace(/^-/, "");
		if (digits.replace(/\D/g, "").length < 3 && !digits.includes(".")) continue;
		const scaleWord = /^\s*(thousand|million|billion|trillion)\b/i.exec(
			source.slice(match.index + match[0].length),
		)?.[1];
		const value = scaleWord ? scaleValue(Number(digits), scaleWord) : Number(digits);
		if (![...kept].some((candidate) => Math.abs(candidate - value) <= Math.abs(value) * 1e-9))
			dropped.push(literal);
	}
	return [...new Set(dropped)];
}

/** Every number value a text states (see numbersDroppedBy). */
function numberValuesIn(text) {
	const values = new Set();
	for (const match of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
		const token = match[0];
		const scaleWord = /^\s*(천|만|억|조|thousand|million|billion|trillion)/iu.exec(
			text.slice(match.index + token.length),
		)?.[1];
		const scaled = (number) => (scaleWord ? scaleValue(number, scaleWord) : number);
		// A dotted date gives its parts: "2023.5.12." and the Korean year-month "2023.5." (year 1900-2100,
		// month 1-12); any other single dot is a decimal point ("1000.5", "0.1000").
		const yearMonth = /^(19\d{2}|20\d{2}|2100)\.(\d{1,2})$/.exec(token);
		if ((token.match(/\./g) ?? []).length >= 2 || (yearMonth && Number(yearMonth[2]) >= 1 && Number(yearMonth[2]) <= 12)) {
			for (const part of token.split(".")) values.add(Number(part));
			continue;
		}
		const plain = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)
			? token.replace(/,/g, "")
			: token.replace(",", ".");
		values.add(scaled(Number(plain)));
	}
	for (const value of koreanCompoundValues(text)) values.add(value);
	return values;
}

const KOREAN_SMALL_UNITS = { 십: 10, 백: 100, 천: 1e3 };
const KOREAN_LARGE_UNITS = { 만: 1e4, 억: 1e8, 조: 1e12 };

/**
 * The value of each Korean compound numeral: numbers with 십/백/천 inside a 만/억/조 group, groups added
 * ("1천500" = 1,500, "1만 5천" = 15,000, "3억 2천만" = 320,000,000). The single numbers are values of
 * their own as well (numberValuesIn), so this only adds what the whole run states.
 */
function koreanCompoundValues(text) {
	const values = [];
	const run = /(?:\d+(?:[.,]\d+)?\s*[십백천만억조](?:\s*[만억조])*\s*)+(?:\d+(?:[.,]\d+)?(?![\d.,]))?/gu;
	for (const match of text.matchAll(run)) {
		let total = 0;
		let section = 0;
		// Whether this section wrote any coefficient: "0천만" has one (zero), "만" has none (round-5 review).
		let written = false;
		for (const part of match[0].matchAll(/(\d+(?:[.,]\d+)?)?\s*([십백천만억조])?/gu)) {
			const [, digits, unit] = part;
			if (digits === undefined && unit === undefined) continue;
			const number =
				digits === undefined
					? undefined
					: Number(
							/^\d{1,3}(?:,\d{3})+$/.test(digits)
								? digits.replace(/,/g, "")
								: digits.replace(",", "."),
						);
			if (number !== undefined) written = true;
			if (unit in KOREAN_SMALL_UNITS) section += (number ?? 1) * KOREAN_SMALL_UNITS[unit];
			else if (unit in KOREAN_LARGE_UNITS) {
				// No coefficient written ("만") is one; an explicit zero ("0억", "0천만") stays zero (round-4/5 reviews).
				const coefficient = written ? section + (number ?? 0) : 1;
				total += coefficient * KOREAN_LARGE_UNITS[unit];
				section = 0;
				written = false;
			} else section += number ?? 0;
		}
		values.push(total + section);
	}
	return values;
}

function scaleValue(number, word) {
	const scale = { 천: 1e3, 만: 1e4, 억: 1e8, 조: 1e12, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }[
		word.toLowerCase()
	];
	return number * (scale ?? 1);
}

/**
 * 2026-11-03: a coverage gap carries only ids and its scope item, so the report printed
 * "Coverage gap — gap-coverage-001 — related slots: slot-001". It now names each related area
 * (translated when the synthesis gave one) and what is missing (its status is in the Evidence
 * strength table); a gap without related areas shows its scope item. The packet
 * (final-audit-packet control) keeps the ids.
 */
function withCoverageGapText(gap, slotById) {
	const ownText = ["gap", "finding", "claim", "note", "reason"].some(
		(key) => typeof gap?.[key] === "string" && gap[key].trim(),
	);
	if (ownText) return gap;
	const parts = asArray(gap?.relatedFactSlotIds)
		.map((id) => slotById.get(cleanText(id)))
		.filter(Boolean)
		.map((slot) => {
			const area = cleanText(slot.readerArea ?? slot.label ?? slot.slotId);
			// Parts are joined with "; ", so a part's own closing full stop is dropped.
			const missing = cleanText(slot.readerGap ?? slot.gapReason).replace(
				/[.。]$/u,
				"",
			);
			return `${area}${missing ? `: ${missing}` : ""}`;
		});
	const text = parts.length ? parts.join("; ") : cleanText(gap?.scopeItem);
	return text ? { ...gap, readerText: text } : gap;
}

function withTranslation(item, translation) {
	if (!translation) return item;
	const fields = Object.fromEntries(
		Object.entries(translation).filter(([, value]) => value !== undefined),
	);
	return { ...item, ...fields };
}

function composeResearchReport(
	control,
	packetSource,
	retranslations = new Map(),
) {
	const packet = packetOf(packetSource);
	const legacyReport = control?.finalReport ?? {};
	const synthesis = isRecord(control?.synthesis) ? control.synthesis : null;
	const ledger = claimLedger(packet, control);
	const claimById = mapById(ledger, claimIdOf);
	const gapRows = packetGapRows(packet);
	const gapById = mapById(gapRows, gapIdOf);
	const warnings = [];

	if (!synthesis) {
		const report = {
			...legacyReport,
			notableUnsupportedClaims: [...asArray(legacyReport.notableUnsupportedClaims), ...asArray(legacyReport.unsupportedFindings)],
			contestedAreas: [...asArray(legacyReport.contestedAreas), ...asArray(legacyReport.contestedFindings)],
		};
		// A legacy report row may name the claim without the verifier's correction the ledger holds.
		for (const key of ["notableUnsupportedClaims", "contestedAreas"])
			if (Array.isArray(report[key]))
				report[key] = report[key].map((row) => {
					if (!isRecord(row) || cleanText(row.correctionOrCounterclaim)) return row;
					const correction = cleanText(claimById.get(claimIdOf(row))?.correctionOrCounterclaim);
					return correction ? { ...row, correctionOrCounterclaim: correction } : row;
				});
		if (asArray(packet.factSlotCoverage).length > 0)
			report.factSlotCoverage = packet.factSlotCoverage;
		if (isRecord(packet.researchMetadataSeed))
			report.researchMetadata = packet.researchMetadataSeed;
		if (isRecord(packet.verdictCounts))
			report.coverageSummary = coverageSummaryFromPacket(
				packet,
				report.coverageSummary,
			);
		if (asArray(report.remainingGaps).length === 0 && gapRows.length > 0)
			report.remainingGaps = gapRows;
		if (
			asArray(report.researchScopeCoverage).length === 0 &&
			asArray(packet.researchScopeCoverage).length > 0
		) {
			report.researchScopeCoverage = packet.researchScopeCoverage;
		}
		return { report, packet, ledger, warnings };
	}

	// Preserved leads are valid references for caveats and follow-up actions,
	// but they are not audited evidence and must never gain verified status.
	const referenceById = new Map(claimById);
	const referenceIds = new Set(claimById.keys());
	for (const row of asArray(packet.preservedClaims)) {
		const id = claimIdOf(row);
		if (!id) continue;
		if (referenceIds.has(id)) {
			referenceById.delete(id);
			warnings.push({
				section: "references",
				label: "ambiguous preserved claim ID",
				total: 1,
				rendered: 0,
				missingId: id,
			});
			continue;
		}
		referenceIds.add(id);
		referenceById.set(id, {
			...row,
			status: "unverified",
			verdict: "unverified",
		});
	}

	const keyFindingIds = stringArray(synthesis.keyFindingIds, 12);
	const keyFindingRows = keyFindingIds.length
		? rowsForIds(keyFindingIds, claimById, warnings, "key findings")
		: ledger
				.filter((row) => normalizeClaimStatus(row?.status) === "verified")
				.slice(0, 8);
	const mapOverlayItems = (items, textField) =>
		asArray(items).map((item) => {
			const ids = supportingClaimIds(item);
			const rows = rowsForIds(ids, referenceById, warnings, textField);
			return withSupportingEvidence(item, rows);
		});
	const caveatNotes = asArray(synthesis.caveatNotes).map((item) => {
		const rows = rowsForIds(
			supportingClaimIds(item),
			referenceById,
			warnings,
			"caveat notes",
		);
		const gaps = rowsForIds(
			stringArray(item?.gapIds, 12),
			gapById,
			warnings,
			"gap notes",
		);
		return withSupportingEvidence(
			{
				...item,
				relatedGaps: gaps,
			},
			rows,
		);
	});
	const optionalUnsupported = rowsForIds(
		stringArray(synthesis.notableUnsupportedClaimIds, 12),
		claimById,
		warnings,
		"unsupported claims",
	).map(claimToFinding);
	const optionalContested = rowsForIds(
		stringArray(synthesis.contestedClaimIds, 12),
		claimById,
		warnings,
		"contested claims",
	).map(claimToFinding);
	const derivedUnsupported = ledger
		.filter((row) => normalizeClaimStatus(row?.status) === "unsupported")
		.map(claimToFinding);
	const derivedContested = ledger
		.filter((row) => normalizeClaimStatus(row?.status) === "conflicting")
		.map(claimToFinding);
	const coverageById = mapById(asArray(packet.factSlotCoverage), (slot) => cleanText(slot?.slotId));
	const translations = readerTranslations(
		synthesis,
		referenceIds,
		new Set(asArray(packet.factSlotCoverage).map((slot) => cleanText(slot?.slotId))),
		{
			claimText: (id) => {
				const row = referenceById.get(id);
				return stringOf(row?.claim) ?? stringOf(row?.text);
			},
			slot: (id) => {
				const slot = coverageById.get(id);
				return slot && {
					label: stringOf(slot.label),
					parentImpact: stringOf(slot.parentImpact),
					gapReason: stringOf(slot.gapReason),
				};
			},
		},
		retranslations,
		[
			...keyFindingIds,
			...asArray(packet.preservedClaims).map(claimIdOf).filter(Boolean),
		],
	);
	const translateClaims = (rows) =>
		rows.map((row) => withTranslation(row, translations.claims.get(claimIdOf(row))));
	const factSlotCoverage = asArray(packet.factSlotCoverage).map((slot) =>
		withTranslation(slot, translations.factSlots.get(cleanText(slot?.slotId))),
	);
	const slotById = mapById(factSlotCoverage, (slot) => cleanText(slot?.slotId));

	return {
		report: {
			summary: synthesisSummary(synthesis) ?? control?.digest,
			conclusion: synthesis.conclusion,
			keyPoints: synthesis.keyPoints,
			openQuestion: synthesis.openQuestion,
			researchMetadata: packet.researchMetadataSeed ?? {},
			coverageSummary: coverageSummaryFromPacket(packet, {}),
			factSlotCoverage,
			mainFindings: translateClaims(keyFindingRows.map(claimToFinding)),
			comparisonRows: mapOverlayItems(
				synthesis.comparisonRows,
				"comparison snapshot",
			),
			recommendations: mapOverlayItems(
				synthesis.recommendations,
				"recommendations",
			),
			actionPlan: mapOverlayItems(synthesis.actionPlan, "action plan"),
			caveatedFindings: caveatNotes,
			contestedAreas: translateClaims(
				optionalContested.length ? optionalContested : derivedContested,
			),
			notableUnsupportedClaims: translateClaims(
				optionalUnsupported.length ? optionalUnsupported : derivedUnsupported,
			),
			unverifiedButRelevant: translateClaims(asArray(packet.preservedClaims)),
			parentDecisionNotes: mapOverlayItems(
				synthesis.parentDecisionNotes,
				"decision notes",
			),
			researchScopeCoverage: asArray(packet.researchScopeCoverage),
			remainingGaps: gapRows.map((gap) => withCoverageGapText(gap, slotById)),
			...(hasOwn(synthesis, "translations")
				? {
						readerTranslations: {
							applied: translations.claims.size + translations.factSlots.size,
							ignored: translations.ignored,
							retranslated: translations.retranslated,
							untranslated: translations.refused.filter(
								(row) => row.translated === null,
							).length,
						},
					}
				: {}),
		},
		packet,
		ledger,
		warnings,
		translationRefusals: translations.refused,
	};
}

/**
 * 2026-11-10: the reader translations the report would refuse (a translation that drops a number of its source),
 * for the translation-check stage. Empty without a modern final-audit synthesis.
 */
export function refusedReaderTranslations(sources) {
	const control = findSource(sources, "final-audit");
	const packet = findSource(sources, "final-audit-packet");
	if (!isRecord(control?.synthesis) || !packet) return [];
	return composeResearchReport(control, packet).translationRefusals ?? [];
}

function statusRank(item) {
	const status =
		`${item?.evidenceStatus ?? item?.status ?? item?.confidence ?? ""}`.toLowerCase();
	if (
		status.includes("missing") ||
		status.includes("gap") ||
		status.includes("conflict")
	) {
		return 0;
	}
	if (status.includes("unsupported")) return 1;
	if (status.includes("partial")) return 2;
	if (status.includes("verified") && !status.includes("partial")) return 3;
	if (status.includes("filled") || status.includes("high")) return 4;
	return 5;
}

function sortedFactSlots(report) {
	return asArray(report.factSlotCoverage)
		.slice()
		.sort(
			(a, b) =>
				statusRank(a) - statusRank(b) ||
				cleanText(a?.slotId ?? a?.label).localeCompare(
					cleanText(b?.slotId ?? b?.label),
				),
		);
}

// Presentation only. Keep the machine statuses and the canonical audit unchanged.
const STATUS_LABELS = new Map(Object.entries({
	verified: ["Verified", "확인됨"], partially_supported: ["Partly supported", "일부 확인"],
	unsupported: ["Unsupported", "근거 부족"], conflicting: ["Sources disagree", "출처 상충"],
	verification_blocked: ["Not checked", "검증 불가"], unverified: ["Unverified", "미확인"],
	derived: ["Proposal", "제안"], filled: ["Covered", "충분"], covered: ["Covered", "충분"],
	partial: ["Partly covered", "일부"], missing: ["Missing", "없음"], gap: ["Gap", "공백"],
	out_of_scope: ["Out of scope", "범위 밖"], not_applicable: ["Not applicable", "해당 없음"],
	unknown: ["Unknown", "알 수 없음"], "not specified": ["Not specified", "표시 없음"],
}));

function statusLabel(status, ko) {
	return STATUS_LABELS.get(status.toLowerCase().replace(/[ -]+/g, "_"))?.[ko ? 1 : 0] ??
		STATUS_LABELS.get(status.toLowerCase())?.[ko ? 1 : 0] ??
		STATUS_LABELS.get("not specified")[ko ? 1 : 0];
}

function sentences(text) {
	const ko = /[가-힣]/u.test(text);
	return [...new Intl.Segmenter(ko ? "ko" : "en", { granularity: "sentence" }).segment(text)]
		.map(({ segment }) => segment.trim()).filter(Boolean);
}

function conclusionLines(report, fallback, format) {
	return (report.conclusion ?? sentences(summaryText(report, fallback))).flatMap((line) => [format(line), ""]);
}

function renderKeyPoints(report, ko, format, level) {
	return asArray(report.keyPoints).length ? [
		`${level} ${ko ? "핵심 포인트" : "Key points"}`, "",
		...report.keyPoints.map(({ title, text }) => `- **${format(title)}** — ${format(text)}`), "",
	] : [];
}

function fold(title, body, indent = "") {
	return ["<details>", `<summary>${title}</summary>`, "", ...body, "", "</details>"].map(
		(line) => line ? `${indent}${line}` : "",
	);
}

function renderEvidenceStrength(report, ko) {
	const slots = sortedFactSlots(report);
	const rows = slots.map((slot) => {
		const area = escapeTableCell(
			slot.readerArea ??
				slot.label ??
				slot.slotId ??
				slot.bestValue ??
				(ko ? "근거 항목" : "Evidence area"),
		);
		const status = statusLabel(evidenceStatusOf(slot), ko);
		// referenceList is already Markdown (escaped host, <url>, `ref`): only the cell's pipes are
		// escaped (2026-11-03: escaping it again printed \[host\](\<url\>) instead of a link).
		const evidence = referenceList(slot, Infinity).replace(/\|/g, "\\|") || "—";
		const impact = escapeTableCell(
			slot.readerImpact ??
				slot.parentImpact ??
				slot.whyItMatters ??
				slot.notes ??
				"",
		);
		return `| ${area || (ko ? "근거 항목" : "Evidence area")} | ${status || "—"} | ${evidence} | ${impact || "—"} |`;
	});
	if (rows.length === 0) return [];
	return [
		ko ? "| 항목 | 상태 | 근거 | 중요한 이유 |" : "| Area | Status | Evidence | Why it matters |",
		"|---|---|---|---|",
		...rows,
		"",
	];
}

function mainFindingEntries(report) {
	return asArray(report.mainFindings).map((item) => ({
		item,
		text: itemText(
			item,
			["readerText", "finding", "summary", "bestValue", "claim"],
			stringifyItem(item),
		),
	}));
}

function comparisonEntries(report) {
	return asArray(report.comparisonRows).map((item) => ({
		item,
		area: cleanText(item?.area),
		subjectStatus: cleanText(item?.subjectStatus),
		referencePattern: cleanText(item?.referencePattern),
		assessment: cleanText(item?.assessment),
	}));
}

function recommendationEntries(report) {
	return asArray(report.recommendations).map((item) => ({
		item,
		text: itemText(
			item,
			["recommendation", "action", "step", "note"],
			stringifyItem(item),
		),
	}));
}

function actionEntries(report) {
	return asArray(report.actionPlan).map((item) => ({
		item,
		text:
			itemText(item, ["action", "recommendation", "note"]) ||
			(typeof item?.step === "string" && cleanText(item.step)) ||
			stringifyItem(item),
	}));
}

function comparisonHeading(ko) {
	return ko ? "비교 요약" : "Comparison snapshot";
}

function comparisonTableHeader(ko) {
	return ko ? "| 항목 | 대상의 현재 상태 | 참고 사례 | 평가 |" : "| Area | Subject / current state | Reference pattern | Assessment |";
}

function renderComparisonSnapshot(report, ko) {
	const comparisons = comparisonEntries(report);
	if (comparisons.length === 0) return [];
	const out = [`## ${comparisonHeading(ko)}`, "", comparisonTableHeader(ko), "|---|---|---|---|"];
	for (const { item, area, subjectStatus, referencePattern, assessment } of comparisons) {
		const status = statusLabel(evidenceStatusOf(item), ko);
		out.push(`| ${escapeTableCell(area)} | ${escapeTableCell(subjectStatus)} | ${escapeTableCell(referencePattern)} | **${status}** ${escapeTableCell(assessment)} |`);
	}
	out.push("");
	return out;
}

function renderMainFindings(report, ko) {
	const findings = mainFindingEntries(report);
	if (findings.length === 0) return [];
	const out = [ko ? "## 근거가 된 발견" : "## Findings", ""];
	for (const { item: finding, text } of findings) {
		const status = statusLabel(evidenceStatusOf(finding), ko);
		out.push(`### **${status}** ${text}`, "");
		const evidence = asArray(finding?.evidence).map((row) => evidenceCitationText(row, ko, true)).filter(Boolean).map((row) => `- ${row}`);
		const explanation = itemText(finding, ["readerExplanation", "rationale", "explanation", "details", "notes"]);
		if (explanation && explanation !== text) evidence.push("", explanation);
		const confidence = cleanText(finding?.confidence).toLowerCase();
		const level = new Map([["high", ["High", "높음"]], ["medium", ["Medium", "보통"]], ["low", ["Low", "낮음"]]]).get(confidence);
		if (level) evidence.push("", `${ko ? "신뢰도" : "Confidence"}: ${level[ko ? 1 : 0]}`);
		const sources = referenceList(finding, Infinity);
		if (sources) evidence.push("", `${ko ? "출처" : "Sources"}: ${sources}`);
		if (evidence.length) out.push(...fold(ko ? "근거 보기" : "Evidence", evidence), "");
	}
	return out;
}

function bestRelatedAction(recommendation, actions) {
	const claimIds = new Set(supportingClaimIds(recommendation));
	const refs = new Set([...urlsOf(recommendation, Infinity), ...localRefsOf(recommendation, Infinity)]);
	const scores = actions.map(({ item }) => [
		supportingClaimIds(item).filter((id) => claimIds.has(id)).length,
		[...urlsOf(item, Infinity), ...localRefsOf(item, Infinity)].filter((ref) => refs.has(ref)).length,
	]);
	let best = -1, tied = false;
	for (const [index, [claims, sources]] of scores.entries()) {
		if (!claims && !sources) continue;
		const [prevClaims, prevSources] = scores[best] ?? [0, 0];
		if (claims > prevClaims || (claims === prevClaims && sources > prevSources)) {
			best = index;
			tied = false;
		} else if (claims === prevClaims && sources === prevSources) tied = true;
	}
	return tied ? -1 : best;
}

function renderActions(report, ko) {
	const actions = actionEntries(report).map((entry) => ({ ...entry, related: [] }));
	const recommendations = recommendationEntries(report);
	const standalone = [];
	const owners = new Map();
	const explicit = actions.some(({ item }) => Array.isArray(item?.recommendationNumbers));
	for (const [index, { item }] of actions.entries()) {
		for (const number of asArray(item?.recommendationNumbers))
			if (recommendations[number - 1] && !owners.has(number - 1)) owners.set(number - 1, index);
	}
	for (const [index, entry] of recommendations.entries()) {
		const owner = owners.get(index) ?? (explicit ? -1 : bestRelatedAction(entry.item, actions));
		if (owner < 0) standalone.push({ ...entry, related: [] });
		else actions[owner].related.push(entry);
	}
	actions.push(...standalone);
	if (!actions.length) return [];
	const out = [ko ? "## 할 일" : "## To do", ""];
	const textWithStatus = (item, text) => `**${statusLabel(evidenceStatusOf(item), ko)}** ${text}`;
	const sourceLine = (item) => {
		const sources = referenceList(item, Infinity);
		return sources ? `${ko ? "출처" : "Sources"}: ${sources}` : "";
	};
	for (const [index, { item, text, related }] of actions.entries()) {
		const n = `${index + 1}. `;
		const indent = " ".repeat(n.length);
		out.push(`${n}${textWithStatus(item, text)}`);
		const sources = sourceLine(item);
		const rationale = itemText(item, ["rationale"]);
		const body = [...(rationale ? [rationale, ""] : []), ...(sources ? [sources, ""] : [])];
		for (const entry of related) {
			const relatedSources = sourceLine(entry.item);
			const rationale = itemText(entry.item, ["rationale"]);
			body.push(`- ${textWithStatus(entry.item, entry.text)}${rationale ? ` — ${rationale}` : ""}${relatedSources ? ` (${relatedSources})` : ""}`);
		}
		if (body.length) out.push(...fold(related.length ? (ko ? "관련 권고와 출처" : "Related recommendations and sources") : (ko ? "자세히 보기" : "Details"), body, indent));
	}
	return [...out, ""];
}

function fallbackCaveatText(item) {
	if (!isRecord(item)) return stringifyItem(item);
	const id = cleanText(item.id ?? item.gapId ?? "");
	const slotIds = uniqueStrings([
		item.slotId,
		...asArray(item.relatedFactSlotIds),
	]).join(", ");
	const kind = cleanText(item.kind ?? "gap");
	return (
		[kind, id, slotIds ? `related slots: ${slotIds}` : undefined]
			.filter(Boolean)
			.join(" — ") || stringifyItem(item)
	);
}

const CAVEAT_TEXT_FIELDS = [
	"readerText",
	"gap",
	"finding",
	"claim",
	"note",
	"reason",
	"nextStep",
	"evidenceState",
	"whyItMatters",
	"parentImpact",
];

function caveatText(item) {
	return itemText(item, CAVEAT_TEXT_FIELDS, fallbackCaveatText(item));
}

function rawCaveatText(item) {
	if (typeof item === "string") return cleanText(item);
	const field = CAVEAT_TEXT_FIELDS.find(
		(key) => typeof item?.[key] === "string" && item[key].trim(),
	);
	return field ? cleanText(item[field]) : "";
}

function caveatCategories(report) {
	return [
		{ kind: "Gap", items: flattenItems(report.remainingGaps) },
		{
			kind: "Unsupported",
			items: flattenItems(report.notableUnsupportedClaims),
		},
		{ kind: "Contested", items: flattenItems(report.contestedAreas) },
		{ kind: "Caveat", items: flattenItems(report.caveatedFindings) },
		{
			kind: "Unverified lead",
			items: flattenItems(report.unverifiedButRelevant),
		},
		{ kind: "Decision note", items: flattenItems(report.parentDecisionNotes) },
	]
		.map((category) => ({
			kind: category.kind,
			entries: category.items
				.map((item) => ({ item, text: caveatText(item) }))
				.filter((entry) => entry.text),
		}))
		.filter((category) => category.entries.length > 0);
}

function selectCaveats(report) {
	const categories = caveatCategories(report);
	const selected = [];
	for (const category of categories) {
		for (const entry of category.entries) {
			selected.push({ kind: category.kind, ...entry });
		}
	}
	return {
		selected,
		total: selected.length,
	};
}

// Completion prose consumes raw strings and escapes once. Detailed report
// helpers return already-escaped Markdown and must not be fed through this path.
function completionItemText(item) {
	if (typeof item === "string") return item;
	for (const key of ["recommendation", "action", "step", "note", "readerText", "finding", "summary", "bestValue", "claim"]) {
		if (typeof item?.[key] === "string" && item[key].trim()) return item[key];
	}
	return "";
}

function readerEvidenceQualifier(item, korean) {
	const status = evidenceStatusOf(item);
	if (status === "derived") return korean ? "제안" : "Proposal";
	const labels = {
		verified: "",
		partially_supported: korean ? "일부 근거만 확인됨" : "Only partly supported by the available sources",
		unsupported: korean ? "뒷받침할 근거 부족" : "Insufficient supporting evidence",
		conflicting: korean ? "출처 간 설명이 일치하지 않음" : "Sources disagree",
		verification_blocked: korean ? "검증하지 못함" : "Could not be checked",
		unverified: korean ? "추가 확인 필요" : "Not yet checked",
	};
	return labels[normalizeClaimStatus(status)] ?? labels.unverified;
}

function readerLimits(report, contestedSlots, ko) {
	return uniqueStrings([
		...readerContestedLimits(contestedSlots, ko),
		...uniqueStrings(asArray(report.caveatedFindings).map((item) => item?.readerNote), 4),
	]);
}

// C2 (agent-workflow WP10): the user-facing source-verification statement. Plan wording (Korean):
// "출처 검증: 모델 보고" = "source verification: model-reported". The CLI web tools are used as-is,
// so the URLs and quotes of web evidence are what the model reported; nothing re-reads source
// bytes. (Local repository quotes are still checked against the files by local-quote-gate.)
export const SOURCE_VERIFICATION_STATEMENT =
	"Source verification: model-reported (byte-level source verification is not performed).";

// 2026-11-01: when the engine's web quote check ran, the statement says what it checked; claims
// themselves stay model-judged. Without the check (off, or older runs) the C2 statement stands.
export function sourceVerificationStatement(quoteCheck, ko = false) {
	if (!quoteCheck) return ko ? "출처 검증: 모델 보고 기준입니다(출처 원문은 대조하지 않았습니다)." : SOURCE_VERIFICATION_STATEMENT;
	const summary = quoteCheck.summary;
	if (ko) return `출처 검증: 엔진이 웹 인용 ${summary.quotes}개 중 ${summary.verified}개를 출처 본문에서 찾았습니다(자세한 내용은 근거 감사 참고). 가져온 본문에서 인용을 찾지 못한 주장은 확인됨으로 표시하지 않습니다. 인용이 주장을 뒷받침하는지는 검증 모델이 판단합니다.`;
	return `Source verification: the engine found ${summary.verified} of ${summary.quotes} quoted web passages on the cited pages (see Quote check in the audit); a claim whose quotes were not on their fetched page is not reported as verified; whether a found quote supports its claim is the verifiers' judgment.`;
}

// K1: a reader-facing line per contested value that no verified claim settled.
function readerContestedLimits(contestedSlots, korean) {
	return asArray(contestedSlots)
		.filter((row) => row?.resolution?.status === "unresolved")
		.slice(0, 4)
		.map((row) => {
			const values = asArray(row.values).map((entry) => entry?.value).filter(Boolean).join(" / ");
			const subject = row.entity || row.slotId || "";
			return korean
				? `${subject}에 대해 출처마다 다른 값(${values})이 나왔고, 검증된 근거로 어느 값이 맞는지 가리지 못했습니다.`
				: `Sources gave different values for ${subject} (${values}); no verified evidence settled which is right.`;
		});
}

function renderCompletionSummary(report, claimSummary, fallback, quoteCheck = null, contestedSlots = []) {
	const summary = summaryText(report, fallback);
	// Fixed presentation labels follow Korean prose when present; other prose is
	// retained verbatim and the parent may translate fixed labels as before.
	const korean = scriptOf(summary) === "hangul";
	const comparisons = comparisonEntries(report).slice(0, 8);
	const recommendations = asArray(report.recommendations);
	const primary = (recommendations.length ? recommendations : asArray(report.mainFindings))
		.slice(0, comparisons.length ? 6 : 8);
	const out = [korean ? "## 결론" : "## Core conclusion", "", ...conclusionLines(report, fallback, completionText), ...renderKeyPoints(report, korean, completionText, "###")];
	if (comparisons.length) {
		out.push(`## ${comparisonHeading(korean)}`, "", comparisonTableHeader(korean), "|---|---|---|---|");
		for (const { item, area, subjectStatus, referencePattern, assessment } of comparisons) {
			const qualifier = readerEvidenceQualifier(item, korean);
			const cells = [area, subjectStatus, referencePattern, `${assessment}${qualifier ? ` (${qualifier})` : ""}`];
			out.push(`| ${cells.map(value => completionText(value).replace(/\r?\n/g, " ")).join(" | ")} |`);
		}
		out.push("");
	}
	if (primary.length) {
		out.push(korean ? "## 주요 권고" : "## Main recommendations", "");
		for (const item of primary) {
			const text = completionItemText(item);
			if (!text) continue;
			const qualifier = readerEvidenceQualifier(item, korean);
			out.push(`- ${completionText(`${text}${qualifier ? ` (${qualifier})` : ""}`)}`);
		}
		out.push("");
	}
	const limits = readerLimits(report, contestedSlots, korean);
	// Unlike the report, the compact handoff has no trust line to signal zero verified claims.
	if (claimSummary.verified === 0) limits.unshift(korean ? "확인된 주장이 없어 결론을 확정할 수 없습니다." : "No claims were verified; the conclusion is not established.");
	if (limits.length) out.push(korean ? "## 알아둘 한계" : "## Limits to keep in mind", "", ...limits.map(text => `- ${completionText(text)}`), "");
	out.push(sourceVerificationStatement(quoteCheck, korean), "");
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderEvidenceAuditSummary(report, claimSummary, slots) {
	const out = [];
	const preservedLeads = finiteNumber(report?.coverageSummary?.preserved);
	const omittedPreservedLeads = finiteNumber(
		report?.coverageSummary?.omittedPreserved,
	);
	const omittedVerificationCandidates = finiteNumber(
		report?.coverageSummary?.omittedVerificationCandidates,
	);
	const coverageGaps = finiteNumber(report?.coverageSummary?.coverageGaps);
	out.push(
		"## Evidence level",
		"",
		`- Audited claims (${claimSummary.total} total): ${claimSummary.verified} verified, ${claimSummary.partially_supported} partially supported, ${claimSummary.unsupported} unsupported, ${claimSummary.conflicting} conflicting, ${claimSummary.verification_blocked} verification blocked.`,
		`- Fact slots: ${slots.filled} filled, ${slots.partial} partial, ${slots.missingOrConflicting} missing/conflicting, ${slots.total} total.`,
	);
	if (
		preservedLeads !== undefined ||
		omittedPreservedLeads !== undefined ||
		omittedVerificationCandidates !== undefined ||
		coverageGaps !== undefined
	) {
		const outsideDenominator = [];
		outsideDenominator.push(
			preservedLeads === undefined
				? "preserved unverified lead count unavailable"
				: `${preservedLeads} preserved unverified leads available to synthesis`,
		);
		outsideDenominator.push(
			omittedPreservedLeads === undefined
				? "additional schema-cap omission count unavailable"
				: `${omittedPreservedLeads} additional leads omitted by a schema cap`,
		);
		outsideDenominator.push(
			coverageGaps === undefined
				? "coverage-gap count unavailable"
				: `${coverageGaps} coverage gaps`,
		);
		if ((omittedVerificationCandidates ?? 0) > 0) {
			outsideDenominator.push(
				`${omittedVerificationCandidates} verification ${omittedVerificationCandidates === 1 ? "candidate" : "candidates"} omitted from audit`,
			);
		}
		out.push(
			`- Outside the audited-claim denominator: ${outsideDenominator.join(", ")}.`,
		);
	}
	if (
		claimSummary.unsupported === 0 &&
		claimSummary.conflicting === 0 &&
		claimSummary.verification_blocked === 0 &&
		(preservedLeads ?? 0) > 0
	) {
		out.push(
			`- The zero unsupported/conflicting/blocked counts apply only to the ${claimSummary.total} audited claims; preserved leads and gaps remain separate.`,
		);
	}
	out.push("");
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderResearchScopeAndMethod(report, ko) {
	const metadata = isRecord(report?.researchMetadata) ? report.researchMetadata : {};
	const scopeCounts = new Map();
	for (const row of asArray(report.researchScopeCoverage)) {
		const status = cleanText(row?.status) || "unknown";
		scopeCounts.set(status, (scopeCounts.get(status) ?? 0) + 1);
	}
	const rows = [];
	if (cleanText(metadata.taskType)) rows.push(`- ${ko ? "조사 유형" : "Task type"}: ${escapeMarkdownText(metadata.taskType)}.`);
	if (cleanText(metadata.depth)) rows.push(`- ${ko ? "조사 깊이" : "Research depth"}: ${escapeMarkdownText(metadata.depth)}.`);
	if (Number.isFinite(Number(metadata.researchQuestions))) rows.push(`- ${ko ? "조사 질문" : "Research questions"}: ${Number(metadata.researchQuestions)}.`);
	if (Number.isFinite(Number(metadata.plannedFactSlots))) rows.push(`- ${ko ? "계획한 검증 항목" : "Planned fact slots"}: ${Number(metadata.plannedFactSlots)}.`);
	if (cleanText(metadata.expectedFinalShape)) rows.push(`- ${ko ? "보고서 형식" : "Expected output shape"}: ${escapeMarkdownText(metadata.expectedFinalShape)}.`);
	if (scopeCounts.size) rows.push(`- ${ko ? "조사 범위 충족도" : "Scope coverage"}: ${[...scopeCounts].map(([status, count]) => `${statusLabel(status, ko)} ${count}`).join(", ")}.`);
	rows.push(ko
		? "- 방법: 질문을 계획하고 출처를 조사한 뒤, 주장을 정리하고 일부를 검증했습니다. 자동 감사 결과를 반영해 보고서를 작성했습니다."
		: "- Method: plan research questions, collect source evidence, normalize claims, verify selected claims, apply deterministic audit gates, and synthesize the report.");
	return rows;
}

// Why the pre-verifier sanitizer held a candidate claim back, in reader words (2026-11-03, owner:
// the report listed "sanitized from verifier candidates: source_hint_claim_mismatch" per claim).
const HELD_BACK_REASONS = {
	source_hint_claim_mismatch: [
		"the claim's wording did not match the quoted source passage",
		"주장 문장이 인용된 출처 구절과 맞지 않음",
	],
	placeholder_source_hint: [
		"the source page could not be read",
		"출처 페이지를 읽지 못함",
	],
	overclaimed_source_inference: [
		"the claim went beyond what the source says",
		"출처가 말한 것보다 넓게 주장함",
	],
	unsupported_normative_prerequisite: [
		"the claim added a requirement the source does not state",
		"출처에 없는 조건을 덧붙임",
	],
	unquoted_named_mitigation: [
		"a named fix was not in the quoted passage",
		"인용 구절에 없는 대책 이름을 씀",
	],
	synthesized_recommendation_claim: [
		"it was a recommendation, not a sourced fact",
		"출처의 사실이 아니라 권고임",
	],
	source_broader_than_evidence_claim: [
		"it generalized beyond the evidence",
		"근거보다 넓게 일반화함",
	],
	missing_candidate_source: ["it had no source", "출처가 없음"],
};

function heldBackReasons(item) {
	const reason = cleanText(isRecord(item) ? item.reason : "");
	const match = /^sanitized from verifier candidates:\s*(.+)$/i.exec(reason);
	return match
		? match[1]
				.split(",")
				.map((code) => code.trim())
				.filter(Boolean)
		: null;
}

// "…; sanitized verifier candidates: claim-004, claim-005; …" is a pipeline note, not reader text.
function withoutSanitizerNotes(text) {
	return text
		.replace(/;?\s*sanitized verifier candidates:\s*[^;]*/gi, "")
		.replace(/\.;\s*/g, ". ")
		.replace(/^;\s*|;\s*$/g, "")
		.trim();
}

// 2026-11-10 (owner decision pending, INBOX): a claim the verifier rejected (Unsupported) or contradicted
// (Contested) is listed with the value the verifier found, as the verifier wrote it. The containment check uses the
// raw text: Markdown escaping depends on position ("- x" at a line start), so escaped strings can differ.
function correctionSuffix(kind, item, korean) {
	if (kind !== "Unsupported" && kind !== "Contested") return "";
	const correction = cleanText(item?.correctionOrCounterclaim);
	if (!correction || rawCaveatText(item).includes(correction)) return "";
	return ` ${korean ? "정정" : "Correction"}: ${escapeMarkdownText(correction)}`;
}

const CAVEAT_LABELS_KO = new Map([
	["Gap", "검증 공백"], ["Unsupported", "근거 부족"], ["Contested", "출처 상충"],
	["Caveat", "주의"], ["Unverified lead", "미확인 단서"], ["Decision note", "결정 메모"],
]);

function renderCaveats(report, ko) {
	return caveatCategories(report).flatMap(({ kind, entries }) => {
		let heldCount = 0;
		const lines = entries.map(({ item, text }) => {
			const reasons = heldBackReasons(item);
			if (reasons) heldCount += 1;
			const why = reasons?.map((code) => escapeMarkdownText(HELD_BACK_REASONS[code]?.[ko ? 1 : 0] ?? code)).join("; ");
			const sources = referenceList(item, Infinity);
			if (why && /^sanitized from verifier candidates:/i.test(text))
				return `- ${why}${sources ? ` (${sources})` : ""}`;
			const extra = kind === "Decision note" ? [item?.whyItMatters, item?.suggestedParentDecision].filter(Boolean).map(escapeMarkdownText) : [];
			return `- ${withoutSanitizerNotes(text) || text}${correctionSuffix(kind, item, ko)}${why ? ` — ${why}` : ""}${extra.length ? ` — ${extra.join(" — ")}` : ""}${sources ? ` (${sources})` : ""}`;
		});
		if (heldCount) lines.unshift(ko ? `검증 전 보류: ${heldCount}개.` : `Held back before verification: ${heldCount}.`, "");
		return [...fold(`${ko ? CAVEAT_LABELS_KO.get(kind) : kind} (${entries.length})`, lines), ""];
	});
}

function renderSourceIndex(sourceIndex, localSourceIndex, ko) {
	const grouped = new Map();
	for (const url of sourceIndex) {
		const host = hostOf(url);
		if (!grouped.has(host)) grouped.set(host, []);
		grouped.get(host).push(url);
	}
	return [
		...[...grouped].map(([host, urls]) => `- **${escapeMarkdownText(host)}**: ${markdownLinkList(urls, urls.length)}`),
		...localSourceIndex.map((ref) => `- ${ko ? "로컬 출처" : "Local source"}: \`${ref}\``),
	];
}

function renderAuditSummary(report, claimSummary, slots, quoteCheck, ko) {
	const coverage = report?.coverageSummary ?? {};
	const mismatches = asArray(claimSummary.coverageSummaryMismatch);
	return [
		ko
			? `- 주장: 확인됨 ${claimSummary.verified}, 일부 확인 ${claimSummary.partially_supported}, 근거 부족 ${claimSummary.unsupported}, 출처 상충 ${claimSummary.conflicting}, 검증 불가 ${claimSummary.verification_blocked}.`
			: `- Claims: ${claimSummary.verified} verified, ${claimSummary.partially_supported} partially supported, ${claimSummary.unsupported} unsupported, ${claimSummary.conflicting} conflicting, ${claimSummary.verification_blocked} verification blocked.`,
		ko
			? `- 검증 항목: 전체 ${slots.total}, 충분 ${slots.filled}, 일부 ${slots.partial}, 누락·상충 ${slots.missingOrConflicting}.`
			: `- Fact slots: ${slots.filled} filled, ${slots.partial} partial, ${slots.missingOrConflicting} missing/conflicting, ${slots.total} total.`,
		...(mismatches.length ? [
			`- ${ko ? "감사 집계와 모델 집계가 다른 항목(감사 집계 사용)" : "Coverage summary mismatch (using audited counts)"}: ${mismatches.map(({ field }) => escapeMarkdownText(field)).join(", ")}.`,
		] : []),
		...(coverage.researchQuestions != null ? [`- ${ko ? "조사 질문" : "Research questions"}: ${coverage.researchQuestions}.`] : []),
		...renderQuoteCheckSummaryLine(quoteCheck, ko), "", sourceVerificationStatement(quoteCheck, ko),
	];
}

// 2026-11-01: engine-side web quote check (check-web-quotes stage), shown here. 2026-11-08 (P2):
// audit-claims also reads it and downgrades a verified claim whose quotes were all absent from
// their fetched page; the renderer still only reports.
const QUOTE_CHECK_REASONS = {
	"quote-not-on-page": "not found on the page",
	"little-page-text": "page had little text (script-rendered or blocked)",
	image: "image",
	audio: "audio",
	video: "video",
	"unsupported-type": "unsupported content type",
	"pdf-tool-missing": "pdftotext not installed",
	"pdf-extract-failed": "PDF text extraction failed",
	"http-error": "HTTP error",
	timeout: "timed out",
	"blocked-address": "non-public address",
	"dns-failed": "host not found",
	"too-large": "page too large",
	"too-many-redirects": "too many redirects",
	"network-error": "network error",
	"invalid-url": "invalid URL",
	"unsupported-scheme": "not an http(s) URL",
	"credentials-in-url": "URL carries credentials",
	"no-quote": "no quote given",
	aborted: "stopped",
	"not-stored": "page body not kept by the run",
};

function quoteCheckOf(source) {
	if (!isRecord(source) || source.enabled !== true) return null;
	if (!isRecord(source.summary) || !Array.isArray(source.results)) return null;
	return source;
}

function quoteCheckReasonText(byReason) {
	return Object.entries(isRecord(byReason) ? byReason : {})
		.filter(([, count]) => Number(count) > 0)
		.sort((a, b) => Number(b[1]) - Number(a[1]))
		.map(([reason, count]) => `${QUOTE_CHECK_REASONS[reason] ?? reason} ${count}`)
		.join(", ");
}

function quoteCheckSources(summary) {
	const captured = Number(summary.verifiedCaptured ?? 0);
	const refetched = Number(summary.verifiedRefetched ?? summary.verified ?? 0);
	return captured > 0
		? ` (${captured} in the verifier's own fetched page text, ${refetched} on the engine's re-fetch)`
		: "";
}

function quoteCheckSummaryText(summary) {
	const inSummary = isRecord(summary.inWorkerSummary)
		? summary.inWorkerSummary
		: null;
	if (!inSummary || Number(inSummary.total) <= 0) return [];
	return [
		`- Quotes the verifier's tool only summarized (found in its page summary): ${inSummary.total} — on the page ${Number(inSummary.onPage ?? 0)}, not on the page ${Number(inSummary.notOnPage ?? 0)}, could not check ${Number(inSummary.unchecked ?? 0)}.`,
	];
}

function renderQuoteCheckSummaryLine(quoteCheck, ko) {
	if (!quoteCheck) return [];
	const summary = quoteCheck.summary;
	if (ko) {
		const summarized = summary.inWorkerSummary;
		return [
			`- 인용 대조(엔진): 전체 ${summary.quotes}개 중 ${summary.verified}개 일치(검증 모델이 가져온 본문 ${Number(summary.verifiedCaptured ?? 0)}개, 엔진이 다시 가져온 본문 ${Number(summary.verifiedRefetched ?? summary.verified)}개). 미확인 ${summary.unverified}개와 사유는 [근거 감사](audit.md)에 나옵니다.`,
			...(summarized?.total > 0 ? [`- 도구 요약에서만 발견된 인용: ${summarized.total}개 — 본문 일치 ${summarized.onPage ?? 0}개, 불일치 ${summarized.notOnPage ?? 0}개, 확인 불가 ${summarized.unchecked ?? 0}개.`] : []),
		];
	}
	const reasons = quoteCheckReasonText(summary.byReason);
	return [
		`- Quote check (engine): ${summary.verified} of ${summary.quotes} quotes found on the cited page${quoteCheckSources(summary)}${
			summary.unverified > 0
				? `; ${summary.unverified} not checked (${reasons}) — listed in [audit](audit.md)`
				: ""
		}.`,
		...quoteCheckSummaryText(summary),
	];
}

function renderQuoteCheckAudit(quoteCheck) {
	if (!quoteCheck) return [];
	const summary = quoteCheck.summary;
	const levels = isRecord(summary.byLevel) ? summary.byLevel : {};
	const out = [
		"",
		"## Quote check (engine)",
		"",
		"The engine looked for each verifier quote in the page text the verifier's own tool returned for that URL, otherwise on the cited page fetched by the engine itself. No model was involved; verdicts above are unchanged.",
		"",
		`- Quotes: ${summary.quotes}; found ${summary.verified}${quoteCheckSources(summary)} (exact ${Number(levels.exact ?? 0)}, after normalization ${Number(levels.normalized ?? 0)}, math notation ${Number(levels.math ?? 0)}); pages fetched ${summary.pages}; not checked ${summary.unverified}.`,
		...quoteCheckSummaryText(summary),
	];
	const unchecked = quoteCheck.results.filter(
		(row) => isRecord(row) && row.grade !== "verified-refetched",
	);
	if (unchecked.length > 0) {
		out.push(
			"",
			"| Claim | Source | Quote | Why not checked |",
			"| --- | --- | --- | --- |",
		);
		for (const row of unchecked)
			out.push(
				`| ${escapeTableCell(row.claimId ?? "")} | ${escapeTableCell(row.url ?? "")} | ${escapeTableCell(`${truncateWords(cleanText(row.quote ?? ""), 24)}${row.location ? ` — at ${cleanText(row.location)}` : ""}`)} | ${escapeTableCell(`${row.reason === "http-error" && row.detail ? row.detail : (QUOTE_CHECK_REASONS[row.reason] ?? row.reason ?? "")}${row.inWorkerSummary ? " (it was in the verifier's page summary)" : ""}`)} |`,
			);
	}
	return out;
}

function renderRelatedArtifacts(ko) {
	return ko ? [
		"- [근거 감사](audit.md) — 주장 판정, 검증 항목, 공백, 렌더링 진단.",
		"- [구조화된 출처 참조](refs.json) — 최종 작업에 사용한 출처 참조 목록.",
		"- [구조화된 보고서](control.json) — 최종 보고서 데이터와 완료 요약.",
	] : [
		"- [Evidence audit](audit.md) — claim verdicts, fact-slot coverage, gaps, and renderer diagnostics.",
		"- [Structured source references](refs.json) — machine-readable source pointers used by the final task.",
		"- [Machine-readable report](control.json) — the structured final report and completion-summary contract.",
	];
}

function trustLine(claims, quoteCheck, sourceCount, question, ko) {
	const summary = quoteCheck?.summary;
	return [
		ko ? `주장 ${claims.total}개 중 ${claims.verified}개 확인, ${claims.partially_supported}개 일부 확인` : `Claims: ${claims.verified} verified, ${claims.partially_supported} partly supported, ${claims.total} total`,
		summary ? (ko ? `인용 ${summary.quotes}개 중 ${summary.verified}개 원문 일치` : `Quotes: ${summary.verified}/${summary.quotes} matched`) : (ko ? "웹 인용 원문 대조 없음" : "Web quotes: not checked"),
		ko ? `출처 ${sourceCount}곳` : `Sources: ${sourceCount}`,
		question ? `${ko ? "남은 질문" : "Open question"}: ${escapeMarkdownText(question)}` : "",
	].filter(Boolean).join(" · ");
}

function renderWarnings(sectionCounts) {
	const checks = [
		["caveatsAndGaps", "renderedCaveatsAndGaps", "caveats/gaps"],
		["sourceUrls", "renderedSourceUrls", "source URLs"],
	];
	return checks
		.filter(([totalKey, renderedKey]) => {
			const total = Number(sectionCounts[totalKey] ?? 0);
			const rendered = Number(sectionCounts[renderedKey] ?? 0);
			return total !== rendered;
		})
		.map(([totalKey, renderedKey, label]) => ({
			section: totalKey,
			label,
			total: sectionCounts[totalKey],
			rendered: sectionCounts[renderedKey],
		}));
}

function renderResearchMarkdown(control, packetSource, options = {}) {
	const composed = composeResearchReport(
		control,
		packetSource,
		options.retranslations,
	);
	const report = composed.report;
	const claimSummary = claimCounts(control, composed.packet);
	const factSlots = sortedFactSlots(report);
	const slots = factSlotSummary(asArray(report.factSlotCoverage));
	const findings = mainFindingEntries(report);
	const comparisons = comparisonEntries(report);
	const recommendations = recommendationEntries(report);
	const actions = actionEntries(report);
	const caveats = selectCaveats(report);
	const sourceRows = [
		report.factSlotCoverage,
		report.mainFindings,
		report.comparisonRows,
		report.recommendations,
		report.actionPlan,
		report.caveatedFindings,
		report.contestedAreas,
		report.notableUnsupportedClaims,
		report.remainingGaps,
		report.parentDecisionNotes,
		report.unverifiedButRelevant,
		composed.ledger,
	];
	const allSourceIndex = uniqueStructuredUrls(...sourceRows);
	const localSourceIndex = localRefsOf(sourceRows, Infinity);
	const maxUrls = Number.isFinite(Number(options.maxUrls))
		? Math.max(0, Number(options.maxUrls))
		: Infinity;
	const sourceIndex = Number.isFinite(maxUrls)
		? allSourceIndex.slice(0, maxUrls)
		: allSourceIndex;
	const sectionCounts = {
		findings: asArray(report.mainFindings).length,
		renderedFindings: findings.length,
		comparisonRows: asArray(report.comparisonRows).length,
		renderedComparisonRows: comparisons.length,
		recommendations: asArray(report.recommendations).length,
		renderedRecommendations: recommendations.length,
		actionItems: asArray(report.actionPlan).length,
		renderedActionItems: actions.length,
		caveatsAndGaps:
			flattenItems(report.remainingGaps).length +
			flattenItems(report.notableUnsupportedClaims).length +
			flattenItems(report.contestedAreas).length +
			flattenItems(report.caveatedFindings).length +
			flattenItems(report.unverifiedButRelevant).length +
			flattenItems(report.parentDecisionNotes).length,
		renderedCaveatsAndGaps: caveats.selected.length,
		factSlots: asArray(report.factSlotCoverage).length,
		renderedFactSlots: factSlots.length,
		sourceUrls: allSourceIndex.length,
		renderedSourceUrls: sourceIndex.length,
	};
	const expectedShape = cleanText(
		report?.researchMetadata?.expectedFinalShape,
	)
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	const comparisonShapeSatisfied =
		control?.schema !== "deep-research-final-synthesis-v2" ||
		expectedShape !== "side_by_side_comparison" ||
		comparisons.length >= 3;
	const warnings = [...renderWarnings(sectionCounts), ...composed.warnings];
	if (!comparisonShapeSatisfied) {
		warnings.push({
			section: "comparisonRows",
			label: "expected 3-8 side-by-side comparison rows",
			total: 1,
			rendered: 0,
		});
	}
	const contestedSlots = asArray(composed.packet.contestedSlots);
	const completionSummaryMarkdown = renderCompletionSummary(report, claimSummary, control.digest, options.quoteCheck, contestedSlots);
	const ko = scriptOf(summaryText(report, control.digest)) === "hangul";
	const limits = readerLimits(report, contestedSlots, ko);
	const openQuestion = report.openQuestion ?? limits.flatMap(sentences).find((text) => /[?？]$/u.test(text)) ??
		asArray(report.parentDecisionNotes).map((item) => completionItemText(item)).flatMap(sentences)
			.find((text) => text.length <= 180 && /(?:아직.{0,14}(?:않|모르)|\b(?:still unknown|not yet (?:known|decided|settled))\b)/iu.test(text));
	const appendix = [
		[ko ? "근거 강도" : "Evidence strength", renderEvidenceStrength(report, ko)],
		[ko ? "검증 공백과 미확인 단서" : "Caveats and remaining gaps", renderCaveats(report, ko)],
		[ko ? "조사 범위와 방법" : "Research scope and method", renderResearchScopeAndMethod(report, ko)],
		[ko ? "감사 요약" : "Audit summary", renderAuditSummary(report, claimSummary, slots, options.quoteCheck, ko)],
		[ko ? "출처 목록" : "Source index", renderSourceIndex(sourceIndex, localSourceIndex, ko)],
		[ko ? "관련 자료" : "Related artifacts", renderRelatedArtifacts(ko)],
	];
	const sourceCount = new Set([...allSourceIndex.map(hostOf), ...localSourceIndex.map((ref) => ref.replace(/#L\d+(?:-L?\d+)?$/i, ""))]).size;
	const sections = [
		ko ? "# 조사 보고서" : "# Research report", "",
		trustLine(claimSummary, options.quoteCheck, sourceCount, openQuestion, ko), "",
		ko ? "## 결론" : "## Conclusion", "",
		...conclusionLines(report, control.digest, escapeMarkdownText),
		...renderKeyPoints(report, ko, escapeMarkdownText, "###"),
		...renderComparisonSnapshot(report, ko),
		...renderActions(report, ko),
		...(limits.length ? [ko ? "## 알아둘 한계" : "## Limits to keep in mind", "", ...limits.map((line) => `- ${escapeMarkdownText(line)}`), ""] : []),
		...renderMainFindings(report, ko),
		ko ? "## 자세한 근거" : "## Appendix", "",
		...appendix.flatMap(([title, body]) => body.length ? [...fold(title, body), ""] : []),
	];

	const markdown = sections
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		markdown,
		ko,
		report,
		completionSummaryMarkdown,
		sourceIndex,
		allSourceIndex,
		claimSummary,
		factSlotSummary: slots,
		sectionCounts,
		comparisonShapeSatisfied,
		renderWarnings: warnings,
	};
}

function synthesisClaimRows(control, rows) {
	const synthesis = isRecord(control?.synthesis) ? control.synthesis : null;
	if (!synthesis) return asArray(control?.claimVerdictIndex?.claims);
	const rowById = mapById(rows, claimIdOf);
	const ids = uniqueStrings([
		...asArray(synthesis.keyFindingIds),
		...asArray(synthesis.notableUnsupportedClaimIds),
		...asArray(synthesis.contestedClaimIds),
		...asArray(synthesis.recommendations).flatMap(supportingClaimIds),
		...asArray(synthesis.actionPlan).flatMap(supportingClaimIds),
		...asArray(synthesis.caveatNotes).flatMap(supportingClaimIds),
		...asArray(synthesis.parentDecisionNotes).flatMap(supportingClaimIds),
	]);
	return ids.map((id) => rowById.get(id)).filter(Boolean);
}

// K1 (2026-11-08): structured values that research observations disagreed on, and whether a
// verified claim settled them. Unresolved rows are already `conflicting` in the slot table.
function renderContestedSlotsAudit(contestedSlots) {
	if (contestedSlots.length === 0) return [];
	const out = [
		"",
		"## Contested values (engine)",
		"",
		"Research observations of the same entity disagreed on these values (dates and numbers compared by code; prose is not compared). A value is settled only by a verified claim that states it.",
		"",
		"| Slot | Entity | Aspect | Values (sources) | Resolution |",
		"|---|---|---|---|---|",
	];
	for (const row of contestedSlots) {
		const values = asArray(row.values)
			.map((entry) => {
				const sources = [
					...asArray(entry.documents),
					...asArray(entry.sourceUrls),
					...asArray(entry.files),
					...asArray(entry.sourceRefs),
				].slice(0, 3);
				return `${entry.value ?? "—"}${sources.length ? ` (${sources.join(", ")})` : ""}`;
			})
			.join(" vs ");
		const resolution =
			row.resolution?.status === "resolved_by_verified_claim"
				? `${asArray(row.resolution.values).join(", ")} by ${asArray(row.resolution.claimIds).join(", ")}`
				: "unresolved; slot is conflicting";
		out.push(
			`| ${escapeTableCell(row.slotId ?? "—")} | ${escapeTableCell(row.entity || "—")} | ${escapeTableCell(row.aspect ?? "—")} | ${escapeTableCell(values)} | ${escapeTableCell(resolution)} |`,
		);
	}
	return out;
}

// 2026-11-08 (context-quality E8): the final synthesis once told the reader that notes.md had a wrong
// QUIC v2 RFC number and should be corrected — notes.md had no RFC numbers at all; the wrong number came
// from the plan. A reader-facing sentence that names a local file, says it is wrong or must be
// corrected, and cites numbers or year-months although the file contains no value of that kind is
// listed as a source-attribution warning in the audit (not a blocker). Comparing a note with an RFC, or
// correcting a value the file does contain, is not flagged (40 recorded reports: 1 warning, the real
// case). Only files inside the run's cwd are read.
const LOCAL_FILE_RE =
	/(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt|json|ya?ml|csv|tsv|js|mjs|ts|py))(?![\w/-])/gu;
const VALUE_NUMBER_RE = /(?<![\w.])\d{4,5}(?![\w.])/gu;
const CORRECTION_RE =
	/(수정|고치|고쳐|교정|정정|잘못|틀린|틀렸|오류|오기)|\b(?:incorrect|wrong|mistaken|erroneous|misstat\w*|fix(?:es|ed)?)\b/iu;

function attributionSentences(text) {
	return String(text ?? "")
		.split(/\n+/u)
		.flatMap((line) => line.split(/(?<=[.!?。])\s+/u))
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

async function readLocalFile(cwd, file, cache) {
	if (cache.has(file)) return cache.get(file);
	let text = null;
	try {
		const root = await realpath(cwd);
		const path = await realpath(resolve(root, file));
		const inside = relative(root, path);
		if (inside && !inside.startsWith("..") && !inside.startsWith(sep))
			text = (await readFile(path, "utf8")).slice(0, 1_000_000);
	} catch {
		text = null;
	}
	cache.set(file, text);
	return text;
}

export async function sourceAttributionWarnings(texts, cwd) {
	if (!cwd) return [];
	const cache = new Map();
	const warnings = [];
	const seen = new Set();
	for (const sentence of texts.flatMap(attributionSentences)) {
		const files = [...new Set([...sentence.matchAll(LOCAL_FILE_RE)].map((m) => m[1]))];
		if (files.length === 0) continue;
		const numbers = [...new Set([...sentence.matchAll(VALUE_NUMBER_RE)].map((m) => m[0]))];
		const dates = structuredDatesIn(sentence).filter((date) => date.month !== undefined);
		if (numbers.length === 0 && dates.length === 0) continue;
		if (!CORRECTION_RE.test(sentence)) continue;
		for (const file of files) {
			const content = await readLocalFile(cwd, file, cache);
			if (content === null) continue;
			// The file states values of the kind the sentence corrects: a correction may be right.
			const fileHasNumbers = /(?<![\w.])\d{4,5}(?![\w.])/u.test(content);
			const fileHasDates = structuredDatesIn(content).some(
				(date) => date.month !== undefined,
			);
			if ((numbers.length > 0 && fileHasNumbers) || (dates.length > 0 && fileHasDates))
				continue;
			const key = `${file}\u0000${sentence}`;
			if (seen.has(key)) continue;
			seen.add(key);
			warnings.push({
				file,
				sentence: sentence.slice(0, 300),
				values: [
					...numbers,
					...dates.map((date) => `${date.year}-${String(date.month).padStart(2, "0")}`),
				],
			});
		}
	}
	return warnings;
}

/** One reader line per file the report blames for values it does not contain, after the source-verification line. */
function withAttributionNotes(markdown, warnings, quoteCheck, korean) {
	if (!markdown || !warnings?.length) return markdown;
	const byFile = new Map();
	for (const warning of warnings)
		byFile.set(warning.file, [
			...new Set([...(byFile.get(warning.file) ?? []), ...warning.values]),
		]);
	const notes = [...byFile].map(([file, values]) => {
		const shown = values.slice(0, 6).map(escapeMarkdownText).join(", ");
		return korean
			? `엔진 확인: 이 보고서가 \`${escapeMarkdownText(file)}\`에서 고치라고 한 값(${shown})은 그 파일에 없습니다. 그 값이 이 파일에서 나왔다는 설명은 확인되지 않았습니다.`
			: `Engine check: \`${escapeMarkdownText(file)}\` does not contain the values this report says to correct in it (${shown}); that attribution is unconfirmed.`;
	});
	const statement = sourceVerificationStatement(quoteCheck, korean);
	const at = markdown.indexOf(statement);
	if (at < 0) return `${markdown}\n\n${notes.join("\n\n")}`;
	const end = at + statement.length;
	return `${markdown.slice(0, end)}\n\n${notes.join("\n\n")}${markdown.slice(end)}`;
}

function renderSourceAttributionAudit(warnings) {
	if (!warnings?.length) return [];
	return [
		"",
		"## Source attribution check (engine)",
		"",
		"These reader-facing sentences name a local file together with values that the file does not contain. Check that the report does not blame the file for a value that came from elsewhere (for example the research plan).",
		"",
		...warnings.map(
			(warning) =>
				`- \`${escapeMarkdownText(warning.file)}\` — values not in the file: ${warning.values.map(escapeMarkdownText).join(", ")} — “${escapeMarkdownText(warning.sentence)}”`,
		),
	];
}

function renderAuditMarkdown(
	control,
	packetSource,
	rendered,
	quoteCheck = null,
	attributionWarnings = [],
) {
	const packet = packetSource?.packet ?? {};
	const report = control?.finalReport ?? {};
	const ledger = asArray(packet.claimVerdictLedger);
	const claims = synthesisClaimRows(control, ledger);
	const gaps = asArray(packet.remainingGaps).length
		? asArray(packet.remainingGaps)
		: asArray(report.remainingGaps);
	const sourceRefJoinFailures = asArray(packet.sourceRefJoinFailures).filter(
		(failure) => uniqueStructuredUrls(failure).length > 0,
	);
	const factSlots = asArray(packet.factSlotCoverage).length
		? asArray(packet.factSlotCoverage)
		: asArray(report.factSlotCoverage);
	const rows = ledger.length ? ledger : claims;
	const out = [
		"# Research audit",
		"",
		"This artifact preserves the detailed claim/gap/source ledger behind `final-report.md`.",
		"",
		sourceVerificationStatement(quoteCheck),
		"",
		renderEvidenceAuditSummary(rendered.report, rendered.claimSummary, rendered.factSlotSummary),
		"",
		"## Synthesis caveats",
		"",
		...asArray(rendered.report.caveatedFindings).map(item => `- ${caveatText(item)}`),
		"",
		"## Claim verdict ledger",
		"",
	];
	if (rows.length > 0) {
		out.push(
			"| ID | Status | Claim/support | Caveat/source |",
			"|---|---|---|---|",
		);
		for (const row of rows) {
			const id = escapeTableCell(row.id ?? row.claimId ?? "—");
			const status = escapeTableCell(row.status ?? row.confidence ?? "—");
			const support = escapeTableCell(
				readableClaimText(
					row.claim ??
						row.support ??
						row.verdictDigest?.support ??
						stringifyItem(row),
				),
			);
			// 2026-11-10 (owner): the packet keeps an empty caveat as "", which hid the verifier's correction behind
			// `??`; a claim the verifier did not verify shows its correction next to the caveat. Other rows unchanged.
			const caveatNote = cleanText(row.caveat);
			const correction = cleanText(row.correctionOrCounterclaim);
			const showCorrection =
				correction &&
				(!caveatNote ||
					(normalizeClaimStatus(row.status) !== "verified" &&
						!caveatNote.includes(correction)));
			const caveat = escapeTableCell(
				showCorrection
					? caveatNote
						? `${caveatNote} Correction: ${correction}`
						: correction
					: (row.caveat ??
							row.correctionOrCounterclaim ??
							markdownLinkList(urlsOf(row, 3), 3) ??
							"—"),
			);
			out.push(`| ${id} | ${status} | ${support} | ${caveat || "—"} |`);
		}
	} else {
		out.push("No compact claim ledger was provided.");
	}
	out.push("", "## Fact slot coverage", "");
	if (factSlots.length > 0) {
		out.push("| Slot | Status | Best value | Gap/impact |", "|---|---|---|---|");
		for (const slot of factSlots) {
			out.push(
				`| ${escapeTableCell(slot.slotId ?? slot.label ?? "—")} | ${escapeTableCell(slot.status ?? "—")} | ${escapeTableCell(isRecord(slot.bestValue) ? stringifyItem(slot.bestValue) : (slot.bestValue ?? "—"))} | ${escapeTableCell(slot.gapReason || slot.parentImpact || "—")} |`,
			);
		}
	} else {
		out.push("No fact-slot ledger was provided.");
	}
	out.push("", "## Remaining gaps", "");
	if (gaps.length > 0) {
		for (const gap of gaps)
			out.push(`- ${caveatText(gap) || stringifyItem(gap)}`);
	} else {
		out.push("No remaining gaps were reported.");
	}
	out.push(...renderContestedSlotsAudit(asArray(packet.contestedSlots)));
	if (claims.length > 0 && ledger.length > 0) {
		out.push("", "## Claims used in executive synthesis", "");
		for (const claim of claims) {
			out.push(
				`- **${escapeMarkdownText(claim.id ?? "claim")}** (${escapeMarkdownText(claim.status ?? "unknown")}): ${escapeMarkdownText(readableClaimText(claim.claim ?? claim.support ?? stringifyItem(claim)))}`,
			);
		}
	}
	if (sourceRefJoinFailures.length > 0) {
		out.push("", "## Source reference join failures", "");
		for (const failure of sourceRefJoinFailures)
			out.push(
				`- ${caveatText(failure) || escapeMarkdownText(stringifyItem(failure))}`,
			);
	}
	out.push(...renderQuoteCheckAudit(quoteCheck));
	out.push(...renderSourceAttributionAudit(attributionWarnings));
	out.push(
		"",
		"## Renderer diagnostics",
		"",
		`- Executive word count: ${countWords(rendered.markdown)}.`,
		`- Rendered source URLs: ${rendered.sourceIndex.length}/${rendered.allSourceIndex.length}.`,
		`- Render warnings: ${rendered.renderWarnings.length}.`,
		...readerTranslationDiagnostics(rendered.report.readerTranslations),
		"",
	);
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function readerTranslationDiagnostics(stats) {
	if (!stats) return [];
	const ignored = uniqueStrings(stats.ignored, 8);
	const retranslated = asArray(stats.retranslated).length;
	const untranslated = Number(stats.untranslated ?? 0);
	return [
		`- Reader translations: ${stats.applied} applied${retranslated ? ` (${retranslated} retranslated)` : ""}, ${stats.ignored.length} ignored${ignored.length ? ` (${ignored.map((id) => escapeMarkdownText(id)).join(", ")})` : ""}${untranslated ? `, ${untranslated} left untranslated` : ""}.`,
	];
}

function blockedSourceResult(reason) {
	return {
		schema: "deep-research-executive-render-v1",
		digest: `Research report rendering blocked: ${reason}`,
		status: "blocked",
		blockers: [reason],
		completionSummaryMarkdown: "",
		executiveMarkdown: "",
		reportMarkdown: "",
		auditMarkdown: "",
		wordCount: 0,
		sourceUrlCount: 0,
		totalSourceUrlCount: 0,
		sourceUrls: [],
		sourceIndex: [],
		claimSummary: {
			total: 0,
			verified: 0,
			partially_supported: 0,
			unsupported: 0,
			conflicting: 0,
			verification_blocked: 0,
		},
		factSlotSummary: { total: 0, filled: 0, partial: 0, missingOrConflicting: 0 },
		sectionCounts: {},
		renderWarnings: [],
		gates: { renderedAllStructuredItems: false, passed: false },
		auditArtifact: "final-audit.control.json",
	};
}

export default async function renderExecutive({
	sources,
	options = {},
	context = {},
}) {
	let control;
	let auditPacket;
	let quoteCheck = null;
	try {
		control = findSource(sources, "final-audit");
		auditPacket = findSource(sources, "final-audit-packet");
		quoteCheck = quoteCheckOf(findSource(sources, "check-web-quotes"));
	} catch (error) {
		return blockedSourceResult(
			error instanceof Error ? error.message : String(error),
		);
	}
	const modernControl = validModernFinalAudit(control);
	const legacyControl = validLegacyFinalAudit(control);
	let controlBlocker = "";
	if (!control || typeof control !== "object")
		controlBlocker = "missing final-audit control source";
	else if (!modernControl && !legacyControl)
		controlBlocker = "malformed final-audit control source";
	else if (modernControl && !auditPacket)
		controlBlocker = "missing final-audit-packet control source";
	else if (modernControl && !validFinalAuditPacket(auditPacket))
		controlBlocker = "malformed final-audit-packet control source";
	if (controlBlocker) {
		return {
			schema: "deep-research-executive-render-v1",
			digest: `Research report rendering failed: ${controlBlocker}.`,
			status: "blocked",
			blockers: [controlBlocker],
			completionSummaryMarkdown: "",
			executiveMarkdown: "",
			reportMarkdown: "",
			auditMarkdown: "",
			wordCount: 0,
			sourceUrlCount: 0,
			totalSourceUrlCount: 0,
			sourceUrls: [],
			sourceIndex: [],
			claimSummary: {
				total: 0,
				verified: 0,
				partially_supported: 0,
				unsupported: 0,
				conflicting: 0,
				verification_blocked: 0,
			},
			factSlotSummary: {
				total: 0,
				filled: 0,
				partial: 0,
				missingOrConflicting: 0,
			},
			sectionCounts: {},
			renderWarnings: [],
			gates: {
				renderedAllStructuredItems: false,
				passed: false,
			},
			auditArtifact: "final-audit.control.json",
		};
	}

	// K3 (2026-11-08): a synthesis that declared its own input blocked is not rendered as a report.
	// The engine fails such a stage before it reaches here; this guards replays and older bundles.
	const integrity = control?.inputIntegrity;
	if (isRecord(integrity) && integrity.status === "blocked") {
		const detail = boundedString(integrity.detail, 1, 600)
			? ` (${integrity.detail})`
			: "";
		return blockedSourceResult(
			`final-audit reported inputIntegrity.status="blocked" with reason="${typeof integrity.reason === "string" && integrity.reason ? integrity.reason : "unspecified"}"${detail}; the synthesis was produced on input its author declared unusable`,
		);
	}

	const packet = packetOf(auditPacket);
	const duplicates = packetDuplicateIds(packet, control);
	if (duplicates.claimIds.length > 0 || duplicates.gapIds.length > 0)
		return duplicateIdRenderResult(duplicates);
	const packetReconciliation = reconcileFinalPacket(packet, control);

	const opts = {
		maxWords: Number.isFinite(Number(options.maxWords))
			? Math.max(0, Number(options.maxWords))
			: Infinity,
		maxUrls: Number.isFinite(Number(options.maxUrls))
			? Math.max(0, Number(options.maxUrls))
			: Infinity,
	};
	const rendered = renderResearchMarkdown(control, auditPacket, {
		...opts,
		quoteCheck,
		retranslations: retranslationsFrom(sources),
	});
	let markdown = rendered.markdown;
	let truncated = false;
	if (Number.isFinite(opts.maxWords) && countWords(markdown) > opts.maxWords) {
		truncated = true;
		markdown = truncateWords(markdown, opts.maxWords);
	}
	const attributionWarnings = await sourceAttributionWarnings(
		[rendered.completionSummaryMarkdown, markdown],
		context.cwd,
	);
	// 2026-11-10 (E8): the reader sees the check too, beside the source-verification line; it was audit-only, so a
	// report that blamed a file for a value it does not state still read as confirmed.
	markdown = withAttributionNotes(markdown, attributionWarnings, quoteCheck, rendered.ko);
	const completionSummaryMarkdown = withAttributionNotes(
		rendered.completionSummaryMarkdown,
		attributionWarnings,
		quoteCheck,
		rendered.ko,
	);
	const auditMarkdown = renderAuditMarkdown(
		control,
		auditPacket,
		rendered,
		quoteCheck,
		attributionWarnings,
	);
	const serializationArtifact =
		hasObjectSerializationArtifact(markdown) ||
		hasObjectSerializationArtifact(auditMarkdown);
	const wordCount = countWords(markdown);
	const sourceUrlCount = rendered.sourceIndex.length;
	const substantiveRenderWarnings = rendered.renderWarnings.filter(
		(warning) => warning.section !== "sourceUrls",
	);
	let renderedAllStructuredItems = substantiveRenderWarnings.length === 0;
	const truncatedWithOpenGaps =
		truncated && Number(rendered.sectionCounts.caveatsAndGaps ?? 0) > 0;
	let passed =
		renderedAllStructuredItems &&
		rendered.comparisonShapeSatisfied &&
		!truncatedWithOpenGaps &&
		!serializationArtifact &&
		packetReconciliation.passed;

	const sidecarErrors = [];
	let finalReportSidecarPath;
	let legacyExecutiveSidecarPath;
	let auditSidecarPath;
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
			finalReportSidecarPath = join(taskDir, "final-report.md");
			legacyExecutiveSidecarPath = join(taskDir, "executive.md");
			auditSidecarPath = join(taskDir, "audit.md");
			await writeFile(finalReportSidecarPath, `${markdown}\n`, "utf8");
			await writeFile(legacyExecutiveSidecarPath, `${markdown}\n`, "utf8");
			await writeFile(auditSidecarPath, `${auditMarkdown}\n`, "utf8");
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		sidecarErrors.push({
			section: "sidecars",
			reason: `sidecar write failed: ${reason}`,
		});
		rendered.renderWarnings.push(sidecarErrors[sidecarErrors.length - 1]);
		renderedAllStructuredItems = false;
		passed = false;
	}

	return {
		schema: "deep-research-executive-render-v1",
		digest: truncateWords(summaryText(rendered.report, control.digest), 45),
		status: passed ? "passed" : "failed",
		renderMode: "evidence-backed-report",
		completionSummaryMarkdown: passed ? completionSummaryMarkdown : "",
		executiveMarkdown: markdown,
		reportMarkdown: markdown,
		auditMarkdown,
		wordCount,
		sourceUrlCount,
		totalSourceUrlCount: rendered.allSourceIndex.length,
		sourceUrls: rendered.sourceIndex,
		sourceIndex: rendered.sourceIndex.map((url) => ({
			url,
			host: hostOf(url),
		})),
		claimSummary: rendered.claimSummary,
		factSlotSummary: rendered.factSlotSummary,
		...(quoteCheck ? { quoteCheck: quoteCheck.summary } : {}),
		sectionCounts: rendered.sectionCounts,
		renderWarnings: rendered.renderWarnings,
		sourceAttributionWarnings: attributionWarnings,
		sidecarErrors,
		packetReconciliation,
		gates: {
			renderedAllStructuredItems,
			maxWords: Number.isFinite(opts.maxWords) ? opts.maxWords : null,
			maxUrls: Number.isFinite(opts.maxUrls) ? opts.maxUrls : null,
			truncated,
			truncatedWithOpenGaps,
			serializationArtifact,
			expectedOutputShapeSatisfied: rendered.comparisonShapeSatisfied,
			sidecarWriteSucceeded: sidecarErrors.length === 0,
			packetReconciliationPassed: packetReconciliation.passed,
			packetReconciliationBlockers: packetReconciliation.blockers,
			passed,
		},
		auditArtifact: auditSidecarPath ? "audit.md" : "final-audit.control.json",
		...(finalReportSidecarPath ? { sidecarPath: "final-report.md" } : {}),
		...(auditSidecarPath ? { auditSidecarPath: "audit.md" } : {}),
	};
}
