// Dependency-free Chrome DevTools pipe, adapted from the approved mockup helper.
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
			"--hide-scrollbars",
			"--remote-debugging-pipe",
			`--user-data-dir=${profile}`,
			...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
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
	const send = (method, params = {}, target = session) =>
		new Promise((resolve, reject) => {
			if (startupError) return reject(startupError);
			const id = ++sequence;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, 15000);
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
	const waitFor = async (fn, timeout = 5000) => {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			if (await evaluate(fn)) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`Browser condition timed out: ${fn}`);
	};
	const open = async (url, width = 1440, height = 900) => {
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
	const settle = () =>
		evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => resolve(true)),
					),
				),
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
		await settle();
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
			await send("Browser.close", {}, null);
		} catch {}
		if (chrome.exitCode === null && !startupError)
			await new Promise((resolve) => {
				chrome.once("exit", resolve);
				setTimeout(() => {
					chrome.kill();
					resolve();
				}, 3000).unref();
			});
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("Browser closed"));
		}
		pending.clear();
		await rm(profile, { recursive: true, force: true });
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
		await close();
		throw error;
	}
	return {
		send,
		evaluate,
		waitFor,
		open,
		click,
		key,
		close,
		errors,
		requests,
		responses,
	};
}
