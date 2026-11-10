import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
// This alias is an in-memory CDP client: launch below never starts Chrome (unit-tier guard stays enabled).
import { createBrowser as createPipeClient } from "../helpers/dashboard-browser.mjs";
import { waitForSavedProfile } from "../helpers/dashboard-profile-wait.mjs";

async function scriptedBrowser(t, evaluate, nextPoll) {
	const calls = [];
	const chrome = new EventEmitter();
	chrome.exitCode = null;
	chrome.signalCode = null;
	chrome.stderr = new PassThrough();
	const output = new PassThrough();
	const input = new Writable({
		write(chunk, _encoding, done) {
			const { id, method, params } = JSON.parse(chunk.toString().slice(0, -1));
			calls.push({ method, params });
			queueMicrotask(() => {
				let reply = { result: {} };
				if (method === "Target.createTarget")
					reply.result = { targetId: "target" };
				if (method === "Target.attachToTarget")
					reply.result = { sessionId: "session" };
				if (method === "Runtime.evaluate") reply = evaluate(params.expression);
				output.write(`${JSON.stringify({ id, ...reply })}\0`);
				if (method === "Browser.close") {
					chrome.exitCode = 0;
					chrome.emit("exit", 0, null);
					chrome.emit("close", 0, null);
				}
			});
			done();
		},
	});
	chrome.stdio = [null, null, chrome.stderr, input, output];
	const browser = await createPipeClient("in-memory-cdp", {
		launch: () => chrome,
		nextPoll,
	});
	t.after(() => browser.close());
	return { browser, calls };
}

const value = (value) => ({ result: { result: { value } } });
const failure = (message) => ({ error: { code: -32000, message } });

for (const message of [
	"Inspected target navigated or closed",
	"Execution context was destroyed",
	"Cannot find context with specified id",
]) {
	test(`waitFor retries ${message} before reading the next document`, async (t) => {
		const paused = Promise.withResolvers();
		const release = Promise.withResolvers();
		t.after(() => release.resolve());
		let evaluations = 0;
		const { browser } = await scriptedBrowser(
			t,
			() => (++evaluations === 1 ? failure(message) : value("next document")),
			() => {
				paused.resolve();
				return release.promise;
			},
		);
		const waiting = browser.waitFor(() => document.readyState === "complete");
		try {
			await Promise.race([paused.promise, waiting]);
			assert.equal(evaluations, 1, "retry is held before the next document");
			release.resolve();
			await waiting;
			assert.equal(evaluations, 2);
		} finally {
			release.resolve();
			await waiting.catch(() => {});
		}
	});
}

test("click recovers from a navigation during settle and waits for the next document", async (t) => {
	const paused = Promise.withResolvers();
	const release = Promise.withResolvers();
	t.after(() => release.resolve());
	const expressions = [];
	const replies = [
		value(true),
		value({ x: 10, y: 20 }),
		failure("Inspected target navigated or closed"),
		failure("Cannot find context with specified id"),
		value(true),
	];
	const { browser, calls } = await scriptedBrowser(
		t,
		(expression) => {
			expressions.push(expression);
			return replies.shift();
		},
		() => {
			paused.resolve();
			return release.promise;
		},
	);
	const clicking = browser.click("a.next-view");
	try {
		await Promise.race([paused.promise, clicking]);
		assert.equal(expressions.length, 4);
		assert.match(expressions[2], /getAnimations/);
		assert.match(expressions[3], /document.readyState/);
		assert.deepEqual(
			calls
				.filter(({ method }) => method === "Input.dispatchMouseEvent")
				.map(({ params }) => params.type),
			["mousePressed", "mouseReleased"],
		);
		release.resolve();
		await clicking;
		assert.equal(replies.length, 0);
		assert.match(expressions[4], /document.readyState/);
	} finally {
		release.resolve();
		await clicking.catch(() => {});
	}
});

for (const action of ["waitFor", "click"]) {
	test(`${action} does not hide non-navigation CDP errors`, async (t) => {
		let evaluations = 0;
		const { browser } = await scriptedBrowser(
			t,
			() => {
				evaluations++;
				if (action === "click" && evaluations < 3)
					return value(evaluations === 1 ? true : { x: 10, y: 20 });
				return failure("Unexpected evaluation failure");
			},
			() => assert.fail("non-navigation errors must not poll"),
		);
		await assert.rejects(
			action === "click"
				? browser.click("a.next-view")
				: browser.waitFor(() => true),
			/Unexpected evaluation failure/,
		);
		assert.equal(evaluations, action === "click" ? 3 : 1);
	});
}

test("profile save verification waits past the permanent heading for the save result", async (t) => {
	const paused = Promise.withResolvers();
	const release = Promise.withResolvers();
	t.after(() => release.resolve());
	let textContent = "Saved profiles";
	let evaluations = 0;
	const { browser } = await scriptedBrowser(
		t,
		(expression) => {
			evaluations++;
			return value(
				runInNewContext(expression, {
					document: {
						querySelector: (selector) => {
							assert.equal(selector, "#center");
							return { textContent };
						},
					},
				}),
			);
		},
		() => {
			paused.resolve();
			return release.promise;
		},
	);
	let verified = false;
	const saving = waitForSavedProfile(browser).then(() => {
		verified = true;
	});
	try {
		await Promise.race([paused.promise, saving]);
		assert.equal(verified, false, "the heading cannot acknowledge a save");
		assert.equal(evaluations, 1);
		textContent = "Saved profiles\nSaved profile: codex";
		release.resolve();
		await saving;
		assert.equal(verified, true);
		assert.equal(evaluations, 2);
	} finally {
		release.resolve();
		await saving.catch(() => {});
	}
});
