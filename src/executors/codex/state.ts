/**
 * Durable attempt evidence for the Codex adapter (B3, R#1, R#15). One JSON record and one event
 * log per attemptKey under `<stateDir>/attempts/`, so a restarted executor (or a fresh process
 * reloaded from the descriptor) can answer submit/reconcile/observe without a second launch.
 * Records hold no prompt, env value or credential: attemptKey digest, phase, ExecRef, pid, thread
 * id. The event log holds the normalized events (the same view the runtime persists).
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecRef } from "../../sdk/contract.js";
import type { ExecEvent } from "../../sdk/events.js";

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

	read(attemptKey: string): AttemptRecord | undefined {
		try {
			const record = JSON.parse(
				readFileSync(`${this.base(attemptKey)}.json`, "utf8"),
			) as AttemptRecord;
			return record.attemptKey === attemptKey ? record : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Create the first record exclusively (`O_EXCL`): two processes racing on one attemptKey
	 * cannot both claim it. Returns false when a record already exists.
	 */
	create(record: Omit<AttemptRecord, "schema" | "updatedAt">): boolean {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		let fd: number;
		try {
			fd = openSync(`${this.base(record.attemptKey)}.json`, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		try {
			writeSync(fd, JSON.stringify(this.full(record)));
		} finally {
			closeSync(fd);
		}
		return true;
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

export function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
