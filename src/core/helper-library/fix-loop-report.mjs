// Renders the loop's code-tested rounds. Writer summaries are labelled as reported;
// file deltas and test verdicts are from the same-round helper, not the writer.
import { codeSpan, renderCell, tableRow } from "./render-report.mjs";

const STATUS_TEXT = {
  green: "green",
  "still-failing": "still failing",
  "command-error": "test command error",
  timeout: "test command timed out",
  "protected-changed": "green but protected files changed",
  unverified: "not verified",
};

function clip(value, max) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function cell(value, max) {
  return renderCell(value, { max });
}

function readOptions(options) {
  const settings = options || {};
  const names = {};
  for (const [key, fallback] of [["loop", "fix-loop"], ["writer", "write"], ["tester", "test"]]) {
    const value = settings[key] === undefined ? fallback : settings[key];
    if (typeof value !== "string" || value === "") throw new Error("report: support.options." + key + " must be a stage id");
    names[key] = value;
  }
  return names;
}

function pathList(paths, total, budget, format, empty = "none") {
  const entries = [];
  let used = 0;
  for (const path of paths) {
    const item = format(path);
    const remaining = total - entries.length - 1;
    const suffix = remaining > 0 ? ", " + remaining + " more omitted" : "";
    const size = (entries.length > 0 ? 2 : 0) + item.length;
    if (used + size + suffix.length > budget) break;
    used += size;
    entries.push(item);
  }
  if (total > entries.length) entries.push((total - entries.length) + " more omitted");
  return entries.join(", ") || empty;
}

function code(value, max) {
  return codeSpan(clip(value, max));
}

function markdownFor(view) {
  // Share the 20,000-character schema limit across the round table (8,000),
  // five path lists (1,400 each), and bounded headings, diagnostics and output.
  const lines = ["# Fix loop report", "", "- Status: **" + STATUS_TEXT[view.status] + "**", "- Rounds used: " + view.rounds + " (loop " + clip(view.loopStatus || "unknown", 40) + ")", "- Branch: " + code(view.branch || "(none)", 200), "- Worktree: " + code(view.worktree || "(none)", 500), ""];
  if (view.lastObserved) lines.push("Branch and worktree above are the last observed location, not a final test verdict.", "");
  else if (view.recorded) lines.push("The recorded checkout above identifies the retained location, not a final test verdict.", "");
  if (view.headline) lines.push(clip(view.headline, 850), "");
  lines.push("## Rounds", "");
  if (view.rows.length === 0) {
    lines.push("No round reported what it changed.", "");
  } else {
    lines.push(tableRow(["Round", "What changed (as reported)", "Files changed (git)", "Tests"]), tableRow(["---", "---", "---", "---"]));
    let budget = 8000;
    let shown = 0;
    for (const row of view.rows) {
      const files = !row.measured ? "unknown (not measured)"
        : row.baselineKnown === false ? "unknown (baseline unavailable)"
        : "(" + row.total + ") " + pathList(row.files, row.total, 250, (file) => cell(file, 120), "-");
      const line = tableRow([row.round, cell(row.summary || "-", 160), files, cell(row.tests, 160)]);
      if (line.length + 1 > budget) break;
      lines.push(line);
      budget -= line.length + 1;
      shown += 1;
    }
    lines.push("");
    if (shown < view.rows.length) lines.push((view.rows.length - shown) + " more rounds omitted.", "");
  }
  lines.push("## Verified state of the worktree", "");
  if (view.measured) {
    const paths = (label, values, total, lowerBound = false) => "- " + label + " (" + (lowerBound ? "at least " : "") + total + "): " + pathList(values, total, 1400, (file) => code(file, 120));
    const unknown = ": unknown (baseline unavailable)";
    lines.push(
      "- Test command: " + code(view.command, 300) + (view.verified ? ", exit " + view.exitCode + (view.passed >= 0 ? ", " + view.passed + " passed" : "") + (view.failed >= 0 ? ", " + view.failed + " failed" : "") : ": " + STATUS_TEXT[view.status]),
      paths("Final dirt vs HEAD", view.changed, view.changedTotal),
      view.runBaselineKnown === false ? "- Changed protected paths" + unknown : paths("Changed protected paths", view.protectedChanged, view.protectedTotal),
    );
    if (view.runBaselineKnown !== undefined) {
      lines.push(
        view.runBaselineKnown ? paths("Pre-existing dirt", view.preExistingFiles, view.preExistingTotal) : "- Pre-existing dirt" + unknown,
        view.runBaselineKnown ? paths("Net changes during this run", view.runFiles, view.runTotal) : "- Net changes during this run" + unknown,
      );
    }
    if (view.unreported.length > 0) lines.push(paths("Changes no round reported", view.unreported, view.unreported.length, view.unreportedCapped));
    else if (view.unreportedCapped) lines.push("- Changes no round reported: unknown (path list truncated)");
    if (view.outputTruncated) lines.push("- Test output was truncated.");
    if (view.note) lines.push("- Diagnostic: " + cell(view.note, 300));
    lines.push("");
    if (view.excerpt) lines.push("Last test output:", "", "```", view.excerpt.slice(0, 1200).replace(/```/g, "'''"), "```", "");
  } else {
    lines.push("The project test result is unavailable, so nothing was verified.", "");
  }
  lines.push("Nothing is merged automatically: review the worktree and branch, then merge or copy the changes yourself. The worktree is kept.", "");
  return lines.join("\n");
}

export default async function helper({ sources, options, context }) {
  const names = readOptions(options);
  const rowsOfSources = Array.isArray(context.sourceStatuses) ? context.sourceStatuses : [];
  const loopRow = rowsOfSources.find((row) => row.loop && row.loop.loopId === names.loop);
  const loopInfo = loopRow ? loopRow.loop : undefined;
  const rounds = loopInfo?.roundsUsed ?? 0;
  const earlierTests = await context.readLoopHistory(names.loop, names.tester);
  const earlierWrites = await context.readLoopHistory(names.loop, names.writer);
  const write = sources[names.loop + "." + names.writer] ?? earlierWrites.find((row) => row.round === rounds)?.control;
  const test = sources[names.loop + "." + names.tester] ?? earlierTests.find((row) => row.round === rounds)?.control;
  const measured = Boolean(test && !test.rehearsal && typeof test.outcome === "string");
  const verified = measured && ((test.outcome === "green" && test.exitCode === 0) || (test.outcome === "red" && test.exitCode > 0));
  const green = verified && test.outcome === "green";
  const protectedChanged = measured && Array.isArray(test.protectedChanged) ? test.protectedChanged : [];
  let status;
  if (measured && test.outcome === "timeout") status = "timeout";
  else if (measured && test.outcome === "error") status = "command-error";
  else if (!verified) status = "unverified";
  else if (!green) status = "still-failing";
  else if (protectedChanged.length > 0) status = "protected-changed";
  else status = "green";

  const rows = [];
  const named = new Set();
  for (let round = 1; round <= rounds; round += 1) {
    const writer = round === rounds ? write : earlierWrites.find((row) => row.round === round)?.control;
    const measured = round === rounds ? test : earlierTests.find((row) => row.round === round)?.control;
    const tests = !measured ? "not verified" : measured.rehearsal ? "rehearsal worktree probe"
      : measured.outcome === "error" || measured.outcome === "timeout" ? STATUS_TEXT[measured.outcome === "error" ? "command-error" : "timeout"] + (measured.note ? ": " + measured.note : "")
      : measured.outcome + ", exit " + measured.exitCode + (measured.failed >= 0 ? ", " + measured.failed + " failing" : "");
    if (Array.isArray(writer?.files)) for (const file of writer.files) named.add(file);
    const files = measured?.roundFiles ?? [];
    rows.push({ round, summary: clip(writer?.summary ?? "", 200), files: files.slice(0, 6), total: measured?.roundTotal ?? files.length, baselineKnown: measured?.roundBaselineKnown, measured: Boolean(measured), tests: clip(tests, 200) });
  }
  const changed = measured && Array.isArray(test.changedFiles) ? test.changedFiles : [];
  const compared = test?.runFiles ?? changed;
  const comparedTotal = (Array.isArray(test?.runFiles) ? test.runTotal : test?.changedTotal) ?? compared.length;
  const unreported = compared.filter((file) => !named.has(file));
  const unreportedCapped = comparedTotal > compared.length;

  let headline;
  if (status === "green") headline = "Tests are green after " + rounds + " round" + (rounds === 1 ? "" : "s") + ": the test command exited 0 in the kept worktree.";
  else if (status === "protected-changed") headline = "Tests are green after " + rounds + " round(s), but the fix changed protected path(s): " + pathList(protectedChanged, test.protectedTotal ?? protectedChanged.length, 360, (file) => clip(file, 120)) + ". Review them before trusting the result.";
  else if (status === "still-failing") headline = "Tests still failing after " + rounds + " round" + (rounds === 1 ? "" : "s") + (loopInfo ? " (loop " + loopInfo.status + ")" : "") + ".";
  else if (status === "timeout" || status === "command-error") headline = "The " + STATUS_TEXT[status] + "; no completed test verdict.";
  else if (test?.rehearsal) headline = "Rehearsal verified the worktree and loop wiring only: project tests were not run.";
  else headline = "The final test run did not happen, so the result is not verified" + (loopInfo ? " (loop " + loopInfo.status + ")" : "") + ".";

  const lastObserved = !test && earlierTests.findLast(({ control }) => control?.branch && control?.worktree)?.control;
  const recorded = !test && !lastObserved && loopInfo?.worktreePath;
  const location = test ?? (lastObserved || (recorded ? { branch: loopInfo.worktreeBranch, worktree: recorded } : undefined));
  const view = {
    status, rounds, loopStatus: loopInfo ? loopInfo.status : "", branch: location?.branch ?? "", worktree: location?.worktree ?? "", lastObserved, recorded, headline, rows, verified, measured, note: measured ? String(test.note || "") : "",
    command: measured ? String(test.command) : "", exitCode: verified ? test.exitCode : -1, passed: verified ? test.passed : -1, failed: verified ? test.failed : -1,
    outputTruncated: test?.outputTruncated, runBaselineKnown: test?.runBaselineKnown,
    preExistingFiles: test?.preExistingFiles ?? [], preExistingTotal: test?.preExistingTotal ?? test?.preExistingFiles?.length ?? 0,
    runFiles: test?.runFiles ?? [], runTotal: test?.runTotal ?? test?.runFiles?.length ?? 0,
    changed, changedTotal: test?.changedTotal ?? changed.length,
    protectedChanged, protectedTotal: test?.protectedTotal ?? protectedChanged.length, unreported, unreportedCapped, excerpt: measured && !green ? String(test.excerpt || "") : "",
  };
  const markdown = markdownFor(view);
  return {
    schema: "fix-report-v1",
    digest: clip(status === "green" ? "green after " + rounds + " round(s)" : STATUS_TEXT[status] + " after " + rounds + " round(s)", 200),
    status,
    rounds,
    loopStatus: clip(view.loopStatus, 40),
    branch: clip(view.branch, 200),
    worktree: clip(view.worktree, 500),
    finalExitCode: view.exitCode,
    rows: rows.map((row) => ({ round: row.round, summary: row.summary, files: row.files.map((file) => file.slice(0, 60)), baselineKnown: row.baselineKnown ?? false, tests: row.tests })).slice(0, 20),
    changedFiles: changed.slice(0, 100),
    preExistingFiles: (test?.preExistingFiles ?? []).slice(0, 100),
    runFiles: (test?.runFiles ?? []).slice(0, 100),
    runBaselineKnown: test?.runBaselineKnown ?? false,
    unreportedFiles: unreported.slice(0, 100),
    protectedChanged: protectedChanged.slice(0, 100),
    markdown,
    completionSummaryMarkdown: clip(headline + " Worktree kept, not merged.", 900),
  };
}
