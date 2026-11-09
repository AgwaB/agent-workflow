// The READY wait accepts an abort signal so the engine can stop waiting for an ended worker.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{64}$/u;

export class DurableLaunchBarrierError extends Error {
	readonly failureKind = "guard_failure" as const;

	constructor(message: string) {
		super(message);
		this.name = "DurableLaunchBarrierError";
	}
}

export function isDurableLaunchBarrierError(
	error: unknown,
): error is DurableLaunchBarrierError {
	return error instanceof DurableLaunchBarrierError;
}

export interface DurableLaunchBarrierV2Descriptor {
	schema: "agent-workflow-durable-launch-barrier-v2";
	identitySha256: string;
	directory: string;
	readyPath: string;
	decisionPath: string;
	ackPath: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	/** Optional caller-verified per-run authority digest; the runtime binds but does not interpret it. */
	authorityBindingSha256?: string;
	directoryIdentity: {
		device: number;
		inode: number;
		uid?: number;
	};
	timeoutMs: number;
	pollIntervalMs: number;
}

export interface DurableLaunchBarrierV2Ready {
	schema: "agent-workflow-durable-launch-barrier-ready-v2";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	workerPid: number;
	workerProcessGroupId?: number;
	launchPayloadSha256: string;
	executionPlanSha256: string;
	readySha256: string;
}

export interface DurableLaunchBarrierV2ReleaseDecision {
	schema: "agent-workflow-durable-launch-barrier-decision-v2";
	kind: "released";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	releasePayloadSha256: string;
	decisionSha256: string;
}

export interface DurableLaunchBarrierV2RevocationDecision {
	schema: "agent-workflow-durable-launch-barrier-decision-v2";
	kind: "revoked";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	cancellationId: string;
	reasonSha256: string;
	decisionSha256: string;
}

export type DurableLaunchBarrierV2Decision =
	| DurableLaunchBarrierV2ReleaseDecision
	| DurableLaunchBarrierV2RevocationDecision;

export interface DurableLaunchBarrierV2Ack {
	schema: "agent-workflow-durable-launch-barrier-ack-v2";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	decisionSha256: string;
	ackSha256: string;
}

export interface DurableLaunchBarrierV2Resolution {
	outcome: DurableLaunchBarrierV2Decision["kind"];
	decision: DurableLaunchBarrierV2Decision;
}

export interface DurableLaunchBarrierV2State {
	ready?: DurableLaunchBarrierV2Ready;
	decision?: DurableLaunchBarrierV2Decision;
	ack?: DurableLaunchBarrierV2Ack;
}

export class DurableLaunchBarrierRevokedError extends Error {
	readonly failureKind = "user_cancelled" as const;
	readonly decision: DurableLaunchBarrierV2RevocationDecision;

	constructor(decision: DurableLaunchBarrierV2RevocationDecision) {
		super("durable launch barrier was revoked before release");
		this.name = "DurableLaunchBarrierRevokedError";
		this.decision = decision;
	}
}

export function isDurableLaunchBarrierRevokedError(
	error: unknown,
): error is DurableLaunchBarrierRevokedError {
	return error instanceof DurableLaunchBarrierRevokedError;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

export function durableLaunchBarrierDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertSha256(label: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || !SHA256.test(value))
		throw new DurableLaunchBarrierError(`${label} is not SHA-256`);
}

function assertNonEmpty(
	label: string,
	value: unknown,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		throw new DurableLaunchBarrierError(`${label} is empty`);
}

function assertPositiveInteger(
	label: string,
	value: unknown,
	minimum: number,
	maximum: number,
): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new DurableLaunchBarrierError(
			`${label} is outside the supported range`,
		);
}

function normalizePathGuardError(error: unknown, operation: string): never {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code ?? ""))
		throw new DurableLaunchBarrierError(
			`durable launch barrier ${operation} failed guard check (${code})`,
		);
	throw error;
}

async function assertOwnerOnlyDirectory(
	path: string,
	expected?: DurableLaunchBarrierV2Descriptor["directoryIdentity"],
): Promise<DurableLaunchBarrierV2Descriptor["directoryIdentity"]> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		normalizePathGuardError(error, "directory identity");
	}
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new DurableLaunchBarrierError(
			"durable launch barrier directory is not a real directory",
		);
	if ((info.mode & 0o777) !== 0o700)
		throw new DurableLaunchBarrierError(
			"durable launch barrier directory is not owner-only 0700",
		);
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && info.uid !== uid)
		throw new DurableLaunchBarrierError(
			"durable launch barrier directory owner mismatch",
		);
	const identity = {
		device: info.dev,
		inode: info.ino,
		...(uid === undefined ? {} : { uid }),
	};
	if (
		expected !== undefined &&
		(expected.device !== identity.device ||
			expected.inode !== identity.inode ||
			expected.uid !== identity.uid)
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier directory was replaced",
		);
	return identity;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function transientCommitError(): NodeJS.ErrnoException {
	const error = new DurableLaunchBarrierError(
		"durable launch barrier file commit is still in progress",
	) as NodeJS.ErrnoException;
	error.code = "EAGAIN";
	return error;
}

async function removeTransactionTempAliases(
	transactionPath: string,
): Promise<void> {
	const transactionInfo = await lstat(transactionPath);
	const directory = resolve(transactionPath, "..");
	const prefix = `${transactionPath.slice(directory.length + 1)}.`;
	for (const name of await readdir(directory)) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const candidate = join(directory, name);
		let info;
		try {
			info = await lstat(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
			throw error;
		}
		if (
			info.isFile() &&
			!info.isSymbolicLink() &&
			info.dev === transactionInfo.dev &&
			info.ino === transactionInfo.ino
		)
			await rm(candidate, { force: true });
	}
}

async function assertTransactionLink(
	path: string,
	transactionPath: string,
): Promise<void> {
	const [finalInfo, transactionInfo] = await Promise.all([
		lstat(path),
		lstat(transactionPath),
	]);
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!finalInfo.isFile() ||
		finalInfo.isSymbolicLink() ||
		!transactionInfo.isFile() ||
		transactionInfo.isSymbolicLink() ||
		finalInfo.dev !== transactionInfo.dev ||
		finalInfo.ino !== transactionInfo.ino ||
		finalInfo.nlink !== 2 ||
		transactionInfo.nlink !== 2 ||
		(finalInfo.mode & 0o777) !== 0o600 ||
		(transactionInfo.mode & 0o777) !== 0o600 ||
		(uid !== undefined &&
			(finalInfo.uid !== uid || transactionInfo.uid !== uid))
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier transaction identity mismatch",
		);
}

async function writeDurableExclusive(
	descriptor: DurableLaunchBarrierV2Descriptor,
	path: string,
	value: unknown,
): Promise<void> {
	const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
	const transactionPath = `${path}.txn`;
	const temporaryPath = `${transactionPath}.${process.pid}.${randomUUID()}.tmp`;
	const pendingPath = `${path}.pending`;
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	let pending;
	let ownsPending = false;
	try {
		pending = await open(
			pendingPath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		ownsPending = true;
		await pending.writeFile("pending\n");
		await pending.sync();
		await pending.close();
		pending = undefined;
		await syncDirectory(descriptor.directory);
	} catch (error) {
		await pending?.close().catch(() => undefined);
		if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
	}
	let transaction;
	try {
		let temporary;
		try {
			temporary = await open(
				temporaryPath,
				constants.O_RDWR |
					constants.O_CREAT |
					constants.O_EXCL |
					(constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			await temporary.writeFile(bytes);
			await temporary.sync();
			await temporary.close();
			temporary = undefined;
			try {
				await link(temporaryPath, transactionPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			}
			await syncDirectory(descriptor.directory);
		} finally {
			await temporary?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
		await removeTransactionTempAliases(transactionPath);
		await syncDirectory(descriptor.directory);
		transaction = await open(
			transactionPath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		const transactionBytes = await transaction.readFile();
		if (!transactionBytes.equals(bytes))
			throw new DurableLaunchBarrierError(
				"durable launch barrier duplicate payload mismatch",
			);
		await transaction.sync();
		await assertOwnerOnlyDirectory(
			descriptor.directory,
			descriptor.directoryIdentity,
		);
		try {
			await link(transactionPath, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
		await assertTransactionLink(path, transactionPath);
		await syncDirectory(descriptor.directory);
	} catch (error) {
		if (ownsPending) {
			await rm(pendingPath, { force: true }).catch(() => undefined);
			await syncDirectory(descriptor.directory).catch(() => undefined);
		}
		throw error;
	} finally {
		await transaction?.close();
	}
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	await rm(pendingPath, { force: true });
	await syncDirectory(descriptor.directory);
}

/**
 * How long a pending fence that is being unlinked may stay visible. CI 2026-11-09 (ci-flakes-20261109): Linux
 * ext4 shows the path with nlink 0 while it finishes the unlink in its journal — up to ~4 ms under fsync load in
 * a reproduction — and three setImmediate re-observations (microseconds) failed the launch.
 */
const PENDING_FENCE_UNLINK_WAIT_MS = 1_000;

async function pendingCommitExists(path: string): Promise<boolean> {
	const pendingPath = `${path}.pending`;
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	const started = Date.now();
	for (let attempt = 0; ; attempt += 1) {
		let info;
		try {
			info = await lstat(pendingPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
			throw error;
		}
		if (!info.isFile() || info.isSymbolicLink())
			throw new DurableLaunchBarrierError(
				"durable launch barrier pending fence identity mismatch",
			);
		if (
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new DurableLaunchBarrierError(
				"durable launch barrier pending fence identity mismatch",
			);
		if (info.nlink === 1) return true;
		if (info.nlink !== 0)
			throw new DurableLaunchBarrierError(
				"durable launch barrier pending fence identity mismatch",
			);
		// Unlink can race lstat and leave an otherwise valid, unlinked inode snapshot. Reobserve only that
		// case, until it is gone or live again (bounded); never accept it as a live fence.
		if (Date.now() - started >= PENDING_FENCE_UNLINK_WAIT_MS)
			throw new DurableLaunchBarrierError(
				"durable launch barrier pending fence identity mismatch",
			);
		if (attempt < 2)
			await new Promise<void>((resolveAttempt) => setImmediate(resolveAttempt));
		else await sleep(Math.min(10, attempt));
	}
}

async function recoverCommittedExclusive(
	descriptor: DurableLaunchBarrierV2Descriptor,
	path: string,
): Promise<boolean> {
	if (!(await pendingCommitExists(path))) return false;
	const transactionPath = `${path}.txn`;
	await removeTransactionTempAliases(transactionPath);
	await syncDirectory(descriptor.directory);
	let transaction;
	try {
		transaction = await open(
			transactionPath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw error;
	}
	try {
		const info = await transaction.stat();
		const uid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			!info.isFile() ||
			(info.nlink !== 1 && info.nlink !== 2) ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new DurableLaunchBarrierError(
				"durable launch barrier transaction identity mismatch",
			);
		await transaction.sync();
		await assertOwnerOnlyDirectory(
			descriptor.directory,
			descriptor.directoryIdentity,
		);
		if (info.nlink === 1) {
			try {
				await link(transactionPath, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			}
		} else {
			try {
				await assertTransactionLink(path, transactionPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
				throw error;
			}
		}
		await assertTransactionLink(path, transactionPath);
		await syncDirectory(descriptor.directory);
		await rm(`${path}.pending`, { force: true });
		await syncDirectory(descriptor.directory);
		await assertOwnerOnlyDirectory(
			descriptor.directory,
			descriptor.directoryIdentity,
		);
		return true;
	} finally {
		await transaction.close();
	}
}

async function readStrictJson(
	descriptor: DurableLaunchBarrierV2Descriptor,
	path: string,
): Promise<unknown> {
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	if (await pendingCommitExists(path))
		await recoverCommittedExclusive(descriptor, path);
	if (await pendingCommitExists(path)) throw transientCommitError();
	const handle = await open(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const info = await handle.stat();
		const uid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			!info.isFile() ||
			(info.nlink !== 1 && info.nlink !== 2) ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new DurableLaunchBarrierError(
				"durable launch barrier file identity mismatch",
			);
		const bytes = await handle.readFile();
		let value: unknown;
		try {
			value = JSON.parse(bytes.toString("utf8"));
		} catch {
			if (info.nlink === 2) throw transientCommitError();
			throw new DurableLaunchBarrierError(
				"durable launch barrier record is not valid JSON",
			);
		}
		if (info.nlink === 2) await assertTransactionLink(path, `${path}.txn`);
		await assertOwnerOnlyDirectory(
			descriptor.directory,
			descriptor.directoryIdentity,
		);
		if (await pendingCommitExists(path)) throw transientCommitError();
		return value;
	} finally {
		await handle.close();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForFile(
	descriptor: DurableLaunchBarrierV2Descriptor,
	path: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const deadline = Date.now() + descriptor.timeoutMs;
	while (Date.now() <= deadline) {
		if (signal?.aborted)
			throw new DurableLaunchBarrierError(
				"durable launch barrier wait was aborted",
			);
		const value = await readStrictJson(descriptor, path).catch(
			(error: NodeJS.ErrnoException) => {
				if (error?.code === "ENOENT" || error?.code === "EAGAIN")
					return undefined;
				throw error;
			},
		);
		if (value !== undefined) return value;
		await sleep(descriptor.pollIntervalMs);
	}
	throw new DurableLaunchBarrierError("durable launch barrier timed out");
}

export async function createDurableLaunchBarrierV2(options: {
	directory: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	challenge?: string;
	decisionNonce?: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
}): Promise<DurableLaunchBarrierV2Descriptor> {
	if (!isAbsolute(options.directory))
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 directory must be absolute",
		);
	assertSha256("durable launch barrier v2 subject", options.subjectSha256);
	if (options.authorityBindingSha256 !== undefined)
		assertSha256(
			"durable launch barrier v2 authority binding",
			options.authorityBindingSha256,
		);
	const challenge = options.challenge ?? randomBytes(32).toString("hex");
	const decisionNonce =
		options.decisionNonce ?? randomBytes(32).toString("hex");
	if (!NONCE.test(challenge) || !NONCE.test(decisionNonce))
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 nonce is invalid",
		);
	const directory = resolve(options.directory);
	await mkdir(directory, { mode: 0o700 });
	const directoryIdentity = await assertOwnerOnlyDirectory(directory);
	const body = {
		schema: "agent-workflow-durable-launch-barrier-v2" as const,
		directory,
		readyPath: join(directory, "ready-v2.json"),
		decisionPath: join(directory, "decision-v2.json"),
		ackPath: join(directory, "ack-v2.json"),
		challenge,
		decisionNonce,
		subjectSha256: options.subjectSha256,
		...(options.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: options.authorityBindingSha256 }),
		directoryIdentity,
		timeoutMs: options.timeoutMs ?? 30_000,
		pollIntervalMs: options.pollIntervalMs ?? 10,
	};
	assertPositiveInteger(
		"durable launch barrier v2 timeout",
		body.timeoutMs,
		100,
		120_000,
	);
	assertPositiveInteger(
		"durable launch barrier v2 poll interval",
		body.pollIntervalMs,
		1,
		1_000,
	);
	return Object.freeze({
		...body,
		identitySha256: durableLaunchBarrierDigest(body),
	});
}

export function assertDurableLaunchBarrierV2Descriptor(
	value: unknown,
): asserts value is DurableLaunchBarrierV2Descriptor {
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 descriptor is invalid",
		);
	const descriptor = value as DurableLaunchBarrierV2Descriptor;
	if (descriptor.schema !== "agent-workflow-durable-launch-barrier-v2")
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 schema mismatch",
		);
	if (
		!isAbsolute(descriptor.directory) ||
		resolve(descriptor.directory) !== descriptor.directory
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 directory identity mismatch",
		);
	if (
		!NONCE.test(descriptor.challenge) ||
		!NONCE.test(descriptor.decisionNonce)
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 nonce is invalid",
		);
	assertSha256("durable launch barrier v2 subject", descriptor.subjectSha256);
	if (descriptor.authorityBindingSha256 !== undefined)
		assertSha256(
			"durable launch barrier v2 authority binding",
			descriptor.authorityBindingSha256,
		);
	assertSha256("durable launch barrier v2 identity", descriptor.identitySha256);
	assertPositiveInteger(
		"durable launch barrier v2 timeout",
		descriptor.timeoutMs,
		100,
		120_000,
	);
	assertPositiveInteger(
		"durable launch barrier v2 poll interval",
		descriptor.pollIntervalMs,
		1,
		1_000,
	);
	assertPositiveInteger(
		"durable launch barrier v2 directory device",
		descriptor.directoryIdentity?.device,
		0,
		Number.MAX_SAFE_INTEGER,
	);
	assertPositiveInteger(
		"durable launch barrier v2 directory inode",
		descriptor.directoryIdentity?.inode,
		1,
		Number.MAX_SAFE_INTEGER,
	);
	if (descriptor.directoryIdentity.uid !== undefined)
		assertPositiveInteger(
			"durable launch barrier v2 directory uid",
			descriptor.directoryIdentity.uid,
			0,
			Number.MAX_SAFE_INTEGER,
		);
	if (
		descriptor.readyPath !== join(descriptor.directory, "ready-v2.json") ||
		descriptor.decisionPath !==
			join(descriptor.directory, "decision-v2.json") ||
		descriptor.ackPath !== join(descriptor.directory, "ack-v2.json")
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 path identity mismatch",
		);
	const { identitySha256, ...body } = descriptor;
	if (durableLaunchBarrierDigest(body) !== identitySha256)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 identity digest mismatch",
		);
}

function assertReadyV2(
	descriptor: DurableLaunchBarrierV2Descriptor,
	value: unknown,
): DurableLaunchBarrierV2Ready {
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 ready record is invalid",
		);
	const ready = value as DurableLaunchBarrierV2Ready;
	const { readySha256, ...body } = ready;
	if (
		ready.schema !== "agent-workflow-durable-launch-barrier-ready-v2" ||
		ready.barrierIdentitySha256 !== descriptor.identitySha256 ||
		ready.challenge !== descriptor.challenge ||
		ready.decisionNonce !== descriptor.decisionNonce ||
		ready.subjectSha256 !== descriptor.subjectSha256 ||
		ready.authorityBindingSha256 !== descriptor.authorityBindingSha256 ||
		!Number.isSafeInteger(ready.workerPid) ||
		ready.workerPid <= 0 ||
		(ready.workerProcessGroupId !== undefined &&
			(!Number.isSafeInteger(ready.workerProcessGroupId) ||
				ready.workerProcessGroupId <= 0))
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 ready record mismatch",
		);
	assertNonEmpty("durable launch barrier v2 run id", ready.runId);
	assertNonEmpty("durable launch barrier v2 attempt id", ready.attemptId);
	assertSha256("durable launch barrier v2 payload", ready.launchPayloadSha256);
	assertSha256(
		"durable launch barrier v2 execution plan",
		ready.executionPlanSha256,
	);
	assertSha256("durable launch barrier v2 ready digest", readySha256);
	if (durableLaunchBarrierDigest(body) !== readySha256)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 ready digest mismatch",
		);
	return ready;
}

function assertDecisionV2(
	descriptor: DurableLaunchBarrierV2Descriptor,
	value: unknown,
	ready?: DurableLaunchBarrierV2Ready,
): DurableLaunchBarrierV2Decision {
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 decision is invalid",
		);
	const decision = value as DurableLaunchBarrierV2Decision;
	const { decisionSha256, ...body } = decision;
	if (
		decision.schema !== "agent-workflow-durable-launch-barrier-decision-v2" ||
		(decision.kind !== "released" && decision.kind !== "revoked") ||
		decision.barrierIdentitySha256 !== descriptor.identitySha256 ||
		decision.challenge !== descriptor.challenge ||
		decision.decisionNonce !== descriptor.decisionNonce ||
		decision.subjectSha256 !== descriptor.subjectSha256 ||
		decision.authorityBindingSha256 !== descriptor.authorityBindingSha256
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 decision mismatch",
		);
	assertSha256("durable launch barrier v2 decision digest", decisionSha256);
	if (durableLaunchBarrierDigest(body) !== decisionSha256)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 decision digest mismatch",
		);
	if (decision.kind === "released") {
		if (
			ready === undefined ||
			decision.runId !== ready.runId ||
			decision.attemptId !== ready.attemptId ||
			decision.readySha256 !== ready.readySha256
		)
			throw new DurableLaunchBarrierError(
				"durable launch barrier v2 release decision does not match ready",
			);
		assertSha256(
			"durable launch barrier v2 release payload",
			decision.releasePayloadSha256,
		);
	} else {
		assertNonEmpty(
			"durable launch barrier v2 cancellation id",
			decision.cancellationId,
		);
		assertSha256(
			"durable launch barrier v2 cancellation reason",
			decision.reasonSha256,
		);
	}
	return decision;
}

function assertAckV2(
	descriptor: DurableLaunchBarrierV2Descriptor,
	ready: DurableLaunchBarrierV2Ready,
	decision: DurableLaunchBarrierV2ReleaseDecision,
	value: unknown,
): DurableLaunchBarrierV2Ack {
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 acknowledgement is invalid",
		);
	const ack = value as DurableLaunchBarrierV2Ack;
	const { ackSha256, ...body } = ack;
	if (
		ack.schema !== "agent-workflow-durable-launch-barrier-ack-v2" ||
		ack.barrierIdentitySha256 !== descriptor.identitySha256 ||
		ack.challenge !== descriptor.challenge ||
		ack.decisionNonce !== descriptor.decisionNonce ||
		ack.runId !== ready.runId ||
		ack.attemptId !== ready.attemptId ||
		ack.readySha256 !== ready.readySha256 ||
		ack.decisionSha256 !== decision.decisionSha256
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 acknowledgement mismatch",
		);
	assertSha256("durable launch barrier v2 acknowledgement digest", ackSha256);
	if (durableLaunchBarrierDigest(body) !== ackSha256)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 acknowledgement digest mismatch",
		);
	return ack;
}

async function readOptionalBarrierRecord(
	descriptor: DurableLaunchBarrierV2Descriptor,
	path: string,
): Promise<unknown | undefined> {
	try {
		return await readStrictJson(descriptor, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function persistV2Decision(
	descriptor: DurableLaunchBarrierV2Descriptor,
	decision: DurableLaunchBarrierV2Decision,
): Promise<void> {
	try {
		await writeDurableExclusive(descriptor, descriptor.decisionPath, decision);
	} catch (error) {
		if (
			!(
				error instanceof DurableLaunchBarrierError &&
				/duplicate payload mismatch/u.test(error.message)
			)
		)
			throw error;
	}
}

export async function waitForDurableLaunchBarrierV2Ready(
	descriptor: DurableLaunchBarrierV2Descriptor,
	options: { signal?: AbortSignal } = {},
): Promise<DurableLaunchBarrierV2Ready> {
	assertDurableLaunchBarrierV2Descriptor(descriptor);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	return assertReadyV2(
		descriptor,
		await waitForFile(descriptor, descriptor.readyPath, options.signal),
	);
}

export async function resolveDurableLaunchBarrierV2Release(
	descriptor: DurableLaunchBarrierV2Descriptor,
	ready: DurableLaunchBarrierV2Ready,
	releasePayloadSha256: string,
): Promise<DurableLaunchBarrierV2Resolution> {
	assertDurableLaunchBarrierV2Descriptor(descriptor);
	assertReadyV2(descriptor, ready);
	assertSha256(
		"durable launch barrier v2 release payload",
		releasePayloadSha256,
	);
	const body = {
		schema: "agent-workflow-durable-launch-barrier-decision-v2" as const,
		kind: "released" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		runId: ready.runId,
		attemptId: ready.attemptId,
		readySha256: ready.readySha256,
		releasePayloadSha256,
	};
	const desired: DurableLaunchBarrierV2ReleaseDecision = {
		...body,
		decisionSha256: durableLaunchBarrierDigest(body),
	};
	await persistV2Decision(descriptor, desired);
	const decision = assertDecisionV2(
		descriptor,
		await waitForFile(descriptor, descriptor.decisionPath),
		ready,
	);
	if (
		decision.kind === "released" &&
		decision.releasePayloadSha256 !== releasePayloadSha256
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 release payload drift",
		);
	return { outcome: decision.kind, decision };
}

export async function revokeDurableLaunchBarrierV2(
	descriptor: DurableLaunchBarrierV2Descriptor,
	options: { cancellationId: string; reasonSha256: string },
): Promise<DurableLaunchBarrierV2Resolution> {
	assertDurableLaunchBarrierV2Descriptor(descriptor);
	assertNonEmpty(
		"durable launch barrier v2 cancellation id",
		options.cancellationId,
	);
	assertSha256(
		"durable launch barrier v2 cancellation reason",
		options.reasonSha256,
	);
	const body = {
		schema: "agent-workflow-durable-launch-barrier-decision-v2" as const,
		kind: "revoked" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		cancellationId: options.cancellationId,
		reasonSha256: options.reasonSha256,
	};
	const desired: DurableLaunchBarrierV2RevocationDecision = {
		...body,
		decisionSha256: durableLaunchBarrierDigest(body),
	};
	await persistV2Decision(descriptor, desired);
	const readyValue = await readOptionalBarrierRecord(
		descriptor,
		descriptor.readyPath,
	);
	const ready =
		readyValue === undefined
			? undefined
			: assertReadyV2(descriptor, readyValue);
	const decision = assertDecisionV2(
		descriptor,
		await waitForFile(descriptor, descriptor.decisionPath),
		ready,
	);
	if (
		decision.kind === "revoked" &&
		(decision.cancellationId !== options.cancellationId ||
			decision.reasonSha256 !== options.reasonSha256)
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 cancellation identity drift",
		);
	return { outcome: decision.kind, decision };
}

export async function readDurableLaunchBarrierV2State(
	descriptor: DurableLaunchBarrierV2Descriptor,
): Promise<DurableLaunchBarrierV2State> {
	assertDurableLaunchBarrierV2Descriptor(descriptor);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	const readyValue = await readOptionalBarrierRecord(
		descriptor,
		descriptor.readyPath,
	);
	const ready =
		readyValue === undefined
			? undefined
			: assertReadyV2(descriptor, readyValue);
	const decisionValue = await readOptionalBarrierRecord(
		descriptor,
		descriptor.decisionPath,
	);
	const decision =
		decisionValue === undefined
			? undefined
			: assertDecisionV2(descriptor, decisionValue, ready);
	const ackValue = await readOptionalBarrierRecord(
		descriptor,
		descriptor.ackPath,
	);
	let ack: DurableLaunchBarrierV2Ack | undefined;
	if (ackValue !== undefined) {
		if (ready === undefined || decision?.kind !== "released")
			throw new DurableLaunchBarrierError(
				"durable launch barrier v2 acknowledgement has no release decision",
			);
		ack = assertAckV2(descriptor, ready, decision, ackValue);
	}
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	return {
		...(ready === undefined ? {} : { ready }),
		...(decision === undefined ? {} : { decision }),
		...(ack === undefined ? {} : { ack }),
	};
}

export async function awaitDurableLaunchBarrierV2(options: {
	descriptor: DurableLaunchBarrierV2Descriptor;
	runId: string;
	attemptId: string;
	launchPayloadSha256: string;
	executionPlanSha256: string;
	workerProcessGroupId?: number;
	signal?: AbortSignal;
}): Promise<DurableLaunchBarrierV2Ack> {
	const { descriptor } = options;
	assertDurableLaunchBarrierV2Descriptor(descriptor);
	assertNonEmpty("durable launch barrier v2 run id", options.runId);
	assertNonEmpty("durable launch barrier v2 attempt id", options.attemptId);
	assertSha256(
		"durable launch barrier v2 payload",
		options.launchPayloadSha256,
	);
	assertSha256(
		"durable launch barrier v2 execution plan",
		options.executionPlanSha256,
	);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	if (options.signal?.aborted)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 was aborted before ready",
		);
	const readyBody = {
		schema: "agent-workflow-durable-launch-barrier-ready-v2" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		runId: options.runId,
		attemptId: options.attemptId,
		workerPid: process.pid,
		...(options.workerProcessGroupId === undefined
			? {}
			: { workerProcessGroupId: options.workerProcessGroupId }),
		launchPayloadSha256: options.launchPayloadSha256,
		executionPlanSha256: options.executionPlanSha256,
	};
	const ready: DurableLaunchBarrierV2Ready = {
		...readyBody,
		readySha256: durableLaunchBarrierDigest(readyBody),
	};
	await writeDurableExclusive(descriptor, descriptor.readyPath, ready);
	const decision = assertDecisionV2(
		descriptor,
		await waitForFile(descriptor, descriptor.decisionPath, options.signal),
		ready,
	);
	if (decision.kind === "revoked")
		throw new DurableLaunchBarrierRevokedError(decision);
	if (options.signal?.aborted)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 was aborted before acknowledgement",
		);
	const ackBody = {
		schema: "agent-workflow-durable-launch-barrier-ack-v2" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		runId: options.runId,
		attemptId: options.attemptId,
		readySha256: ready.readySha256,
		decisionSha256: decision.decisionSha256,
	};
	const ack: DurableLaunchBarrierV2Ack = {
		...ackBody,
		ackSha256: durableLaunchBarrierDigest(ackBody),
	};
	await writeDurableExclusive(descriptor, descriptor.ackPath, ack);
	return ack;
}

export async function waitForDurableLaunchBarrierV2Ack(
	descriptor: DurableLaunchBarrierV2Descriptor,
	decision: DurableLaunchBarrierV2ReleaseDecision,
): Promise<DurableLaunchBarrierV2Ack> {
	assertDurableLaunchBarrierV2Descriptor(descriptor);
	const ready = assertReadyV2(
		descriptor,
		await waitForFile(descriptor, descriptor.readyPath),
	);
	const persistedDecision = assertDecisionV2(
		descriptor,
		await waitForFile(descriptor, descriptor.decisionPath),
		ready,
	);
	if (
		persistedDecision.kind !== "released" ||
		persistedDecision.decisionSha256 !== decision.decisionSha256
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 release decision changed before acknowledgement",
		);
	const ack = assertAckV2(
		descriptor,
		ready,
		persistedDecision,
		await waitForFile(descriptor, descriptor.ackPath),
	);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	return ack;
}

export async function assertDurableLaunchBarrierV2ExecutionAuthorized(
	descriptor: DurableLaunchBarrierV2Descriptor,
	ack: DurableLaunchBarrierV2Ack,
): Promise<DurableLaunchBarrierV2ReleaseDecision> {
	const state = await readDurableLaunchBarrierV2State(descriptor);
	if (
		state.ready === undefined ||
		state.decision?.kind !== "released" ||
		state.ack === undefined ||
		state.ack.ackSha256 !== ack.ackSha256 ||
		state.ack.decisionSha256 !== state.decision.decisionSha256
	)
		throw new DurableLaunchBarrierError(
			"durable launch barrier v2 execution authorization is incomplete",
		);
	return state.decision;
}
