// Deterministic completion renderer for impact-review.
//
// The three readiness joins and impact-synthesis keep their workflow-specific
// ontologies. This helper reconciles them conservatively, renders every
// structured row, and never lets narrative synthesis override canonical risk.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	escapeMarkdownText, fold, reportActions, reportLocale, reportSection, reportRiskStatus, reportStatus, shortNarrative,
} from "./report-markdown.mjs";

const STAGES = [
	"impact-synthesis",
	"contract-consistency",
	"regression-risk",
	"ship-readiness",
];
const LEDGER_STAGES = [
	"change-scope",
	"implementation-map",
	"validation-map",
	"api-contract-impact",
	"state-data-impact",
	"validation-impact",
	"docs-release-impact",
	"security-performance-impact",
	"contract-consistency",
	"regression-risk",
	"ship-readiness",
	"impact-synthesis",
];
const VERDICTS = new Set(["READY", "NEEDS_WORK", "BLOCKED", "UNKNOWN"]);
const RISKS = ["none", "low", "medium", "high"];
const RISK_LEVELS = new Set([...RISKS, "unknown"]);
const CONTRACT_STATES = new Set(["pass", "warn", "fail", "unknown"]);
const SHIP_STATES = new Set(["ready", "needs-work", "blocked", "unknown"]);

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanText(value) {
	return String(value ?? "")
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
			" ",
		)
		.replace(/\s+/g, " ")
		// Only before punctuation that ends a word: ".agent-workflow/…", " .env" keep their space (2026-11-04).
		.replace(/\s+([,.;:!?])(?=\s|$)/g, "$1")
		.trim();
}

function safeInline(value) {
	return cleanText(value)
		.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]{}#+|>])/g, "\\$1")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
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

function canonicalSourceKey(stageId) {
	return `impact-analysis.${stageId}`;
}

function findSource(sources, stageId) {
	const key = canonicalSourceKey(stageId);
	return isRecord(sources) && isRecord(sources[key]) ? sources[key] : null;
}

function statusStageMatches(status, stageId) {
	const source = canonicalSourceKey(stageId);
	const stage = cleanText(status?.stageId);
	const specId = cleanText(status?.specId);
	return (
		(stage === stageId || stage === source) &&
		(specId === source || specId === `${source}.main`)
	);
}

// The runtime manifest, rather than model-produced origin/sourceIds, owns the
// source identity.  Only the shipped 12-source bundle is accepted here; old
// four-source captures must not silently enter the fresh protocol.
function impactSourceCoverage(context) {
	const statuses = Array.isArray(context?.sourceStatuses)
		? context.sourceStatuses
		: [];
	const expected = LEDGER_STAGES.map((stageId) => ({
		stageId,
		source: canonicalSourceKey(stageId),
	}));
	const missing = [];
	const duplicate = [];
	const wrongStage = [];
	const orphan = [];
	const assignments = [];
	const assignedIndexes = new Set();
	const taskOwners = new Map();
	for (const [index, status] of statuses.entries()) {
		const taskId = cleanText(status?.taskId);
		if (!taskId) continue;
		if (taskOwners.has(taskId)) taskOwners.get(taskId).push(index);
		else taskOwners.set(taskId, [index]);
	}
	const duplicateTaskIds = [...taskOwners.entries()]
		.filter(([, indexes]) => indexes.length > 1)
		.map(([taskId]) => taskId);
	for (const target of expected) {
		const matches = statuses
			.map((status, index) => ({ status, index }))
			.filter(({ status }) => cleanText(status?.source) === target.source);
		if (matches.length === 0) {
			missing.push(target);
			continue;
		}
		if (matches.length !== 1) {
			duplicate.push({ target, statusIndexes: matches.map(({ index }) => index) });
			continue;
		}
		const [{ status, index }] = matches;
		assignedIndexes.add(index);
		assignments.push({
			sourceId: target.source,
			stageId: target.stageId,
			statusSpecId: cleanText(status.specId),
			statusSource: cleanText(status.source),
			taskId: cleanText(status.taskId),
		});
		if (
			!statusStageMatches(status, target.stageId) ||
			cleanText(status.status) !== "completed" ||
			!cleanText(status.taskId)
		)
			wrongStage.push({
				stageId: target.stageId,
				statusSource: cleanText(status.source),
				statusSpecId: cleanText(status.specId),
				claimedStageId: cleanText(status.stageId),
				status: cleanText(status.status),
			});
	}
	statuses.forEach((status, index) => {
		if (!assignedIndexes.has(index))
			orphan.push({
				index,
				source: cleanText(status?.source),
				specId: cleanText(status?.specId),
				stageId: cleanText(status?.stageId),
			});
	});
	return {
		available: Array.isArray(context?.sourceStatuses),
		expected,
		assignments,
		missing,
		duplicate,
		wrongStage,
		orphan,
		duplicateTaskIds,
		statusCount: statuses.length,
		expectedCount: expected.length,
		bijection:
			Array.isArray(context?.sourceStatuses) &&
			missing.length === 0 &&
			duplicate.length === 0 &&
			wrongStage.length === 0 &&
			orphan.length === 0 &&
			duplicateTaskIds.length === 0 &&
			assignments.length === expected.length &&
			statuses.length === expected.length,
	};
}

// These are the producer-owned observations.  The final helper reads them
// directly; no model is asked to recopy a second identity-bearing ledger.
const ORIGINAL_FIELDS = {
	"change-scope": [
		["changeInputs", "scope"],
		["affectedFiles", "scope"],
		["affectedComponents", "scope"],
		["publicSurfaces", "scope"],
		["assumptions", "assumption"],
		["outOfScope", "scope"],
	],
	"implementation-map": [
		["components", "scope"],
		["entryPoints", "scope"],
		["dataFlows", "scope"],
		["unknowns", "gap"],
	],
	"validation-map": [
		["tests", "scope"],
		["docs", "scope"],
		["releaseArtifacts", "scope"],
		["validationCommandsMentioned", "action"],
		["knownGaps", "gap"],
	],
	"validation-impact": [
		["coveredAreas", "scope"],
		["missingValidation", "gap"],
		["recommendedCommands", "action"],
		["assumptions", "assumption"],
	],
	"api-contract-impact": [["impacts", "issue"], ["assumptions", "assumption"]],
	"state-data-impact": [["impacts", "issue"], ["assumptions", "assumption"]],
	"docs-release-impact": [["impacts", "issue"], ["assumptions", "assumption"]],
	"security-performance-impact": [
		["impacts", "risk"],
		["assumptions", "assumption"],
	],
	"contract-consistency": [
		["issues", "issue"],
		["confirmedConsistencies", "assumption"],
	],
	"regression-risk": [["risks", "risk"], ["riskReducers", "action"]],
	"ship-readiness": [
		["requiredBeforeShip", "action"],
		["niceToHave", "action"],
		["assumptions", "assumption"],
	],
	"impact-synthesis": [
		["blockingIssues", "blocker"],
		["nonBlockingIssues", "issue"],
		["confirmedSafeAreas", "assumption"],
		["recommendedNextActions", "action"],
		["validationToRun", "action"],
		["needsHuman", "gap"],
	],
};

function optionalString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function contentHash(value) {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function originalRowId(stageId, field, item, occurrence) {
	const producerId = optionalString(item?.id);
	const base = producerId
		? `${canonicalSourceKey(stageId)}:${field}:${producerId}`
		: `${canonicalSourceKey(stageId)}:${field}:payload-${contentHash(item).slice(7)}`;
	return occurrence > 1 ? `${base}#${occurrence}` : base;
}

function originalRow(stageId, field, kind, item, index, occurrence, taskId) {
	const record = isRecord(item) ? item : { text: String(item ?? "") };
	const declaredSeverity = cleanText(record.severity ?? record.riskLevel).toLowerCase();
	// An omitted optional severity is not an assertion that risk is unknown.
	// Preserve explicit uncertainty and conservatively handle unknown labels.
	const severity = declaredSeverity === "critical"
		? "high"
		: RISK_LEVELS.has(declaredSeverity)
			? declaredSeverity
			: declaredSeverity || record.scope === "unknown"
				? "unknown"
				: "none";
	const source = canonicalSourceKey(stageId);
	return {
		id: originalRowId(stageId, field, record, occurrence),
		text: optionalString(record.text) || stableStringify(record),
		kind: [
			"issue",
			"risk",
			"scope",
			"assumption",
			"gap",
			"blocker",
			"action",
		].includes(record.kind)
			? record.kind
			: kind,
		severity,
		scope: ["known", "unknown"].includes(record.scope) ? record.scope : "known",
		resolution: ["unresolved", "resolved", "accepted", "not-applicable"].includes(
			record.resolution,
		)
			? record.resolution
			: "unresolved",
		resolutionNote:
			optionalString(record.resolutionNote) ||
			`No resolution was established for original ${field} row.`,
		// These are host-derived identities.  Producer sourceIds/origin fields
		// remain part of the original control but cannot replace this provenance.
		origin: stageId,
		sourceIds: [source],
		provenance: {
			source,
			stage: stageId,
			...(taskId ? { taskId } : {}),
			field,
			index,
		},
		contentHash: contentHash(item),
		...(typeof record.owner === "string" && record.owner.trim()
			? { owner: record.owner }
			: {}),
		...(Array.isArray(record.resolutionEvidence) &&
		record.resolutionEvidence.every(
			(item) =>
				isRecord(item) &&
				typeof item.type === "string" &&
				item.type.trim() &&
				typeof item.ref === "string" &&
				item.ref.trim(),
		)
			? { resolutionEvidence: record.resolutionEvidence }
			: {}),
	};
}

function originalRowsForStage(stageId, value, taskId) {
	const rows = [];
	for (const [field, kind] of ORIGINAL_FIELDS[stageId] ?? []) {
		const occurrences = new Map();
		for (const [index, item] of asArray(value?.[field]).entries()) {
			const key = optionalString(item?.id)
				? `id:${optionalString(item.id)}`
				: `payload:${contentHash(item)}`;
			const occurrence = (occurrences.get(key) ?? 0) + 1;
			occurrences.set(key, occurrence);
			rows.push({
				field,
				index,
				source: item,
				row: originalRow(stageId, field, kind, item, index, occurrence, taskId),
			});
		}
	}
	return rows;
}

function sourceControlFailures(stageId, value) {
	if (!isRecord(value)) return [`${stageId}:missing-control`];
	return (ORIGINAL_FIELDS[stageId] ?? [])
		.filter(([field]) => !Array.isArray(value[field]))
		.map(([field]) => `${stageId}:missing-original-field:${field}`);
}

function resolutionClaimNeedsVerification(row) {
	return Boolean(row && (["resolved", "accepted"].includes(row.resolution) || (row.resolution === "not-applicable" && row.severity !== "none")));
}

function reconcileImpactLedger(sources, context = {}) {
	const assignments = new Map(
		impactSourceCoverage(context).assignments.map((item) => [item.stageId, item]),
	);
	const canonicalRows = {};
	const allRows = [];
	const stageFailures = [];
	const unverifiedResolutions = new Set();
	const ids = new Set();
	const expectedSources = new Set(LEDGER_STAGES.map(canonicalSourceKey));
	for (const sourceKey of Object.keys(sources ?? {}))
		if (!expectedSources.has(sourceKey))
			stageFailures.push(`runtime-sources:unexpected-source-key:${sourceKey}`);
	for (const stageId of LEDGER_STAGES) {
		const value = findSource(sources, stageId);
		const taskId = assignments.get(stageId)?.taskId;
		stageFailures.push(...sourceControlFailures(stageId, value));
		const rows = originalRowsForStage(stageId, value, taskId).map(({ row }) => row);
		for (const row of rows) {
			if (ids.has(row.id)) stageFailures.push(`${stageId}:${row.id}:identity-collision`);
			ids.add(row.id);
			if (resolutionClaimNeedsVerification(row)) unverifiedResolutions.add(row.id);
		}
		canonicalRows[stageId] = rows;
		allRows.push(...rows);
	}
	const sourceCoverage = impactSourceCoverage(context);
	if (!sourceCoverage.bijection)
		stageFailures.push("runtime-source-statuses:incomplete-12-source-bijection");
	const complete = stageFailures.length === 0 && unverifiedResolutions.size === 0;
	return {
		mode: "ledger",
		status: complete ? "complete" : "invalid",
		impactLedger: allRows,
		missingIds: [],
		duplicateIds: [...new Set(stageFailures.filter((item) => item.includes("identity-collision")).map((item) => item.split(":")[1]))].sort(),
		fabricatedSourceIds: [],
		stageFailures: [...new Set(stageFailures)].sort(),
		unverifiedResolutions: [...unverifiedResolutions].sort(),
		canonicalRows,
		complete,
	};
}

function synthesisValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			cleanText(value.summary) &&
			VERDICTS.has(cleanText(value.verdict)) &&
			RISK_LEVELS.has(cleanText(value.riskLevel)) &&
			[
				"blockingIssues",
				"nonBlockingIssues",
				"confirmedSafeAreas",
				"recommendedNextActions",
				"validationToRun",
				"needsHuman",
			].every((key) => Array.isArray(value[key])),
	);
}

function contractValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			CONTRACT_STATES.has(cleanText(value.status)) &&
			Array.isArray(value.issues) &&
			Array.isArray(value.confirmedConsistencies),
	);
}

function regressionValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			RISK_LEVELS.has(cleanText(value.riskLevel)) &&
			Array.isArray(value.risks) &&
			Array.isArray(value.riskReducers),
	);
}

function shipValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			SHIP_STATES.has(cleanText(value.status)) &&
			Array.isArray(value.requiredBeforeShip) &&
			Array.isArray(value.niceToHave) &&
			Array.isArray(value.assumptions),
	);
}

function requiredVerdict({ synthesis, contract, regression, ship }) {
	if (ship.status === "blocked" || asArray(synthesis.blockingIssues).length > 0)
		return "BLOCKED";
	if (
		ship.status === "unknown" ||
		contract.status === "unknown" ||
		regression.riskLevel === "unknown" ||
		asArray(synthesis.needsHuman).length > 0
	)
		return "UNKNOWN";
	if (
		ship.status === "needs-work" ||
		contract.status === "warn" ||
		contract.status === "fail" ||
		asArray(ship.requiredBeforeShip).length > 0 ||
		asArray(synthesis.nonBlockingIssues).length > 0
	)
		return "NEEDS_WORK";
	return "READY";
}

function riskFloorConsistent(
	synthesisRisk,
	regressionRisk,
	canonicalRisk = "none",
) {
	if (
		!RISK_LEVELS.has(synthesisRisk) ||
		!RISK_LEVELS.has(regressionRisk) ||
		!RISK_LEVELS.has(canonicalRisk)
	)
		return false;
	if (canonicalRisk === "unknown")
		return synthesisRisk === "unknown" && regressionRisk === "unknown";
	if (regressionRisk === "unknown") return synthesisRisk === "unknown";
	if (synthesisRisk === "unknown") return true;
	return (
		RISKS.indexOf(synthesisRisk) >= RISKS.indexOf(regressionRisk) &&
		RISKS.indexOf(synthesisRisk) >= RISKS.indexOf(canonicalRisk) &&
		RISKS.indexOf(regressionRisk) >= RISKS.indexOf(canonicalRisk)
	);
}

function effectiveRiskLevel(
	synthesisRisk,
	regressionRisk,
	canonicalRisk = "none",
) {
	if (
		synthesisRisk === "unknown" ||
		regressionRisk === "unknown" ||
		canonicalRisk === "unknown"
	)
		return "unknown";
	const indexes = [synthesisRisk, regressionRisk, canonicalRisk].map((risk) =>
		RISKS.indexOf(risk),
	);
	if (indexes.every((index) => index < 0)) return "unknown";
	return RISKS[Math.max(...indexes)] ?? "unknown";
}

function informationalUnknown(row) {
	if (row?.severity !== "unknown") return false;
	const text = cleanText(row.text).toLowerCase();
	return /out[- ]of[- ]scope|read[- ]only|unknown caller|caller(?:s)? unavailable|informational note/.test(text) &&
		!/(required|missing|block|must|unavailable baseline|cannot|critical)/.test(text);
}

function summarizeCanonicalRisk(rows, unverifiedResolutions = []) {
	const unverified = new Set(unverifiedResolutions);
	const observationIds = new Set();
	let knownFloor = "none";
	for (const row of rows) {
		// Unbound resolution claims cannot remove either a known risk or an
		// unquantified observation. Unknown is not an ordinal above "high".
		if (row.resolution !== "unresolved" && !unverified.has(row.id)) continue;
		if (row.severity === "unknown") {
			if (!informationalUnknown(row)) observationIds.add(row.id ?? `${row.stageId}.status`);
			continue;
		}
		if (RISKS.indexOf(row.severity) > RISKS.indexOf(knownFloor)) knownFloor = row.severity;
	}
	return { present: observationIds.size > 0, knownFloor, observationIds: [...observationIds].sort() };
}

// agent-workflow 2026-11-01: the schemas only require rows to be objects, so models name fields
// freely ({issue, action}, {question, reason}, {id, text}, …) and every row used to print as JSON. A
// flat row now reads as its main text followed by its other fields; no field is dropped. Rows with
// nested values keep the stable JSON form. (The ledger text and row keys are unchanged.)
const COMPACT_ROW_MAIN_KEYS = [
	"text",
	"issue",
	"title",
	"summary",
	"description",
	"detail",
	"question",
	"item",
	"note",
	"check",
	"action",
	"validation",
	"assumption",
	"area",
];

// The report recognizes `finding` as a heading; compact rows keep their old key order.
const REPORT_CLAIM_KEYS = ["text", "issue", "finding", ...COMPACT_ROW_MAIN_KEYS.slice(2)];

function isRowScalar(value) {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function readableRow(row, { includeClaim = true } = {}) {
	if (typeof row === "string") return row;
	if (!isRecord(row)) return stableStringify(row);
	const keys = Object.keys(row).sort();
	const flat =
		keys.length > 0 &&
		keys.every(
			(key) =>
				isRowScalar(row[key]) ||
				(Array.isArray(row[key]) && row[key].every(isRowScalar)),
		);
	if (!flat) return stableStringify(row);
	const main = includeClaim
		? COMPACT_ROW_MAIN_KEYS.find((key) => typeof row[key] === "string" && row[key].trim())
		: undefined;
	const fields = keys
		.filter((key) => key !== main)
		.map(
			(key) =>
				`${key}: ${Array.isArray(row[key]) ? row[key].join(", ") : String(row[key])}`,
		);
	if (!main) return fields.join("; ");
	return fields.length > 0 ? `${row[main]} — ${fields.join("; ")}` : row[main];
}

function impactClaimKey(row) {
	return REPORT_CLAIM_KEYS.find((key) => typeof row?.[key] === "string" && row[key].trim());
}

function impactFinding(row, label, index) {
	if (typeof row === "string") return { claim: row };
	const main = impactClaimKey(row);
	const id = isRowScalar(row?.id) ? cleanText(row.id) : "";
	const claim = main ? row[main] : id && id.length <= 60 ? id : `${label} ${index + 1}`;
	// Keep the readable claim + fields together in the fold. A report-only
	// finding headline is already explicit, so its fold needs only the fields.
	const details = main === "finding"
		? readableRow(Object.fromEntries(Object.entries(row).filter(([key]) => key !== main)), { includeClaim: false })
		: readableRow(row);
	return { claim, details };
}

function rowCollections({ synthesis, contract, regression, ship }) {
	return [
		["blockingIssues", "Blocking issue", "차단 문제", synthesis.blockingIssues],
		["nonBlockingIssues", "Non-blocking issue", "비차단 문제", synthesis.nonBlockingIssues],
		["recommendedNextActions", "Recommendation", "권고", synthesis.recommendedNextActions, "action"],
		["validationToRun", "Validation", "검증", synthesis.validationToRun, "action"],
		["needsHuman", "Needs human review", "사람 검토 필요", synthesis.needsHuman],
		["confirmedSafeAreas", "Confirmed safe", "안전 확인", synthesis.confirmedSafeAreas],
		["contractIssues", "Contract issue", "계약 문제", contract.issues],
		["confirmedConsistencies", "Confirmed consistency", "일관성 확인", contract.confirmedConsistencies],
		["regressionRisks", "Regression risk", "회귀 위험", regression.risks],
		["riskReducers", "Risk reducer", "위험 완화", regression.riskReducers],
		["requiredBeforeShip", "Required before ship", "배포 전 필수", ship.requiredBeforeShip, "action"],
		["niceToHave", "Optional", "선택 사항", ship.niceToHave, "action"],
		["readinessAssumptions", "Readiness assumptions", "배포 준비 가정", ship.assumptions, "appendix"],
	];
}

function issueSummary(collections) {
	return Object.fromEntries(
		collections.map(([key, _en, _ko, rows]) => [key, asArray(rows).length]),
	);
}

function completionText(value, maxChars = 300) {
	const sanitized = safeInline(value)
		// agent-workflow 2026-11-04 (live runs: "workflow-stop.ts" became "[run omitted]", a reviewed
		// file's "control.json" became "[artifact omitted]"): only this engine's own names are hidden —
		// paths under .agent-workflow/workflows, run ids (workflow_<id>_<hex6>), task ids (task-<n>),
		// sidecar names, and refs/control JSON only as a stage-qualified or path-qualified name.
		.replace(
			/(?<![\w-])\.agent-workflow[\\/]workflows(?:[\\/][^\s]*)?/gi,
			"[artifact omitted]",
		)
		.replace(/\b(?:final-report|audit|executive)\.md\b/gi, "[artifact omitted]")
		.replace(/(?<=[.\\/])(?:refs|control)\.json\b/gi, "[artifact omitted]")
		.replace(/\brelated[\s-]+artifacts\b/gi, "[section title omitted]")
		.replace(/\bworkflow\\?_[a-z0-9]+\\?_[a-f0-9]{6}\b/gi, "[run omitted]")
		.replace(/\btask-\d+\b/gi, "[task omitted]");
	const chars = Array.from(sanitized);
	return chars.length <= maxChars
		? sanitized
		: `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function actionSummaryRows(synthesis, ship) {
	const rows = [
		...asArray(ship.requiredBeforeShip),
		...asArray(synthesis.blockingIssues),
		...asArray(synthesis.nonBlockingIssues),
		...asArray(synthesis.recommendedNextActions),
		...asArray(synthesis.validationToRun),
		...asArray(synthesis.needsHuman),
	];
	const seen = new Set();
	return rows
		.filter((row) => {
			const key =
				isRecord(row) && cleanText(row.id)
					? `id:${cleanText(row.id)}`
					: `row:${stableStringify(row)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

/** Worst case with the 850/420/300-char caps: about 5,500 of the schema's 6,000 chars. */
const COMPLETION_ACTION_ROWS = 4;

function renderCompletionSummary({
	verdict,
	riskLevel,
	synthesis,
	ship,
	summary,
	limitations,
}) {
	const actions = actionSummaryRows(synthesis, ship);
	const out = [
		"## Core conclusion",
		"",
		`Verdict: **${verdict}**${verdict === "UNKNOWN" ? " (insufficient evidence)" : ""}; risk: **${riskLevel}**. ${completionText(synthesis.summary, 850)}`,
		"",
		"## Key actions",
		"",
	];
	if (actions.length === 0)
		out.push(
			"- No blocking issue, follow-up action, or validation command was recorded.",
		);
	else {
		// agent-workflow 2026-11-04 (live: Claude and Antigravity runs failed their own control schema,
		// completionSummaryMarkdown 7,132 > 6,000 chars): the summary lists the first rows like
		// spec-review's (blocking first); the full report keeps every row.
		actions
			.slice(0, COMPLETION_ACTION_ROWS)
			.forEach((row) =>
				out.push(`- ${completionText(readableRow(row), 420)}`),
			);
		if (actions.length > COMPLETION_ACTION_ROWS)
			out.push(
				`- ${actions.length - COMPLETION_ACTION_ROWS} additional action row(s) are covered in the full report.`,
			);
	}
	out.push(
		"",
		"## Evidence level",
		"",
		`- Deterministic joins recorded ${summary.contractIssues} contract issue(s), ${summary.regressionRisks} regression risk(s), and ${summary.requiredBeforeShip} required-before-ship row(s).`,
		"- Contract consistency, regression risk, ship readiness, and synthesis controls passed source-completeness checks.",
		"",
		"## Important limitations",
		"",
	);
	const importantLimitations = [
		...limitations,
		...asArray(synthesis.needsHuman),
		...asArray(ship.assumptions),
	];
	if (importantLimitations.length === 0)
		out.push(
			"- No source-coverage, open-decision, readiness-assumption, or renderer-integrity limitation was recorded.",
		);
	else
		importantLimitations
			.slice(0, 8)
			.forEach((row) =>
				out.push(
					`- ${completionText(readableRow(row), 300)}`,
				),
			);
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderMarkdown({ verdict, riskLevel, synthesis, contract, regression, ship, collections,
	sources, coverageCount, coverageComplete, verdictConsistent, riskConsistent, readerLimitations, t,
}) {
	const status = (value) => escapeMarkdownText(reportStatus(value || "unavailable", t));
	const risk = (value) => escapeMarkdownText(reportRiskStatus(value || "unavailable", t));
	const text = (row) => escapeMarkdownText(readableRow(row));
	const count = {};
	const actions = [], findings = [], assumptions = [];
	for (const [key, en, ko, rows, group] of collections) {
		count[key] = 0;
		const label = t(en, ko);
		for (const row of asArray(rows)) {
			if (group === "action") actions.push({ label, value: readableRow(row) || stableStringify(row) });
			else if (group === "appendix") assumptions.push(`- ${text(row)}`);
			else {
				const { claim, details } = impactFinding(row, label, count[key]);
				findings.push(`### **${escapeMarkdownText(label)}** — ${escapeMarkdownText(claim)}`, "");
				if (details && details !== claim) findings.push(...fold(t("Evidence", "근거 보기"), [escapeMarkdownText(details)]), "");
			}
			count[key]++;
		}
	}
	const narrative = verdictConsistent && riskConsistent && synthesis.verdict === verdict ? shortNarrative(synthesis.summary) : [];
	const outcome = {
		READY: t("No readiness blocker was established by this review.", "이번 검토에서 배포를 막는 문제가 확인되지 않았습니다."),
		NEEDS_WORK: t("Address the open issues before shipping.", "배포 전에 미해결 문제를 처리하세요."),
		BLOCKED: t("Do not ship until the blocking issues are resolved.", "차단 문제를 해결하기 전에는 배포하지 마세요."),
		UNKNOWN: t("The available evidence does not establish readiness.", "현재 근거로는 배포 준비 여부를 판단할 수 없습니다."),
	}[verdict];
	const keyPoints = collections.filter(([key, , , rows, group]) => key !== "confirmedConsistencies" && group !== "appendix" && asArray(rows).length)
		.slice(0, 5).map(([, en, ko, rows]) => `- **${t(en, ko)}** — ${t(`${rows.length} recorded`, `${rows.length}건`)}`);
	// The four visible controls have their rows above. Keep every original row from the other
	// lenses in the report as well, including raw nested evidence and distinct repeated rows.
	const originals = LEDGER_STAGES.filter((stage) => !STAGES.includes(stage)).flatMap((stage) => {
		const control = findSource(sources, stage);
		const rows = (ORIGINAL_FIELDS[stage] ?? []).flatMap(([field]) => asArray(control?.[field]).map((row) => `- ${escapeMarkdownText(field)}: ${text(row)}`));
		return reportSection(4, stage, rows);
	});
	const lines = [
		`# ${t("Impact review report", "영향 검토 보고서")}`, "",
		t(`Evidence: ${coverageCount}/${LEDGER_STAGES.length} sources joined · coverage ${coverageComplete ? "complete" : "partial"} · historical file bytes not attested`, `근거: 출처 ${coverageCount}/${LEDGER_STAGES.length}개 연결 · 검토 범위 ${coverageComplete ? "완료" : "일부"} · 이전 파일 원문 미검증`), "",
		`## ${t("Conclusion", "결론")}`, "",
		`${t("Verdict", "판정")}: **${status(verdict)}** · ${t("Risk", "위험도")}: **${risk(riskLevel)}**.`, "",
		...(narrative.length ? narrative : [outcome, ""]),
		...reportSection(3, t("Key points", "핵심 포인트"), keyPoints.length ? keyPoints : [`- ${t("Contract consistency", "계약 일관성")}: **${status(contract.status)}**`, `- ${t("Ship readiness", "배포 준비")}: **${status(ship.status)}**`]),
		...reportSection(2, t("Limitations", "알아둘 한계"), readerLimitations.map((row) => `- ${escapeMarkdownText(row)}`)),
		...reportActions(t("Actions", "할 일"), actions),
		...reportSection(2, t("Findings", "발견 사항"), findings),
		...reportSection(2, t("Appendix", "부록"), fold(t("Impact review records", "영향 검토 기록"), [
			...(!narrative.length && synthesis.summary ? reportSection(3, t("Synthesis narrative", "종합 의견 원문"), [escapeMarkdownText(synthesis.summary)]) : []),
			...reportSection(3, t("Lens statuses", "관점별 판정"), [
				`- ${t("Synthesis verdict and risk", "종합 판정 및 위험도")}: **${status(synthesis.verdict)}** / **${risk(synthesis.riskLevel)}**`,
				`- ${t("Canonical regression risk", "원장 기준 회귀 위험도")}: **${risk(regression.riskLevel)}**`,
				`- ${t("Ship readiness", "배포 준비")}: **${status(ship.status)}**`,
				`- ${t("Contract consistency", "계약 일관성")}: **${status(contract.status)}**`,
			]),
			...reportSection(3, t("Readiness assumptions", "배포 준비 가정"), assumptions),
			...reportSection(3, t("Original impact rows", "영향 분석 원본 항목"), originals),
			...reportSection(3, t("Related artifacts", "관련 자료"), [
				`- [${t("Machine-readable renderer control", "기계 판독용 보고서") }](control.json)`,
				`- [${t("Structured source references", "구조화된 출처") }](refs.json)`,
				`- [${t("Canonical impact source ledger", "영향 분석 출처 원장") }](source-ledger.json)`,
			]),
		])),
	];
	return { markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), renderedCounts: count };
}

function blockedImpactResult(reason) {
	return {
		schema: "impact-review-render-v1",
		digest: `Impact rendering blocked: ${reason}`,
		status: "blocked",
		completionSummaryMarkdown: "",
		markdown: "",
		verdict: "UNKNOWN",
		riskLevel: "unknown",
		issueSummary: {
			blockingIssues: 0,
			nonBlockingIssues: 0,
			recommendedNextActions: 0,
			validationToRun: 0,
			needsHuman: 0,
			confirmedSafeAreas: 0,
			contractIssues: 0,
			confirmedConsistencies: 0,
			regressionRisks: 0,
			riskReducers: 0,
			requiredBeforeShip: 0,
			niceToHave: 0,
			readinessAssumptions: 0,
		},
		sourceArtifacts: [],
		blockers: [reason],
		impactLedger: [],
		ledgerCoverage: {
			mode: "ledger",
			status: "invalid",
			missingIds: [],
			duplicateIds: [],
			fabricatedSourceIds: [],
			stageFailures: [reason],
		},
		sourceCoverage: impactSourceCoverage({ sourceStatuses: [] }),
		gates: {
			allLedgerSourcesAvailable: false,
			sourceCoverageComplete: false,
			verdictConsistent: false,
			riskFloorConsistent: false,
			synthesisRiskUnknown: true,
			regressionRiskUnknown: true,
			riskGatePassed: false,
			renderedAllStructuredItems: false,
			ledgerComplete: false,
			sidecarPublished: false,
			byteAssuranceLimited: true,
			passed: false,
		},
	};
}

export default async function renderImpactReport({ sources, context = {} }) {
	let synthesis;
	let contract;
	let regression;
	let ship;
	try {
		synthesis = findSource(sources, "impact-synthesis") ?? {};
		contract = findSource(sources, "contract-consistency") ?? {};
		regression = findSource(sources, "regression-risk") ?? {};
		ship = findSource(sources, "ship-readiness") ?? {};
	} catch (error) {
		return blockedImpactResult(
			error instanceof Error ? error.message : String(error),
		);
	}
	const validity = {
		"impact-synthesis": synthesisValid(synthesis),
		"contract-consistency": contractValid(contract),
		"regression-risk": regressionValid(regression),
		"ship-readiness": shipValid(ship),
	};
	let ledgerCoverage;
	try {
		ledgerCoverage = reconcileImpactLedger(sources, context);
	} catch (error) {
		return blockedImpactResult(
			error instanceof Error ? error.message : String(error),
		);
	}
	const ledgerMode = ledgerCoverage.mode === "ledger";
	const sourceCoverage = impactSourceCoverage(context, ledgerMode);
	const coverageComplete = sourceCoverage.bijection;
	const canonicalSourcesAvailable = Object.values(validity).every(Boolean);
	const ledgerStatusComplete =
		!ledgerMode ||
		(ledgerCoverage.complete &&
			ledgerCoverage.status === "complete" &&
			ledgerCoverage.unverifiedResolutions.length === 0);
	const allLedgerSourcesAvailable =
		canonicalSourcesAvailable && ledgerStatusComplete;
	const safeSynthesis = isRecord(synthesis) ? synthesis : {};
	const safeContract = isRecord(contract) ? contract : {};
	const safeRegression = isRecord(regression) ? regression : {};
	const safeShip = isRecord(ship) ? ship : {};
	const unverifiedResolutionNeedsHuman = ledgerCoverage.unverifiedResolutions.map(
		(id) => ({
			id: `UNVERIFIED-RESOLUTION-${id}`,
			text: `Resolution claim for ${id} is model-assessed only; verify owner authority and evidence before relying on it.`,
			kind: "gap",
			severity: "unknown",
			scope: "known",
			resolution: "unresolved",
			resolutionNote: "No externally bound approval or evidence was supplied.",
			origin: "impact-renderer",
			sourceIds: [id],
		}),
	);
	const effectiveSynthesis =
		unverifiedResolutionNeedsHuman.length === 0
			? safeSynthesis
			: {
					...safeSynthesis,
					needsHuman: [
						...asArray(safeSynthesis.needsHuman),
						...unverifiedResolutionNeedsHuman,
					],
				};
	const sourceVerdict = canonicalSourcesAvailable && coverageComplete
		? requiredVerdict({ synthesis: effectiveSynthesis, contract: safeContract, regression: safeRegression, ship: safeShip })
		: "UNKNOWN";
	const proposedVerdict = allLedgerSourcesAvailable || sourceVerdict === "BLOCKED"
		? sourceVerdict
		: "UNKNOWN";
	const synthesisRisk = cleanText(safeSynthesis.riskLevel);
	const regressionRisk = cleanText(safeRegression.riskLevel);
	// Lens-level risk assessments are also original source judgments, even
	// when their individual observations omit an optional severity field.
	const sourceRiskRows = ["api-contract-impact", "state-data-impact", "docs-release-impact", "security-performance-impact"]
		.map((stageId) => ({ stageId, severity: cleanText(findSource(sources, stageId)?.status) }))
		.filter((row) => RISK_LEVELS.has(row.severity))
		.map((row) => ({ ...row, resolution: "unresolved", text: `${row.stageId} aggregate risk` }));
	const riskUncertainty = ledgerMode
		? summarizeCanonicalRisk([...ledgerCoverage.impactLedger, ...sourceRiskRows], ledgerCoverage.unverifiedResolutions)
		: { present: false, knownFloor: "none", observationIds: [] };
	const canonicalRisk = riskUncertainty.knownFloor;
	const riskLevel = riskUncertainty.present && proposedVerdict === "READY"
		? "unknown"
		: effectiveRiskLevel(synthesisRisk, regressionRisk, canonicalRisk);
	const synthesisRiskUnknown =
		!RISK_LEVELS.has(synthesisRisk) || synthesisRisk === "unknown";
	const regressionRiskUnknown =
		!RISK_LEVELS.has(regressionRisk) || regressionRisk === "unknown";
	// Unquantified observations cannot establish READY. They also cannot erase
	// a coherent known BLOCKED/NEEDS_WORK assessment with a stated risk floor.
	const uncertaintyBlocksConclusion = riskUncertainty.present && !["BLOCKED", "NEEDS_WORK"].includes(proposedVerdict);
	const riskGatePassed = !synthesisRiskUnknown && !regressionRiskUnknown && !uncertaintyBlocksConclusion;
	const riskConsistent =
		allLedgerSourcesAvailable &&
		riskFloorConsistent(synthesisRisk, regressionRisk, canonicalRisk);
	// A known blocker remains authoritative even when another risk dimension is
	// unknown; an understated risk cannot support a READY label.
	const requiredReportVerdict =
		proposedVerdict === "BLOCKED"
			? "BLOCKED"
			: riskGatePassed && (proposedVerdict !== "READY" || riskConsistent)
				? proposedVerdict
				: "UNKNOWN";
	const verdictConsistent =
		allLedgerSourcesAvailable &&
		coverageComplete &&
		cleanText(safeSynthesis.verdict) === requiredReportVerdict;
	// 2026-11-10 (owner): a synthesis verdict that differs from the one the lens results require is a warning, not a
	// failed render. The required verdict stands, except that READY needs the synthesis's agreement (else UNKNOWN).
	const verdictMismatch =
		allLedgerSourcesAvailable && coverageComplete && !verdictConsistent;
	const verdict =
		verdictMismatch && requiredReportVerdict === "READY"
			? "UNKNOWN"
			: requiredReportVerdict;
	const collections = rowCollections({
		synthesis: effectiveSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
	});
	const summary = issueSummary(collections);
	const limitations = [];
	const t = reportLocale(safeSynthesis.summary, ...collections.flatMap(([, , , rows]) => asArray(rows).map((row) => typeof row === "string" ? row : row?.[impactClaimKey(row)])));
	const readerLimitations = [];
	const limit = (en, ko) => { limitations.push(en); readerLimitations.push(t(en, ko)); };
	if (!canonicalSourcesAvailable) {
		const unavailable = STAGES.filter((stageId) => !validity[stageId]);
		limit(
			`Missing or malformed canonical source control(s): ${unavailable.join(", ") || "unknown"}.`, `원본 출처 자료가 없거나 형식이 잘못됨: ${unavailable.join(", ")}.`,
		);
	}
	if (!ledgerStatusComplete && canonicalSourcesAvailable)
		limit("Canonical source controls or runtime source provenance are incomplete.", "원본 출처 자료 또는 실행 출처 정보가 불완전합니다.");
	if (ledgerMode && !ledgerCoverage.complete) {
		limit(
			`Impact ledger reconciliation failed: missing=${ledgerCoverage.missingIds.length}, duplicate=${ledgerCoverage.duplicateIds.length}, fabricated=${ledgerCoverage.fabricatedSourceIds.length}.`, `영향 원장 대조 실패: 누락 ${ledgerCoverage.missingIds.length}, 중복 ${ledgerCoverage.duplicateIds.length}, 확인되지 않은 출처 ${ledgerCoverage.fabricatedSourceIds.length}.`,
		);
	}
	if (ledgerMode && ledgerCoverage.status !== "complete")
		limit(
			`Impact ledger status is ${ledgerCoverage.status}; only complete ledger status can pass.`, "영향 원장이 완전하지 않습니다.",
		);
	if (ledgerMode && ledgerCoverage.unverifiedResolutions.length > 0)
		limit(
			`Resolution claims are model-assessed and lack externally bound approval/evidence authority: ${ledgerCoverage.unverifiedResolutions.join(", ")}.`, `해결됐다는 모델 판단에 외부 승인 또는 근거가 없습니다: ${ledgerCoverage.unverifiedResolutions.join(", ")}.`,
		);
	if (ledgerMode && canonicalRisk !== "none")
		limit(`Known canonical impact risk floor is ${canonicalRisk}.`, `원장에서 확인한 최소 위험도: ${reportRiskStatus(canonicalRisk, t)}.`);
	if (riskUncertainty.present)
		limit(`${riskUncertainty.observationIds.length} original risk observations remain unquantified; they are retained separately from the known risk floor and cannot establish READY.`, `위험 관찰 ${riskUncertainty.observationIds.length}건은 수준을 판단하지 못해, 배포 가능 판정의 근거로 삼을 수 없습니다.`);
	limitations.push(
		"Impact review does not attest historical source-file bytes; content hashes cover host-supplied control values only, and citations are unverified unless an authoritative byte snapshot is supplied.",
	);
	if (!coverageComplete)
		limit(
			"Canonical source lifecycle metadata is missing, duplicated, non-terminal, or incomplete.", "출처의 작업 상태에 누락, 중복, 미종료 또는 불완전한 항목이 있습니다.",
		);
	if (allLedgerSourcesAvailable && !verdictConsistent)
		limit(
			`The synthesis gave verdict ${cleanText(safeSynthesis.verdict) || "none"}, but the lens results require ${requiredReportVerdict}; the report uses ${verdict}.`, `종합 의견 판정은 ${reportStatus(safeSynthesis.verdict || "none", t)}이지만 관점별 결과는 ${reportStatus(requiredReportVerdict, t)}입니다. 보고서는 ${reportStatus(verdict, t)} 판정을 적용합니다.`,
		);
	if (allLedgerSourcesAvailable && !riskConsistent)
		limit(
			`Synthesis risk ${synthesisRisk || "unavailable"} understates or obscures the known source risk floor ${canonicalRisk} (regression risk ${regressionRisk || "unavailable"}).`, `종합 위험도(${reportRiskStatus(synthesisRisk || "unavailable", t)})가 출처에서 확인한 최소 위험도(${reportRiskStatus(canonicalRisk, t)})를 반영하지 않습니다(회귀 위험도: ${reportRiskStatus(regressionRisk || "unavailable", t)}).`,
		);
	// 2026-11-23 (owner): "evidence is insufficient" is a verdict, not a failed run. When every source is present
	// and joined and the verdict is UNKNOWN, the run completes and the report says why the evidence did not
	// suffice. A verdict that stays BLOCKED/NEEDS_WORK/READY still needs the risk gates to pass.
	const insufficientEvidence =
		allLedgerSourcesAvailable && coverageComplete && verdict === "UNKNOWN";
	if (!riskGatePassed) {
		readerLimitations.unshift(insufficientEvidence
			? t("Insufficient evidence: the impact risk could not be established from the supplied change and repository, so the verdict is UNKNOWN rather than READY.", "제공된 변경과 저장소만으로는 위험도를 판단할 수 없어 배포 가능 여부를 알 수 없습니다.")
			: t("Unknown impact risk prevents a successful readiness gate.", "영향 위험도를 판단하지 못해 배포 준비 검사를 통과하지 못했습니다."));
		limitations.unshift(
			insufficientEvidence
				? "Insufficient evidence: the impact risk could not be established from the supplied change and repository, so the verdict is UNKNOWN rather than READY."
				: "Unknown impact risk prevents a successful readiness gate.",
		);
	}
	const readerInputs = { sources, coverageCount: LEDGER_STAGES.filter((stage) => findSource(sources, stage)).length, coverageComplete, verdictConsistent, riskConsistent, readerLimitations, t };
	const provisional = renderMarkdown({
		...readerInputs,
		verdict,
		riskLevel,
		synthesis: effectiveSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
		collections,
	});
	const renderedAllStructuredItems = Object.keys(summary).every(
		(key) => summary[key] === provisional.renderedCounts[key],
	);
	if (!renderedAllStructuredItems)
		limitations.push(
			"At least one structured issue, action, validation, needs-human, or readiness row was not rendered.",
		);
	const passed =
		allLedgerSourcesAvailable &&
		coverageComplete &&
		riskConsistent &&
		(insufficientEvidence || riskGatePassed) &&
		renderedAllStructuredItems;
	let status =
		!allLedgerSourcesAvailable || !coverageComplete
			? "blocked"
			: passed
				? "passed"
				: "failed";
	let completionSummaryMarkdown = passed
		? renderCompletionSummary({
				verdict,
				riskLevel,
				synthesis: effectiveSynthesis,
				ship: safeShip,
				summary,
				limitations,
			})
		: "";
	let rendered = renderMarkdown({
		...readerInputs,
		verdict,
		riskLevel,
		synthesis: effectiveSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
		collections,
	});
	const gates = {
		allLedgerSourcesAvailable,
		sourceCoverageComplete: coverageComplete,
		verdictConsistent,
		riskFloorConsistent: riskConsistent,
		synthesisRiskUnknown,
		regressionRiskUnknown,
		riskGatePassed,
		renderedAllStructuredItems,
		ledgerComplete: !ledgerMode || ledgerStatusComplete,
		sidecarPublished: true,
		byteAssuranceLimited: true,
		passed,
	};
	let sidecarPath;
	let ledgerSidecarPath;
	let sidecarError;
	const sidecarRequired = Boolean(
		context.cwd && context.runId && context.taskId,
	);
	try {
		if (sidecarRequired) {
			const taskDir = join(
				context.stateCwd ?? context.cwd,
				".agent-workflow",
				"workflows",
				context.runId,
				"tasks",
				context.taskId,
			);
			await mkdir(taskDir, { recursive: true });
			await writeFile(
				join(taskDir, "final-report.md"),
				`${rendered.markdown}\n`,
				"utf8",
			);
			await writeFile(
				join(taskDir, "source-ledger.json"),
					`${stableStringify({
						schema: "impact-review-source-ledger-v1",
						sourceControls: Object.fromEntries(
							LEDGER_STAGES.map((stageId) => [
								stageId,
								findSource(sources, stageId),
							]),
						),
						impactSynthesis: safeSynthesis,
						contractConsistency: safeContract,
						regressionRisk: safeRegression,
						shipReadiness: safeShip,
						impactLedger: ledgerCoverage.impactLedger,
						ledgerCoverage,
						})}\n`,
				"utf8",
			);
			sidecarPath = "final-report.md";
			ledgerSidecarPath = "source-ledger.json";
		}
	} catch {
		sidecarError =
			"Sidecar publication failed; final report and source ledger were not written.";
		limit(sidecarError, "최종 보고서와 출처 원장을 저장하지 못했습니다.");
	}
	if (sidecarRequired && !sidecarPath) {
		status = "failed";
		completionSummaryMarkdown = "";
		rendered = renderMarkdown({
			...readerInputs,
			verdict,
			riskLevel,
			synthesis: effectiveSynthesis,
			contract: safeContract,
			regression: safeRegression,
			ship: safeShip,
			collections,
		});
	}
	gates.sidecarPublished = !sidecarRequired || Boolean(sidecarPath);
	gates.passed = gates.passed && gates.sidecarPublished;
	const controlForDigestFinal = {
		status,
		verdict,
		riskLevel,
		riskUncertainty,
		issueSummary: summary,
		gates,
		ledgerCoverage,
		markdown: rendered.markdown,
	};
	return {
		schema: "impact-review-render-v1",
		digest: `sha256:${createHash("sha256").update(stableStringify(controlForDigestFinal)).digest("hex")}`,
		status,
		...(limitations.length > 0 ? { blockers: limitations.slice(0, 32) } : {}),
		completionSummaryMarkdown,
		markdown: rendered.markdown,
		verdict,
		riskLevel,
		riskUncertainty,
		issueSummary: summary,
		sourceCoverage,
		sourceArtifacts: STAGES.filter((stageId) => validity[stageId]).map(
			(stageId) => `${stageId}.control.json`,
		),
		impactLedger: ledgerCoverage.impactLedger,
		ledgerCoverage: {
			mode: ledgerCoverage.mode,
			status: ledgerCoverage.status,
			missingIds: ledgerCoverage.missingIds,
			duplicateIds: ledgerCoverage.duplicateIds,
			fabricatedSourceIds: ledgerCoverage.fabricatedSourceIds,
			stageFailures: ledgerCoverage.stageFailures,
		},
		gates,
		...(sidecarError ? { sidecarError } : {}),
		...(sidecarPath ? { sidecarPath } : {}),
		...(ledgerSidecarPath ? { ledgerSidecarPath } : {}),
	};
}
