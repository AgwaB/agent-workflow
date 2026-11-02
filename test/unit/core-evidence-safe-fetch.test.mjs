// agent-workflow 2026-11-01: the engine's evidence fetch only reaches public addresses (also after
// redirects and at DNS time), refuses credentials and non-http schemes, caps bodies while streaming
// (also after decompression), times out, and asks for Markdown/English first.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
	EVIDENCE_FETCH_ACCEPT_LANGUAGE,
	isBlockedAddress,
	publicOnlyLookup,
	safeFetch,
} from "../../dist/core/evidence-safe-fetch.js";

test("non-public addresses are blocked", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.20.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::",
		"fe80::1",
		"fd00::1",
		"fec0::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"64:ff9b::a00:1",
		"not-an-ip",
	])
		assert.equal(isBlockedAddress(address), true, address);
	for (const address of ["8.8.8.8", "140.82.112.3", "2606:4700::6810:84e5"])
		assert.equal(isBlockedAddress(address), false, address);
});

test("refused before any connection: local names, private literals, credentials, schemes", async () => {
	const cases = [
		["http://localhost/", "blocked-address"],
		["http://foo.localhost/", "blocked-address"],
		["http://127.0.0.1:1/", "blocked-address"],
		["http://[::1]/", "blocked-address"],
		["http://10.0.0.1/", "blocked-address"],
		["http://169.254.169.254/latest/meta-data/", "blocked-address"],
		["https://user:secret@example.com/", "credentials-in-url"],
		["ftp://example.com/file", "unsupported-scheme"],
		["file:///etc/passwd", "unsupported-scheme"],
		["not a url", "invalid-url"],
	];
	for (const [url, reason] of cases) {
		const result = await safeFetch(url, { timeoutMs: 2000 });
		assert.equal(result.ok, false, url);
		assert.equal(result.reason, reason, url);
	}
});

test("DNS answers are checked at connect time", async () => {
	const error = await new Promise((resolve) =>
		publicOnlyLookup()("localhost", {}, (err) => resolve(err)),
	);
	assert.equal(error?.code, "EVIDENCE_BLOCKED_ADDRESS");
});

async function withServer(handler, run) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		return await run(`http://127.0.0.1:${port}`, port);
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
}

const local = { allowHostsForTests: ["127.0.0.1"], timeoutMs: 3000 };

test("fetches, decodes gzip, follows safe redirects and sends Markdown/English preferences", async () => {
	const seen = [];
	await withServer(
		(req, res) => {
			seen.push({ url: req.url, headers: req.headers });
			if (req.url === "/moved") {
				res.writeHead(302, { Location: "/page" });
				return res.end();
			}
			if (req.url === "/page") {
				res.writeHead(200, {
					"Content-Type": "text/markdown; charset=utf-8",
					"Content-Encoding": "gzip",
				});
				return res.end(gzipSync("# Title\n\nHello evidence."));
			}
			res.writeHead(404);
			res.end();
		},
		async (base) => {
			const result = await safeFetch(`${base}/moved#frag`, local);
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.equal(result.body.toString("utf8"), "# Title\n\nHello evidence.");
			assert.equal(result.finalUrl, `${base}/page`);
			assert.deepEqual(result.redirects, [`${base}/page`]);
			assert.match(result.contentType, /text\/markdown/);
			const missing = await safeFetch(`${base}/missing`, local);
			assert.equal(missing.reason, "http-error");
			assert.equal(missing.status, 404);
		},
	);
	assert.match(seen[0].headers.accept, /^text\/markdown;q=1\.0/);
	assert.equal(
		seen[0].headers["accept-language"],
		EVIDENCE_FETCH_ACCEPT_LANGUAGE,
	);
	assert.equal(seen[0].url, "/moved", "fragment is not sent");
});

test("a redirect to a local or private address is refused", async () => {
	await withServer(
		(req, res) => {
			const targets = {
				"/to-localhost": `http://localhost:${req.socket.localPort}/x`,
				"/to-metadata": "http://169.254.169.254/latest/meta-data/",
				"/to-ipv6": "http://[::1]/",
				"/loop": "/loop",
			};
			res.writeHead(302, { Location: targets[req.url] ?? "/loop" });
			res.end();
		},
		async (base) => {
			for (const path of ["/to-localhost", "/to-metadata", "/to-ipv6"]) {
				const result = await safeFetch(`${base}${path}`, local);
				assert.equal(result.reason, "blocked-address", path);
			}
			const loop = await safeFetch(`${base}/loop`, {
				...local,
				maxRedirects: 3,
			});
			assert.equal(loop.reason, "too-many-redirects");
		},
	);
});

test("bodies are capped (declared, streamed, decompressed); PDFs get a larger cap", async () => {
	await withServer(
		(req, res) => {
			if (req.url === "/declared") {
				res.writeHead(200, {
					"Content-Type": "text/html",
					"Content-Length": 5000,
				});
				return res.end("x".repeat(5000));
			}
			if (req.url === "/streamed") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.write("x".repeat(800));
				return res.end("x".repeat(800));
			}
			if (req.url === "/bomb") {
				res.writeHead(200, {
					"Content-Type": "text/plain",
					"Content-Encoding": "gzip",
				});
				return res.end(gzipSync(Buffer.alloc(200_000)));
			}
			res.writeHead(200, { "Content-Type": "application/pdf" });
			res.end(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000)]));
		},
		async (base) => {
			const options = { ...local, maxBytes: 1000, maxPdfBytes: 3000 };
			for (const path of ["/declared", "/streamed", "/bomb"]) {
				const result = await safeFetch(`${base}${path}`, options);
				assert.equal(result.reason, "too-large", path);
			}
			const pdf = await safeFetch(`${base}/paper.pdf`, options);
			assert.equal(pdf.ok, true);
			assert.equal(pdf.body.length, 2009);
		},
	);
});

test("a slow server times out", async () => {
	await withServer(
		(_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.write("<p>never ends");
		},
		async (base) => {
			const result = await safeFetch(`${base}/slow`, {
				...local,
				timeoutMs: 300,
			});
			assert.equal(result.ok, false);
			assert.equal(result.reason, "timeout");
		},
	);
});

test("a compressed body cut off mid-stream or by the timeout settles (quality A/B 2026-11-02)", async () => {
	// With `pipe`, the source's early close never reached the gunzip stream and safeFetch never
	// settled, even past its timeout.
	const body = gzipSync(Buffer.alloc(200_000, "a"));
	// Fail instead of hanging when the fetch never settles.
	const settled = (promise) =>
		Promise.race([
			promise,
			new Promise((resolve) =>
				setTimeout(() => resolve({ reason: "never settled" }), 4_000),
			),
		]);
	await withServer(
		(req, res) => {
			res.writeHead(200, {
				"Content-Type": "text/html",
				"Content-Encoding": "gzip",
			});
			res.write(body.subarray(0, 100));
			if (req.url === "/reset") setTimeout(() => res.socket.destroy(), 50);
		},
		async (base) => {
			const reset = await settled(
				safeFetch(`${base}/reset`, { ...local, timeoutMs: 5_000 }),
			);
			assert.equal(reset.ok, false);
			assert.equal(reset.reason, "network-error");
			const stalled = await settled(
				safeFetch(`${base}/stall`, { ...local, timeoutMs: 300 }),
			);
			assert.equal(stalled.ok, false);
			assert.equal(stalled.reason, "timeout");
		},
	);
});
