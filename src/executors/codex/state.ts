/**
 * Durable attempt evidence for the Codex adapter (B3, R#1, R#15). One JSON record and one event
 * log per attemptKey under `<stateDir>/attempts/`, so a restarted executor (or a fresh process
 * reloaded from the descriptor) can answer submit/reconcile/observe without a second launch.
 * Records hold no prompt, env value or credential: attemptKey digest, phase, ExecRef, pid, thread
 * id. The event log holds the normalized events (the same view the runtime persists). WP18b:
 * terminal records older than the retention window are pruned (`classifyCodexAttemptRecord`).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecRef } from "../../sdk/contract.js";
import type { ExecEvent } from "../../sdk/events.js";
import {
	type AttemptRecordClass,
	type AttemptTombstone,
	attemptTombstoneReason,
	parseAttemptTombstone,
} from "../state-retention.js";

export type AttemptPhase = "revoked" | "consumed" | "spawned" | "terminal";

export interface AttemptRecord {
	readonly schema: "agent-workflow-codex-attempt-v1";
	readonly attemptKey: string;
	readonly phase: AttemptPhase;
	readonly updatedAt: number;
	readonly ref?: ExecRef;
	readonly pid?: number;
	readonly threadId?: string;
	readonly terminal?: "completed" | "failed";
}

export type AttemptLookup =
	| { readonly status: "missing" }
	| { readonly status: "found"; readonly record: AttemptRecord }
	| {
			readonly status: "unreadable";
			readonly reason: string;
			/** WP19: the record was replaced by a retention tombstone. */
			readonly pruned?: AttemptTombstone;
	  };

const ATTEMPT_PHASES: ReadonlySet<unknown> = new Set([
	"revoked",
	"consumed",
	"spawned",
	"terminal",
]);

export function attemptDigest(attemptKey: string): string {
	return createHash("sha256").update(attemptKey).digest("hex").slice(0, 32);
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.AGENT_WORKFLOW_HOME ?? join(homedir(), ".agent-workflow");
	return join(home, "executors", "codex");
}

export class AttemptStore {
	readonly dir: string;

	constructor(stateDir: string) {
		this.dir = join(stateDir, "attempts");
	}

	private base(attemptKey: string): string {
		return join(this.dir, attemptDigest(attemptKey));
	}

	/** Per-attempt directory for CLI logs (`-c log_dir=…`); also the launch marker in argv. */
	logDir(attemptKey: string): string {
		return `${this.base(attemptKey)}.log`;
	}

	/**
	 * Durable evidence of an attempt (review #3): `missing` only on ENOENT; a record that cannot be
	 * read, parsed or matched to the attemptKey is `unreadable` and must be treated as ambiguous
	 * (reconcile `unknown`, no launch), never as absence.
	 */
	lookup(attemptKey: string): AttemptLookup {
		let text: string;
		try {
			text = readFileSync(`${this.base(attemptKey)}.json`, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { status: "missing" };
			return {
				status: "unreadable",
				reason: `attempt record unreadable (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
			};
		}
		let record: AttemptRecord;
		try {
			record = JSON.parse(text) as AttemptRecord;
		} catch {
			return { status: "unreadable", reason: "attempt record is malformed" };
		}
		// WP19: a pruned launched attempt is ambiguous (launched, outcome kept), never missing.
		const tombstone = parseAttemptTombstone(record);
		if (tombstone)
			return {
				status: "unreadable",
				reason: attemptTombstoneReason(tombstone),
				pruned: tombstone,
			};
		if (
			record === null ||
			typeof record !== "object" ||
			record.schema !== "agent-workflow-codex-attempt-v1" ||
			!ATTEMPT_PHASES.has(record.phase)
		)
			return { status: "unreadable", reason: "attempt record is malformed" };
		if (record.attemptKey !== attemptKey)
			return {
				status: "unreadable",
				reason: "attempt record belongs to another attemptKey",
			};
		return { status: "found", record };
	}

	/** The record when readable; `undefined` when missing or unreadable (observe paths only). */
	read(attemptKey: string): AttemptRecord | undefined {
		const lookup = this.lookup(attemptKey);
		return lookup.status === "found" ? lookup.record : undefined;
	}

	/**
	 * Create the first record exclusively: two processes racing on one attemptKey cannot both
	 * claim it. The record is written to a temp file and hard-linked into place (`link` fails with
	 * EEXIST), so a reader never sees a half-written claim. Returns false when a record exists.
	 */
	create(record: Omit<AttemptRecord, "schema" | "updatedAt">): boolean {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const path = `${this.base(record.attemptKey)}.json`;
		const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(temp, JSON.stringify(this.full(record)), { mode: 0o600 });
		try {
			linkSync(temp, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		} finally {
			rmSync(temp, { force: true });
		}
	}

	write(record: Omit<AttemptRecord, "schema" | "updatedAt">): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const path = `${this.base(record.attemptKey)}.json`;
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(this.full(record)), { mode: 0o600 });
		renameSync(temp, path);
	}

	appendEvent(attemptKey: string, event: ExecEvent): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		appendFileSync(
			`${this.base(attemptKey)}.events.jsonl`,
			`${JSON.stringify(event)}\n`,
			{
				mode: 0o600,
			},
		);
	}

	events(attemptKey: string): ExecEvent[] {
		let text: string;
		try {
			text = readFileSync(`${this.base(attemptKey)}.events.jsonl`, "utf8");
		} catch {
			return [];
		}
		const events: ExecEvent[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				events.push(JSON.parse(line) as ExecEvent);
			} catch {
				// partially written last line
			}
		}
		return events;
	}

	private full(
		record: Omit<AttemptRecord, "schema" | "updatedAt">,
	): AttemptRecord {
		return {
			schema: "agent-workflow-codex-attempt-v1",
			...record,
			updatedAt: Date.now(),
		};
	}
}

/**
 * When a process started, to tell it from a later process that reused its pid: Linux reads `starttime` from
 * /proc, other systems ask `ps`. undefined when it cannot be read.
 */
export function processStartIdentity(pid: number): string | undefined {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// Fields after "(comm) " start at field 3; starttime is field 22.
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
		}
		// Fixed time zone and locale: the same process must read the same in every environment (round 4).
		const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			env: { ...process.env, TZ: "UTC0", LC_ALL: "C" },
			encoding: "utf8",
			timeout: 2_000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return started === "" ? undefined : started;
	} catch {
		return undefined;
	}
}

export function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface ThreadOwnershipRecord {
	readonly schema: "agent-workflow-codex-thread-v1";
	readonly threadId: string;
	readonly attemptKey: string;
	readonly createdAt: number;
	/** The kept thread's private CODEX_HOME, when it was created in one (re-review 2026-11-09). */
	readonly home?: string;
	/** The user's CODEX_HOME that private home links into (round 3: never re-derived from a later env). */
	readonly userHome?: string;
}

/**
 * Durable ownership evidence for kept Codex threads (D3, R#10, review #9): one record per thread
 * this adapter created with `thread/start`, under `<stateDir>/sessions/`. `deleteOwnedSession`
 * and the `ownedSession` of a resumed thread require it; a thread the adapter did not create
 * (user thread, resumed foreign thread) never gets one.
 */
export class ThreadOwnershipStore {
	readonly dir: string;

	constructor(stateDir: string) {
		this.dir = join(stateDir, "sessions");
	}

	private path(threadId: string): string {
		return join(
			this.dir,
			`${createHash("sha256").update(threadId).digest("hex").slice(0, 40)}.json`,
		);
	}

	record(
		threadId: string,
		attemptKey: string,
		home?: { readonly home: string; readonly userHome: string },
	): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const path = this.path(threadId);
		const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		const record: ThreadOwnershipRecord = {
			schema: "agent-workflow-codex-thread-v1",
			threadId,
			attemptKey,
			createdAt: Date.now(),
			...(home === undefined
				? {}
				: { home: home.home, userHome: home.userHome }),
		};
		writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
		renameSync(temp, path);
	}

	/** True only for a readable record naming exactly this thread. */
	owns(threadId: string): boolean {
		try {
			const record = JSON.parse(
				readFileSync(this.path(threadId), "utf8"),
			) as Partial<ThreadOwnershipRecord> | null;
			return (
				record?.schema === "agent-workflow-codex-thread-v1" &&
				record.threadId === threadId
			);
		} catch {
			return false;
		}
	}

	/** The private home a recorded thread was created in (and the user home it links into), if any. */
	home(
		threadId: string,
	): { readonly home: string; readonly userHome?: string } | undefined {
		try {
			const record = JSON.parse(
				readFileSync(this.path(threadId), "utf8"),
			) as Partial<ThreadOwnershipRecord> | null;
			if (record?.threadId !== threadId || typeof record.home !== "string")
				return undefined;
			return {
				home: record.home,
				...(typeof record.userHome === "string"
					? { userHome: record.userHome }
					: {}),
			};
		} catch {
			return undefined;
		}
	}

	/** Every private home a thread record names (orphan sweep). */
	recordedHomes(): Set<string> {
		const homes = new Set<string>();
		let names: string[] = [];
		try {
			names = readdirSync(this.dir);
		} catch {
			return homes;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			try {
				const record = JSON.parse(
					readFileSync(join(this.dir, name), "utf8"),
				) as Partial<ThreadOwnershipRecord> | null;
				if (typeof record?.home === "string") homes.add(record.home);
			} catch {}
		}
		return homes;
	}

	forget(threadId: string): void {
		rmSync(this.path(threadId), { force: true });
	}
}

/**
 * WP18b retention: a Codex attempt is terminal in phase `terminal` or `revoked`, or `spawned` with
 * its app-server process gone. Its event log and `<h>.log/` dir go with the record.
 */
export function classifyCodexAttemptRecord(
	record: unknown,
): AttemptRecordClass | undefined {
	const value = record as Partial<AttemptRecord> | null;
	if (value?.schema !== "agent-workflow-codex-attempt-v1") return undefined;
	return {
		terminal:
			value.phase === "terminal" ||
			value.phase === "revoked" ||
			(value.phase === "spawned" && !processAlive(value.pid)),
		// WP19: a launched attempt leaves a tombstone with its terminal outcome.
		launched: value.phase === "spawned" || value.phase === "terminal",
		...(typeof value.terminal === "string" ? { outcome: value.terminal } : {}),
		...(typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
			? { updatedAtMs: value.updatedAt }
			: {}),
	};
}
