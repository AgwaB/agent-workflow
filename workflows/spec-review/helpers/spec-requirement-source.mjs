// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) workflows/spec-review/helpers/spec-requirement-source.mjs. MIT, same author. Changes: see docs/bundled-workflows.md.
// Only runtime-owned manifest chains locate requirement controls. Saved gate
// metadata, model aliases, titles and row positions are never source authority.
import { createHash } from "node:crypto";
import { readLocalText, localRange, locateEvidence } from "./local-evidence-reader.mjs";

const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const normalizeId = value => typeof value === "string" && value.trim() ? value.trim() : "";
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const citationShape = value => Boolean(
  value && typeof value === "object" && !Array.isArray(value) &&
  typeof value.file === "string" && value.file.trim() &&
  Number.isSafeInteger(value.lineStart) && Number.isSafeInteger(value.lineEnd) &&
  value.lineStart > 0 && value.lineEnd >= value.lineStart &&
  typeof value.quote === "string" && value.quote.trim(),
);
const sourceFiles = sources => (Array.isArray(sources) ? sources : [])
  .map(source => typeof source === "string" ? source.trim() : source?.file?.trim())
  .filter(Boolean);
const sourceCitations = value => Array.isArray(value) ? value : [value];

function candidateUniverse(control, proof) {
  const rows = Array.isArray(control?.candidateFindings) ? control.candidateFindings : [];
  const ids = rows.map(row => typeof row?.id === "string" && row.id.length > 0 ? row.id : "");
  const validIds = ids.filter(Boolean);
  const duplicateIds = [...new Set(validIds.filter((id, index) => validIds.indexOf(id) !== index))].sort();
  const sortedIds = [...validIds].sort();
  return {
    schema: "spec-review-runtime-candidate-universe-v1",
    count: rows.length,
    uniqueCount: new Set(validIds).size,
    ids: sortedIds,
    duplicateIds,
    invalidRowCount: rows.length - validIds.length,
    proof: proof ?? null,
  };
}
const taskPath = (context, taskId, file) => {
  if (!safeId(context.runId) || !safeId(taskId)) throw new Error("unsafe runtime source identity");
  return `.agent-workflow/workflows/${context.runId}/tasks/${taskId}/${file}`;
};
async function readManifest(context, taskId) {
  const text = await readLocalText(context.cwd, taskPath(context, taskId, "source-manifest.json"), context.signal);
  const manifest = JSON.parse(text);
  if (manifest.schema !== "workflow-source-manifest-v1" || manifest.runId !== context.runId || manifest.taskId !== taskId || !Array.isArray(manifest.sources)) throw new Error("invalid runtime source manifest");
  return { manifest, sha256: sha256(text) };
}
function exactSource(rows, stage) {
  const matches = rows.filter(row => row.stageId === stage && row.source === stage && row.specId === `${stage}.main`);
  if (matches.length !== 1 || matches[0].status !== "completed" || !matches[0].artifacts?.control?.path || !safeId(matches[0].taskId)) throw new Error(`missing_or_incomplete_upstream_source:${stage}`);
  return matches[0];
}

async function verifyRequirementSources(control, context) {
  const specSources = sourceFiles(control?.specSources);
  const rows = [];
  for (const requirement of Array.isArray(control?.requirements) ? control.requirements : []) {
    const id = normalizeId(requirement?.id);
    const citations = sourceCitations(requirement?.specEvidence);
    const checked = [];
    for (const citation of citations) {
      if (!citationShape(citation)) {
        checked.push({ status: "unverified", reason: "typed local spec citation required" });
        continue;
      }
      if (!specSources.includes(citation.file.trim())) {
        checked.push({ status: "unverified", reason: "citation file is not declared in specSources" });
        continue;
      }
      try {
        const text = await readLocalText(context.cwd, citation.file, context.signal);
        const range = localRange(text, citation.lineStart, citation.lineEnd);
        // agent-workflow 2026-11-04 (live Codex spec-review: requirement quotes joining soft-wrapped
        // spec lines): a few lines off or whitespace only, as for verifier citations; checked here,
        // the extract-spec control itself is left as written (its bytes are bound).
        const found = range.includes(citation.quote)
          ? null
          : locateEvidence(text, citation.quote, citation.lineStart, citation.lineEnd, citation.file);
        checked.push({
          citation,
          status: range.includes(citation.quote) || found ? "verified" : "mismatch",
          ...(found
            ? { correction: { actual: `${found.line}-${found.lineEnd}`, reason: found.reason } }
            : {}),
          sha256: sha256(text),
        });
      } catch (error) {
        context.signal?.throwIfAborted();
        checked.push({ citation, status: "unreadable", reason: error.code ?? error.message });
      }
    }
    rows.push({ id, complete: specSources.length > 0 && checked.length > 0 && checked.every(row => row.status === "verified"), checked });
  }
  return rows;
}

// agent-workflow 2026-11-04 (live runs: a requirement the candidate stage left "unclear" kept a review
// INCONCLUSIVE although nothing else was open): the recheck-requirements stage looks at each unclear
// requirement once more. Its rows are read from the recheck tasks' own control.json files, found
// through runtime-owned status rows (the partition's source statuses, or the partition manifest when
// the renderer checks it); a control that echoes another requirement than its item, or a requirement
// rechecked twice, is ignored. Only "covered" changes a row, and only by replacing the unclear row's
// evidence, which then goes through the same byte gate as any covered row.
export const RECHECK_STAGE = "recheck-requirements";
const RECHECK_STATUSES = ["covered", "gap", "partial", "unclear"];

// 2026-11-04 (live probe workflow_mw2tolt6_fcd4e5): both recheck workers echoed the requirement id
// in lower case ("req-s5" for REQ-S5), the form of the task name; an echo that differs only in case
// is accepted and the runtime's item identity is kept. Every recheck that is not used is listed in
// `ignored` (task, item, reason).
export async function recheckRows(context, rows) {
  const byId = new Map();
  const duplicates = new Set();
  const ignored = [];
  const ignore = (row, reason) =>
    ignored.push({ taskId: row.taskId, itemIdentity: String(row.itemIdentity ?? ""), reason });
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.stageId !== RECHECK_STAGE || row.status !== "completed" || !safeId(row.taskId)) continue;
    let control;
    try {
      control = JSON.parse(await readLocalText(context.cwd, taskPath(context, row.taskId, "control.json"), context.signal));
    } catch (error) {
      context.signal?.throwIfAborted();
      ignore(row, `unreadable control (${error.code ?? error.message})`);
      continue;
    }
    const echoed = control?.requirementId;
    const id = typeof row.itemIdentity === "string" ? row.itemIdentity : "";
    if (
      !id ||
      typeof echoed !== "string" ||
      (echoed !== id && echoed.toLowerCase() !== id.toLowerCase())
    ) {
      ignore(row, "requirementId differs from the item");
      continue;
    }
    if (!RECHECK_STATUSES.includes(control.status)) {
      ignore(row, "invalid status");
      continue;
    }
    if (byId.has(id)) duplicates.add(id);
    byId.set(id, {
      status: control.status,
      evidence: Array.isArray(control.evidence) ? control.evidence : [],
      reason: typeof control.reason === "string" ? control.reason.replace(/\s+/g, " ").trim().slice(0, 600) : "",
    });
  }
  for (const id of duplicates) {
    byId.delete(id);
    ignored.push({ taskId: "", itemIdentity: id, reason: "rechecked more than once" });
  }
  return { rechecks: byId, ignored: ignored.slice(0, 8) };
}

/** The coverage rows after the rechecks: an unclear row becomes covered with the recheck's evidence,
 * or keeps its status and records what the recheck found. Other rows are unchanged. */
export function applyRechecks(coverage, rechecks) {
  if (!Array.isArray(coverage) || !(rechecks instanceof Map) || rechecks.size === 0) return coverage;
  return coverage.map((row) => {
    const recheck = row?.status === "unclear" ? rechecks.get(row.requirementId) : undefined;
    if (!recheck) return row;
    if (recheck.status === "covered")
      return { requirementId: row.requirementId, status: "covered", evidence: recheck.evidence, recheck: { from: "unclear", status: "covered", reason: recheck.reason } };
    return { ...row, recheck: { status: recheck.status, reason: recheck.reason } };
  });
}

export async function candidateUpstreamFailures(context, owner) {
  try {
    if (owner?.stageId !== "candidate-findings" || owner.specId !== "candidate-findings.main" || owner.status !== "completed") throw new Error("invalid candidate owner");
    const { manifest, sha256: manifestSha256 } = await readManifest(context, owner.taskId);
    const failures = [];
    let extracted;
    let mapped;
    let inspected;
    for (const stage of ["extract-spec", "map-implementation", "inspect-tests"]) {
      try {
        const source = exactSource(manifest.sources, stage);
        const text = await readLocalText(context.cwd, taskPath(context, source.taskId, "control.json"), context.signal);
        const control = JSON.parse(text);
        const readProof = { source, control, sha256: sha256(text) };
        if (stage === "extract-spec") extracted = readProof;
        if (stage === "map-implementation") mapped = readProof;
        if (stage === "inspect-tests") inspected = readProof;
      } catch (error) {
        context.signal?.throwIfAborted();
        failures.push({ source: stage, status: "unverifiable_upstream_source", lastMessage: error.code ?? error.message });
      }
    }
    const candidateText = await readLocalText(context.cwd, taskPath(context, owner.taskId, "control.json"), context.signal);
    const candidate = JSON.parse(candidateText);
    const proof = { runId: context.runId, candidateTaskId: owner.taskId, candidateControlSha256: sha256(candidateText), candidateManifestSha256: manifestSha256, extractTaskId: extracted?.source?.taskId ?? "", extractControlSha256: extracted?.sha256 ?? "", mapTaskId: mapped?.source?.taskId ?? "", mapControlSha256: mapped?.sha256 ?? "", inspectTestsTaskId: inspected?.source?.taskId ?? "", inspectTestsControlSha256: inspected?.sha256 ?? "" };
    const runtimeCandidateUniverse = candidateUniverse(candidate, proof);
    const requirementSource = extracted ? {
      proof,
      requirements: extracted.control.requirements,
      candidate,
      complete: failures.length === 0,
      requirementSourceEvidence: await verifyRequirementSources(extracted.control, context),
    } : null;
    return { failures, runtimeCandidateUniverse, requirementSource };
  } catch (error) {
    context.signal?.throwIfAborted();
    return { failures: [{ source: "candidate-findings", status: "unverifiable_upstream_sources", lastMessage: error.code ?? error.message }], runtimeCandidateUniverse: null, requirementSource: null };
  }
}

export async function rendererCandidateUniverse(context) {
  try {
    const owners = (Array.isArray(context.sourceStatuses) ? context.sourceStatuses : []).filter(row => row?.stageId === "partition-findings" && row.specId === "partition-findings.main" && ["partition-findings", "partition-findings.main"].includes(row.source));
    if (owners.length !== 1 || owners[0].status !== "completed") return null;
    const { manifest } = await readManifest(context, owners[0].taskId);
    const candidateOwner = exactSource(manifest.sources, "candidate-findings");
    return (await candidateUpstreamFailures(context, candidateOwner)).runtimeCandidateUniverse;
  } catch (error) {
    context.signal?.throwIfAborted();
    void error;
    return null;
  }
}

// Independently walk final context -> real partition manifest -> candidate
// manifest -> extract control. Never follow a locator stored in reconciliation.
export async function rendererRequirementSource(context) {
  try {
    const owners = (Array.isArray(context.sourceStatuses) ? context.sourceStatuses : []).filter(row => row?.stageId === "partition-findings" && row.specId === "partition-findings.main" && ["partition-findings", "partition-findings.main"].includes(row.source));
    if (owners.length !== 1 || owners[0].status !== "completed") return null;
    const { manifest } = await readManifest(context, owners[0].taskId);
    const candidate = exactSource(manifest.sources, "candidate-findings");
    const source = (await candidateUpstreamFailures(context, candidate)).requirementSource;
    return source ? { ...source, rechecks: (await recheckRows(context, manifest.sources)).rechecks } : source;
  } catch (error) {
    context.signal?.throwIfAborted();
    void error;
    return null;
  }
}
