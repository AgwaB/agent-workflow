// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) workflows/spec-review/helpers/local-evidence-reader.mjs. MIT, same author. Changes: see docs/bundled-workflows.md.
// Current local bytes, not historical attestation or a same-UID OS sandbox.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export async function readLocalText(cwd, file, signal) {
  signal?.throwIfAborted();
  if (typeof cwd !== "string" || !cwd || typeof file !== "string" || !file || /^[a-z][a-z0-9+.-]*:/i.test(file)) throw new Error("local cwd and file required");
  // Canonical cwd is the trust root (e.g. macOS /var -> /private/var).
  const root = await realpath(resolve(cwd));
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes workflow cwd");
  const ancestors = [];
  let path = root;
  for (const part of ["", ...rel.split(sep).slice(0, -1)]) {
    path = resolve(path, part);
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("symlinked or non-directory evidence ancestor");
    ancestors.push({ path, stat });
  }
  const leaf = await lstat(target, { bigint: true });
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size > BigInt(MAX_FILE_BYTES)) throw new Error("not a bounded regular evidence file");
  const checkPath = async () => {
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(ancestor.stat, current)) throw new Error("evidence ancestry changed");
    }
    if (!sameFile(leaf, await lstat(target, { bigint: true })) || await realpath(target) !== target) throw new Error("evidence path changed");
  };
  signal?.throwIfAborted();
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(leaf, before) || before.size > BigInt(MAX_FILE_BYTES)) throw new Error("evidence changed before read");
    await checkPath();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal?.throwIfAborted();
    if (BigInt(size) !== before.size || !sameFile(before, await handle.stat({ bigint: true }))) throw new Error("evidence file changed during read");
    await checkPath();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}

// Inclusive 1-based LF-delimited lines. CR and whitespace are significant.
// A terminal LF creates an empty last line. The quote may be a substring of
// the selected range, but may not cross its boundary; end is never clamped.
export function localRange(text, start, end) {
  const lines = text.split("\n");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw new Error("invalid or out-of-bounds local line range");
  return lines.slice(start - 1, end).join("\n");
}

// agent-workflow 2026-11-04: where a quote that is not inside its cited lines is in the file (see
// spec-evidence-gate.mjs correctCitations; deep-review's finding-pipeline.mjs has the same rule).
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

/**
 * As deep-review's (2026-11-04): a line break with its indentation counts as one space. With
 * `markdown`, inline-code backticks and emphasis asterisks are ignored on both sides too (a quote
 * of Markdown prose often drops them: "outputRetryAttempts와" for "`outputRetryAttempts`와").
 */
function locateJoined(text, quote, markdown = false) {
  const fold = markdown
    ? (line) => foldEvidenceLine(line).replace(/[`*]/gu, "")
    : foldEvidenceLine;
  const wanted = quote.split("\n").map(fold).join(" ");
  if (wanted.length < 8) return null;
  const starts = [];
  let joined = "";
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) joined += " ";
    starts.push(joined.length);
    joined += fold(line);
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

export function locateEvidence(text, quote, citedStart, citedEnd, file = "") {
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
    if (!found && /\.(md|markdown|mdx)$/iu.test(file)) found = locateJoined(text, quote, true);
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
