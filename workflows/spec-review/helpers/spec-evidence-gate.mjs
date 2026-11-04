// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) workflows/spec-review/helpers/spec-evidence-gate.mjs. MIT, same author. Changes: see docs/bundled-workflows.md.
// Typed local citations are the only byte evidence protocol. Strings are
// display-only, including file:line, URLs and opaque source refs. No network.
import { createHash } from "node:crypto";
import {
  locateEvidence,
  readLocalText,
  localRange,
} from "./local-evidence-reader.mjs";
import { rendererRequirementSource } from "./spec-requirement-source.mjs";

export const EVIDENCE_PROTOCOL = "spec-local-evidence-v1";
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function isLocalCitation(row) {
  return (
    row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    typeof row.file === "string" &&
    row.file.length > 0 &&
    Number.isSafeInteger(row.lineStart) &&
    Number.isSafeInteger(row.lineEnd) &&
    row.lineStart > 0 &&
    row.lineEnd >= row.lineStart &&
    typeof row.quote === "string" &&
    row.quote.trim().length > 0
  );
}

/**
 * agent-workflow 2026-11-04 (live: a Codex verifier quoted a tab-indented function with spaces, so a
 * real S6 gap became needs-human): deep-review's 2026-11-01 rule for verifier quotes. A typed
 * citation whose quote is not inside its cited lines is matched once more against the file: a unique
 * exact occurrence, else a unique occurrence after folding each line (trim; quote, dash and space
 * characters), at most EVIDENCE_LINE_TOLERANCE lines from the cited range. The citation then carries
 * the actual lines and, for a folded match, the file's own text, so the byte gate below stays exact;
 * every correction is recorded. A quote that differs in words, sits farther away, or occurs more than
 * once is left as it was (and fails the gate).
 */
/** The citations of one verifier field, corrected where {@link locateEvidence} finds them. */
export async function correctCitations(value, field, id, context, corrections) {
  if (!Array.isArray(value)) return value;
  const out = [];
  for (const citation of value) {
    if (!isLocalCitation(citation)) {
      out.push(citation);
      continue;
    }
    let text;
    try {
      text = await readLocalText(context.cwd, citation.file, context.signal);
    } catch {
      context.signal?.throwIfAborted();
      out.push(citation);
      continue;
    }
    let inRange = false;
    try {
      inRange = localRange(text, citation.lineStart, citation.lineEnd).includes(citation.quote);
    } catch {}
    const found = inRange
      ? null
      : locateEvidence(text, citation.quote, citation.lineStart, citation.lineEnd);
    if (!found) {
      out.push(citation);
      continue;
    }
    corrections.push({
      id,
      field,
      file: citation.file,
      cited: `${citation.lineStart}-${citation.lineEnd}`,
      actual: `${found.line}-${found.lineEnd}`,
      reason: found.reason,
      ...(found.reason === "whitespace" ? { quoted: citation.quote, stored: found.text } : {}),
    });
    out.push({
      ...citation,
      lineStart: found.line,
      lineEnd: found.lineEnd,
      ...(found.reason === "whitespace" ? { quote: found.text } : {}),
    });
  }
  return out;
}

async function checkRows(value, field, context) {
  const rows = [];
  for (const [index, citation] of (Array.isArray(value)
    ? value
    : []
  ).entries()) {
    context.signal?.throwIfAborted();
    const base = { field, index, citation };
    if (typeof citation === "string") {
      rows.push({
        ...base,
        status: "unverified",
        reason: "legacy locator/text is display-only, not byte evidence",
      });
      continue;
    }
    if (!isLocalCitation(citation)) {
      rows.push({
        ...base,
        status: "unverified",
        reason:
          "typed local file/range/quote required; remote snapshots unsupported",
      });
      continue;
    }
    try {
      const text = await readLocalText(
        context.cwd,
        citation.file,
        context.signal,
      );
      const range = localRange(text, citation.lineStart, citation.lineEnd);
      const status = range.includes(citation.quote) ? "verified" : "mismatch";
      rows.push({
        ...base,
        status,
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      rows.push({
        ...base,
        status: "unreadable",
        reason: error.code ?? error.message,
      });
    }
  }
  return rows;
}

export async function gateDisposition(
  id,
  verdict,
  evidence,
  counterEvidence,
  context = {},
) {
  const rows = [
    ...(await checkRows(evidence, "evidence", context)),
    ...(await checkRows(counterEvidence, "counterEvidence", context)),
  ];
  const requiredField = verdict === "DROP" ? "counterEvidence" : "evidence";
  const typed = rows.filter((row) => typeof row.citation !== "string");
  const complete =
    ["KEEP", "WEAKEN", "DROP"].includes(verdict) &&
    typed.some(
      (row) => row.field === requiredField && row.status === "verified",
    ) &&
    typed.every((row) => row.status === "verified");
  return { id, verdict, complete, rows };
}

export const COVERAGE_STATUSES = [
  "covered",
  "gap",
  "partial",
  "unclear",
  "needsHuman",
];
export const exactRequirementId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);

export async function gateRequirementCoverage(
  coverage,
  context = {},
  finalFindings = [],
) {
  const rows = [];
  for (const [index, row] of (Array.isArray(coverage)
    ? coverage
    : []
  ).entries()) {
    const id = exactRequirementId(row?.requirementId) ? row.requirementId : "";
    const positive = row?.status === "covered";
    // agent-workflow 2026-11-04: corrected like verifier citations (above), but only for this check:
    // the coverage rows themselves stay as the candidate control wrote them (their bytes are bound
    // to it); the renderer recomputes the same corrections from the same file bytes.
    const corrections = [];
    const result = await gateDisposition(
      id,
      "KEEP",
      await correctCitations(row?.evidence, "coverage", id, context, corrections),
      [],
      context,
    );
    const accountedBy = ["gap", "partial"].includes(row?.status)
      ? finalFindings
          .filter(
            (finding) =>
              ["KEEP", "WEAKEN"].includes(finding.verdict) &&
              finding.requirementIds?.includes(id),
          )
          .map((finding) => finding.id)
          .sort()
      : [];
    // Partial is a known remaining gap, never positive coverage. Unclear and
    // needsHuman remain unresolved even with a retained finding. DROP cannot
    // resolve a gap. Bad extra typed citations poison every status.
    const bytesValid = result.rows
      .filter((item) => typeof item.citation !== "string")
      .every((item) => item.status === "verified");
    const complete = Boolean(
      id &&
        COVERAGE_STATUSES.includes(row?.status) &&
        bytesValid &&
        (positive ? result.complete : accountedBy.length > 0),
    );
    rows.push({
      index,
      ...result,
      status: typeof row?.status === "string" ? row.status : "",
      complete,
      positive,
      accountedBy,
      ...(corrections.length > 0 ? { corrections } : {}),
    });
  }
  return rows;
}

// Persist both the exact universe and its actual runtime/control-byte binding.
// A set alone is insufficient: stale controls with unchanged IDs also fail.
export function reconcileRequirementCoverage(
  coverage,
  checked,
  finalFindings,
  source,
) {
  const issues = [];
  const requirements = Array.isArray(source?.requirements)
    ? source.requirements
    : [];
  const requirementIds = [];
  if (!source?.complete || !source?.proof)
    issues.push("missing_requirement_source_proof");
  if (!requirements.length || requirements.length > 40)
    issues.push("absent_or_invalid_requirement_scope");
  const sourceEvidence = Array.isArray(source?.requirementSourceEvidence)
    ? source.requirementSourceEvidence
    : [];
  for (const row of requirements) {
    if (!exactRequirementId(row?.id))
      issues.push("invalid_extracted_requirement_id");
    else if (requirementIds.includes(row.id))
      issues.push(`duplicate_extracted_requirement_id:${row.id}`);
    else requirementIds.push(row.id);
    if (
      typeof row?.requirement !== "string" ||
      row.requirement.trim().length < 8 ||
      // agent-workflow 2026-11-04: any script's letters or digits (a Korean statement was "meaningless").
      !/[\p{L}\p{N}]/u.test(row.requirement)
    )
      issues.push(`missing_or_meaningless_requirement_statement:${row?.id ?? "unknown"}`);
    const sourceCheck = sourceEvidence.find((item) => item?.id === row?.id);
    if (!sourceCheck?.complete)
      issues.push(`unverified_requirement_source:${row?.id ?? "unknown"}`);
    if (
      !Array.isArray(row?.implementationSignals) ||
      !Array.isArray(row?.testSignals)
    )
      issues.push(`missing_requirement_signal_shape:${row?.id ?? "unknown"}`);
  }
  requirementIds.sort();
  if (!Array.isArray(coverage) || coverage.length > 40)
    issues.push("missing_or_invalid_coverage_array");
  const coverageIds = [];
  for (const row of Array.isArray(coverage) ? coverage : []) {
    if (!exactRequirementId(row?.requirementId))
      issues.push("invalid_coverage_requirement_id");
    else {
      if (coverageIds.includes(row.requirementId))
        issues.push(`duplicate_coverage_requirement_id:${row.requirementId}`);
      if (!requirementIds.includes(row.requirementId))
        issues.push(`unknown_coverage_requirement_id:${row.requirementId}`);
      coverageIds.push(row.requirementId);
    }
    if (!COVERAGE_STATUSES.includes(row?.status))
      issues.push("invalid_coverage_status");
  }
  const missingIds = requirementIds.filter((id) => !coverageIds.includes(id));
  if (missingIds.length) issues.push("missing_requirement_coverage");
  if (canonical(coverage) !== canonical(source?.candidate?.requirementCoverage))
    issues.push("coverage_differs_from_candidate_control");
  // Accounted gaps must use the candidate's exact explicit linkage, not a
  // post-hoc forged finding link, alias, title or inferred positional ID.
  for (const finding of finalFindings) {
    const candidates = (
      Array.isArray(source?.candidate?.candidateFindings)
        ? source.candidate.candidateFindings
        : []
    ).filter((row) => row?.id === finding.id);
    const ids = finding.requirementIds;
    if (
      candidates.length !== 1 ||
      !Array.isArray(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) => !exactRequirementId(id) || !requirementIds.includes(id),
      ) ||
      canonical(ids) !== canonical(candidates[0]?.requirementIds)
    )
      issues.push(`invalid_finding_requirement_link:${finding.id}`);
  }
  const unresolvedIds = checked
    .filter((row) => !row.complete)
    .map((row) => row.id);
  const complete =
    issues.length === 0 &&
    checked.length === requirements.length &&
    unresolvedIds.length === 0;
  return {
    protocol: "spec-requirement-reconciliation-v1",
    proof: source?.proof ?? null,
    sourceEvidence,
    requirementIds,
    coverageIds,
    missingIds,
    unresolvedIds,
    issues,
    complete,
    allCovered: complete && checked.every((row) => row.positive),
  };
}

async function requirementCoverageAudit(partition, context = {}) {
  const source = await rendererRequirementSource(context);
  const checked = await gateRequirementCoverage(
    partition?.requirementCoverage,
    context,
    partition?.finalFindings ?? [],
  );
  const actual = reconcileRequirementCoverage(
    partition?.requirementCoverage,
    checked,
    partition?.finalFindings ?? [],
    source,
  );
  const matchesSaved =
    canonical(actual) ===
    canonical(partition?.evidenceGate?.requirementReconciliation);
  const requirementReconciliation = {
    ...actual,
    complete: actual.complete && matchesSaved,
  };
  return { checked, requirementReconciliation, actual, matchesSaved };
}

export async function partitionRequirementReconciliation(
  partition,
  context = {},
) {
  return (await requirementCoverageAudit(partition, context))
    .requirementReconciliation;
}

/**
 * The requirement set itself is proven (sources verified, every id known and present); only
 * unresolved rows (unclear, needsHuman, an unaccounted gap) may remain. agent-workflow 2026-11-04.
 */
export function requirementSetProven(reconciliation) {
  return (
    reconciliation !== null &&
    typeof reconciliation === "object" &&
    Array.isArray(reconciliation.issues) &&
    reconciliation.issues.length === 0 &&
    Array.isArray(reconciliation.missingIds) &&
    reconciliation.missingIds.length === 0
  );
}

/** Every partition source task completed and none reported a partial failure. */
export function sourceStatusComplete(summary) {
  if (summary === null || typeof summary !== "object" || summary.metadataAvailable !== true)
    return false;
  const total = Number(summary.total);
  const completed = Number(summary.completed);
  const nonCompleted = Number(summary.nonCompleted);
  if (![total, completed, nonCompleted].every(Number.isInteger)) return false;
  if (total < 1 || completed < 0 || nonCompleted < 0) return false;
  if (completed + nonCompleted !== total) return false;
  if (completed !== total || nonCompleted !== 0) return false;
  return (Array.isArray(summary.partialFailures) ? summary.partialFailures : []).length === 0;
}

/**
 * The deterministic verdict, shared by the partition (which hands it to the report stage to copy)
 * and the renderer (which recomputes it). agent-workflow 2026-11-04 (owner decision, live run of
 * every workflow: all five INCONCLUSIVE spec-reviews had 4–6 confirmed gaps but a requirement the
 * candidate stage left "unclear" or cited badly, so the same review read GAPS_FOUND on one executor
 * and INCONCLUSIVE on another): confirmed gaps decide first. A gap is proven by its own grounded
 * evidence whatever the unresolved requirements turn out to be, so `gapsGrounded` (grounded
 * KEEP/WEAKEN rows, an intact ledger and a proven requirement set) with complete source and
 * verifier coverage is GAPS_FOUND; the unresolved requirements are reported as limitations.
 * CONFORMS still needs every requirement covered.
 */
export function specReviewVerdict({
  sourceCoverageComplete,
  verifierCoverageComplete,
  requirementReconciliation,
  gapsGrounded,
  finalCount,
  integrityRows,
  unresolvedRows,
}) {
  if (!sourceCoverageComplete) return "INCONCLUSIVE";
  if (gapsGrounded && verifierCoverageComplete) return "GAPS_FOUND";
  if (!requirementReconciliation?.complete) return "INCONCLUSIVE";
  if (!verifierCoverageComplete)
    return integrityRows > 0 || unresolvedRows > 0 ? "NEEDS_HUMAN" : "INCONCLUSIVE";
  if (finalCount > 0) return "GAPS_FOUND";
  if (integrityRows > 0 || unresolvedRows > 0) return "NEEDS_HUMAN";
  return requirementReconciliation.allCovered ? "CONFORMS" : "INCONCLUSIVE";
}

export async function auditPartitionEvidence(partition, context = {}) {
  const gate = partition?.evidenceGate;
  const {
    checked: coverage,
    requirementReconciliation,
    actual,
    matchesSaved,
  } = await requirementCoverageAudit(partition, context);
  const ledgerShape =
    gate?.protocol === EVIDENCE_PROTOCOL &&
    Array.isArray(gate.findings) &&
    Array.isArray(gate.coverage) &&
    Array.isArray(partition?.needsHuman);
  const finalFindings = partition?.finalFindings ?? [];
  const dispositions = [...finalFindings, ...(partition?.droppedFindings ?? [])];
  let dispositionsExact =
    ledgerShape &&
    gate.findings.length === dispositions.length &&
    new Set(gate.findings.map((row) => row.id)).size === dispositions.length;
  let dispositionsComplete = true;
  const finalIds = new Set(finalFindings.map((row) => row?.id));
  let finalsGrounded = finalFindings.length > 0;
  for (const finding of dispositionsExact ? dispositions : []) {
    const verdict = finding.verdict ?? "DROP";
    const saved = gate.findings.find((row) => row.id === finding.id);
    const checkedFinding = await gateDisposition(
      finding.id,
      verdict,
      finding.evidence,
      finding.counterEvidence,
      context,
    );
    if (canonical(saved) !== canonical(checkedFinding)) dispositionsExact = false;
    if (!checkedFinding.complete) {
      dispositionsComplete = false;
      if (finalIds.has(finding.id)) finalsGrounded = false;
    }
  }
  const coverageExact = ledgerShape && canonical(gate.coverage) === canonical(coverage);
  const evidenceComplete =
    ledgerShape &&
    gate.complete === true &&
    partition.needsHuman.length === 0 &&
    dispositionsExact &&
    dispositionsComplete &&
    requirementReconciliation.complete &&
    coverage.every((row) => row.complete) &&
    coverageExact;
  // agent-workflow 2026-11-04: the confirmed gaps stand on an intact ledger even when some
  // requirements stayed unresolved (see specReviewVerdict).
  const gapsGrounded =
    dispositionsExact &&
    finalsGrounded &&
    coverageExact &&
    matchesSaved &&
    requirementSetProven(actual);
  return { evidenceComplete, requirementReconciliation, gapsGrounded };
}

// The renderer reconciles canonical rows and recomputes actual bytes. It does
// not accept fabricated verified flags or a reused gate for different quotes.
export async function partitionEvidenceComplete(partition, context = {}) {
  return (await auditPartitionEvidence(partition, context)).evidenceComplete;
}
