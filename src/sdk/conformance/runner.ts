/**
 * Conformance runner: `runConformance` (JSON report) and `registerConformanceTests` (one test per
 * check in any `node:test`-compatible runner).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTOR_CONTRACT_VERSION } from "../contract.js";
import { isJsonValue } from "../json.js";
import { CONFORMANCE_CATALOG } from "./catalog.js";
import type { ConformanceCheck } from "./checks-core.js";
import {
	CheckContext,
	ConformanceSkip,
	ConformanceTimeout,
	withTimeout,
} from "./context.js";
import {
	type CheckResult,
	CONFORMANCE_KIT_VERSION,
	type ConformanceHarness,
	type ConformanceReport,
	type ConformanceTier,
	type ConformanceTimeouts,
	DEFAULT_CONFORMANCE_TIMEOUTS,
} from "./types.js";

export interface RunConformanceOptions {
	/** Tiers to run. Default: offline only. Checks of other tiers are reported as skipped. */
	readonly tiers?: readonly ConformanceTier[];
	/** Run only checks whose id equals or starts with one of these (e.g. `fencing.`). */
	readonly only?: readonly string[];
	/** Skip checks whose id equals or starts with one of these. */
	readonly exclude?: readonly string[];
	readonly timeouts?: Partial<ConformanceTimeouts>;
	/** Override the catalog (tests, custom suites). */
	readonly catalog?: readonly ConformanceCheck[];
	/** Called after every check (progress output). */
	readonly onResult?: (result: CheckResult) => void;
}

const matches = (id: string, patterns: readonly string[]) =>
	patterns.some((pattern) => id === pattern || id.startsWith(pattern));

function info(check: ConformanceCheck) {
	const { id, tier, area, title, refs, scenarios, pending } = check;
	return pending === undefined
		? { id, tier, area, title, refs, scenarios }
		: { id, tier, area, title, refs, scenarios, pending };
}

function resolveTimeouts(
	overrides: Partial<ConformanceTimeouts> = {},
): ConformanceTimeouts {
	return { ...DEFAULT_CONFORMANCE_TIMEOUTS, ...overrides };
}

/** Run one check. Never throws: errors become `fail`, ConformanceSkip becomes `skip`. */
export async function runConformanceCheck(
	harness: ConformanceHarness,
	check: ConformanceCheck,
	options: {
		readonly tiers?: readonly ConformanceTier[];
		readonly timeouts?: Partial<ConformanceTimeouts>;
		readonly workDir?: string;
	} = {},
): Promise<CheckResult> {
	const tiers = options.tiers ?? ["offline"];
	const started = Date.now();
	const finish = (
		status: CheckResult["status"],
		violations: readonly string[],
		extra: { reason?: string; details?: unknown } = {},
	): CheckResult => {
		const result: CheckResult = {
			...info(check),
			status,
			durationMs: Date.now() - started,
			violations: [...violations],
			...(extra.reason === undefined ? {} : { reason: extra.reason }),
			...(extra.details !== undefined && isJsonValue(extra.details)
				? { details: extra.details }
				: {}),
		};
		return result;
	};
	if (check.pending !== undefined)
		return finish("skip", [], { reason: check.pending });
	if (!tiers.includes(check.tier))
		return finish("skip", [], { reason: `tier ${check.tier} not requested` });
	if (check.tier === "live" && !harness.live)
		return finish("skip", [], { reason: "harness is not live" });
	const timeouts = resolveTimeouts(options.timeouts);
	const ownDir = options.workDir === undefined;
	const workDir =
		options.workDir ?? (await mkdtemp(join(tmpdir(), "aw-conformance-")));
	const ctx = new CheckContext({
		harness,
		timeouts,
		checkId: check.id,
		workDir: join(workDir, check.id),
	});
	try {
		const outcome = await withTimeout(
			check.run(ctx),
			timeouts.checkMs,
			`check ${check.id}`,
		);
		if ("status" in outcome)
			return finish(outcome.status, outcome.violations, {
				...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
				details: outcome.details,
			});
		return finish(
			outcome.violations.length === 0 ? "pass" : "fail",
			outcome.violations,
			{ details: outcome.details },
		);
	} catch (error) {
		if (error instanceof ConformanceSkip)
			return finish("skip", [], { reason: error.message });
		const message =
			error instanceof ConformanceTimeout
				? error.message
				: `check threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
		return finish("fail", [message]);
	} finally {
		await ctx.dispose();
		if (ownDir)
			await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

function selectChecks(options: RunConformanceOptions) {
	const catalog = options.catalog ?? CONFORMANCE_CATALOG;
	return catalog.filter(
		(check) =>
			(options.only === undefined || matches(check.id, options.only)) &&
			(options.exclude === undefined || !matches(check.id, options.exclude)),
	);
}

/** Run the catalog against a harness and return a JSON-serializable report. */
export async function runConformance(
	harness: ConformanceHarness,
	options: RunConformanceOptions = {},
): Promise<ConformanceReport> {
	const tiers = options.tiers ?? ["offline"];
	const startedAt = new Date();
	const workDir = await mkdtemp(join(tmpdir(), "aw-conformance-"));
	const results: CheckResult[] = [];
	let executor: ConformanceReport["executor"] = null;
	try {
		executor = await identify(harness, options.timeouts);
		for (const check of selectChecks(options)) {
			const result = await runConformanceCheck(harness, check, {
				tiers,
				workDir,
				...(options.timeouts === undefined
					? {}
					: { timeouts: options.timeouts }),
			});
			results.push(result);
			options.onResult?.(result);
		}
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
	const count = (status: CheckResult["status"]) =>
		results.filter((result) => result.status === status).length;
	const summary = {
		total: results.length,
		pass: count("pass"),
		fail: count("fail"),
		skip: count("skip"),
	};
	return {
		kitVersion: CONFORMANCE_KIT_VERSION,
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		harness: harness.name,
		executor,
		tiers: [...tiers],
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
		ok: summary.fail === 0,
		summary,
		results,
	};
}

async function identify(
	harness: ConformanceHarness,
	timeouts: Partial<ConformanceTimeouts> | undefined,
): Promise<ConformanceReport["executor"]> {
	const scenario = harness.scenarios[0];
	if (scenario === undefined) return null;
	try {
		const session = await withTimeout(
			harness.open(scenario),
			resolveTimeouts(timeouts).callMs,
			"open",
		);
		try {
			const { id, version, contractVersion } = session.executor;
			return { id, version, contractVersion };
		} finally {
			await session.dispose?.().catch(() => {});
		}
	} catch {
		return null;
	}
}

/** Minimal shape of `node:test`'s TestContext used by `registerConformanceTests`. */
export interface ConformanceTestContext {
	skip(message?: string): void;
}
export type ConformanceTestFn = (
	name: string,
	fn: (t: ConformanceTestContext) => Promise<void>,
) => unknown;

/**
 * Register one test per catalog check. Pass `test` from `node:test` (or a compatible runner):
 *
 * ```js
 * import { test } from "node:test";
 * registerConformanceTests({ test, harness: myHarness });
 * ```
 * Skipped checks call `t.skip(reason)`; failing checks throw with every violation listed.
 */
export function registerConformanceTests(
	options: RunConformanceOptions & {
		readonly test: ConformanceTestFn;
		readonly harness: ConformanceHarness;
		/** Test name prefix. Default: `conformance(<harness name>)`. */
		readonly prefix?: string;
	},
): void {
	const prefix = options.prefix ?? `conformance(${options.harness.name})`;
	for (const check of selectChecks(options)) {
		options.test(`${prefix} ${check.id}: ${check.title}`, async (t) => {
			const result = await runConformanceCheck(options.harness, check, {
				tiers: options.tiers ?? ["offline"],
				...(options.timeouts === undefined
					? {}
					: { timeouts: options.timeouts }),
			});
			options.onResult?.(result);
			if (result.status === "skip") {
				t.skip(result.reason);
				return;
			}
			if (result.status === "fail")
				throw new Error(
					`${check.id} failed:\n${result.violations.map((violation) => `- ${violation}`).join("\n")}`,
				);
		});
	}
}
