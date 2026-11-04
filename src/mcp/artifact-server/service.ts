// New in agent-workflow (WP5): the workflow_artifact tool behind the stdio MCP server. Wraps the
// core tool (src/core/workflow-artifact-tool.ts) without changing it: config loading and
// validation, path containment checks, the delivery bound (R#9) and the read-ledger write.
// WP5b: the server passes its output limit to the core as `pageLimitChars`, so whole-artifact
// reads are paged (`offset`) within the limit instead of being cut.
// WP12d-1 (review #8): the server no longer writes rows itself. The core tool hands each row over
// (`appendLedger: false` + `onLedgerRecord`, no scratch ledger), and the server persists it with
// the core's hardened writer (`appendWorkflowArtifactReadLedger`: no-follow open, descriptor
// type/link-count/identity checks) plus a descriptor containment check against the run directory.
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
	type ArtifactAccessConfig,
	artifactAccessConfigPath,
	readArtifactAccessConfig,
	workflowArtifactFailureResult,
} from "../../core/artifact-access.js";
import {
	appendWorkflowArtifactReadLedger,
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
import { isInsidePath } from "../../core/physical-paths.js";

/**
 * Ledger row written by this server: the core record. `deliveryUnverified` is `true` when the
 * server cut the response to fit the delivery bound, `false` on page rows (WP5b) delivered whole.
 */
export type ArtifactMcpLedgerRecord = WorkflowArtifactReadLedgerRecord;

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
	// The core tool does not append (`appendLedger: false`): it hands each row to the server,
	// which decides delivery before the row reaches the real ledger.
	const coreConfig = {
		runId: config.runId,
		taskId: config.taskId,
		manifestPath: config.manifestPath,
		ledgerPath: config.ledgerPath,
		accessMode: config.accessMode,
		runDir: config.runDir,
		...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
		...(config.maxLines === undefined ? {} : { maxLines: config.maxLines }),
		...(config.readDedup === undefined ? {} : { readDedup: config.readDedup }),
	};
	// Reads (keyed like the core dedup key) whose delivery was cut; a duplicate-suppressed
	// re-read of one of them must not become clean required-read evidence.
	const cutReads = new Set<string>();
	let queue: Promise<unknown> = Promise.resolve();

	const callOnce = async (
		args: Record<string, unknown>,
	): Promise<ArtifactToolCallResult> => {
		const rows: ArtifactMcpLedgerRecord[] = [];
		let result: Awaited<ReturnType<typeof handleWorkflowArtifactToolCall>>;
		try {
			result = await handleWorkflowArtifactToolCall(args, coreConfig, {
				pageLimitChars: outputLimit,
				appendLedger: false,
				onLedgerRecord: (record) => {
					rows.push(record);
				},
			});
		} catch (error) {
			return failure(error);
		}
		const fullText = result.content.map((part) => part.text).join("");
		const details = result.details;
		const readKey = JSON.stringify([
			args.source,
			args.artifact,
			args.path,
			args.maxItems,
			args.maxChars,
			args.offset,
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
			for (const row of rows)
				await appendWorkflowArtifactReadLedger(
					config.ledgerPath,
					markRows ? markDeliveryUnverified(row, deliveredBytes) : row,
					{ insideDir: realRunDir },
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
			// Serialized: ledger rows keep call order.
			const next = queue.then(() => callOnce(args));
			queue = next.catch(() => undefined);
			return next;
		},
		async close() {
			await queue;
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
	record: ArtifactMcpLedgerRecord,
	deliveredBytes: number | undefined,
): ArtifactMcpLedgerRecord {
	return {
		...record,
		returnedBytes:
			deliveredBytes === undefined
				? record.returnedBytes
				: Math.min(record.returnedBytes, deliveredBytes),
		truncated: true,
		deliveryUnverified: true,
	};
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
