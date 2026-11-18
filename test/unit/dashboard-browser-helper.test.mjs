// test-tier: integration
// 2026-11-09 (round-4 validation): a Chrome that failed during startup surfaced as an uncaught EPIPE from the test
// helper's cleanup, hiding why Chrome failed. The helper now reports the original error with Chrome's stderr tail.
// Round-6 review: a Chrome that closed its DevTools pipe but stays alive fails at once, not after the command
// timeout.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";

test("click hits an offscreen target even when the document uses smooth scrolling", async (t) => {
	const chrome = await findChrome();
	if (!chrome) return t.skip("Chrome is not installed");
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.navigate", {
		url: `data:text/html,${encodeURIComponent('<!doctype html><style>html { scroll-behavior: smooth; } body { margin: 0; } .space { height: 4000px; }</style><div class="space"></div><button onclick="globalThis.clicked = true">Target</button><div class="space"></div>')}`,
	});
	await browser.waitFor(() => !!document.querySelector("button"));
	await browser.click("button");
	assert.equal(
		await browser.evaluate(() => globalThis.clicked === true),
		true,
		"the native click must use the target position after scrolling, not its old offscreen position",
	);
});

const page = (html) =>
	`data:text/html,${encodeURIComponent(`<!doctype html><style>body{margin:0}button,#decoy,#overlay{position:absolute;left:10px;width:100px;height:40px}</style>${html}`)}`;

test("click re-measures when the target moves between measuring and pressing, and the misdirected press has no effect", async (t) => {
	const chrome = await findChrome();
	if (!chrome) return t.skip("Chrome is not installed");
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	// The click guard is installed after the measurement and before the press: move the target then and
	// let a decoy take its place (it ignores the pointer until then, so the measurement sees the target).
	await browser.send("Page.navigate", {
		url: page(`<button id="target" style="top:10px">Target</button>
<div id="decoy" style="top:10px;pointer-events:none">Decoy</div>
<script>
globalThis.clicks = [];
for (const id of ["target", "decoy"]) document.getElementById(id).onclick = () => clicks.push(id);
let moved = false;
Object.defineProperty(window, "__awClickGuard", {
	configurable: true,
	set(value) {
		Object.defineProperty(window, "__awClickGuard", { configurable: true, writable: true, value });
		if (!moved) { moved = true; document.getElementById("target").style.top = "200px"; document.getElementById("decoy").style.pointerEvents = "auto"; }
	},
});
</script>`),
	});
	await browser.waitFor(() => !!document.querySelector("#target"));
	await browser.click("#target");
	assert.deepEqual(
		await browser.evaluate(() => globalThis.clicks),
		["target"],
		"the press that landed on the decoy must be blocked, and the retry must reach the target",
	);
});

test("click on a target permanently covered by an overlay fails clearly and delivers nothing", async (t) => {
	const chrome = await findChrome();
	if (!chrome) return t.skip("Chrome is not installed");
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.navigate", {
		url: page(`<button id="target" style="top:10px">Target</button>
<div id="overlay" style="top:0;height:80px">Overlay</div>
<script>
globalThis.clicks = [];
for (const id of ["target", "overlay"]) document.getElementById(id).onclick = () => clicks.push(id);
</script>`),
	});
	await browser.waitFor(() => !!document.querySelector("#target"));
	await assert.rejects(
		browser.click("#target"),
		/Click target #target was not hit: target covered by <div#overlay>/,
	);
	assert.deepEqual(await browser.evaluate(() => globalThis.clicks), []);
});

test("a Chrome that dies during startup is reported with its exit and stderr", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-fake-chrome-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const previousTimeout = process.env.AW_TEST_CDP_TIMEOUT_MS;
	process.env.AW_TEST_CDP_TIMEOUT_MS = "10000";
	t.after(() => {
		if (previousTimeout === undefined)
			delete process.env.AW_TEST_CDP_TIMEOUT_MS;
		else process.env.AW_TEST_CDP_TIMEOUT_MS = previousTimeout;
	});
	for (const [name, script] of [
		["exits", 'echo "fake chrome: cannot open display" >&2\nexit 3\n'],
		[
			"closes-pipes",
			'exec 3<&- 4>&-\necho "fake chrome: cannot open display" >&2\nsleep 1\nexit 3\n',
		],
		[
			"closes-pipes-stays-alive",
			// Keep the sleeper in Chrome's PID: a shell child would retain stderr after cleanup kills the shell.
			'exec 3<&- 4>&-\necho "fake chrome: cannot open display" >&2\nexec sleep 30\n',
		],
	]) {
		const executable = join(dir, name);
		await writeFile(executable, `#!/bin/sh\n${script}`, { mode: 0o755 });
		const started = Date.now();
		await assert.rejects(createBrowser(executable), (error) => {
			// Which error comes first (the exit, Chrome closing its pipe, or EPIPE on a write) depends on the
			// platform; the message always says Chrome failed, how it ended and what it printed (CI 42647384816).
			assert.match(error.message, /^Chrome failed to start: /, name);
			assert.match(
				error.message,
				/\[Chrome (exit code 3|stopped by SIG[A-Z]+)\]/,
				name,
			);
			assert.match(error.message, /cannot open display/, name);
			return true;
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 5_000, `${name} took ${elapsed} ms`);
	}
});
