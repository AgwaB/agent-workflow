// test-tier: integration
// 2026-11-09 (round-4 validation): a Chrome that failed during startup surfaced as an uncaught EPIPE from the test
// helper's cleanup, hiding why Chrome failed. The helper now reports the original error with Chrome's stderr tail.
// Round-6 review: a Chrome that closed its DevTools pipe but stays alive fails at once, not after the command
// timeout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

test("a Chrome that hangs at startup is relaunched once; two hangs fail with both reasons", async (t) => {
	const chrome = await findChrome();
	if (!chrome) return t.skip("Chrome not found");
	const dir = await mkdtemp(join(tmpdir(), "aw-hung-chrome-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const hung = join(dir, "hung");
	// Keeps the DevTools pipes open and never answers, like the CI Chrome stuck on Runtime.enable.
	await writeFile(hung, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
	const previous = process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS;
	process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS = "1000";
	t.after(() => {
		if (previous === undefined)
			delete process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS;
		else process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS = previous;
	});
	let calls = 0;
	const browser = await createBrowser(chrome, {
		launch: (executable, args, options) => {
			// Only the fake gets the 1 s budget: a real Chrome on a slow CI runner needs longer to answer
			// (CI 44352210538, macOS).
			if (++calls === 2) delete process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS;
			return spawn(calls === 1 ? hung : executable, args, options);
		},
	});
	process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS = "1000";
	t.after(() => browser.close());
	assert.equal(calls, 2);
	assert.equal(await browser.evaluate(() => 1 + 1), 2);
	let attempts = 0;
	await assert.rejects(
		createBrowser(hung, {
			launch: (executable, args, options) => {
				attempts++;
				return spawn(executable, args, options);
			},
		}),
		(error) => {
			assert.match(error.message, /^Chrome failed to start: CDP timeout: /);
			assert.match(
				error.message,
				/first attempt: Chrome failed to start: CDP timeout: /,
			);
			return true;
		},
	);
	assert.equal(attempts, 2);
});

test("the Node process exits after relaunching a Chrome that ignores SIGTERM", {
	skip: process.platform === "win32" && "requires catchable SIGTERM",
}, async () => {
	const helper = new URL("../helpers/dashboard-browser.mjs", import.meta.url);
	const driver = `
		import assert from 'node:assert/strict';
		import { spawn } from 'node:child_process';
		import { once } from 'node:events';
		import { createBrowser } from ${JSON.stringify(helper.href)};

		const hung = spawn(process.execPath, ['-e', \`
			process.on('SIGTERM', () => {});
			setTimeout(() => {}, 30000);
			console.error('ready');
		\`], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
		// Start the short CDP timeout only after the fake is listening for SIGTERM.
		const [ready] = await once(hung.stderr, 'data');
		assert.match(ready.toString(), /ready/);
		process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS = '100';
		let attempts = 0;
		const browser = await createBrowser(process.execPath, {
			launch(executable, _args, options) {
				if (++attempts === 1) return hung;
				process.env.AW_TEST_CHROME_STARTUP_TIMEOUT_MS = '5000';
				return spawn(executable, ['-e', \`
					const { createReadStream, writeSync } = require('node:fs');
					let buffer = '';
					createReadStream(null, { fd: 3, encoding: 'utf8' }).on('data', chunk => {
						const packets = (buffer + chunk).split('\\\\0');
						buffer = packets.pop();
						for (const packet of packets) {
							const { id, method } = JSON.parse(packet);
							writeSync(4, JSON.stringify({ id, result: { targetId: 'target', sessionId: 'session' } }) + '\\\\0');
							if (method === 'Browser.close') process.exit(0);
						}
					});
				\`], options);
			},
		});
		assert.equal(attempts, 2);
		await browser.close();
		console.log('relaunch complete', process.getActiveResourcesInfo());
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	// This group belongs to the test. On a red run, do not leave the fake running.
	const killDriver = () => {
		if (!child.pid || child.exitCode !== null || child.signalCode !== null)
			return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	};
	let deadline = setTimeout(killDriver, 15_000);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
		if (stdout.includes("relaunch complete")) {
			clearTimeout(deadline);
			deadline = setTimeout(killDriver, 2_000);
		}
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	try {
		const [code, signal] = await once(child, "close");
		assert.match(
			stderr,
			/Chrome hung at startup; relaunching once: .*Target.createTarget/,
		);
		assert.match(stdout, /relaunch complete/);
		assert.equal(
			code,
			0,
			`Node did not exit cleanly (${signal}): ${stdout}${stderr}`,
		);
	} finally {
		clearTimeout(deadline);
		killDriver();
	}
});

test("Chrome is launched with the code-sign-clone feature disabled so killed runs leak no clones", async () => {
	let launchedArgs;
	await assert.rejects(
		createBrowser("/nonexistent/chrome", {
			launch: (_executable, args) => {
				launchedArgs = args;
				throw new Error("stop after capturing args");
			},
		}),
		/stop after capturing args/,
	);
	assert.ok(launchedArgs.includes("--disable-features=MacAppCodeSignClone"));
	assert.equal(
		launchedArgs.filter((a) => a.startsWith("--disable-features=")).length,
		1,
	);
});
