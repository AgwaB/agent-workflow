import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PROJECT_STATE_DIRECTORY } from "./home-dir.js";
import { syncFileAndDirectory, workflowsRoot } from "./store.js";
import { canonicalWithoutUndefined } from "./json-values.js";

const ROOT_SCHEMA = "agent-workflow-state-root-v1" as const;
// Use the current state-root schema and a project nonce. Unrecognized sidecars are unread;
// runs with a mismatched state-root identity fail closed.
const NONCE_FILE = ".state-root-v2.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const CAPABILITIES = new WeakMap<object, WorkflowStateRootIdentity>();

export interface WorkflowStateRootIdentity {
	schema: typeof ROOT_SCHEMA;
	canonicalPath: string;
	device: number;
	inode: number;
	uid?: number;
	mode: number;
	nonce: string;
	nonceSha256: string;
	identitySha256: string;
}

export interface WorkflowStateRootCapability {
	readonly kind: "agent-workflow-private-state-root-capability-v1";
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalWithoutUndefined(value)))
		.digest("hex");
}

async function readNonce(file: string): Promise<{ nonce: string }> {
	const handle = await open(
		file,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const info = await handle.stat();
		const uid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new Error("workflow state-root nonce identity mismatch");
		const value = JSON.parse((await handle.readFile()).toString("utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			(value as { schema?: unknown }).schema !== ROOT_SCHEMA ||
			typeof (value as { nonce?: unknown }).nonce !== "string" ||
			!SHA256.test((value as { nonce: string }).nonce)
		)
			throw new Error("workflow state-root nonce is invalid");
		return { nonce: (value as { nonce: string }).nonce };
	} finally {
		await handle.close();
	}
}

async function createNonce(file: string): Promise<boolean> {
	const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const handle = await open(
		temp,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
		0o600,
	);
	try {
		await handle.writeFile(
			`${JSON.stringify({ schema: ROOT_SCHEMA, nonce: randomBytes(32).toString("hex") })}\n`,
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temp, file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

async function inspectStateRoot(
	cwd: string,
): Promise<WorkflowStateRootIdentity> {
	const lexical = resolve(workflowsRoot(cwd));
	await mkdir(lexical, { recursive: true });
	const canonicalPath = await realpath(lexical);
	const expectedPath = resolve(
		await realpath(cwd),
		PROJECT_STATE_DIRECTORY,
		"workflows",
	);
	if (canonicalPath !== expectedPath)
		throw new Error("workflow state root must not be a symlink");
	const root = await lstat(canonicalPath);
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!root.isDirectory() ||
		root.isSymbolicLink() ||
		(uid !== undefined && root.uid !== uid)
	)
		throw new Error("workflow state-root physical identity mismatch");
	const noncePath = join(canonicalPath, NONCE_FILE);
	const created = await createNonce(noncePath);
	if (created) await syncFileAndDirectory(noncePath);
	const nonce = await readNonce(noncePath);
	const body = {
		schema: ROOT_SCHEMA,
		canonicalPath,
		device: root.dev,
		inode: root.ino,
		...(uid === undefined ? {} : { uid }),
		mode: root.mode & 0o777,
		nonce: nonce.nonce,
		nonceSha256: digest(nonce),
	};
	return { ...body, identitySha256: digest(body) };
}

export async function openWorkflowStateRootCapability(
	cwd: string,
): Promise<WorkflowStateRootCapability> {
	const identity = await inspectStateRoot(cwd);
	const capability = Object.freeze({
		kind: "agent-workflow-private-state-root-capability-v1" as const,
	});
	CAPABILITIES.set(capability, Object.freeze(identity));
	return capability;
}

export async function assertWorkflowStateRootCapability(
	cwd: string,
	capability: WorkflowStateRootCapability,
): Promise<WorkflowStateRootIdentity> {
	const expected = CAPABILITIES.get(capability);
	if (!expected)
		throw new Error("private workflow state-root capability is required");
	const current = await inspectStateRoot(cwd);
	if (current.identitySha256 !== expected.identitySha256)
		throw new Error("workflow state-root physical identity changed");
	return expected;
}

export async function workflowStateRootIdentity(
	cwd: string,
): Promise<WorkflowStateRootIdentity> {
	const capability = await openWorkflowStateRootCapability(cwd);
	return assertWorkflowStateRootCapability(cwd, capability);
}
