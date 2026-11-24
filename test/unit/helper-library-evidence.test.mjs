// The evidence-locate and evidence-gate helpers that `agent-workflow new helper` adds to a bundle. The
// failure cases are the ones novel-briefs-20261124 measured: a model's line numbers off by one must still
// locate the real quote, a bad row is dropped (not the whole run), and a path never leaves the project.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const locate = await import(
	"../../src/core/helper-library/evidence-locate.mjs"
);
const gateModule = await import(
	"../../src/core/helper-library/evidence-gate.mjs"
);
const gate = gateModule.default;

const QUEUE = [
	'import { schedule } from "./scheduler.js";',
	"",
	"// retry queue",
	"export function enqueue(job) {",
	"  jobs.push(job);",
	"  schedule(job);",
	"}",
	"",
	"export function drain() {",
	"  return jobs.splice(0);",
	"}",
	"",
].join("\n");

let root;
let outside;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-evidence-")));
	outside = await realpath(await mkdtemp(join(tmpdir(), "aw-evidence-out-")));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "queue.js"), QUEUE);
	await writeFile(join(root, "src", "crlf.js"), QUEUE.replace(/\n/g, "\r\n"));
	await writeFile(
		join(root, "src", "twice.js"),
		"const a = 1;\n// x\nconst a = 1;\n",
	);
	await writeFile(
		join(root, "src", "binary.bin"),
		Buffer.from([0xff, 0xfe, 0x00, 0x80]),
	);
	await writeFile(join(outside, "secret.txt"), "top secret value here\n");
	await symlink(outside, join(root, "linked"));
	await symlink(
		join(outside, "secret.txt"),
		join(root, "src", "secret-link.txt"),
	);
});
after(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

test("a verbatim quote is exact and carries its real line range", async () => {
	const verdict = await locate.locateEvidence({
		cwd: root,
		file: "src/queue.js",
		quote: "export function enqueue(job) {\n  jobs.push(job);",
	});
	assert.equal(verdict.verdict, "exact");
	assert.equal(verdict.startLine, 4);
	assert.equal(verdict.endLine, 5);
	assert.equal(verdict.lineCorrected, false);
	assert.equal(verdict.claimed, undefined);
});

test("line numbers off by one (or wildly) still locate the quote and are reported as corrected", async () => {
	for (const [start, end] of [
		[3, 4],
		[5, 6],
		[400, 401],
	]) {
		const verdict = await locate.locateEvidence({
			cwd: root,
			file: "src/queue.js",
			quote: "export function enqueue(job) {\n  jobs.push(job);",
			claimedStart: start,
			claimedEnd: end,
		});
		assert.equal(verdict.verdict, "exact", `claimed ${start}-${end}`);
		assert.deepEqual([verdict.startLine, verdict.endLine], [4, 5]);
		assert.equal(verdict.lineCorrected, true);
		assert.deepEqual(verdict.claimed, { startLine: start, endLine: end });
	}
	const right = await locate.locateEvidence({
		cwd: root,
		file: "src/queue.js",
		quote: "export function drain() {",
		claimedStart: "9",
		claimedEnd: 9,
	});
	assert.equal(right.lineCorrected, false);
});

test("a re-wrapped or re-indented quote is located, and a CRLF file matches an LF quote", async () => {
	const wrapped = await locate.locateEvidence({
		cwd: root,
		file: "src/queue.js",
		quote: "export function enqueue(job) { jobs.push(job);    schedule(job); }",
	});
	assert.equal(wrapped.verdict, "located");
	assert.deepEqual([wrapped.startLine, wrapped.endLine], [4, 7]);
	assert.match(
		wrapped.quote,
		/^export function enqueue\(job\) \{\n {2}jobs\.push/,
	);
	const crlf = await locate.locateEvidence({
		cwd: root,
		file: "src/crlf.js",
		quote: "export function enqueue(job) {\n  jobs.push(job);",
	});
	assert.equal(crlf.verdict, "exact");
	assert.deepEqual([crlf.startLine, crlf.endLine], [4, 5]);
});

test("a repeated quote picks the occurrence nearest the claimed line and counts them", async () => {
	const near = await locate.locateEvidence({
		cwd: root,
		file: "src/twice.js",
		quote: "const a = 1;",
		claimedStart: 4,
	});
	assert.equal(near.startLine, 3);
	assert.equal(near.occurrences, 2);
	const first = await locate.locateEvidence({
		cwd: root,
		file: "src/twice.js",
		quote: "const a = 1;",
	});
	assert.equal(first.startLine, 1);
});

test("rejections say why: empty, short, term missing, not in file, missing file", async () => {
	const cases = [
		[{ quote: "" }, /no quote/],
		[{ quote: "short" }, /too short/],
		[
			{ quote: "export function drain() {", term: "enqueue" },
			/does not contain "enqueue"/,
		],
		[{ quote: "export function missing() {}" }, /not in the file/],
		[
			{ quote: "export function drain() {", file: "src/none.js" },
			/does not exist/,
		],
	];
	for (const [args, reason] of cases) {
		const verdict = await locate.locateEvidence({
			cwd: root,
			file: "src/queue.js",
			...args,
		});
		assert.equal(verdict.verdict, "rejected");
		assert.match(verdict.reason, reason);
	}
});

test("the term must be a whole word in the quote unless termMatch is substring", () => {
	const text = "function enqueueAll() {}\n";
	assert.equal(
		locate.locateInText(text, "function enqueueAll() {}", { term: "enqueue" })
			.verdict,
		"rejected",
	);
	assert.equal(
		locate.locateInText(text, "function enqueueAll() {}", {
			term: "enqueue",
			termMatch: "substring",
		}).verdict,
		"exact",
	);
	assert.equal(
		locate.locateInText(text, "function enqueueAll() {}", {
			term: "enqueueAll",
		}).verdict,
		"exact",
	);
});

test("paths that leave the project, symlinks, absolute paths, urls and non-UTF-8 files are refused", async () => {
	for (const file of [
		"../" + outside.split("/").pop() + "/secret.txt",
		"linked/secret.txt",
		"src/secret-link.txt",
		join(outside, "secret.txt"),
		"https://example.com/a.js",
		"src",
		"src/binary.bin",
		"",
		"a\0b",
	]) {
		const verdict = await locate.locateEvidence({
			cwd: root,
			file,
			quote: "top secret value here",
		});
		assert.equal(verdict.verdict, "rejected", file);
		assert.equal(verdict.quote, "", "nothing of the outside file is returned");
	}
});

const rows = [
	{
		id: "r1",
		name: "enqueue",
		evidence: {
			file: "src/queue.js",
			quote: "export function enqueue(job) {",
			startLine: 3,
			endLine: 3,
		},
	},
	{
		id: "r2",
		name: "drain",
		evidence: {
			file: "src/queue.js",
			quote: "export  function drain() {\n return jobs.splice(0);",
			startLine: 10,
			endLine: 11,
		},
	},
	{
		id: "r3",
		name: "ghost",
		evidence: {
			file: "src/queue.js",
			quote: "export function ghost() {}",
			startLine: 1,
			endLine: 1,
		},
	},
	{
		id: "r4",
		name: "x",
		evidence: {
			file: "../escape.js",
			quote: "whatever quote text",
			startLine: 1,
			endLine: 1,
		},
	},
];
const options = (extra = {}) => ({
	from: "plan",
	rows: "items",
	fields: {
		startLine: "evidence.startLine",
		endLine: "evidence.endLine",
		term: "name",
	},
	...extra,
});

test("evidence-gate drop: verified rows are kept with real lines, rejected rows are listed, the stage passes", async () => {
	const out = await gate({
		sources: { plan: { items: rows } },
		options: options(),
		context: { cwd: root },
	});
	assert.equal(out.status, "passed");
	assert.equal(out.gates.passed, true);
	assert.deepEqual(out.counts, {
		total: 4,
		exact: 1,
		located: 1,
		rejected: 2,
		kept: 2,
		lineCorrected: 2,
		unchecked: 0,
	});
	assert.deepEqual(
		out.kept.map((row) => row.id),
		["r1", "r2"],
	);
	assert.deepEqual(out.kept[0].evidence, {
		file: "src/queue.js",
		quote: "export function enqueue(job) {",
		startLine: 4,
		endLine: 4,
	});
	assert.deepEqual(
		[out.kept[1].evidence.startLine, out.kept[1].evidence.endLine],
		[9, 10],
	);
	assert.equal(
		rows[0].evidence.startLine,
		3,
		"the source rows are not mutated",
	);
	assert.deepEqual(
		out.rejected.map((row) => row.id),
		["r3", "r4"],
	);
	assert.match(out.rejected[0].reason, /not in the file/);
	assert.match(out.rejected[1].reason, /relative path|leaves the project/);
	assert.match(out.digest, /2 of 4 rows verified, 2 rejected/);
	assert.match(out.markdown, /## Rejected rows/);
});

test("evidence-gate block: any failing row makes the stage declare blocked; no failure passes", async () => {
	const blocked = await gate({
		sources: { plan: { items: rows } },
		options: options({ policy: "block" }),
		context: { cwd: root },
	});
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.gates.passed, false);
	const clean = await gate({
		sources: { plan: { items: rows.slice(0, 2) } },
		options: options({ policy: "block" }),
		context: { cwd: root },
	});
	assert.equal(clean.status, "passed");
});

test("evidence-gate: the default policy is drop, minKept fails a stage with too few survivors, bad options throw", async () => {
	const none = await gate({
		sources: { plan: { items: rows.slice(2) } },
		options: options({ minKept: 1 }),
		context: { cwd: root },
	});
	assert.equal(none.status, "failed");
	assert.equal(none.policy, "drop");
	await assert.rejects(
		gate({
			sources: { plan: { items: [] } },
			options: options({ policy: "stop" }),
			context: { cwd: root },
		}),
		/policy/,
	);
	await assert.rejects(
		gate({
			sources: {},
			options: options(),
			context: { cwd: root, sourceStatuses: [] },
		}),
		/not a source/,
	);
	await assert.rejects(
		gate({
			sources: { plan: { items: 3 } },
			options: options(),
			context: { cwd: root },
		}),
		/no array/,
	);
	const empty = await gate({
		sources: { plan: { items: [] } },
		options: options(),
		context: { cwd: root },
	});
	assert.equal(empty.status, "passed");
	assert.equal(empty.counts.total, 0);
});

test("evidence-gate collects the items of a foreach stage through sourceStatuses and reports a source that did not complete", async () => {
	const context = {
		cwd: root,
		sourceStatuses: [
			{
				source: "audit",
				stageId: "audit",
				itemIdentity: "a",
				status: "completed",
			},
			{
				source: "audit.b",
				stageId: "audit",
				itemIdentity: "b",
				status: "completed",
			},
			{
				source: "audit.c",
				stageId: "audit",
				itemIdentity: "c",
				status: "failed",
			},
		],
	};
	const sources = {
		audit: { items: [rows[0]] },
		"audit.b": { items: [rows[1]] },
	};
	const out = await gate({
		sources,
		options: options({ from: "audit" }),
		context,
	});
	assert.equal(out.counts.total, 2);
	const failed = await gate({
		sources: {},
		options: options({ from: "late" }),
		context: {
			cwd: root,
			sourceStatuses: [{ source: "late", stageId: "late", status: "failed" }],
		},
	});
	assert.equal(failed.status, "failed");
});

test("evidence-gate fixQuote replaces a located quote with the file's text; rehearsal keeps every row unchecked", async () => {
	const out = await gate({
		sources: { plan: { items: [rows[1]] } },
		options: options({ fixQuote: true }),
		context: { cwd: root },
	});
	assert.match(
		out.kept[0].evidence.quote,
		/^export function drain\(\) \{\n {2}return/,
	);
	process.env.AGENT_WORKFLOW_REHEARSAL = "1";
	try {
		const rehearsal = await gate({
			sources: { plan: { items: rows } },
			options: options({ policy: "block" }),
			context: { cwd: "/nonexistent" },
		});
		assert.equal(rehearsal.status, "passed");
		assert.equal(rehearsal.counts.unchecked, 4);
		assert.equal(rehearsal.kept.length, 4);
	} finally {
		delete process.env.AGENT_WORKFLOW_REHEARSAL;
	}
});

test("evidence-gate output is deterministic", async () => {
	const run = () =>
		gate({
			sources: { plan: { items: rows } },
			options: options(),
			context: { cwd: root },
		});
	assert.equal(JSON.stringify(await run()), JSON.stringify(await run()));
});
