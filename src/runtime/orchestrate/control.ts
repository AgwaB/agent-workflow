// New in agent-workflow (WP2b): the durable control channel into a running attempt — a file
// mailbox in `<attemptDir>/control/` that survives the launching host exiting and a supervisor
// restarting (stage-1 plan §2.1 R#2/R#4, decisions D2, B3). The process that executes the attempt
// (the durable worker, or the in-process caller of a sync run) serves it; any process that can
// read the run directory can write to it.
//
// Files (seq is a positive integer, zero-padded to SEQ_WIDTH digits):
//   <seq>.seq             engine-side reservation (O_EXCL) so concurrent requesters never share a seq
//   <seq>-<type>.json     request, written atomically (temp + rename): approval_response
//                         {requestId, decision} | cancel {scope}
//   <seq>.ack.json        exactly one ack per seq, created exclusively (temp + link)
//   closed.json           the server stopped (written before the attempt's terminal result)
//   rejected.jsonl        rejections that could not get an ack (duplicate seq after an ack, gaps)
// Approval audit: `<attemptDir>/approvals.jsonl` (requested / decided records, decided `by`
// engine-policy | host | default-timeout).
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalDecision } from "../../sdk/approval.js";
import type {
	ApprovalResponseResult,
	CancelResult,
	CancelScope,
} from "../../sdk/contract.js";

export const CONTROL_DIR = "control";
export const APPROVAL_AUDIT_FILE = "approvals.jsonl";
export const CONTROL_REQUEST_SCHEMA = "agent-workflow-control-request-v1";
export const CONTROL_ACK_SCHEMA = "agent-workflow-control-ack-v1";
export const CONTROL_CLOSED_SCHEMA = "agent-workflow-control-closed-v1";
export const APPROVAL_AUDIT_SCHEMA = "agent-workflow-approval-audit-v1";
export const CONTROL_REQUEST_TYPES = ["approval_response", "cancel"] as const;
export type ControlRequestType = (typeof CONTROL_REQUEST_TYPES)[number];
const SEQ_WIDTH = 6;
const REQUEST_FILE = /^(\d+)-([a-z_]+)\.json$/u;
const ACK_FILE = /^(\d+)\.ack\.json$/u;
const RESERVATION_FILE = /^(\d+)\.seq$/u;
/** How long the server waits for a reserved lower seq whose request file has not appeared yet. */
export const CONTROL_GAP_WAIT_MS = 2_000;
export const DEFAULT_CONTROL_POLL_MS = 50;

export function controlPollMs(): number {
	const raw = Number.parseInt(
		process.env.AGENT_WORKFLOW_CONTROL_POLL_MS ?? "",
		10,
	);
	return Number.isFinite(raw) && raw >= 5 ? raw : DEFAULT_CONTROL_POLL_MS;
}

export type ApprovalDecider = "engine-policy" | "host" | "default-timeout";

export interface ControlRequest {
	schema: typeof CONTROL_REQUEST_SCHEMA;
	seq: number;
	type: string;
	requestedAt: string;
	requester: { pid: number; host: string };
	requestId?: string;
	decision?: ApprovalDecision;
	scope?: CancelScope;
}

export type ControlAckError =
	| "unknown_type"
	| "invalid_request"
	| "out_of_order"
	| "duplicate_seq";

export interface ControlAck {
	schema: typeof CONTROL_ACK_SCHEMA;
	seq: number;
	type: string;
	/** The request file this ack answers (a requester whose file differs lost a duplicate seq). */
	request: string;
	ok: boolean;
	/** approval_response → ApprovalResponseResult; cancel → CancelResult. */
	result?: ApprovalResponseResult | CancelResult;
	error?: ControlAckError;
	detail?: string;
	/** "worker": applied by the serving process; "closed": answered by the closing sweep;
	 * "requester": self-acked because the mailbox was closed or the attempt terminal. */
	by: "worker" | "closed" | "requester";
	ackedAt: string;
}

export interface ControlClosed {
	schema: typeof CONTROL_CLOSED_SCHEMA;
	closedAt: string;
	/** Highest request seq acked by the closing sweep (every request ≤ lastSeq has an ack). */
	lastSeq: number;
	pid: number;
}

export function controlDirOf(attemptDir: string): string {
	return join(attemptDir, CONTROL_DIR);
}

export function formatSeq(seq: number): string {
	return String(seq).padStart(SEQ_WIDTH, "0");
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeDurable(
	path: string,
	text: string,
	flag: "w" | "a",
): Promise<void> {
	const handle = await open(path, flag, 0o600);
	try {
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Write a file atomically under its final name (temp + rename). */
async function writeAtomic(path: string, value: unknown): Promise<void> {
	const dir = join(path, "..");
	const temp = join(
		dir,
		`.${randomBytes(6).toString("hex")}.${process.pid}.tmp`,
	);
	await writeDurable(temp, `${JSON.stringify(value, null, 2)}\n`, "w");
	await rename(temp, path);
}

/** Create a file exclusively with its full content (temp + link). Returns false when it exists. */
async function createExclusive(path: string, value: unknown): Promise<boolean> {
	const dir = join(path, "..");
	const temp = join(
		dir,
		`.${randomBytes(6).toString("hex")}.${process.pid}.tmp`,
	);
	await writeDurable(temp, `${JSON.stringify(value, null, 2)}\n`, "w");
	try {
		await link(temp, path);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

export async function appendJsonLineDurable(
	path: string,
	value: unknown,
): Promise<void> {
	await writeDurable(path, `${JSON.stringify(value)}\n`, "a");
}

interface MailboxListing {
	requests: Map<number, string[]>;
	acks: Set<number>;
	reservations: Map<number, string>;
	closed: boolean;
}

async function listMailbox(dir: string): Promise<MailboxListing> {
	const listing: MailboxListing = {
		requests: new Map(),
		acks: new Set(),
		reservations: new Map(),
		closed: false,
	};
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return listing;
		throw error;
	}
	for (const name of names) {
		if (name === "closed.json") {
			listing.closed = true;
			continue;
		}
		const request = REQUEST_FILE.exec(name);
		if (request !== null) {
			const seq = Number(request[1]);
			listing.requests.set(seq, [...(listing.requests.get(seq) ?? []), name]);
			continue;
		}
		const ack = ACK_FILE.exec(name);
		if (ack !== null) {
			listing.acks.add(Number(ack[1]));
			continue;
		}
		const reservation = RESERVATION_FILE.exec(name);
		if (reservation !== null)
			listing.reservations.set(Number(reservation[1]), name);
	}
	return listing;
}

function ackPath(dir: string, seq: number): string {
	return join(dir, `${formatSeq(seq)}.ack.json`);
}

async function writeAck(
	dir: string,
	ack: Omit<ControlAck, "schema" | "ackedAt">,
): Promise<ControlAck> {
	const full: ControlAck = {
		schema: CONTROL_ACK_SCHEMA,
		...ack,
		ackedAt: new Date().toISOString(),
	};
	if (await createExclusive(ackPath(dir, ack.seq), full)) return full;
	return (await readJson<ControlAck>(ackPath(dir, ack.seq))) ?? full;
}

/** The answer a request gets when nobody will apply it any more (attempt over / mailbox closed). */
function terminalAnswer(
	type: string,
): Pick<ControlAck, "ok" | "result" | "error"> {
	if (type === "approval_response") return { ok: true, result: "too_late" };
	if (type === "cancel") return { ok: true, result: "no_active" };
	return { ok: false, error: "unknown_type" };
}

function validateRequest(
	request: ControlRequest | undefined,
	seq: number,
	type: string,
): string | undefined {
	if (request === undefined) return "request is not valid JSON";
	if (request.schema !== CONTROL_REQUEST_SCHEMA)
		return `schema must be ${CONTROL_REQUEST_SCHEMA}`;
	if (request.seq !== seq) return `seq ${request.seq} does not match the file`;
	if (request.type !== type)
		return `type ${request.type} does not match the file`;
	if (type === "approval_response") {
		if (typeof request.requestId !== "string" || request.requestId === "")
			return "requestId must be a non-empty string";
		if (request.decision !== "allow" && request.decision !== "deny")
			return 'decision must be "allow" or "deny"';
	}
	if (
		type === "cancel" &&
		request.scope !== "turn" &&
		request.scope !== "owned"
	)
		return 'scope must be "turn" or "owned"';
	return undefined;
}

export interface ControlHandlers {
	approval(
		requestId: string,
		decision: ApprovalDecision,
		seq: number,
	): Promise<ApprovalResponseResult>;
	cancel(scope: CancelScope, seq: number): Promise<CancelResult>;
}

export interface ControlServer {
	/** Stop serving: write closed.json, answer every unacked request (too_late / no_active). */
	close(): Promise<void>;
}

/**
 * Serve the mailbox: apply each request exactly once in seq order (an ack marks it applied) and
 * ack it. Duplicate seqs, seqs below the last applied one, unknown types and invalid requests are
 * rejected with an error ack (or, when the seq already has an ack, recorded in rejected.jsonl).
 */
export async function startControlServer(options: {
	attemptDir: string;
	handlers: ControlHandlers;
	pollMs?: number;
}): Promise<ControlServer> {
	const dir = controlDirOf(options.attemptDir);
	await mkdir(dir, { recursive: true });
	const pollMs = options.pollMs ?? controlPollMs();
	const recordedRejections = new Set<string>();
	let lastApplied = Math.max(0, ...(await listMailbox(dir)).acks);
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: Promise<void> = Promise.resolve();

	const reject = async (
		seq: number,
		name: string,
		type: string,
		error: ControlAckError,
		detail: string,
	) => {
		const ack = await writeAck(dir, {
			seq,
			type,
			request: name,
			ok: false,
			error,
			detail,
			by: "worker",
		});
		if (ack.request !== name) await recordRejection(name, seq, error, detail);
	};
	const recordRejection = async (
		name: string,
		seq: number,
		error: ControlAckError | "gap",
		detail: string,
	) => {
		const key = `${name}:${error}`;
		if (recordedRejections.has(key)) return;
		recordedRejections.add(key);
		await appendJsonLineDurable(join(dir, "rejected.jsonl"), {
			seq,
			request: name,
			error,
			detail,
			at: new Date().toISOString(),
		}).catch(() => undefined);
	};

	async function tick(): Promise<void> {
		const listing = await listMailbox(dir);
		const pending = [...listing.requests.keys()]
			.filter((seq) => !listing.acks.has(seq))
			.sort((a, b) => a - b);
		// Duplicates of an already acked seq cannot get their own ack: record them.
		for (const [seq, names] of listing.requests)
			if (listing.acks.has(seq) && names.length > 1) {
				const ack = await readJson<ControlAck>(ackPath(dir, seq));
				for (const name of names)
					if (name !== ack?.request)
						await recordRejection(
							name,
							seq,
							"duplicate_seq",
							`seq ${seq} was already answered for ${ack?.request ?? "another request"}`,
						);
			}
		for (const seq of pending) {
			if (stopped) return;
			const names = listing.requests.get(seq) ?? [];
			const first = names[0] as string;
			const type = (REQUEST_FILE.exec(first) as RegExpExecArray)[2] as string;
			if (seq <= lastApplied) {
				await reject(
					seq,
					first,
					type,
					"out_of_order",
					`seq ${seq} arrived after seq ${lastApplied} was applied`,
				);
				continue;
			}
			// Keep order across concurrent requesters: wait (bounded) for a reserved lower seq.
			const waiting = [...listing.reservations.keys()].filter(
				(reserved) =>
					reserved > lastApplied &&
					reserved < seq &&
					!listing.requests.has(reserved) &&
					!listing.acks.has(reserved),
			);
			let blocked = false;
			for (const reserved of waiting) {
				const name = listing.reservations.get(reserved) as string;
				const info = await stat(join(dir, name)).catch(() => undefined);
				if (
					info !== undefined &&
					Date.now() - info.mtimeMs < CONTROL_GAP_WAIT_MS
				) {
					blocked = true;
					break;
				}
				await recordRejection(
					name,
					reserved,
					"gap",
					`reserved seq ${reserved} never got a request within ${CONTROL_GAP_WAIT_MS} ms`,
				);
			}
			if (blocked) return;
			lastApplied = seq;
			if (names.length > 1) {
				for (const name of names)
					await reject(
						seq,
						name,
						(REQUEST_FILE.exec(name) as RegExpExecArray)[2] as string,
						"duplicate_seq",
						`seq ${seq} is used by ${names.join(", ")}`,
					);
				continue;
			}
			const request = await readJson<ControlRequest>(join(dir, first));
			const problem = validateRequest(request, seq, type);
			if (!(CONTROL_REQUEST_TYPES as readonly string[]).includes(type)) {
				await reject(
					seq,
					first,
					type,
					"unknown_type",
					`unknown request type ${type}`,
				);
				continue;
			}
			if (problem !== undefined) {
				await reject(seq, first, type, "invalid_request", problem);
				continue;
			}
			const valid = request as ControlRequest;
			const result =
				type === "approval_response"
					? await options.handlers.approval(
							valid.requestId as string,
							valid.decision as ApprovalDecision,
							seq,
						)
					: await options.handlers.cancel(valid.scope as CancelScope, seq);
			await writeAck(dir, {
				seq,
				type,
				request: first,
				ok: true,
				result,
				by: "worker",
			});
		}
	}

	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(() => {
			current = tick()
				.catch(() => undefined)
				.finally(schedule);
		}, pollMs);
		timer.unref?.();
	};
	current = tick()
		.catch(() => undefined)
		.finally(schedule);

	return {
		async close() {
			if (stopped) return;
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			await current;
			await closeMailbox(dir, lastApplied);
		},
	};
}

/**
 * Close a mailbox: write closed.json (from then on requesters answer their own requests), then
 * ack every unacked request with the terminal answer (approval → too_late, cancel → no_active),
 * then record the highest acked seq. Called by the serving process before the attempt's terminal
 * result, and by any other writer of a terminal result (pre-serve failures, reconcile).
 */
async function closeMailbox(dir: string, lastApplied: number): Promise<void> {
	const closedAt = new Date().toISOString();
	await writeAtomic(join(dir, "closed.json"), {
		schema: CONTROL_CLOSED_SCHEMA,
		closedAt,
		lastSeq: lastApplied,
		pid: process.pid,
	} satisfies ControlClosed);
	const listing = await listMailbox(dir);
	let lastSeq = lastApplied;
	for (const [seq, names] of [...listing.requests].sort(
		(a, b) => a[0] - b[0],
	)) {
		lastSeq = Math.max(lastSeq, seq);
		if (listing.acks.has(seq)) continue;
		const name = names[0] as string;
		const type = (REQUEST_FILE.exec(name) as RegExpExecArray)[2] as string;
		await writeAck(dir, {
			seq,
			type,
			request: name,
			...terminalAnswer(type),
			detail: "the attempt is no longer running",
			by: "closed",
		});
	}
	await writeAtomic(join(dir, "closed.json"), {
		schema: CONTROL_CLOSED_SCHEMA,
		closedAt,
		lastSeq,
		pid: process.pid,
	} satisfies ControlClosed);
}

/**
 * Close the attempt's mailbox when it was never served (or its server is gone) before writing a
 * terminal result: keeps "every request has an ack once result.json is terminal". A missing
 * control directory (nobody ever wrote a request) is left absent; an already closed one is kept.
 */
export async function closeControlMailbox(attemptDir: string): Promise<void> {
	const dir = controlDirOf(attemptDir);
	const listing = await listMailbox(dir);
	if (listing.closed) return;
	const exists = await stat(dir).then(
		() => true,
		() => false,
	);
	if (!exists) return;
	await closeMailbox(dir, Math.max(0, ...listing.acks));
}

// ---------------------------------------------------------------------------------------------
// Requester side (engine, host, supervisor): any process.

export interface ControlRequestBody {
	type: ControlRequestType | string;
	requestId?: string;
	decision?: ApprovalDecision;
	scope?: CancelScope;
}

/** Reserve the next seq (exclusive) and write the request atomically. Returns seq + file name. */
export async function writeControlRequest(
	attemptDir: string,
	body: ControlRequestBody,
): Promise<{ seq: number; file: string }> {
	const dir = controlDirOf(attemptDir);
	await mkdir(dir, { recursive: true });
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		const listing = await listMailbox(dir);
		const seq =
			Math.max(
				0,
				...listing.requests.keys(),
				...listing.acks,
				...listing.reservations.keys(),
			) +
			1 +
			attempt;
		const reservation = join(dir, `${formatSeq(seq)}.seq`);
		try {
			const handle = await open(reservation, "wx", 0o600);
			await handle.writeFile(
				`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
			);
			await handle.close();
		} catch (error) {
			if (errorCode(error) === "EEXIST") continue;
			throw error;
		}
		const file = `${formatSeq(seq)}-${body.type}.json`;
		await writeAtomic(join(dir, file), {
			schema: CONTROL_REQUEST_SCHEMA,
			seq,
			type: body.type,
			requestedAt: new Date().toISOString(),
			requester: { pid: process.pid, host: hostname() },
			...(body.requestId === undefined ? {} : { requestId: body.requestId }),
			...(body.decision === undefined ? {} : { decision: body.decision }),
			...(body.scope === undefined ? {} : { scope: body.scope }),
		} satisfies ControlRequest);
		return { seq, file };
	}
	throw new Error("could not reserve a control seq");
}

export type ControlAckWait =
	| { status: "acked"; ack: ControlAck }
	| { status: "timeout" };

/**
 * Wait for the ack of `seq`. When the mailbox is closed, or `isTerminal()` says the attempt is over
 * (its result.json is terminal), nobody will apply the request: the requester writes the
 * terminal answer itself (exclusive with a late sweep, so there is still one ack per seq).
 */
export async function awaitControlAck(options: {
	attemptDir: string;
	seq: number;
	file: string;
	timeoutMs: number;
	isTerminal: () => Promise<boolean>;
	pollMs?: number;
}): Promise<ControlAckWait> {
	const dir = controlDirOf(options.attemptDir);
	const deadline = Date.now() + options.timeoutMs;
	const pollMs = options.pollMs ?? 20;
	const type = (REQUEST_FILE.exec(options.file)?.[2] ?? "unknown") as string;
	for (;;) {
		const ack = await readJson<ControlAck>(ackPath(dir, options.seq));
		if (ack !== undefined) return { status: "acked", ack };
		const closed = await stat(join(dir, "closed.json")).then(
			() => true,
			() => false,
		);
		if (closed || (await options.isTerminal()))
			return {
				status: "acked",
				ack: await writeAck(dir, {
					seq: options.seq,
					type,
					request: options.file,
					...terminalAnswer(type),
					detail: closed
						? "the control mailbox was closed"
						: "the attempt is terminal",
					by: "requester",
				}),
			};
		if (Date.now() >= deadline) return { status: "timeout" };
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

// ---------------------------------------------------------------------------------------------
// Approval audit.

export interface ApprovalAuditRequested {
	schema: typeof APPROVAL_AUDIT_SCHEMA;
	phase: "requested";
	requestId: string;
	kind: string;
	detail?: string;
	at: string;
	/** When the runtime applies the default (deny) if nobody answers; null = decided by policy. */
	deadlineAt: string | null;
}

export interface ApprovalAuditDecided {
	schema: typeof APPROVAL_AUDIT_SCHEMA;
	phase: "decided";
	requestId: string;
	kind: string;
	decision: ApprovalDecision;
	by: ApprovalDecider;
	/** Why the decider decided (policy rule, mailbox seq, timeout, stop). */
	reason: string;
	/** What `executor.respond` returned (or `error: …`). */
	response: string;
	seq?: number;
	at: string;
}

export type ApprovalAuditRecord = ApprovalAuditRequested | ApprovalAuditDecided;

export async function readApprovalAudit(
	attemptDir: string,
): Promise<ApprovalAuditRecord[]> {
	let text: string;
	try {
		text = await readFile(join(attemptDir, APPROVAL_AUDIT_FILE), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as ApprovalAuditRecord];
			} catch {
				return [];
			}
		});
}

export async function appendApprovalAudit(
	attemptDir: string,
	record:
		| Omit<ApprovalAuditRequested, "schema">
		| Omit<ApprovalAuditDecided, "schema">,
): Promise<void> {
	await appendJsonLineDurable(join(attemptDir, APPROVAL_AUDIT_FILE), {
		schema: APPROVAL_AUDIT_SCHEMA,
		...record,
	});
}

// ---------------------------------------------------------------------------------------------
// Serving side state for one attempt (used by executeAttempt / observeAttempt).

export interface ApprovalOutcome {
	decision: ApprovalDecision;
	by: ApprovalDecider;
	reason: string;
	seq?: number;
}

interface ApprovalWaiter {
	outcome: Promise<ApprovalOutcome>;
	resolve(outcome: ApprovalOutcome): void;
	responded: Promise<ApprovalResponseResult>;
	settle(result: ApprovalResponseResult): void;
	/** A host answer already claimed it (a second answer is too_late). */
	claimed: boolean;
	/** The decision applied came from the host (else a claiming host answer lost the race). */
	hostDecided: boolean;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function asApprovalResponse(response: string): ApprovalResponseResult {
	return response === "accepted" ||
		response === "unknown_request" ||
		response === "too_late"
		? response
		: "too_late";
}

/**
 * What the mailbox handlers act on while one attempt runs: interactive approvals waiting for a
 * host answer, the ExecRef for `cancel(turn)`, and the runtime stop for `cancel(owned)` (the same
 * path SIGTERM takes: stop → `cancel(ref, "owned")` → grace → terminal).
 */
export class AttemptControl {
	readonly attemptDir: string;
	private readonly requestStop: (reason: string) => void;
	private cancelTurn: (() => Promise<CancelResult>) | undefined;
	private readonly waiters = new Map<string, ApprovalWaiter>();
	private readonly decided = new Set<string>();
	private ownedCancel: ReturnType<typeof deferred<CancelResult>> | undefined;
	private ownedCancelResult: CancelResult | undefined;
	private finished = false;

	constructor(options: {
		attemptDir: string;
		requestStop: (reason: string) => void;
	}) {
		this.attemptDir = options.attemptDir;
		this.requestStop = options.requestStop;
	}

	/** The executor accepted the attempt: `cancel(turn)` can reach it from now on. */
	bind<Ref>(
		executor: { cancel(ref: Ref, scope: CancelScope): Promise<CancelResult> },
		ref: Ref,
	): void {
		this.cancelTurn = () => executor.cancel(ref, "turn");
	}

	get launched(): boolean {
		return this.cancelTurn !== undefined;
	}

	/** Register a waiter before the request becomes visible, so an early host answer finds it. */
	expectApproval(requestId: string): void {
		if (this.waiters.has(requestId) || this.decided.has(requestId)) return;
		const outcome = deferred<ApprovalOutcome>();
		const responded = deferred<ApprovalResponseResult>();
		this.waiters.set(requestId, {
			outcome: outcome.promise,
			resolve: outcome.resolve,
			responded: responded.promise,
			settle: responded.resolve,
			claimed: false,
			hostDecided: false,
		});
	}

	/**
	 * Wait for the host's answer (mailbox), up to `timeoutMs`; then deny (`default-timeout`).
	 * A stop while waiting denies too (the runtime is cancelling the attempt).
	 */
	async awaitApproval(
		requestId: string,
		timeoutMs: number,
		stop: Promise<unknown>,
	): Promise<ApprovalOutcome> {
		this.expectApproval(requestId);
		const waiter = this.waiters.get(requestId);
		if (waiter === undefined)
			return {
				decision: "deny",
				by: "engine-policy",
				reason: "the request was already decided",
			};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<ApprovalOutcome>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						decision: "deny",
						by: "default-timeout",
						reason: `no answer within approvalPolicy.timeoutMs (${timeoutMs} ms); fail-closed default (D2)`,
					}),
				Math.max(0, timeoutMs),
			);
		});
		const stopped = stop.then(
			(): ApprovalOutcome => ({
				decision: "deny",
				by: "engine-policy",
				reason: "the attempt was stopped while waiting for an answer",
			}),
		);
		try {
			const outcome = await Promise.race([waiter.outcome, timeout, stopped]);
			// From here a host answer is too_late (unless it already claimed the waiter).
			this.decided.add(requestId);
			waiter.hostDecided = outcome.by === "host";
			return outcome;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** A policy decision (no waiting): later host answers for this id are `too_late`. */
	markDecided(requestId: string): void {
		this.decided.add(requestId);
	}

	/** The executor's answer to `respond`: completes the host's ack. */
	settleApproval(requestId: string, response: string): void {
		const waiter = this.waiters.get(requestId);
		this.waiters.delete(requestId);
		this.decided.add(requestId);
		// A host answer that claimed the waiter after the timeout/stop already won was not applied.
		waiter?.settle(
			waiter.hostDecided ? asApprovalResponse(response) : "too_late",
		);
	}

	/** The runtime sent `cancel(ref, "owned")` for a stop: that is the owned-cancel ack. */
	noteOwnedCancel(result: CancelResult | "error"): void {
		this.ownedCancelResult ??= result === "error" ? "uncertain" : result;
		this.ownedCancel?.resolve(this.ownedCancelResult);
	}

	/** The attempt is over (before the mailbox closes): settle what is still waiting. */
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.ownedCancel?.resolve(
			this.ownedCancelResult ?? (this.launched ? "too_late" : "cancelled"),
		);
		for (const [requestId, waiter] of this.waiters) {
			waiter.resolve({
				decision: "deny",
				by: "engine-policy",
				reason: "the attempt ended before an answer",
			});
			waiter.settle("too_late");
			this.decided.add(requestId);
		}
		this.waiters.clear();
	}

	readonly handlers: ControlHandlers = {
		approval: async (requestId, decision, seq) => {
			const waiter = this.waiters.get(requestId);
			if (waiter === undefined || waiter.claimed || this.decided.has(requestId))
				return this.decided.has(requestId) || waiter?.claimed === true
					? "too_late"
					: "unknown_request";
			waiter.claimed = true;
			waiter.resolve({
				decision,
				by: "host",
				reason: `answered through the control mailbox (seq ${seq})`,
				seq,
			});
			return await waiter.responded;
		},
		cancel: async (scope, seq) => {
			if (this.finished) return "no_active";
			if (scope === "turn") {
				if (this.cancelTurn === undefined) return "no_active";
				try {
					return await this.cancelTurn();
				} catch {
					return "uncertain";
				}
			}
			if (this.ownedCancel === undefined) {
				this.ownedCancel = deferred<CancelResult>();
				if (this.ownedCancelResult !== undefined)
					this.ownedCancel.resolve(this.ownedCancelResult);
				this.requestStop(`control mailbox cancel(owned) (seq ${seq})`);
			}
			return await this.ownedCancel.promise;
		},
	};
}
