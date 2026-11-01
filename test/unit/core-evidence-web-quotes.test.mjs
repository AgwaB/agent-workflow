// agent-workflow 2026-11-01: engine-side web quote check. Each cited page is fetched once (then
// cached by content hash), turned into text views by content type, and each quote is looked up.
// What cannot be checked gets a reason instead of a verdict.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidencePageCache } from "../../dist/core/evidence-page-cache.js";
import { pdfToText, pdfTextViews } from "../../dist/core/evidence-pdf-text.js";
import {
	checkWebQuotes,
	EVIDENCE_REFETCH_ENV,
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

test("support helpers get the check, enabled only by the experimental flag", () => {
	const signal = new AbortController().signal;
	assert.equal(
		supportEvidenceContext("/tmp", signal, {}).refetchEnabled,
		false,
	);
	assert.equal(
		supportEvidenceContext("/tmp", signal, { [EVIDENCE_REFETCH_ENV]: "1" })
			.refetchEnabled,
		true,
	);
	assert.equal(
		typeof supportEvidenceContext("/tmp", signal, {}).checkWebQuotes,
		"function",
	);
});
