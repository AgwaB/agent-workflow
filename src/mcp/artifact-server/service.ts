// New in agent-workflow (WP5): the workflow_artifact tool behind the stdio MCP server. Wraps the
// core tool (src/core/workflow-artifact-tool.ts) without changing it: config loading and
// validation, path containment checks, the delivery bound (R#9) and the read-ledger write.
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
	type ArtifactAccessConfig,
	artifactAccessConfigPath,
	readArtifactAccessConfig,
	workflowArtifactFailureResult,
} from "../../core/artifact-access.js";
import {
	handleWorkflowArtifactToolCall,
	loadWorkflowSourceManifest,
	type WorkflowArtifactReadLedgerRecord,
} from "../../core/workflow-artifact-tool.js";
import {
	cutToDeliveryBudget,
	DEFAULT_MCP_OUTPUT_LIMIT_CHARS,
	fitsDeliveryLimit,
	genericCutNotice,
	readCutNotice,
} from "./delivery.js";

/** Ledger row written by this server: the core record plus the R#9 delivery flag. */
export type ArtifactMcpLedgerRecord = WorkflowArtifactReadLedgerRecord & {
	/** Present (always `true`) when the server cut the response to fit the delivery bound. */
	deliveryUnverified?: true;
};

export interface ArtifactToolCallResult {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
}

export interface ArtifactToolService {
	readonly config: ArtifactAccessConfig;
	readonly outputLimit: number;
	readonly outputLimitSource: "client" | "default";
	call(args: Record<string, unknown>): Promise<ArtifactToolCallResult>;
	close(): Promise<void>;
}

export class ArtifactServerStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactServerStartupError";
	}
}

/**
 * Load and validate the config, then return the tool service. Throws
 * `ArtifactServerStartupError` when the server must refuse to start.
 */
export async function createArtifactToolService(options: {
	configPath: string;
	outputLimit?: number;
}): Promise<ArtifactToolService> {
	const fail = (message: string): never => {
		throw new ArtifactServerStartupError(message);
	};
	if (options.configPath.includes("\0"))
		fail("config path must not contain NUL bytes");
	const configPath = resolve(options.configPath);
	await assertRegularFile(configPath, "config").catch((error) =>
		fail(errorMessage(error)),
	);
	const { config } = await readArtifactAccessConfig(configPath).catch((error) =>
		fail(`cannot load config: ${errorMessage(error)}`),
	);
	for (const [field, value] of [
		["runDir", config.runDir],
		["manifestPath", config.manifestPath],
		["ledgerPath", config.ledgerPath],
	] as const)
		if (value.includes("\0"))
			fail(`config ${field} must not contain NUL bytes`);
	if (artifactAccessConfigPath(config) !== configPath)
		fail(
			"config file is not the task's artifact-access.json next to its manifest",
		);
	const runDir = resolve(config.runDir);
	for (const [field, value] of [
		["manifestPath", config.manifestPath],
		["ledgerPath", config.ledgerPath],
	] as const)
		if (!isInsidePath(runDir, resolve(value)))
			fail(`config ${field} must be inside the workflow run directory`);
	const realRunDir = await realpath(runDir).catch(() =>
		fail("workflow run directory is missing or unreadable"),
	);
	if (!(await lstat(realRunDir)).isDirectory())
		fail("workflow run directory is not a directory");
	for (const [label, path] of [
		["config", configPath],
		["source manifest", resolve(config.manifestPath)],
	] as const) {
		await assertRegularFile(path, label).catch((error) =>
			fail(errorMessage(error)),
		);
		if (!isInsidePath(realRunDir, await realpath(path)))
			fail(`${label} must stay inside the workflow run directory`);
	}
	await assertLedgerTarget(config.ledgerPath, realRunDir).catch((error) =>
		fail(errorMessage(error)),
	);
	const manifest = await loadWorkflowSourceManifest(config.manifestPath, {
		runDir,
	}).catch((error) =>
		fail(`cannot load source manifest: ${errorMessage(error)}`),
	);
	if (manifest.runId !== config.runId || manifest.taskId !== config.taskId)
		fail("source manifest runId/taskId do not match the config");

	const outputLimit = options.outputLimit ?? DEFAULT_MCP_OUTPUT_LIMIT_CHARS;
	const outputLimitSource =
		options.outputLimit === undefined ? "default" : "client";
	// Server-private scratch ledger: the core tool appends its row here first, so the server can
	// decide delivery before the row reaches the real ledger. Never an artifact source.
	const scratchDir = await mkdtemp(join(tmpdir(), "aw-artifact-mcp-"));
	const scratchLedger = join(scratchDir, "read-ledger.jsonl");
	const coreConfig = {
		runId: config.runId,
		taskId: config.taskId,
		manifestPath: config.manifestPath,
		ledgerPath: scratchLedger,
		accessMode: config.accessMode,
		runDir: config.runDir,
		...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
		...(config.maxLines === undefined ? {} : { maxLines: config.maxLines }),
	};
	// Reads (keyed like the core dedup key) whose delivery was cut; a duplicate-suppressed
	// re-read of one of them must not become clean required-read evidence.
	const cutReads = new Set<string>();
	let queue: Promise<unknown> = Promise.resolve();

	const callOnce = async (
		args: Record<string, unknown>,
	): Promise<ArtifactToolCallResult> => {
		await writeFile(scratchLedger, "", { mode: 0o600 });
		let result: Awaited<ReturnType<typeof handleWorkflowArtifactToolCall>>;
		try {
			result = await handleWorkflowArtifactToolCall(args, coreConfig);
		} catch (error) {
			return failure(error);
		}
		const rows = (await readFile(scratchLedger, "utf8"))
			.split("\n")
			.filter((line) => line.trim() !== "");
		const fullText = result.content.map((part) => part.text).join("");
		const details = result.details;
		const readKey = JSON.stringify([
			args.source,
			args.artifact,
			args.path,
			args.maxItems,
			args.maxChars,
		]);
		let text = fullText;
		let cut = false;
		let deliveredBytes: number | undefined;
		if (!fitsDeliveryLimit(fullText, outputLimit)) {
			cut = true;
			if (details.action === "read") {
				const notice = readCutNotice({
					limit: outputLimit,
					limitSource: outputLimitSource,
					bytes: Number(details.bytes ?? 0),
					rawAssurance: details.rawAssurance as
						| { kind: string; originalBytes: string }
						| undefined,
				});
				const prefix = cutToDeliveryBudget(
					fullText,
					outputLimit - notice.length,
				);
				const header = readHeader(details);
				deliveredBytes = prefix.startsWith(header)
					? Buffer.byteLength(prefix.slice(header.length), "utf8")
					: 0;
				text = prefix + notice;
			} else {
				const notice = genericCutNotice(outputLimit);
				text =
					cutToDeliveryBudget(fullText, outputLimit - notice.length) + notice;
			}
		}
		const markRows =
			details.action === "read" &&
			(cut || (details.duplicate === true && cutReads.has(readKey)));
		if (details.action === "read" && cut) cutReads.add(readKey);
		try {
			await assertLedgerTarget(config.ledgerPath, realRunDir);
			for (const line of rows)
				await appendLedgerLine(
					config.ledgerPath,
					markRows ? markDeliveryUnverified(line, deliveredBytes) : line,
				);
		} catch (error) {
			return failure(error);
		}
		return { content: [{ type: "text", text }], isError: false };
	};

	const failure = (error: unknown): ArtifactToolCallResult => {
		const failed = workflowArtifactFailureResult(error, config);
		const fullText = failed.content.map((part) => part.text).join("");
		const notice = genericCutNotice(outputLimit);
		const text = fitsDeliveryLimit(fullText, outputLimit)
			? fullText
			: cutToDeliveryBudget(fullText, outputLimit - notice.length) + notice;
		return { content: [{ type: "text", text }], isError: true };
	};

	return {
		config,
		outputLimit,
		outputLimitSource,
		call(args) {
			// Serialized: one scratch ledger, and ledger rows keep call order.
			const next = queue.then(() => callOnce(args));
			queue = next.catch(() => undefined);
			return next;
		},
		async close() {
			await queue;
			await rm(scratchDir, { recursive: true, force: true });
		},
	};
}

function readHeader(details: Record<string, unknown>): string {
	const projection = details.projection as { path?: string } | undefined;
	const label =
		projection?.path === undefined ? "" : ` path=${projection.path}`;
	return `# workflow_artifact: ${String(details.source)}.${String(details.artifact)}${label}\n\n`;
}

function markDeliveryUnverified(
	line: string,
	deliveredBytes: number | undefined,
): string {
	let record: ArtifactMcpLedgerRecord;
	try {
		record = JSON.parse(line) as ArtifactMcpLedgerRecord;
	} catch {
		throw new Error("core read-ledger row is not valid JSON");
	}
	return JSON.stringify({
		...record,
		returnedBytes:
			deliveredBytes === undefined
				? record.returnedBytes
				: Math.min(record.returnedBytes, deliveredBytes),
		truncated: true,
		deliveryUnverified: true,
	});
}

/** Append one JSONL row without following a symlinked ledger. */
async function appendLedgerLine(
	ledgerPath: string,
	line: string,
): Promise<void> {
	await mkdir(dirname(resolve(ledgerPath)), { recursive: true, mode: 0o700 });
	const handle = await open(
		resolve(ledgerPath),
		fsConstants.O_WRONLY |
			fsConstants.O_APPEND |
			fsConstants.O_CREAT |
			fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(`${line}\n`, "utf8");
	} finally {
		await handle.close();
	}
}

/** The ledger may be absent; if present it must be a single-link regular file inside the run dir. */
async function assertLedgerTarget(
	ledgerPath: string,
	realRunDir: string,
): Promise<void> {
	const path = resolve(ledgerPath);
	const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (stat !== undefined) {
		if (stat.isSymbolicLink())
			throw new Error("read ledger must not be a symlink");
		if (!stat.isFile()) throw new Error("read ledger is not a regular file");
		if (stat.nlink > 1) throw new Error("read ledger must not be hard-linked");
	}
	let parent = dirname(path);
	for (;;) {
		const real = await realpath(parent).catch(() => undefined);
		if (real !== undefined) {
			if (!isInsidePath(realRunDir, real))
				throw new Error(
					"read ledger must stay inside the workflow run directory",
				);
			return;
		}
		const up = dirname(parent);
		if (up === parent) throw new Error("read ledger directory is unreadable");
		parent = up;
	}
}

async function assertRegularFile(path: string, label: string): Promise<void> {
	const stat = await lstat(path).catch(() => {
		throw new Error(`${label} is missing or unreadable`);
	});
	if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
	if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
}

function isInsidePath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
