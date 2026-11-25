// Runs the configured argument array (without a shell) in the loop's shared managed worktree.
// A nonzero command exit is evidence, not a failed workflow task: the next writer can fix it.
// timeoutMs defaults to 180000; protectedPrefixes defaults to ["test/", "tests/"]. Rehearsal probes the
// worktree and exercises git accounting but does not run project code on synthetic writer output.
import { spawn } from "node:child_process";
import { commandEnv, gitDirtyPaths, gitSnapshot, verifyWorktree } from "./git-worktree.mjs";
const MAX_TAIL = 64 * 1024;
const FAILURE_LINE = /(^|\s)(not ok|✖|✗|FAIL\b|FAILED|failing|AssertionError|Error:|expected|actual|Expected|Received)/;
const MAX_FILES = 100;

function clip(value, max) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function readOptions(options) {
  const settings = options || {};
  const command = settings.command === undefined ? ["npm", "test"] : settings.command;
  if (
    !Array.isArray(command) || command.length < 1 || command.length > 8 ||
    command.some((part) => typeof part !== "string" || part === "" || part.length > 200)
  ) {
    throw new Error("test: support.options.command must be an argument array of 1 to 8 non-empty strings, for example [\"npm\", \"test\"]");
  }
  const timeoutMs = settings.timeoutMs === undefined ? 180000 : settings.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
    throw new Error("test: support.options.timeoutMs must be an integer from 1000 to 900000");
  }
  const protectedPrefixes = settings.protectedPrefixes === undefined ? ["test/", "tests/"] : settings.protectedPrefixes;
  if (
    !Array.isArray(protectedPrefixes) || protectedPrefixes.length > 20 ||
    protectedPrefixes.some((prefix) => typeof prefix !== "string" || !prefix.endsWith("/") || prefix.startsWith("/") || prefix.includes("..") || prefix.includes("\\") || prefix.length > 200)
  ) {
    throw new Error("test: support.options.protectedPrefixes must be at most 20 relative directories ending in /");
  }
  return { command, timeoutMs, protectedPrefixes };
}

function delta(previous, current) {
  const before = new Map(previous.map(({path, fingerprint}) => [path, fingerprint]));
  const after = new Map(current.map(({path, fingerprint}) => [path, fingerprint]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}

// Pass and fail counts from the formats the common runners print; -1 when none is recognised.
function counts(text) {
  const number = (pattern) => {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : undefined;
  };
  let passed = number(/^(?:ℹ|#) pass (\d+)/m);
  let failed = number(/^(?:ℹ|#) fail (\d+)/m);
  if (passed === undefined && failed === undefined) {
    // jest and vitest: "Tests: 1 failed, 2 passed, 3 total" / "Tests  1 failed | 2 passed (3)"
    const line = /^\s*Tests:?\s+(.*)$/m.exec(text);
    if (line) {
      passed = /(\d+) passed/.exec(line[1])?.[1];
      failed = /(\d+) failed/.exec(line[1])?.[1];
      passed = passed === undefined ? 0 : Number(passed);
      failed = failed === undefined ? 0 : Number(failed);
    }
  }
  if (passed === undefined && failed === undefined) {
    // mocha: "3 passing" and "1 failing"
    const ok = /^\s*(\d+) passing\b/m.exec(text);
    const bad = /^\s*(\d+) failing\b/m.exec(text);
    if (ok || bad) {
      passed = ok ? Number(ok[1]) : 0;
      failed = bad ? Number(bad[1]) : 0;
    }
  }
  if (passed === undefined && failed === undefined) {
    // pytest: "== 1 failed, 2 passed in 0.1s ==" or "2 passed in 0.1s"
    const summary = /^=*\s*((?:\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, )?)+)\s+in [\d.]+s/m.exec(text);
    if (summary) {
      passed = Number(/(\d+) passed/.exec(summary[1])?.[1] ?? 0);
      failed = Number(/(\d+) failed/.exec(summary[1])?.[1] ?? 0) + Number(/(\d+) errors?/.exec(summary[1])?.[1] ?? 0);
    }
  }
  return {
    passed: passed === undefined ? -1 : Number(passed),
    failed: failed === undefined ? -1 : Number(failed),
  };
}

// Prefer recent failure lines (even from before the retained tail); otherwise show the end.
function excerpt({ output, failureLines, truncated }) {
  const lines = output.split("\n").filter((line) => line.trim() !== "").slice(-14);
  const chosen = (failureLines.length ? failureLines : lines).map((line) => line.trim().slice(0, 160));
  return ((truncated ? "[output truncated; showing retained evidence]\n" : "") + chosen.join("\n")).slice(0, 1200);
}

function execute(command, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    signal?.throwIfAborted();
    let output = "";
    let truncated = false;
    const failureLines = [];
    const flush = [];
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      for (const end of flush) end();
      resolve({ ...value, output, timedOut, truncated, failureLines });
    };
    const killGroup = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const stop = () => killGroup();
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: commandEnv(),
      });
    } catch (error) {
      resolve({ code: -1, output: "", timedOut: false, truncated: false, failureLines: [], startError: clip(error.message, 200) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const collect = (stream) => {
      let line = "";
      const scan = () => {
        if (FAILURE_LINE.test(line)) {
          failureLines.push(line.trim().slice(0, 160));
          if (failureLines.length > 14) failureLines.shift();
        }
        line = "";
      };
      flush.push(scan);
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        truncated ||= output.length + chunk.length > MAX_TAIL;
        output = (output + chunk).slice(-MAX_TAIL);
        let from = 0;
        for (let next = chunk.indexOf("\n"); next !== -1; next = chunk.indexOf("\n", from)) {
          line = (line + chunk.slice(from, next)).slice(0, 1024);
          scan();
          from = next + 1;
        }
        line = (line + chunk.slice(from)).slice(0, 1024);
      });
    };
    collect(child.stdout);
    collect(child.stderr);
    child.on("error", (error) => finish({ code: -1, startError: clip(error.message, 200) }));
    child.on("close", (code, killedBy) => finish({ code: typeof code === "number" ? code : -1, killedBy }));
  });
}

function result(fields) {
  const { outcome, branch, worktree, command, exitCode, passed, failed, durationMs, text, files, protectedChanged, note, roundFiles, snapshot, rehearsal, baseline, previous, runFiles, outputTruncated } = fields;
  return {
    schema: "test-run-v1",
    digest: clip(
      outcome === "green" ? "tests green" + (note ? " (" + note + ")" : "")
      : outcome === "red" ? "tests red: exit " + exitCode + (failed >= 0 ? ", " + failed + " failing" : "")
      : outcome === "timeout" ? "test command timed out"
      : "test command did not run",
      200,
    ),
    outcome,
    command: clip(command.join(" "), 300),
    exitCode,
    passed,
    failed,
    durationMs,
    excerpt: outcome === "green" ? "" : text.slice(0, 1200),
    branch,
    worktree,
    changedTotal: files.length,
    protectedTotal: protectedChanged.length,
    preExistingTotal: baseline?.length ?? 0,
    runTotal: runFiles.length,
    roundTotal: roundFiles.length,
    changedFiles: files.slice(0, MAX_FILES).map((file) => file.slice(0, 200)),
    protectedChanged: protectedChanged.slice(0, MAX_FILES).map((file) => file.slice(0, 200)),
    note: clip(note || "", 300),
    roundFiles: roundFiles.slice(0, MAX_FILES).map((file) => file.slice(0, 200)),
    preExistingFiles: (baseline ?? []).slice(0, MAX_FILES).map(({ path }) => path.slice(0, 200)),
    runFiles: runFiles.slice(0, MAX_FILES).map((file) => file.slice(0, 200)),
    runBaselineKnown: Array.isArray(baseline),
    roundBaselineKnown: Array.isArray(previous),
    outputTruncated,
    rehearsal,
    snapshot,
  };
}

export default async function helper({ options, context }) {
  const wanted = readOptions(options);
  const { worktreePath: worktree, worktreeBranch: branch, worktreeBaseCwd, loopId, round, childStageId } = context.loop ?? {};
  if (!worktree || !branch) throw new Error("test: no managed worktree for this loop (did the writer get one?)");
  const history = await context.readLoopHistory(loopId, childStageId);
  const baselineRecord = await context.readLoopWorktreeBaselineRecord?.();
  const baseline = baselineRecord?.snapshot;
  const previous = !baseline ? undefined : round === 1 ? baseline : history.find((row) => row.round === round - 1 && row.status === "completed")?.control?.snapshot;
  const rehearsal = process.env.AGENT_WORKFLOW_REHEARSAL === "1";
  const physical = await verifyWorktree(worktree, branch, worktreeBaseCwd ?? context.cwd, context.signal);
  const started = Date.now();
  const ran = await execute(rehearsal ? ["git", "rev-parse", "--is-inside-work-tree"] : wanted.command, physical, wanted.timeoutMs, context.signal);
  const durationMs = Date.now() - started;
  await verifyWorktree(worktree, branch, worktreeBaseCwd ?? context.cwd, context.signal, physical);
  const files = await gitDirtyPaths(physical, context.signal);
  const snapshot = baseline ? await gitSnapshot(physical, baselineRecord.head, context.signal) : [];
  await verifyWorktree(worktree, branch, worktreeBaseCwd ?? context.cwd, context.signal, physical);
  const roundFiles = previous ? delta(previous, snapshot) : [];
  const runFiles = baseline ? delta(baseline, snapshot) : [];
  const protectedChanged = runFiles.filter((file) => wanted.protectedPrefixes.some((prefix) => file.startsWith(prefix)));
  const text = ran.output;
  const base = { branch, worktree, command: wanted.command, durationMs, files, protectedChanged, roundFiles, snapshot, rehearsal, baseline, previous, runFiles, outputTruncated: ran.truncated };
  if (rehearsal && ran.code === 0) {
    return result({ ...base, outcome: "green", exitCode: 0, passed: -1, failed: -1, text: "", note: "rehearsal: worktree probe passed; project tests were not run" });
  }
  if (ran.startError !== undefined) {
    return result({ ...base, outcome: "error", exitCode: -1, passed: -1, failed: -1, text: ran.startError, note: "the command could not start: " + ran.startError });
  }
  if (ran.timedOut) {
    return result({ ...base, outcome: "timeout", exitCode: -1, ...counts(text), text: excerpt(ran), note: "killed after " + wanted.timeoutMs + " ms" });
  }
  if (ran.killedBy) {
    return result({ ...base, outcome: "error", exitCode: -1, passed: -1, failed: -1, text: excerpt(ran), note: "command terminated by " + ran.killedBy });
  }
  const tally = counts(text);
  return result({ ...base, outcome: ran.code === 0 ? "green" : "red", exitCode: ran.code, ...tally, text: excerpt(ran) });
}
