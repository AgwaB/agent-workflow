/**
 * Durable adapter state (B3, R#1, R#10): one record per attempt and one per kept worker session,
 * under `config.stateDir`. Reconcile in a fresh process reads these records: `revoked` or no record
 * ⇒ `absent`; `consumed` without launch evidence ⇒ `unknown`; `spawned` ⇒ `found`. The first
 * record of an attempt is claimed exclusively (review #2).
 * Records hold no env values and no prompt text.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecRef } from "../../sdk/contract.js";

export interface AttemptRecord {
	readonly schema: "agent-workflow-claude-attempt-v1";
	readonly attemptKey: string;
	readonly phase: "consumed" | "spawned" | "revoked";
	readonly sessionId: string | null;
	readonly keepSession: boolean;
	readonly ref?: ExecRef;
	readonly pid?: number | null;
	readonly cwd?: string;
	/** Raw stream-json log (the evidence; normalized events are a view over it, D3). */
	readonly rawPath?: string;
	readonly stderrPath?: string;
	readonly updatedAt: string;
}

export interface SessionRecord {
	readonly schema: "agent-workflow-claude-session-v1";
	readonly sessionId: string;
	readonly attemptKey: string;
	readonly cwd: string;
	readonly createdAt: string;
}

const keyHash = (attemptKey: string) =>
	createHash("sha256").update(attemptKey).digest("hex").slice(0, 40);

async function writeAtomic(path: string, value: unknown): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export class ClaudeStateStore {
	readonly dir: string;

	constructor(stateDir: string) {
		this.dir = stateDir;
	}

	private attemptsDir() {
		return join(this.dir, "attempts");
	}

	private sessionsDir() {
		return join(this.dir, "sessions");
	}

	/** Directory for adapter files of an attempt without a runtime `artifactsDir`. */
	attemptFilesDir(attemptKey: string): string {
		return join(this.attemptsDir(), keyHash(attemptKey));
	}

	async readAttempt(attemptKey: string): Promise<AttemptRecord | undefined> {
		const record = await readJson<AttemptRecord>(
			join(this.attemptsDir(), `${keyHash(attemptKey)}.json`),
		);
		return record?.attemptKey === attemptKey ? record : undefined;
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
				schema: "agent-workflow-claude-attempt-v1",
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
				schema: "agent-workflow-claude-attempt-v1",
				...record,
				updatedAt: new Date().toISOString(),
			},
		);
	}

	async recordSession(record: Omit<SessionRecord, "schema" | "createdAt">) {
		await mkdir(this.sessionsDir(), { recursive: true, mode: 0o700 });
		await writeAtomic(join(this.sessionsDir(), `${record.sessionId}.json`), {
			schema: "agent-workflow-claude-session-v1",
			...record,
			createdAt: new Date().toISOString(),
		});
	}

	async readSession(sessionId: string): Promise<SessionRecord | undefined> {
		const record = await readJson<SessionRecord>(
			join(this.sessionsDir(), `${sessionId}.json`),
		);
		return record?.sessionId === sessionId ? record : undefined;
	}

	async forgetSession(sessionId: string): Promise<void> {
		await rm(join(this.sessionsDir(), `${sessionId}.json`), { force: true });
	}
}
