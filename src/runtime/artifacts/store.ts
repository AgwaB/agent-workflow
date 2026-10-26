// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/artifacts/store.ts. MIT, same author. Changes: default runs dir is DEFAULT_RUNS_DIR (".agent-workflow/runs") from core/constants; WP2a-2 adds exec-events.jsonl. WP2b (terminal-last-write): writeResult fsyncs the temp file (and, for a terminal result, every listed artifact) before the rename and the directory after it; buildResult returns the envelope writeResult would write without writing it; ensureTextArtifact creates a missing artifact empty.
import { randomBytes } from "node:crypto";
import {
	appendFile,
	mkdir,
	open,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	createResultEnvelope,
	mergeArtifactRefs,
	type ArtifactRef,
	type ArtifactType,
	type ResultEnvelope,
	type ResultEnvelopeInput,
} from "./result.js";
import { DEFAULT_RUNS_DIR } from "../core/constants.js";

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
	result: "result.json",
	stdout: "stdout.log",
	stderr: "stderr.log",
	output: "output.log",
	worker: "worker.json",
	"worktree-status": "worktree.status.txt",
	"worktree-diff": "worktree.diff.patch",
	"tool-calls": "tool-calls.jsonl",
	"tool-calls-summary": "tool-calls-summary.json",
	"exec-events": "exec-events.jsonl",
};

export type LogArtifactType = Exclude<ArtifactType, "result" | "worker">;

export interface CreateAttemptArtifactStoreOptions {
	cwd?: string;
	runId?: string;
	attemptId?: string;
	runsDir?: string;
	/** @deprecated v1 compatibility only; mapped to attemptId when attemptId is absent. */
	taskId?: string;
}

export type StoreResultEnvelopeInput = Omit<
	ResultEnvelopeInput,
	"runId" | "attemptId"
> &
	Partial<Pick<ResultEnvelopeInput, "runId" | "attemptId">>;

export interface AttemptArtifactStore {
	runId: string;
	attemptId: string;
	cwd: string;
	runsDir: string;
	runDir: string;
	attemptsDir: string;
	attemptDir: string;
	pathFor(type: ArtifactType): string;
	refFor(type: ArtifactType, bytes?: number): ArtifactRef;
	writeTextArtifact(
		type: LogArtifactType,
		content: string | Uint8Array,
	): Promise<ArtifactRef>;
	appendTextArtifact(
		type: LogArtifactType,
		content: string | Uint8Array,
	): Promise<ArtifactRef>;
	/** Create the artifact empty when it does not exist (never clobbers); WP2b terminal-last-write. */
	ensureTextArtifact(type: LogArtifactType): Promise<ArtifactRef>;
	writeResult(input: StoreResultEnvelopeInput): Promise<ResultEnvelope>;
	/** The envelope `writeResult` would write, not written (WP2b: finalize before the terminal write). */
	buildResult(input: StoreResultEnvelopeInput): ResultEnvelope;
	/** @deprecated v1 compatibility only. */
	taskId: string;
	/** @deprecated v1 compatibility only. */
	taskDir: string;
}

export type CreateTaskArtifactStoreOptions = CreateAttemptArtifactStoreOptions;
export type TaskArtifactStore = AttemptArtifactStore;

function assertSafeId(name: string, value: string): void {
	if (!SAFE_ID_PATTERN.test(value)) {
		throw new Error(
			`${name} must contain only letters, numbers, dots, underscores, or dashes.`,
		);
	}
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

function toSafeRelativePath(cwd: string, artifactPath: string): string {
	const artifactRelative = relative(cwd, artifactPath);
	if (
		artifactRelative === "" ||
		artifactRelative.startsWith("..") ||
		isAbsolute(artifactRelative)
	) {
		throw new Error(
			"artifact path must stay inside cwd to be exposed as a relative tool path.",
		);
	}
	return artifactRelative.split(sep).join("/");
}

function byteLength(content: string | Uint8Array): number {
	return typeof content === "string"
		? Buffer.byteLength(content, "utf8")
		: content.byteLength;
}

async function fileSize(path: string): Promise<number> {
	const info = await stat(path);
	return info.size;
}

function isTerminalResultStatus(status: string): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

/** fsync a file or directory; a missing path or a platform without directory fsync is ignored. */
async function syncFile(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch {
		// Missing artifact (reported by its reader) or EISDIR/EPERM for directory fsync.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export function createRunId(now: Date = new Date()): string {
	return `run_${now.getTime().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function createAttemptId(now: Date = new Date()): string {
	return `attempt_${now.getTime().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export async function createAttemptArtifactStore(
	options: CreateAttemptArtifactStoreOptions = {},
): Promise<AttemptArtifactStore> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const runId = options.runId ?? createRunId();
	const attemptId = options.attemptId ?? options.taskId ?? createAttemptId();

	assertSafeId("runId", runId);
	assertSafeId("attemptId", attemptId);

	const runsDir = resolve(cwd, options.runsDir ?? DEFAULT_RUNS_DIR);
	if (!isInsideOrEqual(cwd, runsDir)) {
		throw new Error(
			"runsDir must be inside cwd so artifact refs can remain relative and safe.",
		);
	}

	const runDir = join(runsDir, runId);
	const attemptsDir = join(runDir, "attempts");
	const attemptDir = join(attemptsDir, attemptId);
	await mkdir(attemptDir, { recursive: true });

	function pathFor(type: ArtifactType): string {
		return join(attemptDir, ARTIFACT_FILENAMES[type]);
	}

	function refFor(type: ArtifactType, bytes?: number): ArtifactRef {
		return {
			type,
			path: toSafeRelativePath(cwd, pathFor(type)),
			...(bytes === undefined ? {} : { bytes }),
		};
	}

	async function writeTextArtifact(
		type: LogArtifactType,
		content: string | Uint8Array,
	): Promise<ArtifactRef> {
		await writeFile(pathFor(type), content);
		return refFor(type, byteLength(content));
	}

	async function ensureTextArtifact(
		type: LogArtifactType,
	): Promise<ArtifactRef> {
		try {
			await writeFile(pathFor(type), "", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
		return refFor(type, await fileSize(pathFor(type)));
	}

	async function appendTextArtifact(
		type: LogArtifactType,
		content: string | Uint8Array,
	): Promise<ArtifactRef> {
		await appendFile(pathFor(type), content);
		return refFor(type, await fileSize(pathFor(type)));
	}

	function buildResult(input: StoreResultEnvelopeInput): ResultEnvelope {
		return createResultEnvelope({
			...input,
			runId: input.runId ?? runId,
			attemptId: input.attemptId ?? attemptId,
			artifacts: mergeArtifactRefs(input.artifacts ?? [], [refFor("result")]),
		});
	}

	async function writeResult(
		input: StoreResultEnvelopeInput,
	): Promise<ResultEnvelope> {
		const result = buildResult(input);
		const resultPath = pathFor("result");
		const tempPath = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
		// WP2b terminal-last-write: a terminal result.json is the commit point observers and
		// reconcile trust, so the artifacts it lists reach disk before it does (rename after fsync,
		// then the directory entry).
		if (isTerminalResultStatus(result.status))
			for (const artifact of result.artifacts)
				if (artifact.type !== "result")
					await syncFile(resolve(cwd, artifact.path.split("/").join(sep)));
		const handle = await open(tempPath, "w");
		try {
			await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, resultPath);
		await syncFile(attemptDir);
		return result;
	}

	return {
		runId,
		attemptId,
		cwd,
		runsDir,
		runDir,
		attemptsDir,
		attemptDir,
		pathFor,
		refFor,
		writeTextArtifact,
		appendTextArtifact,
		ensureTextArtifact,
		writeResult,
		buildResult,
		taskId: attemptId,
		taskDir: attemptDir,
	};
}

/** @deprecated Use createAttemptArtifactStore. */
export async function createTaskArtifactStore(
	options: CreateTaskArtifactStoreOptions = {},
): Promise<TaskArtifactStore> {
	return await createAttemptArtifactStore(options);
}
