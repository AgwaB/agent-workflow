import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { providerRetryAfterMs } from "../../dist/core/provider-retry.js";
import {
	recordSharedModelRateLimitBackoffForTests,
	removePersistedSharedModelRateLimitBackoffsForTests,
	setExecutorAuthKindProbe,
	sharedModelRateLimitBackoffs,
	transientModelRateLimitBackoffMs,
} from "../../dist/core/retry-policy.js";

const NOW = Date.parse("2026-11-06T03:48:00Z");
for (const [hint, expected] of [
	["Retry-After: 30", 30_000],
	["Try again in 379ms.", 379],
	["Try again in 1.5 seconds.", 1500],
	["Try again in 2 minutes.", 120_000],
	["Try again in 5 hours.", 18_000_000],
	["Try again in 2h30m10s.", 9_010_000],
	["Try again in 1 day, 2 hours and 30 minutes.", 95_400_000],
	["Retry-After: Fri, 06 Nov 2026 06:30:00 GMT", 9_720_000],
	["resets_at: 2026-11-06T06:30:00Z", 9_720_000],
	["resets_at: 2026-11-06T15:30:00+09:00", 9_720_000],
	[`"resets_at": ${Date.parse("2026-11-06T06:30:00Z") / 1000}`, 9_720_000],
	["You've hit your limit · resets 3:30pm (Asia/Seoul)", 9_720_000],
	["resets 15:30 (Asia/Seoul)", 9_720_000],
	["resets 12am (Asia/Seoul)", 40_320_000],
	["Retry-After: 1 | resets 3:30pm (Asia/Seoul)", 9_720_000],
	["Try again in 0 seconds.", undefined],
	["Retry-After: -1", undefined],
	["Retry-After: Infinity", undefined],
	["Try again in 3 months.", undefined],
	["Retry-After: Wed, 21 Oct 2015 07:28:00 GMT", undefined],
	["resets 13:30pm (Asia/Seoul)", undefined],
	["resets 3:61pm (Asia/Seoul)", undefined],
	["resets 3:30pm (No/Such_Zone)", undefined],
	["No reset time provided", undefined],
])
	test(`provider wait: ${hint}`, () => {
		assert.equal(providerRetryAfterMs(hint, NOW), expected);
	});

test("clock hints handle DST overlap conservatively and do not invent a nonexistent clock", () => {
	assert.equal(
		providerRetryAfterMs(
			"resets 1:30am (America/New_York)",
			Date.parse("2026-11-01T04:00:00Z"),
		),
		9_000_000,
	);
	assert.equal(
		providerRetryAfterMs(
			"resets 2:30am (America/New_York)",
			Date.parse("2026-03-08T05:00:00Z"),
		),
		undefined,
	);
});

test("a clock without an explicit zone uses the producing process timezone", () => {
	const before = process.env.TZ;
	try {
		process.env.TZ = "Asia/Seoul";
		assert.equal(providerRetryAfterMs("resets 3:30pm", NOW), 9_720_000);
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
});

test("classified rate limits read all error surfaces and never cap explicit waits", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: NOW });
	setExecutorAuthKindProbe(() => "api-key");
	try {
		const base = {
			attempt: 1,
			modelBackoffKey: "anthropic",
			stderrText: "",
			failureKind: "rate_limit",
		};
		assert.equal(transientModelRateLimitBackoffMs(base), 60_000);
		assert.equal(
			transientModelRateLimitBackoffMs({
				...base,
				errorMessage: "Rate limit reached. Retry-After: 30",
				snapshotMetadata: {
					errorMessage: "You've hit your limit · resets 3:30pm (Asia/Seoul)",
				},
			}),
			9_720_000,
		);
		assert.equal(
			transientModelRateLimitBackoffMs({
				...base,
				subagentResult: {
					metadata: { streamErrors: ["Try again in 5 hours."] },
				},
			}),
			18_000_000,
		);
		assert.equal(
			transientModelRateLimitBackoffMs({
				...base,
				failureKind: "permanent",
				errorMessage: "resets 3:30pm (Asia/Seoul)",
			}),
			undefined,
			"a clock alone must not turn an unrelated failure into a retry",
		);
	} finally {
		setExecutorAuthKindProbe(undefined);
	}
});

test("a multi-hour provider reset survives a fresh process", async () => {
	const duration = 5 * 60 * 60_000;
	try {
		await recordSharedModelRateLimitBackoffForTests(
			"reset-test/model",
			duration,
		);
		const url = new URL("../../dist/core/retry-policy.js", import.meta.url)
			.href;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const m=await import(${JSON.stringify(url)}); console.log(JSON.stringify(await m.sharedModelRateLimitBackoffRemaining("reset-test")));`,
			],
			{ encoding: "utf8", timeout: 10_000 },
		);
		assert.equal(child.status, 0, child.stderr);
		const persisted = JSON.parse(child.stdout);
		assert.ok(persisted.remainingMs > duration - 10_000);
		assert.ok(persisted.remainingMs <= duration);
	} finally {
		sharedModelRateLimitBackoffs.clear();
		removePersistedSharedModelRateLimitBackoffsForTests();
	}
});
