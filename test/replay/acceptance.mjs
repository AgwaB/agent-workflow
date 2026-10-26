#!/usr/bin/env node
// WP1b replay acceptance: replay every fixture through the agent-workflow engine (replay-driver.mjs),
// compare it with the recording (compare.mjs) and build the per-fixture report.
//
// CLI: node test/replay/acceptance.mjs [--write] [--keep] [fixture[:variant] ...]
//   --write  writes test/replay/acceptance/<fixture>.{md,json} (variants into the same report)
//   --keep   keeps the replay project directories (printed)
// Needs `npm run build`. The unit test test/unit/replay-acceptance.test.mjs runs the same code.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareReplay, loadExplainedDifferences } from "./compare.mjs";
import {
	createContext,
	loadAllowedDifferences,
	normalizeTree,
	compareTrees,
} from "./normalize.mjs";
import {
	cleanupReplay,
	FIXTURES_ROOT,
	fixtureSkipReason,
	loadFixture,
	replayFixture,
} from "./replay-driver.mjs";
import {
	listFixtureNames,
	loadRecordedWorkerCalls,
	readJsonLines,
} from "./replay-executor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPORT_DIR = join(HERE, "acceptance");

/**
 * Replay variants. `original` (every fixture) runs the recorded spec with the Pi adapter's request
 * checks; extra variants isolate one explained divergence so the rest of the run is still checked.
 */
export const VARIANTS = {
	"spec-review": [
		{
			id: "state-path-migrated",
			description:
				"The original helpers read upstream engine state from the hard-coded `.pi/workflows/<run>/…` (template literal in spec-requirement-source.mjs); the run state moved to `.agent-workflow/workflows/` (WP4b). This variant migrates that one literal in the copied bundle (the comparison renames it back, so the bundle still compares equal) and holds the rest of the run to the full standard.",
			options: { migrateStatePaths: true },
		},
	],
	"deep-research": [
		{
			id: "engine-only",
			description:
				"The replay executor skips the Pi adapter's tool-mapping check, so the recorded workers are served although the original spec asks for the removed workflow_web_* tools. Shows how far the engine itself reproduces the recording past the C2 refusal.",
			options: { adapterChecks: false },
		},
	],
};

export function fixtureVariants(name) {
	return [
		{
			id: "original",
			description: "Original spec, Pi adapter request checks.",
		},
		...(VARIANTS[name] ?? []),
	];
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The committed normalized/ tree must still be the WP1a policy output of run/. */
export function checkCommittedNormalized(fixtureDir, scratch) {
	const wp1a = loadAllowedDifferences();
	const out = join(scratch, "normalized-recorded");
	try {
		normalizeTree(join(fixtureDir, "run"), out, createContext({}), {
			allowed: wp1a,
		});
		return compareTrees(join(fixtureDir, "normalized"), out);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Worker-side reproduction summary from the replay trace. */
function traceSummary(fixtureDir, trace) {
	const recorded = loadRecordedWorkerCalls(fixtureDir);
	const served = trace.filter((entry) => entry.type === "serve");
	const servedSeqs = new Set(served.map((entry) => entry.seq));
	const reads = trace.filter((entry) => entry.type === "reads");
	return {
		recordedLaunches: recorded.length,
		servedLaunches: served.length,
		unservedLaunches: recorded
			.filter((call) => !servedSeqs.has(call.seq))
			.map((call) => ({ taskId: call.taskId, seq: call.seq })),
		misses: trace
			.filter((entry) => entry.type === "miss")
			.map(({ taskId, exhausted, closest, digestBindings }) => ({
				taskId,
				exhausted,
				closest,
				...(digestBindings === undefined ? {} : { digestBindings }),
			})),
		adapterRefusals: trace
			.filter((entry) => entry.type === "adapter-refusal")
			.map(({ taskId, code, message }) => ({ taskId, code, message })),
		recordedReads: recorded.reduce((sum, call) => sum + call.reads.length, 0),
		reissuedReads: reads.reduce((sum, entry) => sum + entry.results.length, 0),
		readErrors: reads.flatMap((entry) =>
			entry.results
				.filter((result) => result.isError || result.error)
				.map((result) => ({
					read: result.read,
					error: result.error ?? "isError",
				})),
		),
		unreproducibleReads: trace
			.filter((entry) => entry.type === "read-unreproducible")
			.map(({ reason, reads: list }) => ({ reason, reads: list })),
		readsOverDefaultDeliveryBound: recorded.flatMap((call) =>
			readJsonLines(
				join(fixtureDir, "run", "tasks", call.taskId, "read-ledger.jsonl"),
			)
				.filter((row) => row.returnedBytes > 8192)
				.map((row) => ({
					taskId: call.taskId,
					source: row.source,
					artifact: row.artifact,
					returnedBytes: row.returnedBytes,
				})),
		),
	};
}

/** What this replay cannot reproduce for the fixture (docs/replay.md). */
function unreproducible(fixtureDir, summary) {
	const items = [
		"Worker CLI stderr (pi-subagent stderr.log, e.g. Pi's session notice): the runtime stderr.log holds runtime diagnostics only; the replay emits no CLI output.",
		"Worker tool calls other than workflow_artifact reads (read/grep/find/ls on project files, web tools): they only shaped the recorded final text, which is replayed verbatim.",
		"Pi session files: the replay reports the ownedSession locator the Pi adapter would report but creates no session directory.",
		"Timing, poll counts, process ids and the Pi provider/model metadata of the recorded attempt (not part of the executor event contract).",
	];
	if (summary.readsOverDefaultDeliveryBound.length > 0)
		items.push(
			`Artifact delivery bound: ${summary.readsOverDefaultDeliveryBound.length} recorded read(s) returned more than 8192 chars. The replay starts the artifact MCP server with --max-output-chars ${16 * 1024 * 1024} so these rows reproduce the recorded ledger (the recorded Pi worker received them whole). The stage-1 Pi adapter passes no limit, so the server default (8192) would cut them and mark the rows deliveryUnverified (docs/mcp.md "Delivery bound", R#9); a model would then re-read with a projection, which a replay cannot reproduce.`,
		);
	if (existsSync(join(fixtureDir, "worker-snapshots")))
		items.push(
			"Worker-filled web-source cache (worker-snapshots/<run>/web-source-cache): written by the removed workflow_web_* tools (C2); not restored.",
		);
	return items;
}

/**
 * Run one variant in a fresh Node process (default). Variants of one fixture replay the same run id
 * at the same pinned project path, so in one process the engine's ESM cache would hand the second
 * variant the first variant's bundled helper modules (same file URL).
 */
export async function runFixtureVariant(name, variant, options = {}) {
	if (options.inProcess === true)
		return runFixtureVariantInProcess(name, variant, options);
	const out = join(
		options.scratch ?? tmpdir(),
		`awr-variant-${name}-${variant.id}-${process.pid}-${Date.now()}.json`,
	);
	try {
		await new Promise((resolveChild, rejectChild) => {
			const child = spawn(
				process.execPath,
				[
					fileURLToPath(import.meta.url),
					"--child",
					`${name}:${variant.id}`,
					out,
					...(options.keep ? ["--keep"] : []),
				],
				{ stdio: ["ignore", "inherit", "inherit"], env: process.env },
			);
			child.on("error", rejectChild);
			child.on("exit", (code, signal) =>
				code === 0
					? resolveChild()
					: rejectChild(
							new Error(
								`replay variant ${name}:${variant.id} exited ${code ?? signal}`,
							),
						),
			);
		});
		return JSON.parse(readFileSync(out, "utf8"));
	} finally {
		rmSync(out, { force: true });
	}
}

async function runFixtureVariantInProcess(name, variant, options = {}) {
	const loaded = loadFixture(name);
	const skip = fixtureSkipReason(loaded);
	if (skip) return { fixture: name, variant: variant.id, skipped: skip };
	const scratch = join(
		options.scratch ?? tmpdir(),
		`awr-acc-${name}-${variant.id}-${process.pid}`,
	);
	mkdirSync(scratch, { recursive: true });
	const result = await replayFixture(name, {
		work: join(scratch, "work"),
		...variant.options,
	});
	try {
		const summary = traceSummary(loaded.fixtureDir, result.trace);
		const report = {
			fixture: name,
			variant: variant.id,
			description: variant.description,
			platform: process.platform,
			recordedStatus: loaded.fixture.expectedStatus ?? "completed",
			replayedStatus: result.run?.status ?? "refused",
			...(result.refusal === undefined ? {} : { refusal: result.refusal }),
			tasks: (result.run?.tasks ?? []).map((task) => ({
				taskId: task.taskId,
				specId: task.specId,
				status: task.status,
				statusDetail: task.statusDetail,
				...(task.status === "completed"
					? {}
					: { lastMessage: task.lastMessage }),
			})),
			worker: summary,
			...(result.migratedHelpers?.length > 0
				? { migratedHelpers: result.migratedHelpers }
				: {}),
			unreproducible: unreproducible(loaded.fixtureDir, summary),
		};
		if (result.runDir !== undefined) {
			const comparison = compareReplay({
				fixtureDir: loaded.fixtureDir,
				runDir: result.runDir,
				legacyRunDir: join(
					result.project,
					".pi",
					"workflows",
					result.run.runId,
				),
				roots: result.roots,
				fixture: name,
				variant: variant.id,
				recordedRoots:
					loaded.fixture.replayRoot === undefined
						? undefined
						: { ROOT: loaded.fixture.replayRoot },
			});
			Object.assign(report, comparison);
		}
		if (options.keep) report.kept = result.project;
		return report;
	} finally {
		cleanupReplay(result, { keep: options.keep === true });
		if (!options.keep) {
			rmSync(scratch, {
				recursive: true,
				force: true,
				maxRetries: 20,
				retryDelay: 100,
			});
		}
	}
}

export async function runFixture(name, options = {}) {
	const loaded = loadFixture(name);
	const normalizedCheck = checkCommittedNormalized(
		loaded.fixtureDir,
		join(options.scratch ?? tmpdir(), `awr-norm-${name}-${process.pid}`),
	);
	const variants = [];
	for (const variant of fixtureVariants(name))
		if (!options.variants || options.variants.includes(variant.id))
			variants.push(await runFixtureVariant(name, variant, options));
	return {
		schema: "agent-workflow-replay-acceptance-v1",
		fixture: name,
		recordedRunId: loaded.fixture.workflowRunId,
		committedNormalizedMatches: normalizedCheck.length === 0,
		...(normalizedCheck.length === 0
			? {}
			: { normalizedDrift: normalizedCheck }),
		variants,
	};
}

// ---------------------------------------------------------------- report rendering

const escapeCell = (value) =>
	String(value ?? "")
		.replaceAll("|", "\\|")
		.replaceAll("\n", "⏎")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
const code = (value) => `\`${String(value ?? "").replaceAll("`", "'")}\``;

const rowCount = (rows) =>
	rows.reduce((total, row) => total + (row.summarized ? row.count : 1), 0);

function renderVariant(lines, report, explained, allowed) {
	lines.push(`## Variant \`${report.variant}\``, "");
	if (report.description) lines.push(report.description, "");
	if (report.skipped) {
		lines.push(`Skipped on ${process.platform}: ${report.skipped}.`, "");
		return;
	}
	lines.push(
		"| | |",
		"|---|---|",
		`| Recorded status | ${report.recordedStatus} |`,
		`| Replayed status | ${report.replayedStatus} |`,
		`| Worker launches served / recorded | ${report.worker.servedLaunches} / ${report.worker.recordedLaunches} |`,
		`| Artifact reads re-issued / recorded | ${report.worker.reissuedReads} / ${report.worker.recordedReads} |`,
		`| Differences: allowed | ${report.counts?.allowed ?? "-"} |`,
		`| Differences: explained | ${report.counts?.explained ?? "-"} |`,
		`| Differences: unexplained | ${report.counts?.unexplained ?? "-"} |`,
		`| Exact-match violations | ${report.exactMatchViolations?.length ?? "-"} |`,
		"",
	);
	if (report.refusal)
		lines.push("Refusal:", "", "```", report.refusal.message, "```", "");
	if (report.worker.adapterRefusals.length > 0) {
		lines.push(
			"Executor refusals (Pi adapter request checks, before any effect):",
			"",
		);
		for (const refusal of report.worker.adapterRefusals)
			lines.push(
				`- ${refusal.taskId}: ${code(refusal.code)} ${refusal.message}`,
			);
		lines.push("");
	}
	if (report.worker.unservedLaunches.length > 0)
		lines.push(
			`Recorded launches not served: ${report.worker.unservedLaunches.map((call) => `${call.taskId} (seq ${call.seq})`).join(", ")}.`,
			"",
		);
	if (report.worker.misses.length > 0) {
		lines.push("Replay misses:", "");
		for (const miss of report.worker.misses)
			lines.push(
				`- ${miss.taskId}: closest ${miss.closest?.taskId} seq ${miss.closest?.seq}, line ${miss.closest?.diff?.line}`,
			);
		lines.push("");
	}
	const failed = report.tasks.filter((task) => task.status !== "completed");
	if (failed.length > 0) {
		lines.push(
			"Tasks not completed:",
			"",
			"| Task | Spec | Status | Detail | Message |",
			"|---|---|---|---|---|",
		);
		for (const task of failed)
			lines.push(
				`| ${task.taskId} | ${escapeCell(task.specId)} | ${task.status} | ${escapeCell(task.statusDetail)} | ${escapeCell(task.lastMessage?.slice(0, 200))} |`,
			);
		lines.push("");
	}
	if (!report.differences) return;
	const groups = new Map();
	for (const row of report.differences) {
		const key = `${row.class}\0${row.rule ?? ""}`;
		const group = groups.get(key) ?? {
			class: row.class,
			rule: row.rule,
			rows: [],
		};
		group.rows.push(row);
		groups.set(key, group);
	}
	lines.push(
		"### Differences by rule",
		"",
		"| Class | Rule | Rows | Source |",
		"|---|---|---|---|",
	);
	const order = { unexplained: 0, explained: 1, allowed: 2 };
	const sorted = [...groups.values()].sort(
		(a, b) =>
			order[a.class] - order[b.class] ||
			String(a.rule).localeCompare(String(b.rule)),
	);
	for (const group of sorted) {
		const source =
			group.class === "explained"
				? explained.find((entry) => entry.id === group.rule)?.citation
				: group.class === "allowed"
					? `allowed-differences.json (${allowed.find((entry) => entry.id === group.rule)?.introducedBy ?? "?"})`
					: "";
		lines.push(
			`| ${group.class} | ${code(group.rule ?? "—")} | ${rowCount(group.rows)} | ${escapeCell(source)} |`,
		);
	}
	lines.push("");
	const unexplained = report.differences.filter(
		(row) => row.class === "unexplained",
	);
	if (unexplained.length > 0) {
		lines.push(
			"### Unexplained",
			"",
			"| File | Path / line | Kind | Recorded | Replayed |",
			"|---|---|---|---|---|",
		);
		for (const row of unexplained)
			lines.push(
				`| ${escapeCell(row.file)} | ${escapeCell(row.path ?? row.line ?? "")} | ${row.kind}${row.exactMatch ? ` (exact-match: ${row.exactMatch})` : ""} | ${escapeCell(row.recorded)} | ${escapeCell(row.replayed)} |`,
			);
		lines.push("");
	}
	lines.push("### Explained and allowed rows", "");
	for (const group of sorted.filter((group) => group.class !== "unexplained")) {
		lines.push(
			`<details><summary>${group.class} ${escapeCell(group.rule)} (${rowCount(group.rows)})</summary>`,
			"",
			"| File | Path / line | Kind | Recorded | Replayed |",
			"|---|---|---|---|---|",
		);
		for (const row of group.rows)
			lines.push(
				`| ${escapeCell(row.file)} | ${escapeCell(row.path ?? row.line ?? row.literal ?? "")} | ${row.kind}${row.count === undefined ? "" : ` ×${row.count}`} | ${escapeCell(row.recorded)} | ${escapeCell(row.replayed)} |`,
			);
		lines.push("", "</details>", "");
	}
}

export function renderReport(result) {
	const explained = loadExplainedDifferences();
	const allowed = loadAllowedDifferences(undefined, { replay: true });
	const lines = [
		`# Replay acceptance: ${result.fixture}`,
		"",
		"Generated by `node test/replay/acceptance.mjs --write` (WP1b). Classification rules: docs/replay.md.",
		"",
		`Recorded run: ${code(result.recordedRunId)}. Committed normalized/ is the WP1a policy output: ${result.committedNormalizedMatches ? "yes" : "NO"}.`,
		"",
	];
	for (const report of result.variants)
		renderVariant(lines, report, explained, allowed);
	const unreproducible =
		result.variants.find((report) => report.unreproducible)?.unreproducible ??
		[];
	if (unreproducible.length > 0) {
		lines.push("## What the replay cannot reproduce", "");
		for (const item of unreproducible) lines.push(`- ${item}`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Rows classified by a divergence entry (a variant that records an expected different outcome) are
 * kept per file and kind with a count; the acceptance test asserts their cause separately.
 */
export function compactDivergenceRows(differences = []) {
	const divergent = new Set(
		loadExplainedDifferences()
			.filter((entry) => entry.divergence === true)
			.map((entry) => entry.id),
	);
	const out = [];
	const groups = new Map();
	for (const row of differences) {
		if (row.class !== "explained" || !divergent.has(row.rule)) {
			out.push(row);
			continue;
		}
		const key = `${row.rule}\0${row.file}\0${row.kind}`;
		let group = groups.get(key);
		if (group === undefined) {
			group = {
				class: "explained",
				rule: row.rule,
				citation: row.citation,
				file: row.file,
				kind: row.kind,
				summarized: true,
				count: 0,
				exactMatch: [],
			};
			groups.set(key, group);
			out.push(group);
		}
		group.count += 1;
		if (
			row.exactMatchDivergence &&
			!group.exactMatch.includes(row.exactMatchDivergence)
		)
			group.exactMatch.push(row.exactMatchDivergence);
	}
	return out;
}

export function writeReport(result) {
	mkdirSync(REPORT_DIR, { recursive: true });
	const json = {
		...result,
		variants: result.variants.map(({ kept: _kept, ...rest }) => ({
			...rest,
			...(rest.differences === undefined
				? {}
				: { differences: compactDivergenceRows(rest.differences) }),
			...(rest.exactMatchDivergences === undefined
				? {}
				: { exactMatchDivergences: rest.exactMatchDivergences.length }),
		})),
	};
	writeFileSync(
		join(REPORT_DIR, `${result.fixture}.json`),
		`${JSON.stringify(json, null, 2)}\n`,
	);
	writeFileSync(join(REPORT_DIR, `${result.fixture}.md`), renderReport(json));
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	if (args[0] === "--child") {
		const [name, variantId] = args[1].split(":");
		const variant = fixtureVariants(name).find(
			(entry) => entry.id === variantId,
		);
		if (variant === undefined) throw new Error(`unknown variant ${args[1]}`);
		const report = await runFixtureVariantInProcess(name, variant, {
			keep: args.includes("--keep"),
		});
		writeFileSync(args[2], JSON.stringify(report));
		process.exit(0);
	}
	const write = args.includes("--write");
	const keep = args.includes("--keep");
	const selected = args.filter((arg) => !arg.startsWith("--"));
	const names =
		selected.length > 0
			? selected.map((arg) => arg.split(":")[0])
			: listFixtureNames(FIXTURES_ROOT);
	for (const name of names) {
		const variantFilter = selected
			.find((arg) => arg.startsWith(`${name}:`))
			?.split(":")[1];
		const result = await runFixture(name, {
			keep,
			...(variantFilter ? { variants: [variantFilter] } : {}),
		});
		if (write) writeReport(result);
		for (const report of result.variants)
			console.log(
				`${name}:${report.variant} ${report.skipped ? `skipped (${report.skipped})` : `${report.replayedStatus} counts=${JSON.stringify(report.counts)} exactMatchViolations=${report.exactMatchViolations?.length}${report.kept ? ` kept=${report.kept}` : ""}`}`,
			);
		if (!result.committedNormalizedMatches)
			console.log(`${name}: committed normalized/ drifted`);
	}
	void sha256;
	void readFileSync;
	process.exit(0);
}
