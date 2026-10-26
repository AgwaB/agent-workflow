// New in agent-workflow (WP5b, R#9): paged whole-artifact reads through the artifact MCP server.
// Every response fits the output limit (UTF-16 chars and UTF-8 bytes); page rows carry
// rangeStart/rangeEnd/totalChars/contentSha256 and deliveryUnverified: false; a complete set of
// pages of one artifact version satisfies a whole-artifact required read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { EXPERIMENTAL_TOOL_DEDUP_ENV } from "../../dist/core/experimental-speed-flags.js";
import { checkRequiredArtifactReads } from "../../dist/core/required-reads.js";
import {
	readWorkflowArtifactReadLedger,
	workflowArtifactPage,
} from "../../dist/core/workflow-artifact-tool.js";
import { fitsDeliveryLimit } from "../../dist/mcp/artifact-server/index.js";
import {
	createRunFixture,
	resultText,
	startServer,
} from "../fixtures/mcp/helpers.mjs";

const HEADER = "# workflow_artifact: producer.analysis\n\n";
const PAGE_FOOTER =
	/\n\n\[workflow_artifact page: chars (\d+)–(\d+) of (\d+); (?:call again with offset=(\d+) to continue|end of artifact)\]$/u;

const sha256 = (text) =>
	createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

async function setup(t, { limit, analysis, env } = {}) {
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	if (analysis !== undefined)
		await writeFile(join(fixture.producerDir, "analysis.md"), analysis);
	const server = startServer(
		[
			"--config",
			fixture.configPath,
			...(limit === undefined ? [] : ["--max-output-chars", String(limit)]),
		],
		{ env },
	);
	t.after(() => server.child.kill("SIGKILL"));
	await server.initialize();
	const rows = async () =>
		(await readFile(fixture.ledgerPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { fixture, server, rows };
}

/** Parse one page response: page text, range and the next offset (undefined at the end). */
function parsePage(text) {
	assert.ok(text.startsWith(HEADER), text.slice(0, 80));
	const match = PAGE_FOOTER.exec(text);
	assert.ok(match, `no page footer: …${text.slice(-120)}`);
	return {
		page: text.slice(HEADER.length, match.index),
		start: Number(match[1]),
		end: Number(match[2]),
		total: Number(match[3]),
		next: match[4] === undefined ? undefined : Number(match[4]),
	};
}

/** Read every page from offset 0 on, checking each response against the limit. */
async function readAllPages(server, limit) {
	const pages = [];
	let offset = 0;
	for (let guard = 0; guard < 1000; guard += 1) {
		const result = await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
			offset,
		});
		assert.equal(result.isError, false, resultText(result));
		const text = resultText(result);
		assert.ok(
			fitsDeliveryLimit(text, limit),
			`${text.length} chars / ${Buffer.byteLength(text)} bytes > ${limit}`,
		);
		const page = parsePage(text);
		assert.equal(page.start, offset);
		pages.push(page);
		if (page.next === undefined) return pages;
		assert.equal(page.next, page.end);
		offset = page.next;
	}
	throw new Error("paging did not terminate");
}

test("ASCII: pages tile the artifact, fit the limit and satisfy the required read", async (t) => {
	const limit = 600;
	const analysis = Array.from(
		{ length: 120 },
		(_, index) => `line ${index} ${"a".repeat(20)}`,
	).join("\n");
	const { server, rows, fixture } = await setup(t, { limit, analysis });
	const pages = await readAllPages(server, limit);
	assert.ok(pages.length > 5);
	assert.equal(pages.map((page) => page.page).join(""), analysis);
	assert.equal(pages.at(-1).end, analysis.length);
	const ledger = await rows();
	assert.equal(ledger.length, pages.length);
	for (const [index, row] of ledger.entries()) {
		assert.equal(row.rangeStart, pages[index].start);
		assert.equal(row.rangeEnd, pages[index].end);
		assert.equal(row.totalChars, analysis.length);
		assert.equal(row.contentSha256, sha256(analysis));
		assert.equal(row.deliveryUnverified, false);
		assert.equal(row.truncated, true, "a partial page is never a whole read");
		assert.equal(row.bytes, Buffer.byteLength(analysis));
		assert.equal(
			row.returnedBytes,
			Buffer.byteLength(analysis.slice(row.rangeStart, row.rangeEnd)),
		);
		assert.equal("path" in row, false);
	}
	const parsed = await readWorkflowArtifactReadLedger(fixture.ledgerPath);
	assert.equal(parsed[0].deliveryUnverified, false);
	assert.equal(parsed[0].contentSha256, sha256(analysis));
	assert.deepEqual(
		await checkRequiredArtifactReads(fixture.taskDir, ["producer.analysis"]),
		{ missing: [], projectionFailures: [] },
	);
	// Without the last page the required read is missing, and the gap is named.
	await writeFile(
		fixture.ledgerPath,
		`${(await readFile(fixture.ledgerPath, "utf8"))
			.trim()
			.split("\n")
			.slice(0, -1)
			.join("\n")}\n`,
	);
	const partial = await checkRequiredArtifactReads(fixture.taskDir, [
		"producer.analysis",
	]);
	assert.deepEqual(partial.missing, ["producer.analysis"]);
	assert.deepEqual(partial.incompleteCoverage, [
		`producer.analysis: paged read incomplete, missing chars ${pages.at(-1).start}–${analysis.length} of ${analysis.length}`,
	]);
});

test("multibyte and surrogate pairs: bytes bounded, pairs never split, exact reassembly", async (t) => {
	const limit = 512;
	const analysis = "한국어 텍스트 😀 emoji 𝄞 clef\n".repeat(80);
	const { server } = await setup(t, { limit, analysis });
	const pages = await readAllPages(server, limit);
	assert.equal(pages.map((page) => page.page).join(""), analysis);
	for (const { page } of pages) {
		assert.doesNotMatch(page, /\uFFFD/u);
		const first = page.charCodeAt(0);
		const last = page.charCodeAt(page.length - 1);
		assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "starts mid-pair");
		assert.ok(!(last >= 0xd800 && last <= 0xdbff), "ends mid-pair");
	}
	// An offset on the low half of a pair starts one char earlier (rangeStart reports it).
	const low = analysis.indexOf("😀") + 1;
	const page = parsePage(
		resultText(
			await server.callTool({
				action: "read",
				source: "producer",
				artifact: "analysis",
				offset: low,
			}),
		),
	);
	assert.equal(page.start, low - 1);
	assert.ok(page.page.startsWith("😀"));
});

test("exact boundary: a whole read of exactly the limit is unchanged, one char more is paged", async (t) => {
	const limit = 600;
	const exact = "e".repeat(limit - HEADER.length);
	const first = await setup(t, { limit, analysis: exact });
	const text = resultText(
		await first.server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
		}),
	);
	assert.equal(text, HEADER + exact);
	const [row] = await first.rows();
	assert.equal(row.truncated, false);
	assert.equal("rangeStart" in row, false, "old row shape");
	assert.equal("deliveryUnverified" in row, false);

	const over = `${exact}f`;
	const second = await setup(t, { limit, analysis: over });
	const paged = parsePage(
		resultText(
			await second.server.callTool({
				action: "read",
				source: "producer",
				artifact: "analysis",
			}),
		),
	);
	assert.equal(paged.start, 0);
	assert.ok(paged.next > 0 && paged.next < over.length);
	const pages = [paged, ...(await readAllPages(second.server, limit)).slice(1)];
	assert.equal(pages.map((page) => page.page).join(""), over);
});

test("a page that ends exactly at the end says end of artifact; offset=0 on a small artifact is one whole page", async (t) => {
	const { server, rows, fixture } = await setup(t, {
		limit: 4096,
		analysis: "small artifact",
	});
	const text = resultText(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
			offset: 0,
		}),
	);
	assert.match(text, /chars 0–14 of 14; end of artifact\]$/u);
	const [row] = await rows();
	assert.equal(row.rangeStart, 0);
	assert.equal(row.rangeEnd, 14);
	assert.equal(row.truncated, false);
	assert.equal(row.deliveryUnverified, false);
	assert.deepEqual(
		(await checkRequiredArtifactReads(fixture.taskDir, ["producer.analysis"]))
			.missing,
		[],
	);
});

test("offset past the end, offset with a projection, and a negative offset are tool errors without ledger rows", async (t) => {
	const { server, fixture } = await setup(t, {
		limit: 4096,
		analysis: "0123456789",
	});
	for (const [args, pattern] of [
		[
			{ offset: 11 },
			/offset 11 is past the end of producer\.analysis \(10 chars\)/,
		],
		[{ offset: 10 }, /offset 10 is past the end/],
		[{ offset: -1 }, /offset must be a non-negative integer/],
		[{ offset: 1.5 }, /offset must be a non-negative integer/],
	]) {
		const result = await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
			...args,
		});
		assert.equal(result.isError, true, JSON.stringify(args));
		assert.match(resultText(result), pattern);
	}
	const projected = await server.callTool({
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
		offset: 0,
	});
	assert.equal(projected.isError, true);
	assert.match(
		resultText(projected),
		/offset pages a whole-artifact read; it cannot be combined with path, maxItems or maxChars/,
	);
	await assert.rejects(readFile(fixture.ledgerPath), { code: "ENOENT" });
});

test("an empty artifact pages as one empty whole page", async (t) => {
	const { server, rows } = await setup(t, { limit: 4096, analysis: "" });
	const text = resultText(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
			offset: 0,
		}),
	);
	assert.match(text, /chars 0–0 of 0; end of artifact\]$/u);
	const [row] = await rows();
	assert.deepEqual(
		[row.rangeStart, row.rangeEnd, row.totalChars, row.truncated],
		[0, 0, 0, false],
	);
});

test("pages are never duplicate-suppressed, and an artifact change starts a new version", async (t) => {
	const analysis = "p".repeat(3000);
	const { server, rows, fixture } = await setup(t, {
		limit: 1000,
		analysis,
		env: { [EXPERIMENTAL_TOOL_DEDUP_ENV]: "1" },
	});
	const read = (offset) =>
		server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
			offset,
		});
	const first = parsePage(resultText(await read(0)));
	const again = parsePage(resultText(await read(0)));
	assert.deepEqual(again, first);
	await writeFile(join(fixture.producerDir, "analysis.md"), "q".repeat(3000));
	let offset = first.next;
	while (offset !== undefined)
		offset = parsePage(resultText(await read(offset))).next;
	const ledger = await rows();
	assert.ok(ledger.every((row) => row.returnedBytes > 0));
	assert.notEqual(ledger[0].contentSha256, ledger.at(-1).contentSha256);
	const check = await checkRequiredArtifactReads(fixture.taskDir, [
		"producer.analysis",
	]);
	assert.deepEqual(check.missing, ["producer.analysis"]);
	assert.match(
		check.incompleteCoverage[0],
		/missing chars 0–\d+ of 3000 \(pages of 2 artifact versions; pages of different versions do not combine\)$/u,
	);
});

test("workflowArtifactPage: raw assurance line inside the limit, too-small limit refused", () => {
	const content = "r".repeat(2000);
	const page = workflowArtifactPage({
		source: "producer",
		artifact: "raw",
		content,
		offset: 0,
		limit: 600,
		rawAssurance: {
			kind: "independent_unattested",
			originalBytes: "unattested",
		},
	});
	assert.ok(page.text.length <= 600);
	assert.match(
		page.text,
		/\[raw assurance: independent_unattested; original bytes: unattested\]\n\n\[workflow_artifact page: chars 0–\d+ of 2000; call again/u,
	);
	assert.throws(
		() =>
			workflowArtifactPage({
				source: "producer",
				artifact: "analysis",
				content,
				offset: 0,
				limit: 60,
			}),
		/too small to page/,
	);
});
