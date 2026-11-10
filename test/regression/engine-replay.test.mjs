// test-tier: integration
// Engine-replay regression (2026-11-10; owner: run once after a large change — local AGENTS.md; not in GitHub CI).
// Each recorded run under test/fixtures/regression/ is replayed through the real engine and the current bundled
// spec: the fixture executor answers every model task with its recorded outputs (failed attempts first) and re-does
// its recorded artifact reads; support stages, validation, repairs, foreach materialization, required reads and the
// final render run as code does today. Web quote checks read the recorded pages from a seeded cache with DNS
// refused, so nothing goes to the network. The outcome (task statuses, every task's control, the final report and
// audit) is compared with test/fixtures/regression/golden/<name>.json.
//
//   npm run test:regression                                   check every fixture
//   AGENT_WORKFLOW_WRITE_REGRESSION=1 npm run test:regression  rewrite the golden files (review the diff)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
	REGRESSION_FIXTURES,
	REGRESSION_GOLDEN,
} from "../helpers/regression-fixtures.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");
const { EvidencePageCache, evidenceCacheDir } = await import(
	"../../dist/core/evidence-page-cache.js"
);

const WRITE = process.env.AGENT_WORKFLOW_WRITE_REGRESSION === "1";
const fixtures = existsSync(REGRESSION_FIXTURES)
	? readdirSync(REGRESSION_FIXTURES)
			.filter((name) => name.endsWith(".json.gz"))
			.sort()
	: [];

let root;
const undo = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-regression-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	// Offline: a lookup never resolves, so a page the run did not record fails the same way every time.
	const lookup = dns.lookup;
	dns.lookup = (hostname, options, callback) => {
		const done = typeof options === "function" ? options : callback;
		process.nextTick(() =>
			done(
				Object.assign(new Error(`regression replay is offline: ${hostname}`), {
					code: "ENOTFOUND",
				}),
			),
		);
	};
	syncBuiltinESMExports();
	undo.push(() => {
		dns.lookup = lookup;
		syncBuiltinESMExports();
	});
	// The suite runner turns the web quote check off for unit tests (no network); here it runs against the
	// recorded pages.
	const refetch = process.env.AGENT_WORKFLOW_EVIDENCE_REFETCH;
	process.env.AGENT_WORKFLOW_EVIDENCE_REFETCH = "1";
	undo.push(() => {
		if (refetch === undefined)
			delete process.env.AGENT_WORKFLOW_EVIDENCE_REFETCH;
		else process.env.AGENT_WORKFLOW_EVIDENCE_REFETCH = refetch;
	});
});
after(async () => {
	for (const step of undo.splice(0).reverse()) step();
	slots.setWorkerLaunchControlsForTests({});
	// AGENT_WORKFLOW_REGRESSION_LOGS keeps the replayed runs (and the executors' effect logs) for inspection.
	if (process.env.AGENT_WORKFLOW_REGRESSION_LOGS !== undefined) {
		console.log(`kept replayed runs under ${root}`);
		return;
	}
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

/** Run-independent text: run ids, temporary paths, timestamps, durations and hashes become placeholders. */
function normalize(text, cwd, runId) {
	return (
		text
			.split(runId)
			.join("<run>")
			.split(cwd)
			.join("<cwd>")
			.split(root)
			.join("<root>")
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>")
			// Hashes over run-specific content (manifests naming the run) differ per replay; the content is compared.
			.replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, "<sha256>")
			.replace(
				/"(\w*(?:Ms|At|Seconds|duration\w*))":\s*(?:\d+(?:\.\d+)?|"[^"]*")/g,
				'"$1":"<n>"',
			)
	);
}

const sha = (text) =>
	createHash("sha256").update(text).digest("hex").slice(0, 16);

async function replay(name) {
	const fixture = JSON.parse(
		gunzipSync(readFileSync(join(REGRESSION_FIXTURES, name))).toString("utf8"),
	);
	const label = name.replace(/\.json\.gz$/, "");
	const cwd = join(root, label);
	for (const [path, text] of Object.entries(fixture.files)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), text);
	}
	mkdirSync(cwd, { recursive: true });
	const cache = new EvidencePageCache(evidenceCacheDir(cwd));
	for (const page of fixture.pages)
		await cache.put(
			{
				url: page.url,
				finalUrl: page.finalUrl,
				status: page.status,
				contentType: page.contentType,
				redirects: [],
			},
			Buffer.from(page.body, "base64"),
		);
	const id = `replay-${label}`;
	const fixtureFile = join(root, `${label}.json`);
	writeFileSync(fixtureFile, JSON.stringify(fixture));
	undo.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(
					process.env.AGENT_WORKFLOW_REGRESSION_LOGS ?? root,
					// One log per replay: the executor counts a task's attempts in it, and task ids repeat across runs.
					`${label}-${process.pid}-${Date.now()}-effects.jsonl`,
				),
				replay: { file: fixtureFile },
				capabilities: {
					webTools: {
						level: "native",
						source: "declared",
						detail: "search+fetch",
						safetyPolicy: "unknown",
					},
				},
			}),
		),
	);
	const started = await engine.runWorkflowSpec(join(REPO, fixture.spec), cwd, {
		task: fixture.task,
		executor: id,
		...(fixture.profile ? { executionProfile: fixture.profile } : {}),
	});
	const run = await engine.waitForRun(cwd, started.runId, 600_000);
	const runDir = store.workflowRunDir(cwd, run.runId);
	const tasks = run.tasks
		.map((task) => {
			const dir = join(runDir, "tasks", task.taskId);
			const control = join(dir, "control.json");
			return {
				specId: task.specId,
				status: task.status,
				statusDetail: task.statusDetail ?? null,
				...(task.status === "completed"
					? {}
					: {
							message: normalize(
								String(task.lastMessage ?? "").slice(0, 400),
								cwd,
								run.runId,
							),
						}),
				control: existsSync(control)
					? sha(normalize(readFileSync(control, "utf8"), cwd, run.runId))
					: null,
			};
		})
		.sort((a, b) => a.specId.localeCompare(b.specId));
	const finalTask = run.tasks.find((task) => task.specId === "final.main");
	const sidecar = (file) => {
		const path = finalTask && join(runDir, "tasks", finalTask.taskId, file);
		return path && existsSync(path)
			? normalize(readFileSync(path, "utf8"), cwd, run.runId)
			: null;
	};
	return {
		label,
		source: fixture.source,
		outcome: {
			status: run.status,
			tasks,
			finalReport: sidecar("final-report.md"),
			audit: sidecar("audit.md"),
		},
	};
}

test("there are regression fixtures to replay", () => {
	assert.ok(fixtures.length > 0, `no fixtures under ${REGRESSION_FIXTURES}`);
});

for (const name of fixtures)
	test(`engine replay: ${name}`, { timeout: 900_000 }, async () => {
		const { label, source, outcome } = await replay(name);
		const goldenPath = join(REGRESSION_GOLDEN, `${label}.json`);
		if (WRITE || !existsSync(goldenPath)) {
			mkdirSync(REGRESSION_GOLDEN, { recursive: true });
			writeFileSync(
				goldenPath,
				`${JSON.stringify({ fixture: label, recordedFrom: source, ...outcome }, null, "\t")}\n`,
			);
			if (!WRITE)
				assert.fail(
					`golden written for a new fixture: ${goldenPath}; review and commit it`,
				);
			return;
		}
		const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
		const changed = outcome.tasks
			.filter((task) => {
				const before = golden.tasks.find((row) => row.specId === task.specId);
				return JSON.stringify(before) !== JSON.stringify(task);
			})
			.map((task) => task.specId);
		const missing = golden.tasks
			.filter(
				(row) => !outcome.tasks.some((task) => task.specId === row.specId),
			)
			.map((row) => row.specId);
		if (changed.length || missing.length) {
			const out = join(tmpdir(), `aw-regression-${label}-actual.json`);
			writeFileSync(out, JSON.stringify(outcome, null, "\t"));
			assert.fail(
				`${label}: tasks changed ${JSON.stringify(changed)}, missing ${JSON.stringify(missing)} (actual outcome: ${out})`,
			);
		}
		assert.equal(outcome.status, golden.status, `${label}: run status`);
		assert.equal(
			outcome.finalReport,
			golden.finalReport,
			`${label}: final report`,
		);
		assert.equal(outcome.audit, golden.audit, `${label}: audit`);
	});
