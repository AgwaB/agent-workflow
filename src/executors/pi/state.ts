// New in agent-workflow (WP6): durable launch evidence for the Pi executor (B3, R#1, R#15). One JSON
// record per attempt under `<stateDir>/attempts/`, so a restarted or fresh process can answer
// `submit` (same ref, no second effect) and `reconcile` (`found` / `absent` / `unknown`).
// Phases: pending (written before consume) → revoked | consumed → spawned → exited. A record left in
// `pending` or `consumed` is "consumed without launch evidence" and reconciles as `unknown`.
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecRef } from "../../sdk/contract.js";
import type { OwnedSession } from "../../sdk/events.js";

export type PiAttemptPhase =
	| "pending"
	| "revoked"
	| "consumed"
	| "spawned"
	| "exited";

export interface PiAttemptExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly cancelled: boolean;
}

export interface PiAttemptRecord {
	readonly schema: "agent-workflow-pi-attempt-v1";
	readonly attemptKey: string;
	readonly phase: PiAttemptPhase;
	readonly updatedAt: string;
	/** Directory with the raw Pi stream (`pi-stdout.jsonl`) and stderr. */
	readonly runDir?: string;
	readonly ref?: ExecRef;
	readonly pid?: number;
	readonly processGroupId?: number;
	readonly identity?: {
		readonly pid: number;
		readonly processGroupId: number;
		readonly birthIdentity: string;
	} | null;
	readonly sessionId?: string | null;
	readonly ownedSession?: OwnedSession;
	readonly spawnError?: string;
	readonly exit?: PiAttemptExit;
}

export type PiAttemptLookup =
	| { readonly status: "missing" }
	| { readonly status: "found"; readonly record: PiAttemptRecord }
	| { readonly status: "unreadable"; readonly reason: string };

const PI_ATTEMPT_PHASES: ReadonlySet<unknown> = new Set([
	"pending",
	"revoked",
	"consumed",
	"spawned",
	"exited",
]);

export function attemptDigest(attemptKey: string): string {
	return createHash("sha256").update(attemptKey).digest("hex");
}

export class PiAttemptStore {
	readonly dir: string;

	constructor(stateDir: string) {
		this.dir = join(stateDir, "attempts");
	}

	path(attemptKey: string): string {
		return join(this.dir, `${attemptDigest(attemptKey)}.json`);
	}

	/**
	 * Durable evidence of an attempt (review #3): `missing` only on ENOENT; a record that cannot be
	 * read, parsed or matched to the attemptKey is `unreadable` and must be treated as ambiguous
	 * (reconcile `unknown`, no launch), never as absence.
	 */
	async lookup(attemptKey: string): Promise<PiAttemptLookup> {
		let text: string;
		try {
			text = await readFile(this.path(attemptKey), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { status: "missing" };
			return {
				status: "unreadable",
				reason: `attempt record unreadable (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
			};
		}
		let record: PiAttemptRecord;
		try {
			record = JSON.parse(text) as PiAttemptRecord;
		} catch {
			return { status: "unreadable", reason: "attempt record is malformed" };
		}
		if (
			record === null ||
			typeof record !== "object" ||
			record.schema !== "agent-workflow-pi-attempt-v1" ||
			!PI_ATTEMPT_PHASES.has(record.phase)
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
	async read(attemptKey: string): Promise<PiAttemptRecord | undefined> {
		const lookup = await this.lookup(attemptKey);
		return lookup.status === "found" ? lookup.record : undefined;
	}

	/**
	 * Create the first record exclusively (temp file hard-linked into place, so a reader never
	 * sees a half-written claim). Returns false when another submit got there first.
	 */
	async create(
		record: Omit<PiAttemptRecord, "schema" | "updatedAt">,
	): Promise<boolean> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const target = this.path(record.attemptKey);
		const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(temp, `${JSON.stringify(this.stamp(record))}\n`, {
			mode: 0o600,
		});
		try {
			await link(temp, target);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		} finally {
			await rm(temp, { force: true });
		}
	}

	/** Atomic replace (temp + rename). */
	async write(
		record: Omit<PiAttemptRecord, "schema" | "updatedAt">,
	): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const target = this.path(record.attemptKey);
		const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(temp, `${JSON.stringify(this.stamp(record))}\n`, {
			mode: 0o600,
		});
		await rename(temp, target);
	}

	private stamp(
		record: Omit<PiAttemptRecord, "schema" | "updatedAt">,
	): PiAttemptRecord {
		return {
			schema: "agent-workflow-pi-attempt-v1",
			...record,
			updatedAt: new Date().toISOString(),
		};
	}
}
