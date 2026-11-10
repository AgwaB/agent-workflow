// Dependency-free Chrome DevTools pipe, adapted from the approved mockup helper.
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 2026-11-05 (owner: real-time animation checks are not deterministic): checks of animation timing
 * (entrance replay, morph, handoff packets, the motion family) run only with
 * AGENT_WORKFLOW_UI_MOTION=1 (`npm run test:ui-motion`), not in `npm run validate` or CI. Run them when
 * changing dashboard motion.
 */
export const motionChecks = process.env.AGENT_WORKFLOW_UI_MOTION === "1";
export const MOTION_SKIP =
	"animation timing check; run with npm run test:ui-motion (AGENT_WORKFLOW_UI_MOTION=1)";

export async function findChrome() {
	const candidates = [
		process.env.CHROME,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	for (const candidate of candidates.filter(Boolean)) {
		try {
			await access(candidate);
			return candidate;
		} catch {}
	}
	return null;
}
export async function createBrowser(executable) {
	const profile = await mkdtemp(join(tmpdir(), "aw-dashboard-browser-"));
	const chrome = spawn(
		executable,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			// The unit runner isolates HOME; without these, a fresh-profile Chrome on macOS can block on
			// the login keychain ("Chrome Safe Storage") and never answer the first navigation.
			"--use-mock-keychain",
			"--password-store=basic",
			"--disable-extensions",
			"--disable-crash-reporter",
			"--disable-breakpad",
			"--metrics-recording-only",
			"--hide-scrollbars",
			"--remote-debugging-pipe",
			`--user-data-dir=${profile}`,
			...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
	);
	// 2026-11-09 (round-4 validation): a Chrome that ended its pipe during startup surfaced only as an uncaught
	// EPIPE from cleanup. Keep its stderr tail and exit, and never let a pipe error escape.
	let stderrTail = "";
	let exitError;
	// Set once Chrome has exited and its stdio (stderr included) is drained.
	let closed = false;
	const whenClosed = new Promise((resolve) =>
		chrome.once("close", () => {
			closed = true;
			resolve();
		}),
	);
	chrome.stderr.on("data", (chunk) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-4000);
	});
	// Round-6 review: a command-pipe error, or Chrome closing its response pipe, fails pending commands at once
	// instead of after their 60 s timeout.
	const failPending = (error) => {
		exitError ??= error;
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(exitError);
		}
		pending.clear();
	};
	chrome.stdio[3].on("error", failPending);
	chrome.stdio[4].on("close", () =>
		failPending(new Error("Chrome closed its DevTools pipe")),
	);
	let sequence = 0,
		buffer = "",
		session,
		startupError;
	const pending = new Map(),
		errors = [],
		requests = [],
		responses = [];
	chrome.on("error", (error) => {
		startupError = error;
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		pending.clear();
	});
	// 2026-11-06: a Chrome that dies mid-test fails its pending commands at once instead of after the
	// 60 s command bound each (two such waits exceeded the 120 s test timeout and hid the cause).
	chrome.on("exit", (code, signal) => {
		const error = new Error(`Chrome exited (code ${code}, signal ${signal})`);
		exitError ??= error;
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		pending.clear();
	});
	chrome.stdio[4].on("data", (chunk) => {
		buffer += chunk.toString();
		let at;
		while ((at = buffer.indexOf("\0")) >= 0) {
			const packet = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (!packet) continue;
			const event = JSON.parse(packet);
			if (event.id && pending.has(event.id)) {
				const p = pending.get(event.id);
				pending.delete(event.id);
				clearTimeout(p.timer);
				if (event.error) p.reject(new Error(JSON.stringify(event.error)));
				else p.resolve(event.result);
			}
			if (event.method === "Runtime.exceptionThrown")
				errors.push(event.params.exceptionDetails);
			if (
				event.method === "Runtime.consoleAPICalled" &&
				event.params.type === "error"
			)
				errors.push(event.params);
			if (
				event.method === "Log.entryAdded" &&
				event.params.entry.level === "error"
			)
				errors.push(event.params.entry);
			if (
				event.method === "Network.requestWillBeSent" &&
				/^https?:/.test(event.params.request.url)
			)
				requests.push(event.params.request.url);
			if (event.method === "Network.responseReceived")
				responses.push(event.params.response);
		}
	});
	// Chrome under the parallel unit suite can take well over 15 s for its first navigation; the
	// per-command bound is generous so contention becomes slowness, not a flaky failure.
	const CDP_TIMEOUT_MS = Number(process.env.AW_TEST_CDP_TIMEOUT_MS) || 60_000;
	const send = (
		method,
		params = {},
		target = session,
		timeoutMs = CDP_TIMEOUT_MS,
	) =>
		new Promise((resolve, reject) => {
			if (startupError) return reject(startupError);
			if (
				exitError ||
				chrome.stdio[3].destroyed ||
				chrome.stdio[3].writableEnded
			)
				return reject(exitError ?? new Error("Chrome closed its command pipe"));
			const id = ++sequence;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			chrome.stdio[3].write(
				`${JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) })}\0`,
			);
		});
	const evaluate = async (fn, ...args) => {
		const expression =
			typeof fn === "function"
				? `(${fn.toString()})(...${JSON.stringify(args)})`
				: fn;
		const result = await send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails)
			throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	};
	// 2026-11-06 (CI ubuntu/Node 26): a poll that overlaps a navigation the page makes itself (deep link,
	// launch redirect) fails with "Inspected target navigated or closed". Only these transient
	// navigation errors mean "not yet"; any other error still fails the test.
	const NAVIGATION_ERRORS = [
		"Inspected target navigated or closed",
		"Execution context was destroyed",
		"Cannot find context with specified id",
	];
	const isNavigationError = (error) =>
		NAVIGATION_ERRORS.some((text) => String(error?.message).includes(text));
	const waitFor = async (fn, timeout = 20_000) => {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			try {
				if (await evaluate(fn)) return;
			} catch (error) {
				if (!isNavigationError(error)) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`Browser condition timed out: ${fn}`);
	};
	// The dashboard follows the system theme (2026-11-01) and headless Chrome reports light. Tests
	// see the dark palette unless they emulate a colour scheme themselves. 2026-11-05 (first CI run:
	// the macOS runner reports reduced motion, so every animation check failed there): motion is
	// fixed to no-preference the same way, unless a test emulates reduced motion itself.
	let mediaEmulated = false;
	const DEFAULT_MEDIA = [
		{ name: "prefers-color-scheme", value: "dark" },
		{ name: "prefers-reduced-motion", value: "no-preference" },
	];
	const sendWithScheme = (method, params, target) => {
		if (method !== "Emulation.setEmulatedMedia")
			return send(method, params, target);
		mediaEmulated = true;
		const features = params?.features ?? [];
		const missing = DEFAULT_MEDIA.filter(
			(feature) => !features.some((own) => own.name === feature.name),
		);
		return send(
			method,
			missing.length
				? { ...params, features: [...features, ...missing] }
				: params,
			target,
		);
	};
	const open = async (url, width = 1440, height = 900) => {
		// Only the first time: a test's own emulation (reduced motion, a scheme) is kept.
		if (!mediaEmulated)
			await sendWithScheme("Emulation.setEmulatedMedia", { features: [] });
		await send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await send("Page.navigate", { url });
		await waitFor(
			() =>
				document.readyState === "complete" &&
				!!document.querySelector("#task-count"),
		);
	};
	// Two frames, then any layout transition (a panel opening or closing moves what is clicked)
	// runs out — at most a second; endless status animations are not transitions.
	const settle = () =>
		evaluate(
			() =>
				new Promise((resolve) => {
					const started = performance.now();
					const check = () =>
						document
							.getAnimations()
							.some(
								(animation) =>
									animation instanceof CSSTransition &&
									animation.playState === "running",
							) && performance.now() - started < 1000
							? requestAnimationFrame(check)
							: resolve(true);
					requestAnimationFrame(() => requestAnimationFrame(check));
				}),
		);
	const click = async (selector) => {
		await settle();
		const box = await evaluate((selector) => {
			const node = document.querySelector(selector);
			if (!node) return null;
			node.scrollIntoView({ block: "nearest", inline: "nearest" });
			const r = node.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		}, selector);
		if (!box) throw new Error(`Missing click target: ${selector}`);
		await send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			...box,
			button: "left",
			clickCount: 1,
		});
		await send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			...box,
			button: "left",
			clickCount: 1,
		});
		// A plain link (the dashboard's view navigation) reloads the page while settle() polls;
		// then wait for the new document instead (2026-11-06, CI ubuntu/Node 26).
		try {
			await settle();
		} catch (error) {
			if (!isNavigationError(error)) throw error;
			await waitFor(() => document.readyState === "complete");
		}
	};
	const key = async (key, modifiers = 0) => {
		const windowsVirtualKeyCode =
			{ Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38 }[key] ||
			key.toUpperCase().charCodeAt(0);
		await send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key,
			modifiers,
			windowsVirtualKeyCode,
		});
		await send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key,
			modifiers,
			windowsVirtualKeyCode,
		});
		await settle();
	};
	const close = async () => {
		try {
			// Bounded: an unresponsive Chrome is killed below rather than awaited for 60 s.
			await send("Browser.close", {}, null, 3000);
		} catch {}
		// Its DevTools pipe already gone, Chrome cannot answer Browser.close. 2026-11-10 (CI 42762043887, ubuntu): a
		// Chrome that closes its pipe and then prints why it failed lost that line to an immediate kill; it gets a
		// moment to end on its own (and drain its stderr) before it is stopped.
		if (chrome.exitCode === null && chrome.signalCode === null && exitError) {
			await Promise.race([
				whenClosed,
				new Promise((resolve) => setTimeout(resolve, 1000).unref()),
			]);
			if (!closed) chrome.kill();
		}
		if (!closed && !startupError)
			await Promise.race([
				whenClosed,
				new Promise((resolve) =>
					setTimeout(() => {
						chrome.kill();
						resolve();
					}, 3000).unref(),
				),
			]);
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("Browser closed"));
		}
		pending.clear();
		await rm(profile, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	};
	try {
		const { targetId } = await send(
			"Target.createTarget",
			{ url: "about:blank" },
			null,
		);
		({ sessionId: session } = await send(
			"Target.attachToTarget",
			{ targetId, flatten: true },
			null,
		));
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Network.enable");
		await send("Log.enable");
	} catch (error) {
		await close().catch(() => undefined);
		// How Chrome ended, known after cleanup: the first error may be the pipe (EPIPE on Linux) rather than
		// the exit (CI 42647384816).
		const ended =
			chrome.exitCode !== null
				? ` [Chrome exit code ${chrome.exitCode}]`
				: chrome.signalCode !== null
					? ` [Chrome stopped by ${chrome.signalCode}]`
					: "";
		throw new Error(
			`Chrome failed to start: ${error.message}${ended}${stderrTail.trim() ? `\nChrome stderr (tail):\n${stderrTail.trim()}` : ""}`,
			{ cause: error },
		);
	}
	// 2026-11-05 (CI: a fixed 450 ms after a 0.28 s transition read the rail mid-way on a slower
	// macOS runner): wait until every finite animation and transition has run out (two frames
	// later), instead of sleeping for its nominal duration. Infinite decorative loops are ignored.
	const waitForMotionEnd = (timeout) =>
		waitFor(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() =>
							resolve(
								document
									.getAnimations()
									.every(
										(animation) =>
											animation.playState !== "running" ||
											animation.effect?.getTiming().iterations === Infinity,
									),
							),
						),
					),
				),
			timeout,
		);
	return {
		send: sendWithScheme,
		evaluate,
		waitFor,
		waitForMotionEnd,
		open,
		click,
		key,
		close,
		errors,
		requests,
		responses,
	};
}
