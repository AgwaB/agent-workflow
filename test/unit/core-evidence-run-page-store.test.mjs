// agent-workflow 2026-11-08 (context-quality X2): the web quote check used a shared, 24 h, evictable cache, so a research
// run could not be re-checked against what the engine read. The page bodies the check used are now kept per run,
// named by SHA-256 (write-once), and a recorded check can be repeated from them without the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidencePageCache } from "../../dist/core/evidence-page-cache.js";
import {
	checkWebQuotes,
	recheckWebQuotesFromStore,
	readStoredPageBody,
	runPageStoreDir,
} from "../../dist/core/evidence-web-quotes.js";

const filler = `<p>${"Background text that is not quoted. ".repeat(40)}</p>`;
const PAGES = {
	"https://docs.example.com/a": `<html><body>${filler}<p>The cache is invalidated when content is cleared.</p></body></html>`,
	"https://docs.example.com/b": `<html><body>${filler}<p>Published: May 2023</p></body></html>`,
};
const fetchOnce = (calls) => async (url) => {
	calls.push(url);
	const body = PAGES[url];
	return body === undefined
		? { ok: false, url, reason: "dns-failed", detail: "ENOTFOUND" }
		: {
				ok: true,
				url,
				finalUrl: url,
				status: 200,
				contentType: "text/html",
				body: Buffer.from(body),
				redirects: [],
			};
};
const ROWS = [
	{
		key: "c1#0",
		url: "https://docs.example.com/a",
		quote: "The cache is invalidated when content is cleared.",
	},
	{
		key: "c2#0",
		url: "https://docs.example.com/b",
		quote: "Published: May 2023",
	},
	{
		key: "c3#0",
		url: "https://docs.example.com/b",
		quote: "Published: May 2022",
	},
	{ key: "c4#0", url: "https://gone.example.com/", quote: "anything" },
];

test("the check keeps each page body once, by SHA-256, and a recorded check repeats offline", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "aw-page-store-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = join(root, "pages");
	const calls = [];
	const first = await checkWebQuotes(ROWS, {
		cwd: root,
		cache: new EvidencePageCache(join(root, "cache")),
		fetch: fetchOnce(calls),
		pageStoreDir: store,
	});
	const grades = (result) =>
		result.results.map((row) => [row.key, row.grade, row.reason ?? null]);
	assert.deepEqual(grades(first), [
		["c1#0", "verified-refetched", null],
		["c2#0", "verified-refetched", null],
		["c3#0", "unverified", "quote-not-on-page"],
		["c4#0", "unverified", "dns-failed"],
	]);
	const hash = (text) => createHash("sha256").update(text).digest("hex");
	assert.deepEqual(
		readdirSync(store).sort(),
		[
			hash(PAGES["https://docs.example.com/a"]),
			hash(PAGES["https://docs.example.com/b"]),
		].sort(),
	);
	for (const name of readdirSync(store))
		assert.equal(statSync(join(store, name)).mode & 0o777, 0o600);
	const pages = first.results.filter((row) => row.page);
	assert.ok(pages.every((row) => row.page.stored === true));

	// Repeat from the store: same grades, no network.
	const again = await recheckWebQuotesFromStore(ROWS, pages, {
		cwd: root,
		pageStoreDir: store,
	});
	assert.deepEqual(grades(again), [
		["c1#0", "verified-refetched", null],
		["c2#0", "verified-refetched", null],
		["c3#0", "unverified", "quote-not-on-page"],
		["c4#0", "unverified", "not-stored"],
	]);

	// A body that no longer hashes to its name is never served.
	const tampered = hash(PAGES["https://docs.example.com/a"]);
	writeFileSync(join(store, tampered), "<html><body>altered</body></html>");
	assert.equal(await readStoredPageBody(store, tampered), undefined);
	const afterTamper = await recheckWebQuotesFromStore(ROWS, pages, {
		cwd: root,
		pageStoreDir: store,
	});
	assert.deepEqual(afterTamper.results[0].grade, "unverified");
	assert.equal(afterTamper.results[0].reason, "not-stored");
	assert.equal(await readStoredPageBody(store, "../../etc/passwd"), undefined);
});

test("the run's page store lives under the run directory", () => {
	assert.match(
		runPageStoreDir("/tmp/project", "workflow_abc_123"),
		/workflows\/workflow_abc_123\/evidence\/pages$/,
	);
});
