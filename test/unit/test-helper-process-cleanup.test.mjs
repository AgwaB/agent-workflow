// 2026-10-31: test cleanup must never signal a pid that no longer belongs to the process the test
// started (macOS reuses pids; a stale group kill took down another test's durable worker, whose run
// then ended `blocked`). process.kill is observed, so "not signalled" is checked directly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import {
	killLiveChild,
	killTrackedProcess,
	trackProcess,
} from "../helpers/process-cleanup.mjs";

const supported = process.platform === "darwin" || process.platform === "linux";

function observeKills(t) {
	const original = process.kill;
	const signals = [];
	process.kill = (pid, signal) => {
		if (signal !== 0 && signal !== undefined) signals.push([pid, signal]);
		return original.call(process, pid, signal);
	};
	t.after(() => {
		process.kill = original;
	});
	return signals;
}

const exited = (child) =>
	child.exitCode !== null || child.signalCode !== null
		? Promise.resolve()
		: new Promise((done) => child.once("exit", done));

test("a tracked process that is still the same process is killed (its group with group)", {
	skip: supported ? false : "process identity needs darwin or linux",
}, async (t) => {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	trackProcess(child.pid);
	await new Promise((done) => setTimeout(done, 100));
	const signals = observeKills(t);
	await killTrackedProcess(child.pid, { group: true });
	await exited(child);
	assert.deepEqual(signals, [[-child.pid, "SIGKILL"]]);
});

test("a tracked process that exited is never signalled (its pid may be another process now)", {
	skip: supported ? false : "process identity needs darwin or linux",
}, async (t) => {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	trackProcess(child.pid);
	await new Promise((done) => setTimeout(done, 100));
	child.kill("SIGKILL");
	await exited(child);
	const signals = observeKills(t);
	await killTrackedProcess(child.pid, { group: true });
	killLiveChild(child, { group: true });
	assert.deepEqual(signals, []);
});

test("killLiveChild signals a child Node has not seen exit, and nothing else", async (t) => {
	const signals = observeKills(t);
	killLiveChild(undefined);
	killLiveChild({ pid: undefined, exitCode: null, signalCode: null });
	assert.deepEqual(signals, []);
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	killLiveChild(child);
	await exited(child);
	assert.deepEqual(signals, [[child.pid, "SIGKILL"]]);
});
