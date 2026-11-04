// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) workflows/spec-review/helpers/spec-evidence-gate.mjs. MIT, same author. Changes: see docs/bundled-workflows.md.
// Typed local citations are the only byte evidence protocol. Strings are
// display-only, including file:line, URLs and opaque source refs. No network.
import { createHash } from "node:crypto";
import { readLocalText, localRange } from "./local-evidence-reader.mjs";
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
const EVIDENCE_LINE_TOLERANCE = 10;

function foldEvidenceLine(line) {
  return line
    .replace(/\r$/u, "")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ")
    .trim();
}

/** As deep-review's (2026-11-04): a line break with its indentation counts as one space. */
function locateJoined(text, quote) {
  const wanted = quote.split("\n").map(foldEvidenceLine).join(" ");
  if (wanted.length < 8) return null;
  const starts = [];
  let joined = "";
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) joined += " ";
    starts.push(joined.length);
    joined += foldEvidenceLine(line);
  }
  const at = joined.indexOf(wanted);
  if (at < 0 || joined.indexOf(wanted, at + 1) >= 0) return null;
  const lineOf = (offset) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
    return line + 1;
  };
  return { line: lineOf(at), lineEnd: lineOf(at + wanted.length - 1) };
}

function locateEvidence(text, quote, citedStart, citedEnd) {
  const lines = text.split("\n");
  const span = quote.split("\n").length;
  let found = null;
  let reason = "line";
  const exact = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const line = text.slice(0, at).split("\n").length;
    exact.push({ line, lineEnd: line + span - 1 });
    if (exact.length > 1) return null;
  }
  if (exact.length === 1) found = exact[0];
  else {
    const folded = quote.split("\n").map(foldEvidenceLine).join("\n");
    if (folded.length < 8) return null;
    for (let start = 1; start + span - 1 <= lines.length; start++) {
      const window = lines
        .slice(start - 1, start - 1 + span)
        .map(foldEvidenceLine)
        .join("\n");
      if (!window.includes(folded)) continue;
      if (found) return null;
      found = { line: start, lineEnd: start + span - 1 };
    }
    found ??= locateJoined(text, quote);
    if (!found) return null;
    reason = "whitespace";
    found.text = lines.slice(found.line - 1, found.lineEnd).join("\n");
  }
  const distance =
    found.lineEnd < citedStart
      ? citedStart - found.lineEnd
      : citedEnd < found.line
        ? found.line - citedEnd
        : 0;
  return distance > EVIDENCE_LINE_TOLERANCE ? null : { ...found, reason };
}

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
      !/[A-Za-z0-9]/u.test(row.requirement)
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
  const requirementReconciliation = {
    ...actual,
    complete:
      actual.complete &&
      canonical(actual) ===
        canonical(partition?.evidenceGate?.requirementReconciliation),
  };
  return { checked, requirementReconciliation };
}

export async function partitionRequirementReconciliation(
  partition,
  context = {},
) {
  return (await requirementCoverageAudit(partition, context))
    .requirementReconciliation;
}

export async function auditPartitionEvidence(partition, context = {}) {
  const gate = partition?.evidenceGate;
  const { checked: coverage, requirementReconciliation } =
    await requirementCoverageAudit(partition, context);
  let evidenceComplete =
    gate?.protocol === EVIDENCE_PROTOCOL &&
    gate.complete === true &&
    Array.isArray(gate.findings) &&
    Array.isArray(gate.coverage) &&
    Array.isArray(partition?.needsHuman) &&
    partition.needsHuman.length === 0;
  const dispositions = [
    ...(partition?.finalFindings ?? []),
    ...(partition?.droppedFindings ?? []),
  ];
  if (
    evidenceComplete &&
    (gate.findings.length !== dispositions.length ||
      new Set(gate.findings.map((row) => row.id)).size !== dispositions.length)
  )
    evidenceComplete = false;
  for (const finding of evidenceComplete ? dispositions : []) {
    const verdict = finding.verdict ?? "DROP";
    const saved = gate.findings.find((row) => row.id === finding.id);
    const checkedFinding = await gateDisposition(
      finding.id,
      verdict,
      finding.evidence,
      finding.counterEvidence,
      context,
    );
    if (
      !checkedFinding.complete ||
      canonical(saved) !== canonical(checkedFinding)
    )
      evidenceComplete = false;
  }
  evidenceComplete =
    evidenceComplete &&
    requirementReconciliation.complete &&
    coverage.every((row) => row.complete) &&
    canonical(gate.coverage) === canonical(coverage);
  return { evidenceComplete, requirementReconciliation };
}

// The renderer reconciles canonical rows and recomputes actual bytes. It does
// not accept fabricated verified flags or a reused gate for different quotes.
export async function partitionEvidenceComplete(partition, context = {}) {
  return (await auditPartitionEvidence(partition, context)).evidenceComplete;
}
