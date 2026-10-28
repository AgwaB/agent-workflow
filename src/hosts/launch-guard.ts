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
// WP18b: claim files only matter inside the guard window, so stale ones (older than 1 h, and not
// naming a still-active run) are pruned in the background on every launch and by
// `agent-workflow prune` (`pruneHostLaunchClaims`).
//
// WP19 (stage-2 review #1): claim ownership is exclusive and fenced.
// - Every claim carries a unique owner token. Every read-modify-write of a claim file (initial
//   publish, stale takeover, lease renewal, record, release, prune) runs under a per-fingerprint
//   mutex, `<fingerprint>.lock`: an atomically created lock directory with owner-aware stealing
//   (runtime/artifacts/dir-lock.ts: a dead holder's uniquely named owner record is renamed to the
//   stealer's, so exactly one contender wins). "Replace, then re-read" is gone: two takeovers of
//   the same stale claim serialize on the mutex and the second one sees the first one's live
//   claim.
// - The claim is a renewable lease (`leaseExpiresAt`). The owner renews it every
//   LAUNCH_CLAIM_RENEW_MS while the launch is in flight (e.g. waiting for a user confirmation), so
//   a live owner keeps its claim past LAUNCH_CLAIM_STALE_MS; only an expired lease or a dead
//   owner process (same host) is taken over.
// - record, release and prune check the owner token first: a launch whose claim was taken over
//   never overwrites or deletes the new owner's claim.
import { createHash, randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DUPLICATE_RUN_WINDOW_MS } from "../core/run-estimates.js";
import { readRunRecord, workflowsRoot } from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";
import { acquireDirectoryLock } from "../runtime/artifacts/dir-lock.js";

const CLAIM_SCHEMA = "agent-workflow-host-launch-v1";
/** A pending claim whose lease was not renewed for this long belongs to a launch that died. */
export const LAUNCH_CLAIM_STALE_MS = 60_000;
/** WP19: how often a live owner renews its pending claim's lease. */
export const LAUNCH_CLAIM_RENEW_MS = 15_000;
/** How long a concurrent identical launch waits for the first one to record its run id. */
const IN_FLIGHT_WAIT_MS = 15_000;
const IN_FLIGHT_POLL_MS = 100;
/** WP19: the per-fingerprint mutex is held for a few file operations; wait up to ~5 s. */
const MUTEX_RETRIES = 250;
const MUTEX_RETRY_MS = 20;
/**
 * WP18b: a claim file older than this (mtime) is stale: the guard window is 10 min and a claim
 * without a run id is taken over once its lease expired.
 */
export const LAUNCH_CLAIM_RETENTION_MS = 60 * 60 * 1000;
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
	/** WP19: unique owner token (absent in claims written before WP19: owned by nobody). */
	token?: string;
	/** WP19: host of the owner process (liveness is only checked on the same host). */
	host?: string;
	/** WP19: the pending claim's lease; the owner renews it while the launch is in flight. */
	leaseExpiresAt?: string;
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

function mutexPath(file: string): string {
	return `${file.replace(/\.json$/u, "")}.lock`;
}

/**
 * WP19: run `body` while holding the claim file's mutex. Returns `undefined` when the mutex stays
 * held (ELOCKED) for the whole retry budget.
 */
async function withClaimMutex<T>(
	file: string,
	body: () => Promise<T>,
): Promise<{ value: T } | undefined> {
	await mkdir(dirname(file), { recursive: true });
	let release: () => Promise<void>;
	try {
		release = await acquireDirectoryLock(mutexPath(file), {
			retries: MUTEX_RETRIES,
			retryMs: MUTEX_RETRY_MS,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
		throw error;
	}
	try {
		return { value: await body() };
	} finally {
		await release().catch(() => undefined);
	}
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

/** Write a complete claim to a uniquely named temp file and rename it into place. */
async function writeClaimAtomic(file: string, claim: LaunchClaim) {
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(temp, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(claim)}\n`);
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
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

/** Lease expiry of a pending claim (claims before WP19: claimedAt + LAUNCH_CLAIM_STALE_MS). */
function leaseExpiry(claim: LaunchClaim): number {
	const lease = Date.parse(claim.leaseExpiresAt ?? "");
	if (Number.isFinite(lease)) return lease;
	return Date.parse(claim.claimedAt) + LAUNCH_CLAIM_STALE_MS;
}

/** A pending claim (no run id) whose owner may still be launching. */
function pendingClaimLive(claim: LaunchClaim, nowMs: number): boolean {
	if (claim.runId) return false;
	const expiry = leaseExpiry(claim);
	if (!Number.isFinite(expiry) || nowMs >= expiry) return false;
	// A dead owner on this host cannot renew: take over at once.
	if ((claim.host ?? hostname()) === hostname() && !processAlive(claim.pid))
		return false;
	return true;
}

export type LaunchGuardDecision =
	| { kind: "existing"; run: WorkflowRunRecord }
	| { kind: "in-flight"; claimedAt: string }
	| {
			kind: "claimed";
			/** WP19: this launch's unique owner token. */
			token: string;
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

type ClaimStep =
	| { kind: "claimed"; claim: LaunchClaim }
	| { kind: "existing"; run: WorkflowRunRecord }
	| { kind: "wait"; claimedAt: string };

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
		/** WP19: lease renewal interval (tests shorten it). */
		renewMs?: number;
		/** WP19 test hook: runs after the claim was inspected, before it is replaced. */
		beforeTakeover?: () => Promise<void>;
	} = {},
): Promise<LaunchGuardDecision> {
	const windowMs = options.windowMs ?? DUPLICATE_RUN_WINDOW_MS;
	const now = options.now ?? Date.now;
	const file = claimPath(cwd, fingerprint);
	const deadline = now() + (options.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS);
	const token = randomBytes(16).toString("hex");
	const fresh = (): LaunchClaim => ({
		schema: CLAIM_SCHEMA,
		fingerprint,
		claimedAt: new Date(now()).toISOString(),
		pid: process.pid,
		token,
		host: hostname(),
		leaseExpiresAt: new Date(now() + LAUNCH_CLAIM_STALE_MS).toISOString(),
	});
	const claimed = (claim: LaunchClaim): LaunchGuardDecision => {
		let done = false;
		const ours = (current: LaunchClaim | undefined): current is LaunchClaim =>
			current?.token === token;
		const renew = async () => {
			if (done) return;
			await withClaimMutex(file, async () => {
				const current = await readClaim(file);
				if (done || !ours(current) || current.runId) return;
				await writeClaimAtomic(file, {
					...current,
					leaseExpiresAt: new Date(now() + LAUNCH_CLAIM_STALE_MS).toISOString(),
				});
			}).catch(() => undefined);
		};
		const timer = setInterval(() => {
			void renew();
		}, options.renewMs ?? LAUNCH_CLAIM_RENEW_MS);
		timer.unref?.();
		const stop = () => {
			done = true;
			clearInterval(timer);
		};
		return {
			kind: "claimed",
			token,
			record: async (runId) => {
				stop();
				await withClaimMutex(file, async () => {
					const current = await readClaim(file);
					// Taken over (lease expired): the new owner's claim stays.
					if (!ours(current)) return;
					await writeClaimAtomic(file, {
						...claim,
						runId,
						recordedAt: new Date(now()).toISOString(),
					});
				});
			},
			release: async () => {
				stop();
				await withClaimMutex(file, async () => {
					const current = await readClaim(file);
					if (ours(current) && !current.runId)
						await unlink(file).catch(() => undefined);
				});
			},
		};
	};
	// WP18b: stale claims of earlier launches go in the background (never blocks the launch).
	void pruneHostLaunchClaims(cwd).catch(() => undefined);
	while (true) {
		const step = await withClaimMutex(file, async (): Promise<ClaimStep> => {
			const existing = await readClaim(file);
			if (existing?.runId) {
				const run = await activeMatch(cwd, existing, now(), windowMs);
				if (run) return { kind: "existing", run };
			} else if (existing && pendingClaimLive(existing, now())) {
				// Another identical launch is starting right now.
				return { kind: "wait", claimedAt: existing.claimedAt };
			}
			// No claim, or a stale one (terminal/gone/outside-window run, expired lease, dead
			// owner, unreadable file). We hold the mutex, so this replacement is exclusive.
			if (existing && options.beforeTakeover) await options.beforeTakeover();
			const mine = fresh();
			await writeClaimAtomic(file, mine);
			return { kind: "claimed", claim: mine };
		});
		if (!step) {
			// The mutex stayed held (e.g. a holder that can not be proven dead).
			if (now() >= deadline)
				return { kind: "in-flight", claimedAt: new Date(now()).toISOString() };
			await sleep(IN_FLIGHT_POLL_MS);
			continue;
		}
		const decision = step.value;
		if (decision.kind === "claimed") return claimed(decision.claim);
		if (decision.kind === "existing") return decision;
		if (now() >= deadline)
			return { kind: "in-flight", claimedAt: decision.claimedAt };
		await sleep(IN_FLIGHT_POLL_MS);
	}
}

export interface HostLaunchClaimPrune {
	dir: string;
	dryRun: boolean;
	/** Stale claim and temp files removed (or that would be removed in a dry run). */
	removed: string[];
	errors: string[];
}

/**
 * Remove stale launch claim files (and interrupted temp files): mtime older than
 * `LAUNCH_CLAIM_RETENTION_MS`, unless the claim names a run that is still active and inside the
 * guard window, or is a pending claim whose owner still renews its lease. WP19: a claim file is
 * re-checked and removed under its mutex, so a claim that a launch just (re)took is never deleted.
 */
export async function pruneHostLaunchClaims(
	cwd: string,
	options: { dryRun?: boolean; nowMs?: number; retentionMs?: number } = {},
): Promise<HostLaunchClaimPrune> {
	const dir = launchGuardDir(cwd);
	const nowMs = options.nowMs ?? Date.now();
	const cutoff = nowMs - (options.retentionMs ?? LAUNCH_CLAIM_RETENTION_MS);
	const summary: HostLaunchClaimPrune = {
		dir,
		dryRun: options.dryRun === true,
		removed: [],
		errors: [],
	};
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			summary.errors.push(String(error));
		return summary;
	}
	const stale = async (file: string, name: string): Promise<boolean> => {
		const info = await lstat(file).catch(() => undefined);
		if (!info?.isFile() || info.mtimeMs > cutoff) return false;
		if (!name.endsWith(".json")) return true;
		const claim = await readClaim(file);
		if (!claim) return true;
		if (pendingClaimLive(claim, nowMs)) return false;
		return !(await activeMatch(cwd, claim, nowMs, DUPLICATE_RUN_WINDOW_MS));
	};
	for (const name of names) {
		// Mutex staging files (`.<name>.lock.owner-*.tmp`) belong to dir-lock.
		if (name.startsWith(".")) continue;
		if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
		const file = join(dir, name);
		if (!(await stale(file, name))) continue;
		if (summary.dryRun || !name.endsWith(".json")) {
			summary.removed.push(file);
			if (summary.dryRun) continue;
			await unlink(file).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					summary.errors.push(`${file}: ${String(error)}`);
			});
			continue;
		}
		const outcome = await withClaimMutex(file, async () => {
			// Re-check under the mutex: a launch may have taken the claim over meanwhile.
			if (!(await stale(file, name))) return false;
			await unlink(file).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					summary.errors.push(`${file}: ${String(error)}`);
			});
			return true;
		}).catch((error) => {
			summary.errors.push(`${file}: ${String(error)}`);
			return undefined;
		});
		if (outcome?.value) summary.removed.push(file);
	}
	return summary;
}

/** Record a forceNew launch so later identical launches find the newest run. */
export async function recordForcedLaunch(
	cwd: string,
	fingerprint: string,
	runId: string,
): Promise<void> {
	const file = claimPath(cwd, fingerprint);
	await withClaimMutex(file, async () => {
		const current = await readClaim(file);
		// WP19: never overwrite another launch's live pending claim (its owner records it).
		if (current && pendingClaimLive(current, Date.now())) return;
		const at = new Date().toISOString();
		await writeClaimAtomic(file, {
			schema: CLAIM_SCHEMA,
			fingerprint,
			claimedAt: at,
			pid: process.pid,
			token: randomBytes(16).toString("hex"),
			host: hostname(),
			runId,
			recordedAt: at,
		});
	});
}
