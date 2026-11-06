import { stateBase } from "./state-location.js";
// Delete owned sessions through the executor that reported them; keep the run if deletion fails.
import { PROJECT_STATE_DIRECTORY } from "./home-dir.js";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
	acquireRunFileLease,
	acquireWorkflowTopologyLease,
	deriveRunStatus,
	isSafeRunId,
	isTerminalWorkflowStatus,
	isWorkflowRunLeaseLive,
	TERMINAL_INDEX_LIMIT,
	updateIndex,
	workflowsRoot,
} from "./store.js";
import { type ExecutorRegistry, loadExecutor } from "../sdk/descriptor.js";
import { acquireDirectoryLock } from "../runtime/artifacts/dir-lock.js";
import { RUN_LOCKS_DIR } from "../runtime/artifacts/registry.js";
import { physicalDirectoryChain } from "./physical-paths.js";
import {
	AUTO_ROUTER_PINS_DIR,
	AUTO_ROUTER_RUN_ID_PATTERN,
	AUTO_ROUTER_RUNS_DIR_NAME,
	type AutoRouterPinState,
	readAutoRouterPins,
	unidentifiedClassifierReason,
} from "./auto-router-runs.js";
import {
	ownedSessionReleased,
	runExecutorSelectionFor,
} from "./owned-session-release.js";
import type { WorkflowRunRecord, WorkflowRunStatus } from "./types.js";

export interface WorkflowPruneOptions {
	keep?: number;
	olderThanDays?: number;
	/**
	 * 2026-11-01: exactly these terminal runs (keep/olderThanDays ignored; auto-router requests are
	 * left alone). Any id that is not a terminal run here fails the whole call; nothing is deleted.
	 */
	runIds?: readonly string[];
	yes?: boolean;
	/**
	 * R#10/D3: delete the worker sessions each pruned run recorded as engine-owned
	 * (`task.ownedSessions`) through the run's executor `deleteOwnedSession`. Default true.
	 */
	deleteOwnedSessions?: boolean;
	/** In-process executor modules checked before importing a recorded descriptor module. */
	executorRegistry?: ExecutorRegistry;
}

export interface WorkflowPruneRun {
	runId: string;
	name?: string;
	status: WorkflowRunStatus;
	updatedAt: string;
	bytes: number;
	selected: boolean;
	protected: boolean;
	deleted: boolean;
	/** Canonical identity removed, even if recovery evidence is retained. */
	detached?: boolean;
	purged?: boolean;
	retainedEvidencePath?: string;
	retainedMirrorPath?: string;
	/**
	 * WP39b (O7): the run's managed worktrees (`<run>/worktrees/<task>`, branch
	 * `agent-workflow/<run>-<task>`). Kept after the run by design (no auto-merge); prune lists them
	 * in the dry run and removes them with `--yes` (`git worktree remove --force`), deleting the
	 * branch only when it has no commits outside the checkout's HEAD (`git branch -d`).
	 */
	worktrees?: WorkflowPruneWorktree[];
	/** R#10: owned worker sessions handled for this run. */
	ownedSessions?: {
		deleted: number;
		notFound: number;
		/** The executor has no deleteOwnedSession (sessions are left in place). */
		unsupported: number;
	};
	error?: string;
}

export interface WorkflowPruneWorktree {
	/** Project-relative path. */
	path: string;
	branch: string | null;
	/** Uncommitted changes (tracked or untracked) in the worktree. */
	dirty: boolean;
	/** Commits on the worktree's HEAD that the checkout's HEAD does not contain. */
	commits: number;
	/** The directory is gone (only the git registration was cleaned up). */
	missing?: boolean;
	removed?: boolean;
	branchDeleted?: boolean;
	error?: string;
}

/**
 * WP39b (live bundle 5, O16): one auto-classifier request (`workflows/auto-router-runs/run_*`),
 * pruned with the run rules: terminal only, newest `keep` kept, `olderThanDays`, `--yes`.
 */
export interface WorkflowPruneClassifierRun {
	runId: string;
	status: string;
	updatedAt: string;
	bytes: number;
	deleted: boolean;
	/** WP42 (finding 5): pinned by an active classifier request; never deleted. */
	protected?: boolean;
	error?: string;
}

/**
 * WP42 (WP39b review, finding 3): an entry of `workflows/auto-router-runs/` that prune keeps because
 * it is not positively identified as a classifier request (never deleted, whatever its age).
 */
export interface WorkflowPruneKeptEntry {
	name: string;
	reason: string;
}

export interface WorkflowPruneSummary {
	dryRun: boolean;
	keep: number;
	olderThanDays?: number;
	runs: WorkflowPruneRun[];
	/** WP39b (O16): auto-classifier requests beyond the same filters. */
	autoRouterRuns: WorkflowPruneClassifierRun[];
	/** WP42: entries of auto-router-runs kept because they are not identified classifier requests. */
	autoRouterPreserved?: WorkflowPruneKeptEntry[];
	totalBytes: number;
	deletedBytes: number;
	indexUpdated: boolean;
	error?: string;
}

interface Candidate {
	run: WorkflowRunRecord;
	runDir: string;
	mirrorDir: string;
	bytes: number;
	identity: { dev: number; ino: number };
}

let beforeDeleteForTests: (() => void | Promise<void>) | undefined;
let afterQuarantineForTests: (() => void | Promise<void>) | undefined;
let beforePrimaryDetachForTests: (() => void | Promise<void>) | undefined;
export function setWorkflowPruneBeforePrimaryDetachForTests(
	hook?: () => void | Promise<void>,
): void {
	beforePrimaryDetachForTests = hook;
}
export function setWorkflowPruneAfterQuarantineForTests(
	hook?: () => void | Promise<void>,
): void {
	afterQuarantineForTests = hook;
}
export function setWorkflowPruneBeforeDeleteForTests(
	hook?: () => void | Promise<void>,
): void {
	beforeDeleteForTests = hook;
}

export async function pruneWorkflowRuns(
	cwd: string,
	options: WorkflowPruneOptions = {},
): Promise<WorkflowPruneSummary> {
	cwd = await realpath(resolve(cwd));
	const keep = normalizeNonNegativeInteger(options.keep, TERMINAL_INDEX_LIMIT);
	const olderThanDays = options.olderThanDays;
	if (
		olderThanDays !== undefined &&
		(!Number.isFinite(olderThanDays) || olderThanDays < 0)
	)
		throw new Error("--older-than requires a non-negative number of days");

	// WP42 (WP39b review, finding 1): an unsafe retention root (a symlinked `.agent-workflow` or
	// `workflows`) fails closed before anything is listed or deleted; a missing one has nothing.
	const rootState = await physicalRetentionRoot(workflowsRoot(cwd)).then(
		() => "safe" as const,
		(error: unknown) =>
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? ("missing" as const)
				: new Error(`unsafe retention root: ${errorMessage(error)}`),
	);
	if (rootState instanceof Error)
		return emptySummary(
			!options.yes,
			keep,
			olderThanDays,
			`${rootState.message}; nothing was ${options.yes ? "deleted" : "listed"}`,
		);
	if (rootState === "missing")
		return emptySummary(!options.yes, keep, olderThanDays);
	// No topology lock (or any filesystem writes) for a preview.
	if (!options.yes) return prunePlan(cwd, options, keep, olderThanDays);
	const topology = await acquireWorkflowTopologyLease(cwd);
	if (!topology)
		return {
			dryRun: false,
			keep,
			olderThanDays,
			runs: [],
			autoRouterRuns: [],
			totalBytes: 0,
			deletedBytes: 0,
			indexUpdated: false,
			error: "workflow topology lease unavailable",
		};
	try {
		return await prunePlan(
			cwd,
			options,
			keep,
			olderThanDays,
			topology.assertOwner,
		);
	} finally {
		await topology.release();
	}
}

function emptySummary(
	dryRun: boolean,
	keep: number,
	olderThanDays: number | undefined,
	error?: string,
): WorkflowPruneSummary {
	return {
		dryRun,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
		runs: [],
		autoRouterRuns: [],
		autoRouterPreserved: [],
		totalBytes: 0,
		deletedBytes: 0,
		indexUpdated: false,
		...(error === undefined ? {} : { error }),
	};
}

interface RetentionPlan {
	candidates: Candidate[];
	children: Map<string, Set<string>>;
	uncertain: boolean;
}

async function prunePlan(
	cwd: string,
	options: WorkflowPruneOptions,
	keep: number,
	olderThanDays?: number,
	assertTopologyOwner?: () => Promise<void>,
): Promise<WorkflowPruneSummary> {
	const plan = await findRetentionPlan(cwd);
	const candidates = plan.candidates;
	candidates.sort(
		(left, right) =>
			Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt),
	);
	const cutoff =
		olderThanDays === undefined
			? undefined
			: Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const summaryRuns: WorkflowPruneRun[] = [];
	const detachedRunIds: string[] = [];
	const purgedRunIds = new Set<string>();
	const named = options.runIds;
	if (named) {
		const terminal = new Set(
			candidates.map((candidate) => candidate.run.runId),
		);
		const unknown = named.filter((runId) => !terminal.has(runId));
		if (unknown.length > 0)
			return emptySummary(
				!options.yes,
				keep,
				olderThanDays,
				`not a terminal run in this project: ${unknown.join(", ")}; nothing was ${options.yes ? "deleted" : "listed"}`,
			);
	}
	const selected = named
		? candidates.filter((candidate) => named.includes(candidate.run.runId))
		: candidates.filter(
				(candidate, index) =>
					index >= keep &&
					(cutoff === undefined ||
						Date.parse(candidate.run.updatedAt) < cutoff),
			);

	for (const candidate of childrenFirst(selected, plan.children)) {
		// The preview lists only the public fields (no internal absolute paths).
		const worktrees = (await inspectRunWorktrees(cwd, candidate.run)).map(
			({
				absolutePath: _path,
				registered: _registered,
				tip: _tip,
				...worktree
			}) => worktree,
		);
		const entry: WorkflowPruneRun = {
			runId: candidate.run.runId,
			...(candidate.run.name === undefined ? {} : { name: candidate.run.name }),
			status: candidate.run.status,
			updatedAt: candidate.run.updatedAt,
			bytes: candidate.bytes,
			selected: true,
			protected: false,
			deleted: false,
			...(worktrees.length ? { worktrees } : {}),
		};
		const referenceError = await retainedChildReason(
			cwd,
			candidate.run.runId,
			plan,
			purgedRunIds,
		);
		if (referenceError) {
			entry.protected = true;
			entry.error = referenceError;
			summaryRuns.push(entry);
			continue;
		}
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId)) {
			entry.protected = true;
			entry.error = "live or indeterminate supervisor lease";
			summaryRuns.push(entry);
			continue;
		}
		if (!options.yes) {
			// Live bundle 6: a worktree prune would keep (not identified, user branch, unknown state)
			// keeps its run under `--yes` ("worktree removal failed"); the preview says so too.
			const kept = worktrees.find((worktree) => worktree.error);
			if (kept) {
				entry.protected = true;
				entry.error = `worktree kept: ${kept.path}: ${kept.error}`;
			}
			summaryRuns.push(entry);
			continue;
		}
		await beforeDeleteForTests?.();
		const deletion = await deleteCandidate(
			cwd,
			candidate,
			async () => {
				await assertTopologyOwner?.();
				return retainedChildReason(
					cwd,
					candidate.run.runId,
					plan,
					purgedRunIds,
				);
			},
			options.deleteOwnedSessions === false
				? undefined
				: (run) => deleteRunOwnedSessions(run, options.executorRegistry),
		);
		Object.assign(entry, deletion);
		if (deletion.detached) detachedRunIds.push(candidate.run.runId);
		if (deletion.purged) purgedRunIds.add(candidate.run.runId);
		summaryRuns.push(entry);
	}

	const { runs: autoRouterRuns, preserved: autoRouterPreserved } = named
		? { runs: [], preserved: [] }
		: await pruneAutoRouterRuns(cwd, keep, cutoff, options.yes === true);
	let indexUpdated = false;
	const failures = summaryRuns.filter((run) => !run.protected && run.error);
	let error =
		failures.length > 0
			? `${failures.length} selected run(s) failed to purge`
			: undefined;
	if (options.yes && detachedRunIds.length > 0) {
		try {
			await updateIndex(cwd);
			indexUpdated = true;
		} catch (indexError) {
			error = `${error ? `${error}; ` : ""}index update failed: ${errorMessage(indexError)}`;
		}
	}
	return {
		dryRun: !options.yes,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
		runs: summaryRuns,
		autoRouterRuns,
		autoRouterPreserved,
		totalBytes:
			summaryRuns.reduce(
				(total, run) => total + (run.protected ? 0 : run.bytes),
				0,
			) +
			autoRouterRuns.reduce(
				(total, run) => total + (run.protected ? 0 : run.bytes),
				0,
			),
		deletedBytes:
			summaryRuns.reduce(
				(total, run) => total + (run.deleted ? run.bytes : 0),
				0,
			) +
			autoRouterRuns.reduce(
				(total, run) => total + (run.deleted ? run.bytes : 0),
				0,
			),
		indexUpdated,
		...(error === undefined ? {} : { error }),
	};
}

export function formatWorkflowPruneSummary(
	summary: WorkflowPruneSummary,
): string {
	const lines = [
		summary.dryRun ? "Workflow prune (dry run)" : "Workflow prune",
	];
	if (summary.runs.length === 0) {
		lines.push("No terminal runs are beyond the retention filters.");
	} else {
		lines.push(
			summary.dryRun
				? "Runs that would be deleted:"
				: "Runs selected for deletion:",
		);
		for (const run of summary.runs) {
			lines.push(
				`- ${run.runId} ${run.name ?? "(unnamed)"} ${run.status} ${run.updatedAt} ${run.bytes} bytes${run.protected ? ` — protected: ${run.error}` : run.error ? ` — ${run.error}` : run.deleted ? " — deleted" : ""}`,
			);
			for (const worktree of run.worktrees ?? []) {
				const state = [
					worktree.branch ? `branch ${worktree.branch}` : "detached",
					...(worktree.missing ? ["directory missing"] : []),
					...(worktree.dirty ? ["uncommitted changes"] : []),
					...(worktree.commits > 0
						? [
								`${worktree.commits} commit(s) not in the checkout's HEAD; the branch is kept`,
							]
						: []),
				];
				const done = worktree.error
					? ` — ${worktree.error}`
					: worktree.removed
						? ` — removed${worktree.branchDeleted ? ", branch deleted" : worktree.branch ? ", branch kept" : ""}`
						: "";
				lines.push(`  Worktree: ${worktree.path} (${state.join("; ")})${done}`);
			}
			if (run.retainedEvidencePath)
				lines.push(`  Retained run evidence: ${run.retainedEvidencePath}`);
			if (run.retainedMirrorPath)
				lines.push(`  Retained mirror evidence: ${run.retainedMirrorPath}`);
		}
	}
	if (summary.autoRouterRuns?.length) {
		lines.push(
			summary.dryRun
				? "Classifier requests that would be deleted:"
				: "Classifier requests selected for deletion:",
		);
		for (const run of summary.autoRouterRuns)
			lines.push(
				`- ${run.runId} ${run.status} ${run.updatedAt} ${run.bytes} bytes${run.protected ? ` — protected: ${run.error}` : run.error ? ` — ${run.error}` : run.deleted ? " — deleted" : ""}`,
			);
	}
	if (summary.autoRouterPreserved?.length) {
		lines.push(
			"Kept in auto-router-runs (not identified as classifier requests):",
		);
		for (const kept of summary.autoRouterPreserved)
			lines.push(`- ${kept.name} — ${kept.reason}`);
	}
	lines.push(
		`Total bytes: ${summary.totalBytes} (logical file bytes; hard links counted once, so du may report more)`,
	);
	if (!summary.dryRun) lines.push(`Deleted bytes: ${summary.deletedBytes}`);
	if (summary.error) lines.push(`Error: ${summary.error}`);
	return lines.join("\n");
}

async function findRetentionPlan(cwd: string): Promise<RetentionPlan> {
	const plan: RetentionPlan = {
		candidates: [],
		children: new Map(),
		uncertain: false,
	};
	const root = workflowsRoot(cwd);
	const rootReal = await physicalRetentionRoot(root).catch(() => undefined);
	if (!rootReal) return plan;
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		// WP39b (O16): the classifier requests' directory is not a run (pruned separately below).
		if (entry.name === AUTO_ROUTER_RUNS_DIR_NAME) continue;
		const quarantine = entry.name.startsWith(".prune-");
		if (!quarantine && !isSafeRunId(entry.name)) continue;
		// Ordinary root metadata (index, lock) is not a run directory.
		if (!quarantine && entry.isFile()) continue;
		const runDir = join(root, entry.name, ...(quarantine ? ["run"] : []));
		try {
			if (!(await isContainedDirectory(rootReal, runDir)))
				throw new Error("uncertain run directory");
			const run = await readTerminalCandidate(runDir);
			if (
				!isSafeRunId(run.runId) ||
				(!quarantine && run.runId !== entry.name) ||
				(run.parentRunId !== undefined && !isSafeRunId(run.parentRunId)) ||
				(run.rootRunId !== undefined && !isSafeRunId(run.rootRunId)) ||
				(!run.parentRunId &&
					run.rootRunId !== undefined &&
					run.rootRunId !== run.runId)
			)
				throw new Error("uncertain run identity");
			if (run.parentRunId) {
				const children =
					plan.children.get(run.parentRunId) ?? new Set<string>();
				children.add(entry.name);
				plan.children.set(run.parentRunId, children);
			}
			if (
				quarantine ||
				!isTerminalWorkflowStatus(run.status) ||
				!Number.isFinite(Date.parse(run.updatedAt))
			)
				continue;
			const mirrorDir = join(
				stateBase(cwd),
				PROJECT_STATE_DIRECTORY,
				"workflow-subagents",
				entry.name,
			);
			const bytes =
				(await directoryBytes(runDir)) +
				(await containedDirectoryBytes(cwd, mirrorDir));
			plan.candidates.push({
				run,
				runDir,
				mirrorDir,
				bytes,
				identity: await lstat(runDir),
			});
		} catch {
			// An unreadable record may reference ANY candidate. Do not guess.
			plan.uncertain = true;
		}
	}
	return plan;
}

function childrenFirst(
	candidates: Candidate[],
	children: Map<string, Set<string>>,
): Candidate[] {
	const selected = new Map(
		candidates.map((candidate) => [candidate.run.runId, candidate]),
	);
	const pending = new Map(
		candidates.map((candidate) => [
			candidate.run.runId,
			[...(children.get(candidate.run.runId) ?? [])].filter((id) =>
				selected.has(id),
			).length,
		]),
	);
	const queue = candidates.filter(
		(candidate) => pending.get(candidate.run.runId) === 0,
	);
	const visited = new Set<string>();
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index];
		visited.add(candidate.run.runId);
		const parent = candidate.run.parentRunId;
		if (!parent || !pending.has(parent)) continue;
		pending.set(parent, pending.get(parent)! - 1);
		if (pending.get(parent) === 0) queue.push(selected.get(parent)!);
	}
	// Cycles remain protected by their references, rather than being omitted.
	return [
		...queue,
		...candidates.filter((candidate) => !visited.has(candidate.run.runId)),
	];
}

async function retainedChildReason(
	cwd: string,
	runId: string,
	plan: RetentionPlan,
	purged: Set<string>,
): Promise<string | undefined> {
	if (plan.uncertain) return "uncertain run references";
	for (const child of plan.children.get(runId) ?? []) {
		if (!purged.has(child)) return `retained direct child: ${child}`;
		// A selected child was purged, but its canonical name may have been
		// recreated. Never remove its ancestor based on the old generation.
		try {
			await lstat(join(workflowsRoot(cwd), child));
			return `recreated direct child: ${child}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				return `uncertain direct child: ${child}`;
		}
	}
	return undefined;
}

type DeletionOutcome = Pick<
	WorkflowPruneRun,
	| "deleted"
	| "detached"
	| "purged"
	| "protected"
	| "error"
	| "retainedEvidencePath"
	| "retainedMirrorPath"
	| "ownedSessions"
	| "worktrees"
>;

async function deleteCandidate(
	cwd: string,
	candidate: Candidate,
	recheckReferences: () => Promise<string | undefined>,
	deleteOwnedSessions?: (
		run: WorkflowRunRecord,
	) => Promise<NonNullable<WorkflowPruneRun["ownedSessions"]>>,
): Promise<DeletionOutcome> {
	const root = workflowsRoot(cwd);
	let lease: Awaited<ReturnType<typeof acquireRunFileLease>>;
	const outcome: DeletionOutcome = {
		deleted: false,
		detached: false,
		purged: false,
		protected: false,
	};
	let primary: Quarantine | undefined;
	let mirror: Quarantine | undefined;
	try {
		await physicalRetentionRoot(root);
		const identity = await lstat(candidate.runDir);
		if (
			!identity.isDirectory() ||
			identity.isSymbolicLink() ||
			identity.dev !== candidate.identity.dev ||
			identity.ino !== candidate.identity.ino
		)
			throw new Error("run directory changed since selection");
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId))
			return {
				...outcome,
				protected: true,
				error: "live or indeterminate supervisor lease",
			};
		lease = await acquireRunFileLease(cwd, candidate.run.runId, "supervisor");
		if (!lease)
			return {
				...outcome,
				protected: true,
				error: "supervisor lease acquired concurrently",
			};
		const current = await readTerminalCandidate(candidate.runDir);
		if (
			current.runId !== candidate.run.runId ||
			current.updatedAt !== candidate.run.updatedAt ||
			!isTerminalWorkflowStatus(current.status)
		)
			return {
				...outcome,
				protected: true,
				error: "run changed since selection",
			};
		const reason = await recheckReferences();
		if (reason) return { ...outcome, protected: true, error: reason };
		await lease.assertOwner();
		// R#10: owned worker sessions go first; a failure keeps the run (its record is the
		// only evidence of which sessions the engine owns).
		if (deleteOwnedSessions) {
			try {
				outcome.ownedSessions = await deleteOwnedSessions(current);
			} catch (error) {
				return {
					...outcome,
					protected: true,
					error: `owned worker session deletion failed: ${errorMessage(error)}`,
				};
			}
			await lease.assertOwner();
		}
		// WP39b (O7): the run's managed worktrees go before the run directory that contains them
		// (git keeps their registration otherwise); a failure keeps the run.
		const worktrees = await inspectRunWorktrees(cwd, current);
		if (worktrees.length) {
			outcome.worktrees = await removeRunWorktrees(
				cwd,
				current.runId,
				worktrees,
			);
			const failed = outcome.worktrees.find((worktree) => worktree.error);
			if (failed)
				return {
					...outcome,
					protected: true,
					error: `worktree removal failed: ${failed.path}: ${failed.error}`,
				};
			await lease.assertOwner();
		}
		// WP42 (review round 2, N1): never detach or recursively remove a run directory that still
		// contains a registered git worktree (one prune did not identify and remove above).
		const registeredInside = await registeredWorktreeInside(
			cwd,
			candidate.runDir,
		);
		if (registeredInside)
			return { ...outcome, protected: true, error: registeredInside };
		await lease.assertOwner();
		// No irreversible removal until BOTH generations are safely detached.
		mirror = await quarantineContainedDirectory(
			join(stateBase(cwd), PROJECT_STATE_DIRECTORY, "workflow-subagents"),
			candidate.mirrorDir,
		);
		outcome.retainedMirrorPath = mirror?.directory;
		await beforePrimaryDetachForTests?.();
		await lease.assertOwner();
		const finalReason = await recheckReferences();
		if (finalReason) throw new Error(finalReason);
		primary = await quarantineContainedDirectory(
			root,
			candidate.runDir,
			candidate.identity,
			async () => {
				await lease!.assertOwner();
				const reason = await recheckReferences();
				if (reason) throw new Error(reason);
			},
		);
		if (!primary) throw new Error("selected run disappeared before detach");
		outcome.detached = true;
		outcome.retainedEvidencePath = primary.directory;
		await afterQuarantineForTests?.();
		if (mirror) {
			await rm(mirror.container, { recursive: true, force: true });
			outcome.retainedMirrorPath = undefined;
		}
		await rm(primary.container, { recursive: true, force: true });
		outcome.retainedEvidencePath = undefined;
		outcome.purged = true;
		outcome.deleted = true;
	} catch (error) {
		outcome.error = errorMessage(error);
	} finally {
		try {
			await lease?.release();
		} catch (error) {
			outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}lease release failed: ${errorMessage(error)}`;
		}
	}
	return outcome;
}

async function readTerminalCandidate(
	runDir: string,
): Promise<WorkflowRunRecord> {
	const file = join(runDir, "run.json");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
		throw new Error("unsafe run record");
	const run = JSON.parse(await readFile(file, "utf8")) as WorkflowRunRecord;
	const statuses = new Set([
		"pending",
		"running",
		"blocked",
		"completed",
		"failed",
		"skipped",
		"interrupted",
	]);
	if (
		!Array.isArray(run.tasks) ||
		!run.tasks.every((task) => task && statuses.has(task.status))
	)
		throw new Error("invalid task statuses");
	return deriveRunStatus(run);
}

async function physicalRetentionRoot(root: string): Promise<string> {
	// cwd has been canonicalized, but application-owned ancestors must never
	// be canonicalized through a symlink into an unrelated retention tree.
	for (const path of [resolve(root, ".."), root]) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("unsafe retention root");
	}
	const physical = await realpath(root);
	if (physical !== resolve(root)) throw new Error("retention root changed");
	return physical;
}

interface Quarantine {
	container: string;
	directory: string;
}

async function quarantineContainedDirectory(
	root: string,
	directory: string,
	identity?: { dev: number; ino: number },
	commitFence?: () => Promise<void>,
): Promise<Quarantine | undefined> {
	let rootReal: string;
	try {
		rootReal = await physicalRetentionRoot(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("path is not a real directory");
	if (identity && (info.dev !== identity.dev || info.ino !== identity.ino))
		throw new Error("run directory changed since selection");
	const directoryReal = await realpath(directory);
	if (!isInside(rootReal, directoryReal))
		throw new Error("path is outside retention root");
	// Detach the selected generation before recursive removal can unlink its
	// supervisor.lock. An unlocked/recreated original name is not our target.
	// The container has no run.json, so index readers ignore it during removal.
	const container = await mkdtemp(join(rootReal, ".prune-"));
	const detached = join(container, "run");
	let moved = false;
	try {
		await physicalRetentionRoot(root);
		const current = await lstat(directory);
		if (current.dev !== info.dev || current.ino !== info.ino)
			throw new Error("directory changed before quarantine");
		await commitFence?.();
		await rename(directory, detached);
		moved = true;
		return { container, directory: detached };
	} catch (error) {
		if (!moved)
			await rm(container, { recursive: true, force: true }).catch(
				() => undefined,
			);
		throw new Error(
			`${errorMessage(error)}${moved ? `; detached evidence retained at ${detached}` : ""}`,
		);
	}
}

async function containedDirectoryBytes(
	cwd: string,
	directory: string,
): Promise<number> {
	const root = join(
		stateBase(cwd),
		PROJECT_STATE_DIRECTORY,
		"workflow-subagents",
	);
	try {
		if (
			!(await isContainedDirectory(
				await physicalRetentionRoot(root),
				directory,
			))
		)
			return 0;
		return await directoryBytes(directory);
	} catch {
		return 0;
	}
}

async function isContainedDirectory(
	root: string,
	directory: string,
): Promise<boolean> {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) return false;
		return isInside(root, await realpath(directory));
	} catch {
		return false;
	}
}

async function directoryBytes(directory: string): Promise<number> {
	const seen = new Set<string>();
	async function walk(current: string): Promise<number> {
		const entries = await readdir(current, { withFileTypes: true });
		let total = 0;
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const file = join(current, entry.name);
			if (entry.isDirectory()) {
				total += await walk(file);
			} else if (entry.isFile()) {
				const info = await lstat(file);
				const identity = `${info.dev}:${info.ino}`;
				if (!seen.has(identity)) {
					seen.add(identity);
					total += info.size;
				}
			}
		}
		return total;
	}
	return walk(directory).catch(() => 0);
}

function isInside(root: string, child: string): boolean {
	const rel = relative(resolve(root), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeNonNegativeInteger(
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
		throw new Error("--keep requires a non-negative integer");
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * R#10 (D3): delete the worker sessions a run recorded as engine-owned, through the run's
 * recorded executor. Never touches a session that is not in `task.ownedSessions`, and only
 * those whose executor id matches the run's executor (WP31: or another executor a mixed run records
 * in `run.roleExecution.executors`).
 */
export async function deleteRunOwnedSessions(
	run: WorkflowRunRecord,
	registry?: ExecutorRegistry,
): Promise<NonNullable<WorkflowPruneRun["ownedSessions"]>> {
	const result = { deleted: 0, notFound: 0, unsupported: 0 };
	// WP12a: sessions the engine already released (deleted or found absent) are not retried.
	const sessions = run.tasks
		.flatMap((task) => task.ownedSessions ?? [])
		.filter((session) => !ownedSessionReleased(session));
	if (sessions.length === 0) return result;
	const primary = run.executor?.descriptor;
	if (primary === undefined)
		throw new Error(
			`run ${run.runId} records owned worker sessions but no executor`,
		);
	// WP31 (Q4): a mixed run deletes each session through the executor that reported it.
	const executors = new Map<string, Awaited<ReturnType<typeof loadExecutor>>>();
	const seen = new Set<string>();
	for (const session of sessions) {
		const selection = runExecutorSelectionFor(run, session.executorId);
		if (selection === undefined)
			throw new Error(
				`owned worker session ${session.kind}:${session.locator} belongs to executor ${session.executorId}, not ${primary.id}`,
			);
		const descriptor = selection.descriptor;
		let executor = executors.get(descriptor.id);
		if (executor === undefined) {
			executor = await loadExecutor(descriptor, { registry });
			executors.set(descriptor.id, executor);
		}
		const key = `${descriptor.id}\0${session.kind}\0${session.locator}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (typeof executor.deleteOwnedSession !== "function") {
			result.unsupported += 1;
			continue;
		}
		const outcome = await executor.deleteOwnedSession({
			kind: session.kind,
			locator: session.locator,
		});
		if (outcome === "deleted") result.deleted += 1;
		else if (outcome === "not_found") result.notFound += 1;
		else
			throw new Error(
				outcome === "failed"
					? `executor ${descriptor.id} failed to delete owned session ${session.kind}:${session.locator}`
					: `executor ${descriptor.id} refused to delete owned session ${session.kind}:${session.locator}`,
			);
	}
	return result;
}

const execFileAsync = promisify(execFile);

/** WP42 (review round 3): a hung git (e.g. a stalled network mount) fails the check, closed. */
const GIT_TIMEOUT_MS = 30_000;

async function gitText(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: GIT_TIMEOUT_MS,
	});
	return stdout;
}

/**
 * WP42 (review round 3, N4): when git cannot list registrations (git missing, or the project is
 * not a git repository), a git checkout inside the run directory is found on disk instead: any
 * `.git` entry (a worktree's `.git` file or a repository's `.git` directory) below the run
 * directory, without following symlinks and at a bounded depth. Its presence keeps the run.
 */
async function gitCheckoutInside(runDir: string): Promise<string | undefined> {
	const MAX_DEPTH = 6;
	const MAX_ENTRIES = 20_000;
	let seen = 0;
	// WP42 (review round 4): an incomplete scan never proves "no checkout". The entry budget, a
	// directory below the depth limit, or a directory that cannot be read returns that path, so
	// the run is kept.
	const walk = async (
		dir: string,
		depth: number,
	): Promise<string | undefined> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? undefined
				: dir;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > MAX_ENTRIES) return dir;
			const path = join(dir, entry.name);
			if (entry.name === ".git") return path;
			if (entry.isDirectory()) {
				if (depth >= MAX_DEPTH) return path;
				const found = await walk(path, depth + 1);
				if (found) return found;
			}
		}
		return undefined;
	};
	return walk(runDir, 0);
}

interface RunWorktree extends WorkflowPruneWorktree {
	absolutePath: string;
	/** The path `git worktree list` registers for it in this repository, if any. */
	registered?: string;
	/** The managed branch's tip commit, if the branch exists. */
	tip?: string;
}

/** A managed worktree's directory name (its task id) under `<run>/worktrees/`. */
const MANAGED_WORKTREE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

interface GitWorktreeListing {
	path: string;
	/** `refs/heads/<branch>`, or undefined for a detached HEAD. */
	branch?: string;
}

/** This repository's registered worktrees (`git worktree list --porcelain`, run in the project). */
async function listGitWorktrees(cwd: string): Promise<GitWorktreeListing[]> {
	const listed: GitWorktreeListing[] = [];
	let current: GitWorktreeListing | undefined;
	for (const line of (
		await gitText(cwd, ["worktree", "list", "--porcelain"])
	).split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length) };
			listed.push(current);
		} else if (current && line.startsWith("branch "))
			current.branch = line.slice("branch ".length);
	}
	return listed;
}

/**
 * WP42 (review round 2, N1): why a run directory must be kept because this repository's
 * `git worktree list` registers a worktree inside it; undefined when none is (or the project is
 * not in a git repository, or git is not installed, so nothing can be registered).
 */
async function registeredWorktreeInside(
	cwd: string,
	runDir: string,
): Promise<string | undefined> {
	let listed: GitWorktreeListing[];
	try {
		listed = await listGitWorktrees(cwd);
	} catch (error) {
		const failure = error as { code?: unknown; stderr?: unknown };
		if (
			failure.code === "ENOENT" ||
			(typeof failure.stderr === "string" &&
				/not a git repository/iu.test(failure.stderr))
		) {
			// WP42 (review round 3, N4): a missing git does not remove registrations. Without a
			// listing, any git checkout on disk inside the run directory keeps the run.
			const checkout = await gitCheckoutInside(runDir);
			return checkout
				? `${failure.code === "ENOENT" ? "git is not available" : "not a git repository"} and a git checkout inside the run directory cannot be ruled out (${relative(cwd, checkout)}); kept`
				: undefined;
		}
		return `git worktree list failed: ${errorMessage(error).split("\n")[0]}; kept`;
	}
	for (const worktree of listed) {
		const path = await canonicalListedPath(worktree.path);
		if (isInside(runDir, path))
			return `registered git worktree inside the run directory: ${relative(cwd, path)}; kept`;
	}
	return undefined;
}

/**
 * WP42 (review round 2, N1): a recorded worktree path mapped onto the canonical project root. A
 * record may spell the project root through an alias (macOS `/tmp` → `/private/tmp`, a symlinked
 * project parent): its `<root>/.agent-workflow/workflows/<run>/worktrees/<name>` prefix is resolved
 * with `realpath` and must be this project. Symlinks below the project root are still rejected
 * later (physical directory chain). Anything else is an `error`: the record keeps its run.
 */
async function canonicalRecordedWorktree(
	cwd: string,
	runId: string,
	recorded: string,
): Promise<{ absolutePath: string; name: string; error?: string }> {
	const root = join(workflowsRoot(cwd), runId, "worktrees");
	const lexical = resolve(stateBase(cwd), recorded);
	const name = relative(root, lexical);
	if (
		!name ||
		name.startsWith("..") ||
		isAbsolute(name) ||
		name.includes("/") ||
		name.includes("\\")
	)
		return {
			absolutePath: lexical,
			name: basename(lexical),
			error: "recorded worktree is not in this run's worktrees directory; kept",
		};
	return { absolutePath: lexical, name };
}

/** `path` with its longest existing prefix canonicalized (git may list a non-canonical path). */
async function canonicalListedPath(path: string): Promise<string> {
	const absolute = resolve(path);
	const rest: string[] = [];
	for (let current = absolute; ; ) {
		try {
			return join(await realpath(current), ...rest.reverse());
		} catch {
			const parent = resolve(current, "..");
			if (parent === current) return absolute;
			rest.push(relative(parent, current));
			current = parent;
		}
	}
}

/**
 * WP39b (O7): the managed worktrees a run recorded (tasks and shared loop worktrees) that lie in
 * its own `worktrees/` directory, with their state. Never throws: an unreadable or unidentified
 * worktree is reported with `error` (and keeps its run). WP42 (review round 2, N1): an enabled
 * record is never silently skipped; one that cannot be mapped into the run's own `worktrees/`
 * directory of this project is reported with `error` too.
 */
async function inspectRunWorktrees(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<RunWorktree[]> {
	const seen = new Map<string, RunWorktree>();
	const records = [
		...(run.tasks ?? []).map((task) => task.worktree),
		...(run.loopWorktrees ?? []).map((record) => ({
			...record,
			enabled: true,
		})),
	];
	for (const record of records) {
		if (!record?.enabled) continue;
		const branch = typeof record.branch === "string" ? record.branch : null;
		if (typeof record.path !== "string" || record.path === "") {
			if (!seen.has(""))
				seen.set("", {
					path: "(no recorded path)",
					absolutePath: "",
					branch,
					dirty: false,
					commits: 0,
					error: "enabled worktree record without a path; kept",
				});
			continue;
		}
		const mapped = await canonicalRecordedWorktree(cwd, run.runId, record.path);
		const absolutePath = mapped.absolutePath;
		if (seen.has(absolutePath)) continue;
		const entry: RunWorktree = {
			path: relative(cwd, absolutePath),
			absolutePath,
			branch,
			dirty: false,
			commits: 0,
			...(mapped.error === undefined ? {} : { error: mapped.error }),
		};
		seen.set(absolutePath, entry);
		if (mapped.error === undefined)
			await identifyRunWorktree(cwd, run.runId, mapped.name, entry);
	}
	return [...seen.values()];
}

/**
 * WP42 (WP39b review, finding 2): positively identify a recorded managed worktree before prune
 * touches it. All of: the recorded branch is the managed `agent-workflow/<run>-<task>`; the
 * directory chain from the project down to it is real directories (no symlinked parent); and, when
 * the directory exists, this repository's `git worktree list` registers exactly that path checked
 * out on that branch. A missing directory may still be registered (stale), but only on that branch.
 * Anything else sets `error`: the worktree, its branch and the run are kept.
 */
async function identifyRunWorktree(
	cwd: string,
	runId: string,
	name: string,
	entry: RunWorktree,
): Promise<void> {
	const managed = `agent-workflow/${runId}-${name}`;
	if (!MANAGED_WORKTREE_NAME.test(name)) {
		entry.error = "not a managed worktree name; kept";
		return;
	}
	if (entry.branch !== managed) {
		entry.error = `recorded branch ${entry.branch ?? "(none)"} is not the managed branch ${managed}; kept`;
		return;
	}
	let chain;
	try {
		chain = await physicalDirectoryChain(stateBase(cwd), [
			PROJECT_STATE_DIRECTORY,
			"workflows",
			runId,
			"worktrees",
			name,
		]);
	} catch (error) {
		entry.error = `${errorMessage(error)}; kept`;
		return;
	}
	if (chain.path !== entry.absolutePath) {
		entry.error = "worktree path is not canonical; kept";
		return;
	}
	try {
		let registered: GitWorktreeListing | undefined;
		for (const listed of await listGitWorktrees(cwd))
			if ((await canonicalListedPath(listed.path)) === chain.path) {
				registered = listed;
				break;
			}
		if (!chain.exists) entry.missing = true;
		else if (!registered) {
			entry.error = "not registered as a worktree of this repository; kept";
			return;
		}
		if (registered && registered.branch !== `refs/heads/${managed}`) {
			entry.error = `checked out on ${registered.branch?.replace(/^refs\/heads\//u, "") ?? "a detached HEAD"}, not the managed branch ${managed}; kept`;
			return;
		}
		entry.registered = registered?.path;
		if (chain.exists)
			entry.dirty =
				(await gitText(chain.path, ["status", "--porcelain"])).trim() !== "";
		// WP42 (finding 4): the managed branch's own tip against the checkout's HEAD, also when the
		// directory is missing (its commits are not visible through a worktree then).
		entry.tip = await managedBranchTip(cwd, managed);
		if (entry.tip === undefined) {
			if (chain.exists) {
				entry.error = `managed branch ${managed} not found; kept`;
				return;
			}
			return;
		}
		const checkoutHead = (await gitText(cwd, ["rev-parse", "HEAD"])).trim();
		const commits = Number.parseInt(
			(
				await gitText(cwd, [
					"rev-list",
					"--count",
					entry.tip,
					`^${checkoutHead}`,
				])
			).trim(),
			10,
		);
		if (!Number.isFinite(commits)) {
			entry.error = "unknown commit state; kept";
			return;
		}
		entry.commits = commits;
	} catch (error) {
		entry.error = `git: ${errorMessage(error).split("\n")[0]}`;
	}
}

/** `refs/heads/<branch>`'s commit; undefined when the branch does not exist (other errors throw). */
async function managedBranchTip(
	cwd: string,
	branch: string,
): Promise<string | undefined> {
	try {
		return (
			await gitText(cwd, [
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/heads/${branch}^{commit}`,
			])
		).trim();
	} catch (error) {
		if ((error as { code?: unknown }).code === 1) return undefined;
		throw error;
	}
}

/**
 * WP42 (finding 4): delete a managed branch only when `git merge-base --is-ancestor <tip> HEAD`
 * holds (independent of any upstream), no worktree has it checked out, and it still points at the
 * verified tip (`git update-ref -d <ref> <tip>`). Any unknown state keeps the branch.
 */
async function deleteMergedManagedBranch(
	cwd: string,
	branch: string,
	tip: string,
): Promise<boolean> {
	try {
		const head = (await gitText(cwd, ["rev-parse", "HEAD"])).trim();
		await gitText(cwd, ["merge-base", "--is-ancestor", tip, head]);
		for (const listed of await listGitWorktrees(cwd))
			if (listed.branch === `refs/heads/${branch}`) return false;
		await gitText(cwd, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
	} catch {
		return false;
	}
	await gitText(cwd, ["config", "--remove-section", `branch.${branch}`]).catch(
		() => "",
	);
	return true;
}

/** The fields that must not change between inspection and removal. */
function sameWorktreeState(left: RunWorktree, right: RunWorktree): boolean {
	return (
		left.error === undefined &&
		right.error === undefined &&
		left.absolutePath === right.absolutePath &&
		left.branch === right.branch &&
		left.missing === right.missing &&
		left.registered === right.registered &&
		left.tip === right.tip &&
		left.commits === right.commits
	);
}

/**
 * `prune --yes`: remove each identified worktree (rechecked right before git touches it) and delete
 * its managed branch only when its tip is contained in the checkout's HEAD.
 */
async function removeRunWorktrees(
	cwd: string,
	runId: string,
	worktrees: RunWorktree[],
): Promise<WorkflowPruneWorktree[]> {
	const results: WorkflowPruneWorktree[] = [];
	for (const worktree of worktrees) {
		const { absolutePath, registered, tip, ...entry } = worktree;
		if (entry.error) {
			results.push(entry);
			continue;
		}
		const name = relative(
			join(workflowsRoot(cwd), runId, "worktrees"),
			absolutePath,
		);
		const recheck = async (): Promise<boolean> => {
			const current: RunWorktree = {
				path: entry.path,
				absolutePath,
				branch: entry.branch,
				dirty: false,
				commits: 0,
			};
			await identifyRunWorktree(cwd, runId, name, current);
			if (sameWorktreeState(worktree, current)) return true;
			entry.error = current.error ?? "worktree changed since inspection; kept";
			return false;
		};
		try {
			if (!(await recheck())) {
				results.push(entry);
				continue;
			}
			// A missing directory: only its stale registration (identified above) is removed.
			if (registered !== undefined)
				await gitText(cwd, [
					"worktree",
					"remove",
					"--force",
					entry.missing ? registered : absolutePath,
				]);
			entry.removed = true;
		} catch (error) {
			entry.error = `git worktree remove: ${errorMessage(error).split("\n")[0]}`;
			results.push(entry);
			continue;
		}
		if (entry.branch && tip !== undefined)
			entry.branchDeleted =
				entry.commits === 0 &&
				(await deleteMergedManagedBranch(cwd, entry.branch, tip));
		results.push(entry);
	}
	return results;
}

/** `workflows/auto-router-runs/`: the auto classifier's one-shot runtime runs (workflow-router). */
const AUTO_ROUTER_TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** The runtime's run-lock wait (registry LOCK_TIMEOUT_MS / LOCK_RETRY_MS). */
const AUTO_ROUTER_LOCK_RETRY_MS = 25;
const AUTO_ROUTER_LOCK_RETRIES = 200;

const PINNED_CLASSIFIER_REASON =
	"pinned: an active classifier request has not consumed its result yet";

function isPinned(pins: AutoRouterPinState, updatedAt: string): boolean {
	return (
		pins.pinnedSince !== undefined && Date.parse(updatedAt) >= pins.pinnedSince
	);
}

let beforeClassifierDeleteForTests: (() => void | Promise<void>) | undefined;
export function setWorkflowPruneBeforeClassifierDeleteForTests(
	hook?: () => void | Promise<void>,
): void {
	beforeClassifierDeleteForTests = hook;
}

interface ClassifierCandidate extends WorkflowPruneClassifierRun {
	dir: string;
	identity: { dev: number; ino: number };
}

/** The auto-router directory's physical path; throws unless the whole chain is real directories. */
async function physicalAutoRouterRoot(cwd: string): Promise<string> {
	const chain = await physicalDirectoryChain(stateBase(cwd), [
		PROJECT_STATE_DIRECTORY,
		"workflows",
		AUTO_ROUTER_RUNS_DIR_NAME,
	]);
	if (!chain.exists)
		throw Object.assign(new Error("auto-router-runs is missing"), {
			code: "ENOENT",
		});
	return chain.path;
}

/**
 * A classifier record that may be deleted: positively identified (WP42 finding 3: runtime schema,
 * the router's correlation id and runs directory, a runtime-generated id equal to its directory),
 * terminal, with a parseable `updatedAt`. `kept` explains an unidentified record; an identified
 * record that is not (yet) terminal is neither.
 */
function deletableClassifierRecord(
	record: unknown,
	name: string,
): { status: string; updatedAt: string } | { kept: string } | undefined {
	const unidentified = unidentifiedClassifierReason(record, name);
	if (unidentified) return { kept: unidentified };
	const value = record as { status?: unknown; updatedAt?: unknown };
	if (
		typeof value.status !== "string" ||
		!AUTO_ROUTER_TERMINAL.has(value.status)
	)
		return undefined;
	if (
		typeof value.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.updatedAt))
	)
		return { kept: "unparseable updatedAt" };
	return { status: value.status, updatedAt: value.updatedAt };
}

async function readClassifierRecord(dir: string): Promise<unknown> {
	const file = join(dir, "run.json");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
		throw new Error("unsafe classifier record");
	return JSON.parse(await readFile(file, "utf8")) as unknown;
}

/**
 * WP39b (live bundle 5, O16): classifier requests beyond the filters. Only `run_*` directories
 * (no symlinks) with a readable terminal `run.json` are candidates; with `yes` each is removed.
 * WP42 (WP39b review, finding 1): only when `.agent-workflow/workflows/auto-router-runs` is a chain
 * of real directories inside the project; each deletion rechecks that chain, the directory's
 * identity and its record under the runtime's run lock, then detaches it before removing it.
 */
async function pruneAutoRouterRuns(
	cwd: string,
	keep: number,
	cutoff: number | undefined,
	yes: boolean,
): Promise<{
	runs: WorkflowPruneClassifierRun[];
	preserved: WorkflowPruneKeptEntry[];
}> {
	const preserved: WorkflowPruneKeptEntry[] = [];
	let root: string;
	try {
		root = await physicalAutoRouterRoot(cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			preserved.push({
				name: AUTO_ROUTER_RUNS_DIR_NAME,
				reason: `unsafe directory: ${errorMessage(error)}`,
			});
		return { runs: [], preserved };
	}
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const candidates: ClassifierCandidate[] = [];
	for (const entry of entries) {
		// The runtime's run locks; WP42 F5 classifier pins.
		if (entry.name === RUN_LOCKS_DIR || entry.name === AUTO_ROUTER_PINS_DIR)
			continue;
		const keepEntry = (reason: string) =>
			preserved.push({ name: entry.name, reason });
		if (entry.name.startsWith(".prune-")) {
			keepEntry("left by an interrupted prune");
			continue;
		}
		if (!entry.isDirectory()) {
			keepEntry("not a real directory");
			continue;
		}
		if (!AUTO_ROUTER_RUN_ID_PATTERN.test(entry.name)) {
			keepEntry("not a runtime run id");
			continue;
		}
		const dir = join(root, entry.name);
		try {
			const identity = await lstat(dir);
			if (!identity.isDirectory() || identity.isSymbolicLink()) {
				keepEntry("not a real directory");
				continue;
			}
			const record = deletableClassifierRecord(
				await readClassifierRecord(dir),
				entry.name,
			);
			if (!record) continue;
			if ("kept" in record) {
				keepEntry(record.kept);
				continue;
			}
			candidates.push({
				runId: entry.name,
				...record,
				bytes: await directoryBytes(dir),
				deleted: false,
				dir,
				identity,
			});
		} catch (error) {
			keepEntry(`unreadable run record: ${errorMessage(error)}`);
		}
	}
	candidates.sort(
		(left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
	);
	const selected = candidates.filter(
		(candidate, index) =>
			index >= keep &&
			(cutoff === undefined || Date.parse(candidate.updatedAt) < cutoff),
	);
	const results: WorkflowPruneClassifierRun[] = [];
	// WP42 (finding 5): a live per-request pin keeps the results its caller has not consumed yet.
	const pins = await readAutoRouterPins(root, yes);
	for (const { dir, identity, ...entry } of selected) {
		if (isPinned(pins, entry.updatedAt)) {
			entry.protected = true;
			entry.error = PINNED_CLASSIFIER_REASON;
			results.push(entry);
			continue;
		}
		if (yes)
			try {
				await beforeClassifierDeleteForTests?.();
				await deleteClassifierRun(cwd, root, { ...entry, dir, identity });
				entry.deleted = true;
			} catch (error) {
				if ((error as { pinned?: unknown }).pinned === true)
					entry.protected = true;
				entry.error = errorMessage(error);
			}
		results.push(entry);
	}
	return { runs: results, preserved };
}

/**
 * Delete one selected classifier request. Under the runtime's lock for that run (the one its
 * writers hold), recheck the physical chain, the directory's identity and its record, then rename
 * it into a fresh `.prune-*` container in the same directory and remove that container.
 */
async function deleteClassifierRun(
	cwd: string,
	root: string,
	candidate: ClassifierCandidate,
): Promise<void> {
	const recheck = async () => {
		if ((await physicalAutoRouterRoot(cwd)) !== root)
			throw new Error("auto-router-runs changed since selection");
		const info = await lstat(candidate.dir);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			info.dev !== candidate.identity.dev ||
			info.ino !== candidate.identity.ino
		)
			throw new Error("classifier request changed since selection");
		const record = deletableClassifierRecord(
			await readClassifierRecord(candidate.dir),
			candidate.runId,
		);
		if (!record || "kept" in record || record.updatedAt !== candidate.updatedAt)
			throw new Error("classifier request changed since selection");
		if (isPinned(await readAutoRouterPins(root), record.updatedAt))
			throw Object.assign(new Error(PINNED_CLASSIFIER_REASON), {
				pinned: true,
			});
	};
	await recheck();
	// The runtime's lock directory (created like the runtime does, but never through a symlink).
	await mkdir(join(root, RUN_LOCKS_DIR)).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	});
	const locks = await physicalDirectoryChain(root, [RUN_LOCKS_DIR]).catch(
		() => undefined,
	);
	if (!locks?.exists) throw new Error("unsafe classifier lock directory");
	const release = await acquireDirectoryLock(
		join(locks.path, `${candidate.runId}.lock`),
		{ retries: AUTO_ROUTER_LOCK_RETRIES, retryMs: AUTO_ROUTER_LOCK_RETRY_MS },
	);
	try {
		await recheck();
		const container = await mkdtemp(join(root, ".prune-"));
		try {
			await recheck();
			await rename(candidate.dir, join(container, "run"));
		} catch (error) {
			await rm(container, { recursive: true, force: true }).catch(
				() => undefined,
			);
			throw error;
		}
		await rm(container, { recursive: true, force: true });
	} finally {
		await release().catch(() => undefined);
	}
}
