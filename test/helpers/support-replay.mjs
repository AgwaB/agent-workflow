// Support-step regression net (2026-11-04, before refactoring the bundled helpers): recorded live
// runs (real model outputs, every bundled workflow, four executors) are frozen under
// test/fixtures/support-replay/; every support stage of each run is run again with the current
// bundle's helpers, in dependency order, on the recorded worker controls, and its control is compared
// with the golden output committed beside the fixture. Model stages are not re-run: a worker's
// recorded control stays its control, also when an upstream support output now differs.
//
//   node test/helpers/support-replay.mjs                     check every fixture (exit 1 on a diff)
//   node test/helpers/support-replay.mjs --write             rewrite the golden outputs
//   node test/helpers/support-replay.mjs --capture <dir>...  freeze the runs under <dir>/.agent-workflow
//
// Capture keeps per task only control.json and source-manifest.json (support helpers get controls
// as sources and read those two files through the run directory), a slim run.json, and the support
// tasks of compiled.json; the project files the reviews cite are copied once per project. Absolute
// paths of the recorded project become project-relative, so the replay is independent of where it
// is materialized. The web quote check (deep-research) is answered from the recorded check output.
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_ROOT = join(REPO, "test", "fixtures", "support-replay");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
};

/** The bundle directory of a recorded workflow (the tiered deep-research variant uses deep-research). */
function bundleOf(name) {
	if (name.startsWith("deep-research")) return "deep-research";
	return name;
}

// --- capture -----------------------------------------------------------------------------------

function relativize(text, projectRoot) {
	return text.split(`${projectRoot}/`).join("").split(projectRoot).join(".");
}

const SKIP = [".agent-workflow", ".git", "node_modules"];

/** Content hash of a project tree (without run state), so identical clones share one copy. */
function treeHash(root) {
	const hash = createHash("sha256");
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir).sort()) {
			if (!prefix && SKIP.includes(entry)) continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path, `${prefix}${entry}/`);
			else
				hash
					.update(`${prefix}${entry}\0`)
					.update(readFileSync(path))
					.update("\0");
		}
	};
	walk(root, "");
	return hash.digest("hex").slice(0, 12);
}

function copyProject(from, to) {
	for (const entry of readdirSync(from)) {
		if (SKIP.includes(entry)) continue;
		cpSync(join(from, entry), join(to, entry), { recursive: true });
	}
}

function supportTasksOf(compiled) {
	return compiled.tasks
		.filter((task) => task.support)
		.map((task) => ({
			specId: task.specId ?? task.key,
			dependsOn: task.dependsOn ?? [],
			support: task.support,
		}));
}

/** Freeze every run under `<projectDir>/.agent-workflow/workflows` that has a completed support task. */
export function capture(projectDir, label = basename(projectDir)) {
	const projectRoot = realpathSync(projectDir);
	const runsDir = join(projectRoot, ".agent-workflow", "workflows");
	const projectKey = treeHash(projectRoot);
	const projectOut = join(FIXTURE_ROOT, "projects", projectKey);
	if (!existsSync(projectOut)) copyProject(projectRoot, projectOut);
	const captured = [];
	for (const runId of readdirSync(runsDir).filter((name) =>
		name.startsWith("workflow_"),
	)) {
		const runDir = join(runsDir, runId);
		if (!existsSync(join(runDir, "compiled.json"))) continue;
		const compiled = readJson(join(runDir, "compiled.json"));
		const run = readJson(join(runDir, "run.json"));
		const supports = supportTasksOf(compiled);
		const ran = supports.filter((row) =>
			run.tasks.some(
				(task) =>
					task.specId === row.specId &&
					task.status !== "pending" &&
					existsSync(
						join(runDir, "tasks", task.taskId, "source-manifest.json"),
					),
			),
		);
		if (ran.length === 0) continue;
		const out = join(
			FIXTURE_ROOT,
			"runs",
			`${label}-${compiled.name}-${runId.slice(-6)}`,
		);
		rmSync(out, { recursive: true, force: true });
		const slimRun = {
			runId: run.runId,
			name: compiled.name,
			bundle: bundleOf(compiled.name),
			project: projectKey,
			evidenceRefetch: run.evidenceRefetch === true,
			status: run.status,
			tasks: run.tasks.map((task) => ({
				taskId: task.taskId,
				specId: task.specId,
				stageId: task.stageId,
				status: task.status,
				...(task.foreachGenerated
					? { foreachGenerated: task.foreachGenerated }
					: {}),
			})),
			supportTasks: supports,
		};
		writeJson(join(out, "run.json"), slimRun);
		for (const task of run.tasks) {
			for (const file of ["control.json", "source-manifest.json"]) {
				const path = join(runDir, "tasks", task.taskId, file);
				if (!existsSync(path)) continue;
				const target = join(out, "tasks", task.taskId, file);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(
					target,
					relativize(readFileSync(path, "utf8"), projectRoot),
				);
			}
		}
		captured.push(basename(out));
	}
	return captured;
}

// --- replay ------------------------------------------------------------------------------------

/** Copy one fixture run and its project into a fresh directory laid out like a real project. */
export function materialize(runLabel) {
	const fixture = join(FIXTURE_ROOT, "runs", runLabel);
	const run = readJson(join(fixture, "run.json"));
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "aw-support-replay-")));
	cpSync(join(FIXTURE_ROOT, "projects", run.project), cwd, { recursive: true });
	cpSync(
		join(fixture, "tasks"),
		join(cwd, ".agent-workflow", "workflows", run.runId, "tasks"),
		{
			recursive: true,
		},
	);
	return { cwd, run };
}

function statusRow(row) {
	const { digest, artifacts, sourceGeneration, ...status } = row;
	void digest;
	void artifacts;
	void sourceGeneration;
	return status;
}

/** The recorded web quote check answered again (deep-research `check-web-quotes`). */
function recordedEvidence(cwd, run) {
	if (!run.evidenceRefetch) return { refetchEnabled: false };
	const task = run.tasks.find((row) => row.specId === "check-web-quotes.main");
	const path =
		task &&
		join(
			cwd,
			".agent-workflow",
			"workflows",
			run.runId,
			"tasks",
			task.taskId,
			"control.json",
		);
	const recorded = path && existsSync(path) ? readJson(path) : null;
	return {
		refetchEnabled: true,
		async checkWebQuotes(rows) {
			if (!recorded || !Array.isArray(recorded.results))
				throw new Error(recorded?.error ?? "no recorded web quote check");
			const pool = [...recorded.results];
			const results = rows.map((row) => {
				const index = pool.findIndex(
					(result) =>
						result.url === row.url && row.quote.startsWith(result.quote),
				);
				const hit = index >= 0 ? pool.splice(index, 1)[0] : null;
				if (!hit)
					return {
						key: row.key,
						url: row.url,
						grade: "unverified",
						reason: "not in the recording",
					};
				const { claimId, evidenceIndex, quote, location, ...rest } = hit;
				void claimId;
				void evidenceIndex;
				void quote;
				void location;
				return { key: row.key, ...rest };
			});
			return { results, summary: recorded.summary };
		},
	};
}

function orderSupportTasks(supportTasks) {
	const ids = new Set(supportTasks.map((row) => row.specId));
	const done = new Set();
	const ordered = [];
	while (ordered.length < supportTasks.length) {
		const next = supportTasks.find(
			(row) =>
				!done.has(row.specId) &&
				row.dependsOn.every((dep) => !ids.has(dep) || done.has(dep)),
		);
		if (!next) throw new Error("support tasks have a dependency cycle");
		done.add(next.specId);
		ordered.push(next);
	}
	return ordered;
}

/** Run every recorded support task again with the current helpers; returns specId → control. */
export async function replaySupport(cwd, run, { helperRoot = REPO } = {}) {
	const bundle = join(helperRoot, "workflows", run.bundle);
	const runDir = join(cwd, ".agent-workflow", "workflows", run.runId);
	const outputs = {};
	const evidence = recordedEvidence(cwd, run);
	for (const support of orderSupportTasks(run.supportTasks)) {
		const task = run.tasks.find((row) => row.specId === support.specId);
		const manifestPath =
			task && join(runDir, "tasks", task.taskId, "source-manifest.json");
		if (!manifestPath || !existsSync(manifestPath)) continue;
		const manifest = readJson(manifestPath);
		const sources = {};
		for (const row of manifest.sources) {
			if (row.status !== "completed") continue;
			sources[row.source] = readJson(
				join(runDir, "tasks", row.taskId, "control.json"),
			);
		}
		const helper = (
			await import(pathToFileURL(join(bundle, support.support.uses)).href)
		).default;
		let output;
		try {
			output = await helper({
				sources,
				options: support.support.options,
				context: {
					specPath: join(bundle, "spec.json"),
					originalSpecPath: join(bundle, "spec.json"),
					stageId: task.stageId,
					taskId: task.taskId,
					runId: run.runId,
					cwd,
					signal: new AbortController().signal,
					evidence,
					sourceStatuses: manifest.sources.map(statusRow),
				},
			});
		} catch (error) {
			output = {
				replayError: error instanceof Error ? error.message : String(error),
			};
		}
		outputs[support.specId] = output;
		// Downstream helpers that read this task's control through the run directory see the new one.
		writeFileSync(
			join(runDir, "tasks", task.taskId, "control.json"),
			`${JSON.stringify(output, null, 2)}\n`,
		);
	}
	return outputs;
}

/** Stable form for comparison: no absolute replay directory. */
export function normalizeOutputs(outputs, cwd) {
	return JSON.parse(JSON.stringify(outputs).split(cwd).join("@@PROJECT@@"));
}

export function runLabels() {
	const dir = join(FIXTURE_ROOT, "runs");
	return existsSync(dir)
		? readdirSync(dir)
				.filter((name) => statSync(join(dir, name)).isDirectory())
				.sort()
		: [];
}

export const goldenPath = (runLabel) =>
	join(FIXTURE_ROOT, "golden", `${runLabel}.json`);

/** First differing JSON path between two values, for a readable failure. */
export function firstDifference(left, right, path = "$") {
	if (Object.is(left, right)) return null;
	if (
		typeof left !== typeof right ||
		left === null ||
		right === null ||
		typeof left !== "object"
	)
		return { path, actual: left, expected: right };
	if (Array.isArray(left) !== Array.isArray(right))
		return { path, actual: left, expected: right };
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		const diff = firstDifference(left[key], right[key], `${path}.${key}`);
		if (diff) return diff;
	}
	return null;
}

export async function replayFixture(runLabel) {
	const { cwd, run } = materialize(runLabel);
	try {
		return normalizeOutputs(await replaySupport(cwd, run), cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	if (args[0] === "--capture") {
		for (const dir of args.slice(1))
			console.log(`${dir}: ${capture(dir).join(", ") || "nothing"}`);
		process.exit(0);
	}
	const write = args.includes("--write");
	let failed = 0;
	for (const label of runLabels()) {
		const actual = await replayFixture(label);
		if (write) {
			writeJson(goldenPath(label), actual);
			console.log(`wrote ${relative(REPO, goldenPath(label))}`);
			continue;
		}
		const expected = existsSync(goldenPath(label))
			? readJson(goldenPath(label))
			: null;
		const diff = firstDifference(actual, expected);
		if (diff) {
			failed += 1;
			console.log(`${label}: differs at ${diff.path}`);
		} else console.log(`${label}: same`);
	}
	process.exit(failed ? 1 : 0);
}
