// New in agent-workflow (WP16): the host duplicate-launch guard for every launch (attached and
// detached). pi-workflow 0.16.4 (b83cc4f) `duplicateRunGuardNotice` refused an attached launch whose
// spec name and task matched an active run and skipped detached launches, so a model that retried
// `workflow_run`/`aw_run` after a tool timeout started a second detached run. Here a launch has a
// fingerprint (kind, spec path and name, task, typed inputs, executor, profile, permission mode,
// unverified-capability opt-ins, model, effort, cwd); an identical launch while the run it started is
// still non-terminal (running, pending, blocked) and was created within the guard window returns
// that run (`outcome: "existing"`) instead of starting another one. `forceNew` bypasses the guard.
//
// State: one claim file per fingerprint under `<cwd>/.agent-workflow/host-launches/<sha256>.json`
// (outside the run store, so run listings and notices never see it). A launch claims the
// fingerprint exclusively before it starts the run and records the run id afterwards, so two
// concurrent identical launches (a retry racing the first call) also yield one run.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { DUPLICATE_RUN_WINDOW_MS } from "../core/run-estimates.js";
import { readRunRecord, workflowsRoot } from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";

const CLAIM_SCHEMA = "agent-workflow-host-launch-v1";
/** A claim without a run id older than this belongs to a launch that died; it is taken over. */
export const LAUNCH_CLAIM_STALE_MS = 60_000;
/** How long a concurrent identical launch waits for the first one to record its run id. */
const IN_FLIGHT_WAIT_MS = 15_000;
const IN_FLIGHT_POLL_MS = 100;
const ACTIVE_STATUSES = new Set(["running", "pending", "blocked"]);

export interface LaunchFingerprintInput {
	kind: "run" | "dynamic";
	cwd: string;
	specPath: string;
	specName?: string;
	task: string;
	inputs?: Record<string, unknown>;
	executor?: string;
	profile?: string;
	permissionMode?: string;
	allowUnverifiedCapabilities?: string[];
	model?: string;
	effort?: string;
}

interface LaunchClaim {
	schema: typeof CLAIM_SCHEMA;
	fingerprint: string;
	claimedAt: string;
	pid: number;
	runId?: string;
	recordedAt?: string;
}

/** JSON value with sorted object keys. */
type CanonicalJson =
	| string
	| number
	| boolean
	| null
	| CanonicalJson[]
	| { [key: string]: CanonicalJson };

/** Canonical JSON (sorted object keys) so equal inputs hash equally. */
function canonical(value: unknown): CanonicalJson {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const out: { [key: string]: CanonicalJson } = {};
		for (const key of Object.keys(record).sort())
			if (record[key] !== undefined) out[key] = canonical(record[key]);
		return out;
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	)
		return value;
	return null;
}

export function launchFingerprint(input: LaunchFingerprintInput): string {
	const identity = {
		v: 1,
		kind: input.kind,
		cwd: resolve(input.cwd),
		specPath: input.kind === "dynamic" ? "" : resolve(input.specPath),
		specName: input.kind === "dynamic" ? "" : (input.specName ?? ""),
		task: input.task.trim(),
		inputs: input.inputs ?? {},
		executor: input.executor ?? "",
		profile: input.profile ?? "",
		permissionMode: input.permissionMode ?? "",
		allowUnverifiedCapabilities: [
			...(input.allowUnverifiedCapabilities ?? []),
		].sort(),
		model: input.model ?? "",
		effort: input.effort ?? "",
	};
	return createHash("sha256")
		.update(JSON.stringify(canonical(identity)))
		.digest("hex");
}

export function launchGuardDir(cwd: string): string {
	return join(dirname(workflowsRoot(cwd)), "host-launches");
}

function claimPath(cwd: string, fingerprint: string): string {
	return join(launchGuardDir(cwd), `${fingerprint}.json`);
}

async function readClaim(file: string): Promise<LaunchClaim | undefined> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as LaunchClaim;
		if (parsed?.schema !== CLAIM_SCHEMA) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

async function writeClaimAtomic(file: string, claim: LaunchClaim) {
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const handle = await open(temp, "w");
	try {
		await handle.writeFile(`${JSON.stringify(claim)}\n`);
	} finally {
		await handle.close();
	}
	await rename(temp, file);
}

/** Exclusive create; false when the file already exists. */
async function createClaim(file: string, claim: LaunchClaim): Promise<boolean> {
	await mkdir(dirname(file), { recursive: true });
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(file, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		await handle.writeFile(`${JSON.stringify(claim)}\n`);
	} finally {
		await handle.close();
	}
	return true;
}

function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type LaunchGuardDecision =
	| { kind: "existing"; run: WorkflowRunRecord }
	| { kind: "in-flight"; claimedAt: string }
	| {
			kind: "claimed";
			/** Record the started run (or release the claim when nothing started). */
			record: (runId: string) => Promise<void>;
			release: () => Promise<void>;
	  };

async function activeMatch(
	cwd: string,
	claim: LaunchClaim,
	now: number,
	windowMs: number,
): Promise<WorkflowRunRecord | undefined> {
	if (!claim.runId) return undefined;
	const run = await readRunRecord(cwd, claim.runId).catch(() => undefined);
	if (!run || run.runId !== claim.runId) return undefined;
	if (!ACTIVE_STATUSES.has(run.status)) return undefined;
	const createdAtMs = Date.parse(run.createdAt);
	if (!Number.isFinite(createdAtMs) || now - createdAtMs > windowMs)
		return undefined;
	return run;
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/**
 * Check the guard and, when no identical launch is active, claim the fingerprint for this launch.
 * The caller starts the run, then calls `record(runId)` (or `release()` when nothing started).
 */
export async function claimLaunch(
	cwd: string,
	fingerprint: string,
	options: {
		windowMs?: number;
		now?: () => number;
		inFlightWaitMs?: number;
	} = {},
): Promise<LaunchGuardDecision> {
	const windowMs = options.windowMs ?? DUPLICATE_RUN_WINDOW_MS;
	const now = options.now ?? Date.now;
	const file = claimPath(cwd, fingerprint);
	const deadline = now() + (options.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS);
	const fresh = (): LaunchClaim => ({
		schema: CLAIM_SCHEMA,
		fingerprint,
		claimedAt: new Date(now()).toISOString(),
		pid: process.pid,
	});
	const claimed = (claim: LaunchClaim): LaunchGuardDecision => ({
		kind: "claimed",
		record: async (runId) => {
			await writeClaimAtomic(file, {
				...claim,
				runId,
				recordedAt: new Date(now()).toISOString(),
			});
		},
		release: async () => {
			const current = await readClaim(file);
			if (
				current &&
				!current.runId &&
				current.pid === claim.pid &&
				current.claimedAt === claim.claimedAt
			)
				await unlink(file).catch(() => undefined);
		},
	});
	while (true) {
		const mine = fresh();
		if (await createClaim(file, mine)) return claimed(mine);
		const existing = await readClaim(file);
		if (existing?.runId) {
			const run = await activeMatch(cwd, existing, now(), windowMs);
			if (run) return { kind: "existing", run };
		} else if (existing) {
			// Another identical launch is starting right now (or died while starting).
			const age = now() - Date.parse(existing.claimedAt);
			const live =
				Number.isFinite(age) &&
				age < LAUNCH_CLAIM_STALE_MS &&
				processAlive(existing.pid);
			if (live) {
				if (now() >= deadline)
					return { kind: "in-flight", claimedAt: existing.claimedAt };
				await sleep(IN_FLIGHT_POLL_MS);
				continue;
			}
		}
		// Stale: the recorded run is terminal, gone or outside the window, or the launch died.
		// Replace the claim atomically; a racing launch that also replaced it is detected on
		// re-read and treated as in flight.
		await writeClaimAtomic(file, mine);
		const after = await readClaim(file);
		if (after && after.pid === mine.pid && after.claimedAt === mine.claimedAt)
			return claimed(mine);
	}
}

/** Record a forceNew launch so later identical launches find the newest run. */
export async function recordForcedLaunch(
	cwd: string,
	fingerprint: string,
	runId: string,
): Promise<void> {
	const file = claimPath(cwd, fingerprint);
	await mkdir(dirname(file), { recursive: true });
	const at = new Date().toISOString();
	await writeClaimAtomic(file, {
		schema: CLAIM_SCHEMA,
		fingerprint,
		claimedAt: at,
		pid: process.pid,
		runId,
		recordedAt: at,
	});
}
