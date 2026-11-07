import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-01: engine-side web quote check. Each cited page is fetched once (then
// cached by content hash), turned into text views by content type, and each quote is looked up.
// What cannot be checked gets a reason instead of a verdict.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidencePageCache } from "../../dist/core/evidence-page-cache.js";
import { pdfToText, pdfTextViews } from "../../dist/core/evidence-pdf-text.js";
import {
	readTaskWebReceipts,
	receiptUrlKey,
} from "../../dist/core/evidence-receipts.js";
import {
	checkWebQuotes,
	EVIDENCE_REFETCH_ENV,
	evidenceRefetchEnabledAtLaunch,
	supportEvidenceContext,
} from "../../dist/core/evidence-web-quotes.js";

const filler = `<p>${"Background text that is not quoted. ".repeat(40)}</p>`;
const PAGES = {
	"https://docs.example.com/a": {
		contentType: "text/html; charset=utf-8",
		body: `<html><head><title>A</title><script>var x = "not text";</script></head><body>${filler}<p>The cache is invalidated when content is cleared.</p></body></html>`,
	},
	"https://docs.example.com/md": {
		contentType: "text/markdown; charset=utf-8",
		body: `# Doc\n\n${"Filler line for length. ".repeat(60)}\n\nMemory poisoning persists across **sessions**, subtly altering behaviour.`,
	},
	"https://img.example.com/table.png": {
		contentType: "image/png",
		body: "\x89PNG....",
	},
	"https://app.example.com/spa": {
		contentType: "text/html",
		body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
	},
	"https://papers.example.com/p.pdf": {
		contentType: "application/pdf",
		body: "%PDF-1.4 fake",
	},
};

function fakeFetch(calls) {
	return async (url) => {
		calls.push(url);
		if (url === "https://blocked.example.com/")
			return {
				ok: false,
				url,
				reason: "http-error",
				detail: "HTTP 403",
				status: 403,
			};
		const page = PAGES[url];
		if (!page)
			return { ok: false, url, reason: "dns-failed", detail: "ENOTFOUND" };
		return {
			ok: true,
			url,
			finalUrl: url,
			status: 200,
			contentType: page.contentType,
			body: Buffer.from(page.body, "latin1"),
			redirects: [],
		};
	};
}

const fakePdf = async () => ({
	ok: true,
	text: `${"Long PDF text. ".repeat(100)}\nRecognition of evi-\ndence works well.`,
});

test("grades each quote and gives a reason when it cannot be checked", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "aw-evidence-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = [];
	const rows = [
		[
			"html",
			"https://docs.example.com/a",
			"The cache is invalidated when content is cleared.",
		],
		[
			"html-frag",
			"https://docs.example.com/a#section",
			"invalidated when content is cleared",
		],
		[
			"html-wrong",
			"https://docs.example.com/a",
			"The cache is never invalidated.",
		],
		[
			"md",
			"https://docs.example.com/md",
			"persists across sessions, subtly altering",
		],
		["image", "https://img.example.com/table.png", "96.6"],
		[
			"spa",
			"https://app.example.com/spa",
			"Some text from a client-rendered page",
		],
		["blocked", "https://blocked.example.com/", "System > developer > user"],
		[
			"pdf",
			"https://papers.example.com/p.pdf",
			"Recognition of evidence works well",
		],
		["empty", "https://docs.example.com/a", "  "],
	].map(([key, url, quote]) => ({ key, url, quote }));
	const cache = new EvidencePageCache(dir);
	const { results, summary } = await checkWebQuotes(rows, {
		cwd: dir,
		cache,
		fetch: fakeFetch(calls),
		pdfToText: fakePdf,
	});
	const by = Object.fromEntries(results.map((r) => [r.key, r]));
	assert.equal(by.html.grade, "verified-refetched");
	assert.equal(by.html.level, "exact");
	assert.equal(by.html.view, "rendered");
	assert.equal(by["html-frag"].grade, "verified-refetched");
	assert.equal(by["html-wrong"].reason, "quote-not-on-page");
	assert.equal(by.md.level, "normalized");
	assert.equal(by.image.reason, "image");
	assert.equal(by.spa.reason, "little-page-text");
	assert.equal(by.blocked.reason, "http-error");
	assert.equal(by.pdf.grade, "verified-refetched");
	assert.equal(by.pdf.view, "pdf-joined");
	assert.equal(by.empty.reason, "no-quote");
	assert.match(by.html.page.bodySha256, /^[0-9a-f]{64}$/);
	assert.equal(by.html.page.fromCache, false);
	// One fetch per page; the fragment does not cause a second fetch.
	assert.equal(
		calls.filter((url) => url.startsWith("https://docs.example.com/a")).length,
		1,
	);
	assert.deepEqual(
		{
			quotes: summary.quotes,
			verified: summary.verified,
			unverified: summary.unverified,
		},
		{ quotes: 9, verified: 4, unverified: 5 },
	);

	// Second run: pages come from the cache, no network.
	const again = [];
	const second = await checkWebQuotes(rows.slice(0, 1), {
		cwd: dir,
		cache,
		fetch: fakeFetch(again),
	});
	assert.deepEqual(again, []);
	assert.equal(second.results[0].page.fromCache, true);
	assert.equal(second.results[0].grade, "verified-refetched");
});

test("a missing pdftotext is a reason, not an error", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "aw-evidence-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const missing = await pdfToText(Buffer.from("%PDF-1.4"), {
		command: join(dir, "no-such-pdftotext"),
	});
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, "pdf-tool-missing");
	const { results } = await checkWebQuotes(
		[
			{
				key: "pdf",
				url: "https://papers.example.com/p.pdf",
				quote: "anything",
			},
		],
		{
			cwd: dir,
			cache: new EvidencePageCache(dir),
			fetch: fakeFetch([]),
			pdfToText: async () => missing,
		},
	);
	assert.equal(results[0].reason, "pdf-tool-missing");
});

function tinyPdf(lines) {
	const content = `BT /F1 12 Tf 72 720 Td ${lines.map((line, i) => `${i ? "0 -14 Td " : ""}(${line}) Tj`).join(" ")} ET`;
	const objects = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
		`<</Length ${content.length}>>stream\n${content}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [];
	for (const [i, body] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj${body}endobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

let hasPdftotext = true;
try {
	execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
} catch {
	hasPdftotext = false;
}

test("pdftotext extracts PDF text", {
	skip: hasPdftotext ? false : "pdftotext not installed",
}, async () => {
	const result = await pdfToText(
		tinyPdf(["Recognition of evidence", "works well."]),
	);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.match(result.text, /Recognition of evidence\s+works well\./);
});

test("PDF text gets a view with line-break hyphenation joined", () => {
	assert.deepEqual(
		pdfTextViews("Recognition of evi-\ndence works. A well-\nKnown case."),
		[
			"Recognition of evi-\ndence works. A well-\nKnown case.",
			"Recognition of evidence works. A well-\nKnown case.",
		],
	);
	assert.deepEqual(pdfTextViews("no hyphen breaks"), ["no hyphen breaks"]);
});

test("the page cache is content-addressed, expires and stays under its cap", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "aw-evidence-cache-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let now = Date.parse("2026-11-01T00:00:00Z");
	const cache = new EvidencePageCache(dir, {
		maxTotalBytes: 100,
		maxAgeMs: 1000,
		now: () => now,
	});
	const page = (url) => ({
		url,
		finalUrl: url,
		status: 200,
		contentType: "text/plain",
		redirects: [],
	});
	const a = await cache.put(page("https://a.example/"), Buffer.alloc(60, 1));
	now += 10;
	await cache.put(page("https://a2.example/"), Buffer.alloc(60, 1));
	assert.ok(await cache.get("https://a.example/"), "same body is stored once");
	now += 10;
	await cache.put(page("https://b.example/"), Buffer.alloc(60, 2));
	assert.equal(
		await cache.get("https://a.example/"),
		undefined,
		"oldest body evicted",
	);
	assert.ok(await cache.get("https://b.example/"));
	assert.match(a.bodySha256, /^[0-9a-f]{64}$/);
	now += 5000;
	assert.equal(await cache.get("https://b.example/"), undefined, "expired");
});

test("support helpers get the check; enabled is the run's launch-time decision", () => {
	const signal = new AbortController().signal;
	assert.equal(
		supportEvidenceContext({
			cwd: "/tmp",
			runId: "run",
			signal,
			enabled: false,
		}).refetchEnabled,
		false,
	);
	const on = supportEvidenceContext({
		cwd: "/tmp",
		runId: "run",
		signal,
		enabled: true,
	});
	assert.equal(on.refetchEnabled, true);
	assert.equal(typeof on.checkWebQuotes, "function");
	assert.equal(EVIDENCE_REFETCH_ENV, "AGENT_WORKFLOW_EVIDENCE_REFETCH");
	assert.equal(evidenceRefetchEnabledAtLaunch({}), true, "default on");
	for (const value of ["0", "false", "no", "OFF", " off "])
		assert.equal(
			evidenceRefetchEnabledAtLaunch({ [EVIDENCE_REFETCH_ENV]: value }),
			false,
			value,
		);
	for (const value of ["1", "true", "yes", ""])
		assert.equal(
			evidenceRefetchEnabledAtLaunch({ [EVIDENCE_REFETCH_ENV]: value }),
			true,
			value,
		);
});

// Receipts: what the worker's own web tools returned (normalized exec-events of its attempts).
function writeAttempt(cwd, runId, taskId, attempt, events) {
	const dir = join(
		stateDir(cwd),
		".agent-workflow",
		"worker-runs",
		runId,
		taskId,
		"run_1",
		"attempts",
		attempt,
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "exec-events.jsonl"),
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
}

const tool = (name, status, callId, extra) => ({
	type: "tool_call",
	name,
	kind: "fetch",
	status,
	callId,
	...extra,
});

test("receipts come from every attempt's tool calls, typed by what the tool returns", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-evidence-receipts-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeAttempt(cwd, "run-1", "task-3", "attempt_a", [
		tool("fetch_content", "running", "c1", {
			input: { url: "https://www.Docs.example.com/a/" },
		}),
		tool("fetch_content", "completed", "c1", {
			output: "Page A says the cache is cleared.",
		}),
		tool("fetch_content", "running", "c2", {
			input: { urls: ["https://x.example/1", "https://x.example/2"] },
		}),
		tool("fetch_content", "failed", "c2", { output: "error" }),
		tool("web_search", "running", "c3", { input: { queries: ["q"] } }),
		tool("web_search", "completed", "c3", {
			output: "1. Title https://news.example/story snippet text",
		}),
		{ type: "message_delta", text: "fetch_content" },
	]);
	writeAttempt(cwd, "run-1", "task-3", "attempt_b", [
		tool("WebFetch", "running", "w1", {
			input: { url: "https://docs.example.com/b", prompt: "?" },
		}),
		tool("WebFetch", "completed", "w1", {
			output: "The page says **Node.js 24** is the newest LTS.",
		}),
		tool("web_search", "completed", "x1", {
			input: { query: "codex", action: null },
		}),
	]);
	const receipts = await readTaskWebReceipts(cwd, "run-1", "task-3");
	const forms = receipts.map((r) => [r.tool, r.form, r.targets]);
	assert.deepEqual(forms.sort(), [
		["WebFetch", "summary", ["docs.example.com/b"]],
		["fetch_content", "page-text", ["docs.example.com/a"]],
		["web_search", "search-results", ["news.example/story"]],
	]);
	assert.equal(
		receiptUrlKey("https://WWW.Docs.example.com/a/#x"),
		"docs.example.com/a",
	);
	assert.deepEqual(await readTaskWebReceipts(cwd, "run-1", "missing"), []);
});

test("Antigravity's read_url_content (Url input) is page text; search_web is search results", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-evidence-receipts-agy-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeAttempt(cwd, "run-3", "task-1", "attempt_a", [
		tool("read_url_content", "pending", "r1", {
			input: { Url: "https://docs.example/api/globals" },
		}),
		tool("read_url_content", "completed", "r1", {
			input: { Url: "https://docs.example/api/globals" },
			output: "# Globals\n\nReturns a new AbortSignal.",
		}),
		tool("search_web", "completed", "s1", {
			input: { query: "abort" },
			output: "Summary: see https://docs.example/api/globals [1]",
		}),
	]);
	const receipts = await readTaskWebReceipts(cwd, "run-3", "task-1");
	assert.deepEqual(receipts.map((r) => [r.tool, r.form, r.targets]).sort(), [
		["read_url_content", "page-text", ["docs.example/api/globals"]],
		["search_web", "search-results", ["docs.example/api/globals"]],
	]);
});

test("fetch_content of several URLs or in answer mode is not page text for any one URL (quality A/B 2026-11-02)", async (t) => {
	// pi-web-access lists only titles and sizes for several URLs, and answer mode returns a
	// model-written answer; a quote in either must not verify a page without fetching it.
	const cwd = mkdtempSync(join(tmpdir(), "aw-evidence-receipts-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeAttempt(cwd, "run-1", "task-4", "attempt_a", [
		tool("fetch_content", "running", "m1", {
			input: { urls: ["https://x.example/1", "https://x.example/2"] },
		}),
		tool("fetch_content", "completed", "m1", {
			output:
				"## Fetched URLs\n\n- Page one (1200 chars)\n- Page two (900 chars)\n",
		}),
		tool("fetch_content", "running", "a1", {
			input: { url: "https://x.example/3", mode: "answer", prompt: "?" },
		}),
		tool("fetch_content", "completed", "a1", {
			output: "The page says caching is optional.",
		}),
		tool("fetch_content", "running", "s1", {
			input: { url: "https://x.example/4" },
		}),
		tool("fetch_content", "completed", "s1", { output: "Page four text." }),
	]);
	const receipts = await readTaskWebReceipts(cwd, "run-1", "task-4");
	assert.deepEqual(
		receipts.map((r) => [r.form, r.targets]),
		[
			["search-results", ["x.example/1", "x.example/2"]],
			["summary", ["x.example/3"]],
			["page-text", ["x.example/4"]],
		],
	);
});

test("a quote in the worker's own page text is verified without fetching; summaries are only noted", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-evidence-receipts-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeAttempt(cwd, "run-2", "task-1", "attempt_a", [
		tool("fetch_content", "running", "c1", {
			input: { url: "https://captured.example/page" },
		}),
		tool("fetch_content", "completed", "c1", {
			output: "Captured text: the limit is 48,000 bytes.",
		}),
		tool("WebFetch", "running", "w1", {
			input: { url: "https://docs.example.com/a" },
		}),
		tool("WebFetch", "completed", "w1", {
			output:
				"Summary: The cache is invalidated when content is cleared. It is never refreshed.",
		}),
	]);
	const calls = [];
	const checker = supportEvidenceContext({
		cwd,
		runId: "run-2",
		signal: new AbortController().signal,
		enabled: true,
	});
	// Use the injected fetch through checkWebQuotes directly with the same receipts.
	const receipts = await readTaskWebReceipts(cwd, "run-2", "task-1");
	const { results, summary } = await checkWebQuotes(
		[
			{
				key: "cap",
				url: "https://captured.example/page",
				quote: "the limit is 48,000 bytes",
				receipts,
			},
			{
				key: "sum-ok",
				url: "https://docs.example.com/a",
				quote: "The cache is invalidated when content is cleared.",
				receipts,
			},
			{
				key: "sum-bad",
				url: "https://docs.example.com/a",
				quote: "It is never refreshed.",
				receipts,
			},
		],
		{ cwd, cache: new EvidencePageCache(cwd), fetch: fakeFetch(calls) },
	);
	const by = Object.fromEntries(results.map((r) => [r.key, r]));
	assert.equal(by.cap.grade, "verified-captured");
	assert.equal(by.cap.capturedBy, "fetch_content");
	assert.equal(by["sum-ok"].grade, "verified-refetched");
	assert.equal(by["sum-ok"].inWorkerSummary, "summary");
	assert.equal(by["sum-bad"].grade, "unverified");
	assert.equal(by["sum-bad"].reason, "quote-not-on-page");
	assert.equal(by["sum-bad"].inWorkerSummary, "summary");
	assert.deepEqual(
		calls,
		["https://docs.example.com/a"],
		"captured URL is not fetched",
	);
	assert.deepEqual(summary.inWorkerSummary, {
		total: 2,
		onPage: 1,
		notOnPage: 1,
		unchecked: 0,
	});
	assert.equal(summary.verifiedCaptured, 1);
	assert.equal(summary.verifiedRefetched, 1);
	assert.equal(typeof checker.checkWebQuotes, "function");
});

test("a cache write or PDF temp-file failure affects only that page (quality A/B 2026-11-02)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "aw-evidence-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Every write fails (disk full, permissions): the check still uses the fetched pages.
	class BrokenCache extends EvidencePageCache {
		async put() {
			throw Object.assign(new Error("ENOSPC: no space left on device"), {
				code: "ENOSPC",
			});
		}
	}
	const { results, summary } = await checkWebQuotes(
		[
			{
				key: "html",
				url: "https://docs.example.com/a",
				quote: "The cache is invalidated when content is cleared.",
			},
			{
				key: "md",
				url: "https://docs.example.com/md",
				quote: "persists across sessions, subtly altering",
			},
		],
		{
			cwd: dir,
			cache: new BrokenCache(join(dir, "cache")),
			fetch: fakeFetch([]),
		},
	);
	assert.deepEqual(
		results.map((result) => result.grade),
		["verified-refetched", "verified-refetched"],
	);
	assert.match(results[0].page.bodySha256, /^[0-9a-f]{64}$/);
	assert.equal(summary.verified, 2);

	// No usable temp directory: the PDF gets a reason instead of an exception.
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = join(dir, "missing", "tmp");
	t.after(() => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	});
	const pdf = await pdfToText(Buffer.from("%PDF-1.4\n"), {
		command: "/bin/echo",
	});
	assert.equal(pdf.ok, false);
	assert.equal(pdf.reason, "pdf-extract-failed");
	assert.match(pdf.detail, /temporary file/);
});
