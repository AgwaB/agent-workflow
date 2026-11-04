/**
 * Durable ACP adapter state (B3, R#1), the Claude adapter's attempt records without session
 * records (ACP sessions are not kept, design note D8): one record per attempt under
 * `config.stateDir`. `revoked` or no record ⇒ `absent`; `consumed` without launch evidence ⇒
 * `unknown`; `spawned` ⇒ `found`. The first record of an attempt is claimed exclusively.
 * Records hold no env values and no prompt text.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecRef } from "../../sdk/contract.js";
import {
	type AttemptRecordClass,
	type AttemptTombstone,
	attemptTombstoneReason,
	parseAttemptTombstone,
	processAlive,
} from "../state-retention.js";
import { writeAtomic } from "../state-files.js";

export interface AttemptRecord {
	readonly schema: "agent-workflow-acp-attempt-v1";
	readonly attemptKey: string;
	readonly phase: "consumed" | "spawned" | "revoked";
	readonly sessionId: string | null;
	readonly ref?: ExecRef;
	readonly pid?: number | null;
	readonly cwd?: string;
	/** Raw stream-json log (the evidence; normalized events are a view over it, D3). */
	readonly rawPath?: string;
	readonly stderrPath?: string;
	readonly updatedAt: string;
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
	"consumed",
	"spawned",
	"revoked",
]);

const keyHash = (attemptKey: string) =>
	createHash("sha256").update(attemptKey).digest("hex").slice(0, 40);

export class AcpStateStore {
	readonly dir: string;

	constructor(stateDir: string) {
		this.dir = stateDir;
	}

	private attemptsDir() {
		return join(this.dir, "attempts");
	}

	/** Directory for adapter files of an attempt without a runtime `artifactsDir`. */
	attemptFilesDir(attemptKey: string): string {
		return join(this.attemptsDir(), keyHash(attemptKey));
	}

	/**
	 * Durable evidence of an attempt (review #3): `missing` only when the record does not exist
	 * (ENOENT); a record that cannot be read, parsed or matched to the attemptKey is `unreadable`,
	 * which callers must treat as ambiguous (reconcile `unknown`, no launch), never as absence.
	 */
	async lookupAttempt(attemptKey: string): Promise<AttemptLookup> {
		let text: string;
		try {
			text = await readFile(
				join(this.attemptsDir(), `${keyHash(attemptKey)}.json`),
				"utf8",
			);
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
			record.schema !== "agent-workflow-acp-attempt-v1" ||
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

	/** The record when it is readable; `undefined` when missing or unreadable (observe paths only). */
	async readAttempt(attemptKey: string): Promise<AttemptRecord | undefined> {
		const lookup = await this.lookupAttempt(attemptKey);
		return lookup.status === "found" ? lookup.record : undefined;
	}

	/**
	 * Claim the attempt with an exclusive create (`O_EXCL`, review #2): two executor instances or
	 * processes racing on one attemptKey cannot both claim it. The record is written to a temp file
	 * and hard-linked into place, so a reader never sees a half-written claim. Returns false when a
	 * record already exists (the caller resolves it instead of overwriting it).
	 */
	async claimAttempt(
		record: Omit<AttemptRecord, "schema" | "updatedAt">,
	): Promise<boolean> {
		await mkdir(this.attemptsDir(), { recursive: true, mode: 0o700 });
		const path = join(this.attemptsDir(), `${keyHash(record.attemptKey)}.json`);
		const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(
			tmp,
			`${JSON.stringify({
				schema: "agent-workflow-acp-attempt-v1",
				...record,
				updatedAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		try {
			await link(tmp, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		} finally {
			await rm(tmp, { force: true });
		}
	}

	/** Replace this instance's own claimed record (after `claimAttempt` succeeded). */
	async writeAttempt(
		record: Omit<AttemptRecord, "schema" | "updatedAt">,
	): Promise<void> {
		await mkdir(this.attemptsDir(), { recursive: true, mode: 0o700 });
		await writeAtomic(
			join(this.attemptsDir(), `${keyHash(record.attemptKey)}.json`),
			{
				schema: "agent-workflow-acp-attempt-v1",
				...record,
				updatedAt: new Date().toISOString(),
			},
		);
	}
}

/**
 * WP18b retention: an ACP attempt is terminal when revoked or spawned and its process is gone
 * (the adapter has no terminal phase; `consumed` without launch evidence stays, it reconciles as
 * `unknown`).
 */
export function classifyAcpAttemptRecord(
	record: unknown,
): AttemptRecordClass | undefined {
	const value = record as Partial<AttemptRecord> | null;
	if (value?.schema !== "agent-workflow-acp-attempt-v1") return undefined;
	const updatedAtMs = Date.parse(String(value.updatedAt));
	return {
		terminal:
			value.phase === "revoked" ||
			(value.phase === "spawned" && !processAlive(value.pid)),
		// WP19: a spawned attempt leaves a tombstone (the adapter records no outcome).
		launched: value.phase === "spawned",
		...(Number.isFinite(updatedAtMs) ? { updatedAtMs } : {}),
	};
}
