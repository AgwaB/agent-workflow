// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/workflow-artifact-tool.ts. MIT, same author. Changes: read-ledger rows keep deliveryUnverified: true (R#9 groundwork, WP4c); the read ledger is appended and read without following links (O_NOFOLLOW + lstat/fstat same-file check; symlinked parent directory, hard-linked or non-regular ledger refused; mode 0600; one write per row) (WP4c-2); handleWorkflowArtifactToolCall takes `{onLedgerRecord, appendLedger}` so a caller receives the ledger row and can persist it itself (WP4c-2, for the MCP server). WP5b: paged whole-artifact reads (`offset` input, `pageLimitChars` option; a whole read that does not fit the page limit is served as its first page), page rows carry rangeStart/rangeEnd/totalChars/contentSha256 and an explicit deliveryUnverified: false.
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	assertNoRawIntegrityAnchor,
	checkRawLinks,
	establishRawOwner,
	hashRawDescriptor,
	rawDigest,
	readRawIntegrity,
	recheckRawOwner,
	sameRawVersion,
	type RawOwner,
	type RawIntegrity,
	type RawSourceTuple,
} from "./workflow-raw-contract.js";

import {
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import {
	cutToDeliveryBudget,
	fitsDeliveryLimit,
	MCP_OUTPUT_LIMIT_DEFAULT_CHARS,
} from "../sdk/mcp-delivery.js";
import { stringifyPromptJson } from "./prompt-json.js";
import { isSimpleJsonPath, readSimpleJsonPath } from "./workflow-runtime.js";

export const WORKFLOW_SOURCE_MANIFEST_SCHEMA =
	"workflow-source-manifest-v1" as const;
export const WORKFLOW_ARTIFACT_READ_SCHEMA =
	"workflow-artifact-read-v1" as const;

export const WORKFLOW_TASK_ARTIFACT_KINDS = [
	"control",
	"analysis",
	"refs",
	"raw",
] as const;
export const WORKFLOW_DEBUG_ARTIFACT_KINDS = [
	"prompt",
	"system-prompt",
	"stderr",
	"result",
] as const;
export const WORKFLOW_ARTIFACT_KINDS = [
	...WORKFLOW_TASK_ARTIFACT_KINDS,
	...WORKFLOW_DEBUG_ARTIFACT_KINDS,
] as const;

export type WorkflowArtifactKind = (typeof WORKFLOW_ARTIFACT_KINDS)[number];
export type WorkflowArtifactAccessMode = "workflow-task" | "human-debug";

export interface WorkflowArtifactRef {
	path: string;
	mediaType?: string;
}

export interface WorkflowSourceManifestSource {
	source: string;
	generation?: number;
	sourceGeneration?: number;
	displayName?: string;
	taskId?: string;
	specId?: string;
	stageId?: string;
	itemIdentity?: string;
	placeholderSpecId?: string;
	status?: string;
	statusDetail?: string;
	lastMessage?: string;
	errorType?: string;
	digest?: string;
	controlProjection?: unknown;
	projectionMissingPaths?: string[];
	projectionTruncated?: boolean;
	projectionSource?: "partial-ledger";
	artifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifactRef>>;
}

export interface WorkflowSourceManifest {
	schema: typeof WORKFLOW_SOURCE_MANIFEST_SCHEMA;
	runId: string;
	taskId: string;
	sources: WorkflowSourceManifestSource[];
	policy?: {
		accessMode?: WorkflowArtifactAccessMode;
		debugArtifacts?: boolean;
	};
}

export interface RawAssurance {
	kind:
		| "host_digest_verified"
		| "legacy_scoped_unattested"
		| "independent_unattested";
	originalBytes: "host_digest_verified" | "unattested";
}

export interface WorkflowArtifactReadLedgerRecord {
	rawAssurance?: RawAssurance;
	schema: typeof WORKFLOW_ARTIFACT_READ_SCHEMA;
	runId: string;
	taskId: string;
	source: string;
	artifact: WorkflowArtifactKind;
	at: string;
	bytes: number;
	returnedBytes: number;
	truncated: boolean;
	path?: string;
	maxItems?: number;
	maxChars?: number;
	/**
	 * R#9 (agent-workflow): `true` — the MCP server could not verify that the full result reached
	 * the worker (the client's output cap may truncate it); such rows never satisfy a required
	 * read. `false` (WP5b page rows only) — the page was delivered whole within the output limit.
	 */
	deliveryUnverified?: boolean;
	/**
	 * WP5b paged whole-artifact read: the row covers UTF-16 chars `[rangeStart, rangeEnd)` of the
	 * artifact text (`totalChars` long, the UTF-8 decoding of the file whose bytes hash to
	 * `contentSha256`). All four are present together or not at all, never with `path`.
	 * `truncated` is true unless the page covers the whole artifact.
	 */
	rangeStart?: number;
	rangeEnd?: number;
	totalChars?: number;
	contentSha256?: string;
}

export interface WorkflowArtifactToolConfig {
	runId: string;
	taskId: string;
	manifestPath: string;
	ledgerPath: string;
	accessMode?: WorkflowArtifactAccessMode;
	runDir?: string;
	maxBytes?: number;
	maxLines?: number;
}

export interface WorkflowArtifactListEntry {
	source: string;
	displayName?: string;
	taskId?: string;
	specId?: string;
	stageId?: string;
	status?: string;
	statusDetail?: string;
	lastMessage?: string;
	errorType?: string;
	digest?: string;
	controlProjection?: unknown;
	projectionMissingPaths?: string[];
	projectionTruncated?: boolean;
	projectionSource?: "partial-ledger";
	artifacts: WorkflowArtifactKind[];
}

export interface WorkflowArtifactProjectionMetadata {
	path: string;
	valueType: string;
	maxItems?: number;
	maxChars?: number;
	totalItems?: number;
	itemsReturned?: number;
	itemsTruncated?: boolean;
	originalChars: number;
	charsReturned: number;
	charsTruncated: boolean;
}

export interface WorkflowArtifactReadResult {
	rawAssurance?: RawAssurance;
	source: string;
	artifact: WorkflowArtifactKind;
	content: string;
	bytes: number;
	returnedBytes: number;
	truncated: boolean;
	mediaType?: string;
	projection?: WorkflowArtifactProjectionMetadata;
	/** WP5b: sha256 (hex) of the whole file, set by `whole` reads only. */
	contentSha256?: string;
}

export interface WorkflowArtifactToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/**
 * agent-workflow (WP4c-2): ledger hook for hosts that persist read evidence themselves (the MCP
 * server decides delivery first). The result shape is unchanged.
 */
export interface WorkflowArtifactToolCallOptions {
	/**
	 * Default true: append each read row to `config.ledgerPath`. false: do not touch the ledger;
	 * the caller must persist the row it receives through `onLedgerRecord`.
	 */
	appendLedger?: boolean;
	/** Called once per read with the ledger row (after the append when `appendLedger` is true). */
	onLedgerRecord?: (
		record: WorkflowArtifactReadLedgerRecord,
	) => void | Promise<void>;
	/**
	 * WP5b: per-result output limit (UTF-16 chars and UTF-8 bytes) for paged whole-artifact
	 * reads. When set, a whole read (no path, no offset) whose response does not fit is served as
	 * its first page instead. Reads with `offset` are always paged, with this limit or 8192.
	 */
	pageLimitChars?: number;
}

type JsonRecord = Record<string, unknown>;

const WORKFLOW_ARTIFACT_KIND_SET = new Set<string>(WORKFLOW_ARTIFACT_KINDS);
// This cache is intentionally process-local: workflow workers load this tool
// inside the subagent task process, so duplicate-read suppression cannot carry
// across attempts unless the tool host is deliberately hoisted in the future.
const workflowArtifactReadDedupCache = new Map<
	string,
	WorkflowArtifactReadResult
>();
const completedWorkflowArtifactReadCache = new Map<
	string,
	WorkflowArtifactReadResult
>();
const COMPLETED_ARTIFACT_READ_CACHE_MAX = 128;
const DEFAULT_MAX_BYTES = 50 * 1024;
/** WP5b: largest artifact a paged read loads (it is read whole on every page). */
export const WORKFLOW_ARTIFACT_PAGED_READ_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINES = 2000;
const SOURCE_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
let artifactValidatedHookForTests: (() => void | Promise<void>) | undefined;
let artifactReadHookForTests: (() => void | Promise<void>) | undefined;

export function setArtifactReadHookForTests(
	hook: (() => void | Promise<void>) | undefined,
): void {
	artifactReadHookForTests = hook;
}

export function setArtifactValidatedHookForTests(
	hook: (() => void | Promise<void>) | undefined,
): void {
	artifactValidatedHookForTests = hook;
}

export function clearCompletedArtifactReadCacheForTests(): void {
	completedWorkflowArtifactReadCache.clear();
}
const SIMPLE_JSON_PATH_DIAGNOSTIC =
	"path must be $ or a simple dot JSON path with optional array selectors/slices like $.claims[0], $.claims[0:2], $.claims[*], or $[0:2]";
const JSON_PATH_SEGMENT_ALIASES: Record<string, string> = {
	axes: "researchAxes",
	claimVerdicts: "claimVerdictLedger",
	factSlot: "factSlots",
	gaps: "remainingGaps",
	primarySources: "sourcePolicy",
	priorities: "verificationPriorities",
	questions: "researchQuestions",
	requiredSources: "sourcePolicy",
	scope: "researchScope",
	slots: "factSlots",
	sourceQualityRules: "sourcePolicy",
	sourceRequirements: "sourcePolicy",
	verification: "verificationPriorities",
	verificationPriority: "verificationPriorities",
	verdicts: "claimVerdictLedger",
};

export async function loadWorkflowSourceManifest(
	manifestPath: string,
	options: { runDir?: string } = {},
): Promise<WorkflowSourceManifest> {
	const absoluteManifestPath = resolve(manifestPath);
	const runDir = resolve(
		options.runDir ?? inferRunDirFromManifestPath(absoluteManifestPath),
	);
	const raw = JSON.parse(
		await readFile(absoluteManifestPath, "utf8"),
	) as unknown;
	return normalizeWorkflowSourceManifest(raw, { runDir });
}

export function normalizeWorkflowSourceManifest(
	value: unknown,
	options: { runDir: string },
): WorkflowSourceManifest {
	if (!isRecord(value)) throw new Error("source manifest must be an object");
	if (value.schema !== WORKFLOW_SOURCE_MANIFEST_SCHEMA)
		throw new Error(
			`source manifest schema must be ${WORKFLOW_SOURCE_MANIFEST_SCHEMA}`,
		);
	const runId = requiredString(value.runId, "runId");
	const taskId = requiredString(value.taskId, "taskId");
	if (!Array.isArray(value.sources))
		throw new Error("source manifest sources must be an array");

	const seen = new Set<string>();
	const sources = value.sources.map((sourceValue, index) => {
		if (!isRecord(sourceValue))
			throw new Error(`source manifest sources[${index}] must be an object`);
		const source = requiredString(
			sourceValue.source,
			`sources[${index}].source`,
		);
		validateSourceName(source, `sources[${index}].source`);
		if (seen.has(source))
			throw new Error(`duplicate source in source manifest: ${source}`);
		seen.add(source);

		const artifactsValue = sourceValue.artifacts;
		if (!isRecord(artifactsValue))
			throw new Error(`sources[${index}].artifacts must be an object`);

		const artifacts: Partial<
			Record<WorkflowArtifactKind, WorkflowArtifactRef>
		> = {};
		for (const [artifact, refValue] of Object.entries(artifactsValue)) {
			assertArtifactKind(artifact, `sources[${index}].artifacts`);
			if (!isRecord(refValue))
				throw new Error(
					`sources[${index}].artifacts.${artifact} must be an object`,
				);
			const path = requiredString(
				refValue.path,
				`sources[${index}].artifacts.${artifact}.path`,
			);
			const absolutePath = resolveArtifactPath(path, options.runDir, {
				field: `sources[${index}].artifacts.${artifact}.path`,
			});
			const mediaType = optionalString(
				refValue.mediaType,
				`sources[${index}].artifacts.${artifact}.mediaType`,
			);
			artifacts[artifact] = mediaType
				? { path: absolutePath, mediaType }
				: { path: absolutePath };
		}

		return {
			source,
			generation: optionalNonNegativeInteger(
				sourceValue.generation,
				`sources[${index}].generation`,
			),
			sourceGeneration: optionalNonNegativeInteger(
				sourceValue.sourceGeneration,
				`sources[${index}].sourceGeneration`,
			),
			displayName: optionalString(
				sourceValue.displayName,
				`sources[${index}].displayName`,
			),
			taskId: optionalString(sourceValue.taskId, `sources[${index}].taskId`),
			specId: optionalString(sourceValue.specId, `sources[${index}].specId`),
			stageId: optionalString(sourceValue.stageId, `sources[${index}].stageId`),
			status: optionalString(sourceValue.status, `sources[${index}].status`),
			statusDetail: optionalString(
				sourceValue.statusDetail,
				`sources[${index}].statusDetail`,
			),
			lastMessage: optionalString(
				sourceValue.lastMessage,
				`sources[${index}].lastMessage`,
			),
			errorType: optionalString(
				sourceValue.errorType,
				`sources[${index}].errorType`,
			),
			digest: optionalString(sourceValue.digest, `sources[${index}].digest`),
			controlProjection: sourceValue.controlProjection,
			projectionMissingPaths: optionalStringArray(
				sourceValue.projectionMissingPaths,
				`sources[${index}].projectionMissingPaths`,
			),
			projectionTruncated: optionalBoolean(
				sourceValue.projectionTruncated,
				`sources[${index}].projectionTruncated`,
			),
			...(sourceValue.projectionSource === "partial-ledger"
				? { projectionSource: "partial-ledger" as const }
				: {}),
			artifacts,
		};
	});

	const policy = normalizePolicy(value.policy);
	return policy
		? {
				schema: WORKFLOW_SOURCE_MANIFEST_SCHEMA,
				runId,
				taskId,
				sources,
				policy,
			}
		: { schema: WORKFLOW_SOURCE_MANIFEST_SCHEMA, runId, taskId, sources };
}

export function allowedWorkflowArtifactKinds(
	accessMode: WorkflowArtifactAccessMode = "workflow-task",
): WorkflowArtifactKind[] {
	return accessMode === "human-debug"
		? [...WORKFLOW_ARTIFACT_KINDS]
		: [...WORKFLOW_TASK_ARTIFACT_KINDS];
}

export function listWorkflowArtifactSources(
	manifest: WorkflowSourceManifest,
	options: { accessMode?: WorkflowArtifactAccessMode } = {},
): WorkflowArtifactListEntry[] {
	const allowed = new Set(allowedWorkflowArtifactKinds(options.accessMode));
	return manifest.sources.map((source) => {
		const artifacts = Object.keys(source.artifacts).filter(
			(artifact): artifact is WorkflowArtifactKind =>
				allowed.has(artifact as WorkflowArtifactKind),
		);
		return {
			source: source.source,
			displayName: source.displayName,
			taskId: source.taskId,
			specId: source.specId,
			stageId: source.stageId,
			status: source.status,
			statusDetail: source.statusDetail,
			lastMessage: source.lastMessage,
			errorType: source.errorType,
			digest: source.digest,
			controlProjection: source.controlProjection,
			projectionMissingPaths: source.projectionMissingPaths,
			projectionTruncated: source.projectionTruncated,
			projectionSource: source.projectionSource,
			artifacts,
		};
	});
}

export function resolveWorkflowArtifact(
	manifest: WorkflowSourceManifest,
	sourceName: string,
	artifact: string,
	options: { accessMode?: WorkflowArtifactAccessMode } = {},
): {
	source: WorkflowSourceManifestSource;
	artifact: WorkflowArtifactKind;
	ref: WorkflowArtifactRef;
} {
	validateSourceName(sourceName, "source");
	assertArtifactKind(artifact, "artifact");
	const accessMode =
		options.accessMode ?? manifest.policy?.accessMode ?? "workflow-task";
	if (!allowedWorkflowArtifactKinds(accessMode).includes(artifact)) {
		throw new Error(
			`artifact ${artifact} is not available in ${accessMode} access mode`,
		);
	}
	const source = manifest.sources.find(
		(candidate) => candidate.source === sourceName,
	);
	if (!source)
		throw new Error(`unknown workflow artifact source: ${sourceName}`);
	const ref = source.artifacts[artifact];
	if (!ref)
		throw new Error(
			`source ${sourceName} did not produce artifact ${artifact}`,
		);
	return { source, artifact, ref };
}

function rawSourceTuple(source: WorkflowSourceManifestSource): RawSourceTuple {
	const {
		source: name,
		taskId,
		specId,
		stageId,
		generation,
		sourceGeneration,
	} = source;
	return {
		source: name,
		taskId,
		specId,
		stageId,
		generation,
		sourceGeneration,
	};
}

export async function readWorkflowArtifact(
	manifest: WorkflowSourceManifest,
	sourceName: string,
	artifact: string,
	options: {
		accessMode?: WorkflowArtifactAccessMode;
		maxBytes?: number;
		maxLines?: number;
		runDir?: string;
		path?: string;
		maxItems?: number;
		maxChars?: number;
		/**
		 * WP5b: read the whole file (no maxBytes/maxLines truncation, no projection) and set
		 * `contentSha256`. Used by paged reads; files over 64 MiB are refused.
		 */
		whole?: boolean;
	} = {},
): Promise<WorkflowArtifactReadResult> {
	const resolved = resolveWorkflowArtifact(
		manifest,
		sourceName,
		artifact,
		options,
	);
	const artifactPath = resolved.ref.path;
	const opened = await openValidatedArtifactFile({
		artifactPath,
		runDir: options.runDir,
		label: `${sourceName}.${artifact}`,
		rawSource:
			artifact === "raw"
				? {
						runId: manifest.runId,
						...rawSourceTuple(resolved.source),
						sources: manifest.sources.map(rawSourceTuple),
					}
				: undefined,
	});
	let fullRawBytes: Buffer | undefined;
	try {
		if (options.path !== undefined) {
			return {
				...(await readProjectedWorkflowArtifact({
					source: resolved.source.source,
					artifact: resolved.artifact,
					file: opened.file,
					bytes: opened.fileStat.size,
					mediaType: resolved.ref.mediaType,
					path: options.path,
					maxItems: options.maxItems,
					maxChars: options.maxChars,
				})),
				...(opened.rawAssurance ? { rawAssurance: opened.rawAssurance } : {}),
			};
		}
		if (options.maxItems !== undefined || options.maxChars !== undefined) {
			throw new Error("workflow_artifact maxItems/maxChars require path");
		}
		if (options.whole === true) {
			if (opened.fileStat.size > WORKFLOW_ARTIFACT_PAGED_READ_MAX_BYTES)
				throw new Error(
					`workflow artifact is too large to page (${opened.fileStat.size} bytes; limit ${WORKFLOW_ARTIFACT_PAGED_READ_MAX_BYTES}): ${sourceName}.${artifact}`,
				);
			const fullBytes = await opened.file.readFile();
			if (artifact === "raw") fullRawBytes = fullBytes;
			const content = fullBytes.toString("utf8");
			return {
				source: resolved.source.source,
				artifact: resolved.artifact,
				content,
				bytes: opened.fileStat.size,
				returnedBytes: Buffer.byteLength(content, "utf8"),
				truncated: false,
				mediaType: resolved.ref.mediaType,
				contentSha256: createHash("sha256").update(fullBytes).digest("hex"),
				...(opened.rawAssurance ? { rawAssurance: opened.rawAssurance } : {}),
			};
		}
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		const sizeTruncated = opened.fileStat.size > maxBytes;
		if (artifact === "raw" && !sizeTruncated)
			fullRawBytes = await opened.file.readFile();
		const text = fullRawBytes
			? fullRawBytes.toString("utf8")
			: sizeTruncated
				? await readUtf8Prefix(opened.file, maxBytes)
				: await opened.file.readFile({ encoding: "utf8" });
		const bytes = opened.fileStat.size;
		const truncated = truncateHead(text, {
			maxBytes,
			maxLines,
		});
		return {
			source: resolved.source.source,
			artifact: resolved.artifact,
			content: truncated.content,
			bytes,
			returnedBytes: Buffer.byteLength(truncated.content, "utf8"),
			truncated: truncated.truncated || sizeTruncated,
			mediaType: resolved.ref.mediaType,
			...(opened.rawAssurance ? { rawAssurance: opened.rawAssurance } : {}),
		};
	} finally {
		try {
			await opened.validateAfterRead(fullRawBytes);
		} finally {
			await opened.file.close();
		}
	}
}

async function openValidatedArtifactFile(options: {
	artifactPath: string;
	runDir?: string;
	label: string;
	rawSource?: RawSourceTuple & { runId: string; sources: RawSourceTuple[] };
}): Promise<{
	file: FileHandle;
	fileStat: Stats;
	rawAssurance?: RawAssurance;
	validateAfterRead: (fullBytes?: Buffer) => Promise<void>;
}> {
	const linkStat = await lstat(options.artifactPath);
	if (linkStat.isSymbolicLink()) {
		throw new Error(
			`workflow artifact must not be a symlink: ${options.label}`,
		);
	}
	const validatedStat = await stat(options.artifactPath);
	if (!validatedStat.isFile()) {
		throw new Error(
			`workflow artifact is not a regular file: ${options.label}`,
		);
	}
	let owner: RawOwner | undefined;
	let integrity: RawIntegrity | undefined;
	if (options.rawSource) {
		owner = options.runDir
			? await establishRawOwner(dirname(options.artifactPath), {
					...options.rawSource,
					runDir: options.runDir,
				}).catch(() => undefined)
			: undefined;
		if (owner && (await realpath(options.artifactPath)) !== owner.raw)
			throw new Error("raw artifact path is not the owned raw path");
		if (owner) integrity = await readRawIntegrity(owner);
		else await assertNoRawIntegrityAnchor(dirname(options.artifactPath));
	}
	if (validatedStat.nlink > 1) {
		if (!owner)
			throw new Error(
				`workflow artifact must not be hard-linked: ${options.label}`,
			);
		await checkRawLinks(owner, validatedStat);
	}
	if (options.runDir) {
		const [realRunDir, realArtifactPath] = await Promise.all([
			realpath(resolve(options.runDir)),
			realpath(options.artifactPath),
		]);
		if (!isInsidePath(realRunDir, realArtifactPath)) {
			throw new Error(
				`workflow artifact must stay inside the workflow run directory: ${options.label}`,
			);
		}
	}
	await artifactValidatedHookForTests?.();
	const file = await open(
		options.artifactPath,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
	);
	try {
		const fileStat = await file.stat();
		if (fileStat.nlink > 1) {
			if (!owner)
				throw new Error(
					`workflow artifact must not be hard-linked: ${options.label}`,
				);
			await checkRawLinks(owner, fileStat);
		}
		if (!fileStat.isFile() || !sameRawVersion(fileStat, validatedStat)) {
			throw new Error(
				`workflow artifact changed during validation: ${options.label}`,
			);
		}
		if (owner) await recheckRawOwner(owner);
		const rawAssurance: RawAssurance | undefined = options.rawSource
			? {
					kind: integrity
						? "host_digest_verified"
						: owner
							? "legacy_scoped_unattested"
							: "independent_unattested",
					originalBytes: integrity ? "host_digest_verified" : "unattested",
				}
			: undefined;
		return {
			file,
			fileStat,
			rawAssurance,
			validateAfterRead: async (fullBytes) => {
				await artifactReadHookForTests?.();
				if (
					integrity &&
					(integrity.bytes !== fileStat.size ||
						(fullBytes
							? rawDigest(fullBytes)
							: await hashRawDescriptor(file, fileStat.size)) !==
							integrity.sha256)
				)
					throw new Error("raw artifact integrity mismatch");
				if (owner) {
					await recheckRawOwner(owner);
					if (
						JSON.stringify(await readRawIntegrity(owner)) !==
						JSON.stringify(integrity)
					)
						throw new Error("raw artifact integrity record changed");
					if (fileStat.nlink > 1) await checkRawLinks(owner, await file.stat());
				}
				if (
					!sameRawVersion(fileStat, await file.stat()) ||
					!sameRawVersion(fileStat, await lstat(options.artifactPath))
				)
					throw new Error("workflow artifact changed during read");
			},
		};
	} catch (error) {
		await file.close();
		throw error;
	}
}

async function readProjectedWorkflowArtifact(options: {
	source: string;
	artifact: WorkflowArtifactKind;
	file: FileHandle;
	bytes: number;
	mediaType?: string;
	path: string;
	maxItems?: number;
	maxChars?: number;
}): Promise<WorkflowArtifactReadResult> {
	const parsed = JSON.parse(await options.file.readFile({ encoding: "utf8" }));
	let effectivePath = options.path;
	let resolved: unknown;
	for (const candidatePath of projectionPathCandidates(
		options.path,
		options.source,
		options.artifact,
	)) {
		resolved = readSimpleJsonPath(parsed, candidatePath);
		if (resolved !== undefined) {
			effectivePath = candidatePath;
			break;
		}
	}
	if (resolved === undefined) {
		throw new Error(`workflow_artifact path did not resolve: ${options.path}`);
	}
	const sliced = applyProjectionItemLimit(resolved, {
		...options,
		path: effectivePath,
	});
	const serialized = stringifyPromptJson(sliced.value);
	const maxChars = options.maxChars ?? DEFAULT_MAX_BYTES;
	const preview =
		serialized.length > maxChars ? serialized.slice(0, maxChars) : serialized;
	const projection: WorkflowArtifactProjectionMetadata = {
		path: effectivePath,
		valueType: jsonValueType(resolved),
		...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
		maxChars,
		...(sliced.totalItems === undefined
			? {}
			: { totalItems: sliced.totalItems }),
		...(sliced.itemsReturned === undefined
			? {}
			: { itemsReturned: sliced.itemsReturned }),
		...(sliced.itemsTruncated === undefined
			? {}
			: { itemsTruncated: sliced.itemsTruncated }),
		originalChars: serialized.length,
		charsReturned: preview.length,
		charsTruncated: preview.length !== serialized.length,
	};
	const envelope = projection.charsTruncated
		? { projection, preview }
		: { projection, value: sliced.value };
	const content = stringifyPromptJson(envelope);
	return {
		source: options.source,
		artifact: options.artifact,
		content,
		bytes: options.bytes,
		returnedBytes: Buffer.byteLength(content, "utf8"),
		truncated: Boolean(projection.charsTruncated || projection.itemsTruncated),
		mediaType: options.mediaType,
		projection,
	};
}

function projectionPathCandidates(
	path: string,
	source: string,
	artifact: WorkflowArtifactKind,
): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const queue = [path];
	for (let index = 0; index < queue.length && index < 32; index += 1) {
		const candidate = queue[index];
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
		for (const next of [
			stripArraySelector(candidate),
			stripSourcePathPrefix(candidate, source),
			stripArtifactPathPrefix(candidate, artifact),
			applyJsonPathSegmentAliases(candidate),
		]) {
			if (next !== candidate && !seen.has(next)) queue.push(next);
		}
	}
	return candidates;
}

function stripArraySelector(path: string): string {
	return path.replace(/\[(\*|\d+|\d*:\d*)\]/gu, "");
}

function stripSourcePathPrefix(path: string, source: string): string {
	const sourcePrefix = `$.${source}.`;
	if (!path.startsWith(sourcePrefix)) return path;
	return `$.${path.slice(sourcePrefix.length)}`;
}

function stripArtifactPathPrefix(
	path: string,
	artifact: WorkflowArtifactKind,
): string {
	const artifactPath = `$.${artifact}`;
	if (path === artifactPath) return "$";
	if (path.startsWith(`${artifactPath}[`)) {
		return `$${path.slice(artifactPath.length)}`;
	}
	const artifactPrefix = `${artifactPath}.`;
	if (!path.startsWith(artifactPrefix)) return path;
	return `$.${path.slice(artifactPrefix.length)}`;
}

function applyJsonPathSegmentAliases(path: string): string {
	if (path === "$" || !path.startsWith("$.")) return path;
	const parsedSegments: Array<{ name: string; selectors: string }> = [];
	for (const segment of path.slice(2).split(".")) {
		const parsed = parseJsonPathAliasSegment(segment);
		if (!parsed) return path;
		parsedSegments.push(parsed);
	}
	const aliased = parsedSegments.map((segment) => {
		const alias = JSON_PATH_SEGMENT_ALIASES[segment.name];
		return {
			name: alias ?? segment.name,
			selectors: segment.selectors,
			changed: alias !== undefined && alias !== segment.name,
		};
	});
	if (!aliased.some((segment) => segment.changed)) return path;
	return `$.${aliased
		.map((segment) => `${segment.name}${segment.selectors}`)
		.join(".")}`;
}

function parseJsonPathAliasSegment(
	segment: string,
): { name: string; selectors: string } | undefined {
	const match = /^([A-Za-z0-9_-]+)((?:\[(?:\*|\d+|\d*:\d*)\])*)$/u.exec(
		segment,
	);
	if (!match) return undefined;
	return { name: match[1]!, selectors: match[2] ?? "" };
}

function applyProjectionItemLimit(
	value: unknown,
	options: { maxItems?: number; path: string },
): {
	value: unknown;
	totalItems?: number;
	itemsReturned?: number;
	itemsTruncated?: boolean;
} {
	if (options.maxItems === undefined) return { value };
	if (!Array.isArray(value)) {
		throw new Error(
			`workflow_artifact maxItems requires path to resolve to an array: ${options.path}`,
		);
	}
	const itemsReturned = Math.min(value.length, options.maxItems);
	return {
		value: value.slice(0, options.maxItems),
		totalItems: value.length,
		itemsReturned,
		itemsTruncated: itemsReturned < value.length,
	};
}

function jsonValueType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

// O_NOFOLLOW / O_NONBLOCK are absent on some platforms (Windows); the lstat + fstat same-file
// checks below still refuse a link or a non-regular file there.
const LEDGER_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const LEDGER_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function assertLedgerFileStat(stats: Stats): void {
	if (stats.isSymbolicLink())
		throw new Error("read ledger must not be a symlink");
	if (!stats.isFile()) throw new Error("read ledger is not a regular file");
	if (stats.nlink > 1) throw new Error("read ledger must not be hard-linked");
}

async function assertLedgerDirectory(ledgerFile: string): Promise<Stats> {
	const dir = await lstat(dirname(ledgerFile));
	if (dir.isSymbolicLink())
		throw new Error("read ledger directory must not be a symlink");
	if (!dir.isDirectory())
		throw new Error("read ledger directory is not a directory");
	return dir;
}

function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Open the read ledger without following links: a planted symlink (final component or parent
 * directory), a hard link or a non-regular file at the ledger path is refused, so evidence rows can
 * never be redirected outside the task directory. The opened file must be the one at the path
 * (same dev/inode before and after the open).
 */
async function openReadLedger(
	ledgerFile: string,
	flags: number,
	insideDir?: string,
): Promise<FileHandle | undefined> {
	const dirBefore = await assertLedgerDirectory(ledgerFile);
	const before = await lstatIfPresent(ledgerFile);
	if (before !== undefined) assertLedgerFileStat(before);
	let handle: FileHandle;
	try {
		handle = await open(
			ledgerFile,
			flags | LEDGER_NOFOLLOW | LEDGER_NONBLOCK,
			0o600,
		);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" && (flags & fsConstants.O_CREAT) === 0)
			return undefined;
		// O_NOFOLLOW on a symlink: ELOOP (Linux/macOS) or EMLINK (FreeBSD); FIFO without reader: ENXIO.
		if (code === "ELOOP" || code === "EMLINK")
			throw new Error("read ledger must not be a symlink");
		if (code === "ENXIO") throw new Error("read ledger is not a regular file");
		throw error;
	}
	try {
		const opened = await handle.stat();
		assertLedgerFileStat(opened);
		const after = await lstat(ledgerFile);
		assertLedgerFileStat(after);
		const dirAfter = await assertLedgerDirectory(ledgerFile);
		if (!sameFile(opened, after) || !sameFile(dirBefore, dirAfter))
			throw new Error("read ledger changed while it was opened");
		if (insideDir !== undefined) {
			// WP12d-1 (review #8): an ancestor directory swapped for a symlink before the checks
			// above would pass them. The opened file has exactly one name (nlink 1); require that
			// name, fully resolved, to be inside `insideDir` and to be the opened file.
			const real = await realpath(ledgerFile);
			if (!isInsidePath(insideDir, real))
				throw new Error(
					"read ledger must stay inside the workflow run directory",
				);
			if (!sameFile(opened, await lstat(real)))
				throw new Error("read ledger changed while it was opened");
		}
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/**
 * Append one read-ledger row (no-follow open, descriptor checks above). `insideDir` (WP12d-1): a
 * real (symlink-free) directory the opened ledger must resolve inside, checked on the descriptor
 * after the open; the MCP server passes the workflow run directory.
 */
export async function appendWorkflowArtifactReadLedger(
	ledgerPath: string,
	record: WorkflowArtifactReadLedgerRecord,
	options: { insideDir?: string } = {},
): Promise<void> {
	const ledgerFile = resolve(ledgerPath);
	await mkdir(dirname(ledgerFile), { recursive: true });
	const handle = await openReadLedger(
		ledgerFile,
		fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
		options.insideDir,
	);
	if (handle === undefined) throw new Error("read ledger could not be opened");
	try {
		// One O_APPEND write per row keeps rows whole when several calls append concurrently.
		const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		let offset = 0;
		while (offset < line.length) {
			const { bytesWritten } = await handle.write(
				line,
				offset,
				line.length - offset,
			);
			if (bytesWritten <= 0) throw new Error("read ledger write failed");
			offset += bytesWritten;
		}
	} finally {
		await handle.close();
	}
}

export async function readWorkflowArtifactReadLedger(
	ledgerPath: string,
): Promise<WorkflowArtifactReadLedgerRecord[]> {
	const ledgerFile = resolve(ledgerPath);
	if ((await lstatIfPresent(dirname(ledgerFile))) === undefined) return [];
	const handle = await openReadLedger(ledgerFile, fsConstants.O_RDONLY);
	if (handle === undefined) return [];
	let text: string;
	try {
		text = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line, index) =>
			normalizeReadLedgerRecord(JSON.parse(line), index + 1),
		);
}

function completedArtifactReadCacheKey(
	config: WorkflowArtifactToolConfig,
	accessMode: WorkflowArtifactAccessMode,
	input: {
		action: "read";
		source?: string;
		artifact?: string;
		path?: string;
		maxItems?: number;
		maxChars?: number;
	},
	artifactPath: string,
): string {
	return JSON.stringify({
		base: workflowArtifactReadDedupKey(config, accessMode, input),
		artifactPath: resolve(artifactPath),
		maxBytes: config.maxBytes,
		maxLines: config.maxLines,
	});
}

function rememberCompletedArtifactRead(
	key: string,
	read: WorkflowArtifactReadResult,
): void {
	if (completedWorkflowArtifactReadCache.has(key))
		completedWorkflowArtifactReadCache.delete(key);
	completedWorkflowArtifactReadCache.set(key, read);
	while (
		completedWorkflowArtifactReadCache.size > COMPLETED_ARTIFACT_READ_CACHE_MAX
	) {
		const oldest = completedWorkflowArtifactReadCache.keys().next().value;
		if (typeof oldest !== "string") break;
		completedWorkflowArtifactReadCache.delete(oldest);
	}
}

function workflowArtifactReadDedupKey(
	config: WorkflowArtifactToolConfig,
	accessMode: WorkflowArtifactAccessMode,
	input: {
		action: "read";
		source?: string;
		artifact?: string;
		path?: string;
		maxItems?: number;
		maxChars?: number;
	},
): string {
	return JSON.stringify({
		runId: config.runId,
		taskId: config.taskId,
		manifestPath: resolve(config.manifestPath),
		accessMode,
		source: input.source,
		artifact: input.artifact,
		path: input.path,
		maxItems: input.maxItems,
		maxChars: input.maxChars,
	});
}

export async function handleWorkflowArtifactToolCall(
	params: unknown,
	config: WorkflowArtifactToolConfig,
	options: WorkflowArtifactToolCallOptions = {},
): Promise<WorkflowArtifactToolResult> {
	const appendLedger = options.appendLedger ?? true;
	const recordRead = async (
		record: WorkflowArtifactReadLedgerRecord,
	): Promise<void> => {
		if (appendLedger)
			await appendWorkflowArtifactReadLedger(config.ledgerPath, record);
		await options.onLedgerRecord?.(record);
	};
	const input = normalizeToolInput(params);
	const runDir = resolve(
		config.runDir ?? inferRunDirFromManifestPath(resolve(config.manifestPath)),
	);
	const manifest = await loadWorkflowSourceManifest(config.manifestPath, {
		runDir,
	});
	if (manifest.runId !== config.runId)
		throw new Error(
			`source manifest runId mismatch: expected ${config.runId}, got ${manifest.runId}`,
		);
	if (manifest.taskId !== config.taskId)
		throw new Error(
			`source manifest taskId mismatch: expected ${config.taskId}, got ${manifest.taskId}`,
		);
	const accessMode =
		config.accessMode ?? manifest.policy?.accessMode ?? "workflow-task";

	if (input.action === "list") {
		const result = {
			runId: manifest.runId,
			taskId: manifest.taskId,
			sources: listWorkflowArtifactSources(manifest, { accessMode }),
		};
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: {
				action: "list",
				runId: manifest.runId,
				taskId: manifest.taskId,
				sourceCount: result.sources.length,
			},
		};
	}

	if (!input.source) throw new Error("workflow_artifact read requires source");
	if (!input.artifact)
		throw new Error("workflow_artifact read requires artifact");
	const pageLimitChars =
		options.pageLimitChars ?? MCP_OUTPUT_LIMIT_DEFAULT_CHARS;
	const servePage = (offset: number) =>
		serveWorkflowArtifactPage({
			manifest,
			config,
			accessMode,
			runDir,
			source: input.source as string,
			artifact: input.artifact as string,
			offset,
			limit: pageLimitChars,
			recordRead,
		});
	// WP5b: paged reads never use the duplicate-read or completed-read caches.
	if (input.offset !== undefined) return await servePage(input.offset);
	const dedupKey = workflowArtifactReadDedupKey(config, accessMode, input);
	const cachedRead =
		input.artifact !== "raw" &&
		workflowExperimentalFlagEnabled(EXPERIMENTAL_TOOL_DEDUP_ENV)
			? workflowArtifactReadDedupCache.get(dedupKey)
			: undefined;
	if (cachedRead !== undefined) {
		await recordRead({
			schema: WORKFLOW_ARTIFACT_READ_SCHEMA,
			runId: config.runId,
			taskId: config.taskId,
			source: cachedRead.source,
			artifact: cachedRead.artifact,
			at: new Date().toISOString(),
			bytes: cachedRead.bytes,
			returnedBytes: 0,
			truncated: cachedRead.truncated,
			...(cachedRead.projection?.path === undefined
				? {}
				: { path: cachedRead.projection.path }),
			...(cachedRead.projection?.maxItems === undefined
				? {}
				: { maxItems: cachedRead.projection.maxItems }),
			...(cachedRead.projection?.maxChars === undefined
				? {}
				: { maxChars: cachedRead.projection.maxChars }),
		});
		const projectionLabel = cachedRead.projection
			? ` path=${cachedRead.projection.path}`
			: "";
		return {
			content: [
				{
					type: "text",
					text: `# workflow_artifact duplicate read suppressed: ${cachedRead.source}.${cachedRead.artifact}${projectionLabel}\n\n<system-reminder>\nYou repeated the same workflow_artifact read in this task. Reuse the earlier result from this task; do not call this exact workflow_artifact read again unless you need a different source, artifact, path, maxItems, or maxChars.\n</system-reminder>`,
				},
			],
			details: {
				action: "read",
				runId: config.runId,
				taskId: config.taskId,
				source: cachedRead.source,
				artifact: cachedRead.artifact,
				bytes: cachedRead.bytes,
				returnedBytes: 0,
				truncated: cachedRead.truncated,
				mediaType: cachedRead.mediaType,
				projection: cachedRead.projection,
				duplicate: true,
			},
		};
	}
	const resolvedArtifact = resolveWorkflowArtifact(
		manifest,
		input.source,
		input.artifact,
		{ accessMode },
	);
	const completedCacheKey =
		input.artifact !== "raw" && resolvedArtifact.source.status === "completed"
			? completedArtifactReadCacheKey(
					config,
					accessMode,
					input,
					resolvedArtifact.ref.path,
				)
			: undefined;
	let read =
		completedCacheKey === undefined
			? undefined
			: completedWorkflowArtifactReadCache.get(completedCacheKey);
	if (read === undefined) {
		read = await readWorkflowArtifact(manifest, input.source, input.artifact, {
			accessMode,
			maxBytes: config.maxBytes,
			maxLines: config.maxLines,
			runDir,
			path: input.path,
			maxItems: input.maxItems,
			maxChars: input.maxChars,
		});
		if (completedCacheKey !== undefined)
			rememberCompletedArtifactRead(completedCacheKey, read);
	}
	const text = workflowArtifactReadText(read);
	// WP5b: a whole read that does not fit the caller's output limit becomes its first page, so
	// the worker can page on instead of receiving a cut (deliveryUnverified) response.
	if (
		options.pageLimitChars !== undefined &&
		read.projection === undefined &&
		!fitsDeliveryLimit(text, options.pageLimitChars)
	)
		return await servePage(0);
	await recordRead({
		schema: WORKFLOW_ARTIFACT_READ_SCHEMA,
		runId: config.runId,
		taskId: config.taskId,
		source: read.source,
		artifact: read.artifact,
		at: new Date().toISOString(),
		bytes: read.bytes,
		returnedBytes: read.returnedBytes,
		truncated: read.truncated,
		...(read.rawAssurance ? { rawAssurance: read.rawAssurance } : {}),
		...(read.projection?.path === undefined
			? {}
			: { path: read.projection.path }),
		...(read.projection?.maxItems === undefined
			? {}
			: { maxItems: read.projection.maxItems }),
		...(read.projection?.maxChars === undefined
			? {}
			: { maxChars: read.projection.maxChars }),
	});
	if (workflowExperimentalFlagEnabled(EXPERIMENTAL_TOOL_DEDUP_ENV)) {
		workflowArtifactReadDedupCache.set(dedupKey, read);
	}
	return {
		content: [{ type: "text", text }],
		details: {
			action: "read",
			runId: config.runId,
			taskId: config.taskId,
			source: read.source,
			artifact: read.artifact,
			bytes: read.bytes,
			returnedBytes: read.returnedBytes,
			truncated: read.truncated,
			mediaType: read.mediaType,
			projection: read.projection,
			...(read.rawAssurance ? { rawAssurance: read.rawAssurance } : {}),
		},
	};
}

function workflowArtifactReadText(read: WorkflowArtifactReadResult): string {
	const projectionLabel = read.projection
		? ` path=${read.projection.path}`
		: "";
	const truncation = read.truncated
		? `\n\n[workflow_artifact output truncated: returned ${read.returnedBytes} bytes from ${read.bytes} artifact bytes.]`
		: "";
	return `# workflow_artifact: ${read.source}.${read.artifact}${projectionLabel}\n\n${read.content}${truncation}${rawAssuranceLine(read.rawAssurance)}`;
}

function rawAssuranceLine(rawAssurance: RawAssurance | undefined): string {
	return rawAssurance
		? `\n\n[raw assurance: ${rawAssurance.kind}; original bytes: ${rawAssurance.originalBytes}]`
		: "";
}

function workflowArtifactPageFooter(
	start: number,
	end: number,
	total: number,
): string {
	return end < total
		? `\n\n[workflow_artifact page: chars ${start}–${end} of ${total}; call again with offset=${end} to continue]`
		: `\n\n[workflow_artifact page: chars ${start}–${end} of ${total}; end of artifact]`;
}

/**
 * WP5b: one page `[start, end)` of a whole artifact (UTF-16 offsets into its UTF-8 decoding).
 * The response — header, page, raw-assurance line and footer — fits `limit` in UTF-16 chars and in
 * UTF-8 bytes. A page never starts or ends inside a surrogate pair: an `offset` that points at the
 * second half of a pair starts one char earlier. `offset` must be below the length (0 for an
 * empty artifact).
 */
export function workflowArtifactPage(options: {
	source: string;
	artifact: string;
	content: string;
	offset: number;
	limit: number;
	rawAssurance?: RawAssurance;
}): { text: string; start: number; end: number; total: number } {
	const { content, limit } = options;
	const total = content.length;
	if (
		!Number.isSafeInteger(options.offset) ||
		options.offset < 0 ||
		(total === 0 ? options.offset !== 0 : options.offset >= total)
	)
		throw new Error(
			`workflow_artifact offset ${options.offset} is past the end of ${options.source}.${options.artifact} (${total} chars); use an offset below ${Math.max(total, 1)}`,
		);
	let start = options.offset;
	const code = content.charCodeAt(start);
	const before = start > 0 ? content.charCodeAt(start - 1) : 0;
	if (code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff)
		start -= 1;
	const header = `# workflow_artifact: ${options.source}.${options.artifact}\n\n`;
	const raw = rawAssuranceLine(options.rawAssurance);
	// Worst-case footer: the continuation form with the widest end offset.
	const fixed =
		header + raw + workflowArtifactPageFooter(start, total, total + 1);
	const budget = limit - Buffer.byteLength(fixed, "utf8");
	const page = cutToDeliveryBudget(content.slice(start), budget);
	if (page.length === 0 && start < total)
		throw new Error(
			`workflow_artifact output limit ${limit} is too small to page ${options.source}.${options.artifact}`,
		);
	const end = start + page.length;
	const text = `${header}${page}${raw}${workflowArtifactPageFooter(start, end, total)}`;
	if (!fitsDeliveryLimit(text, limit))
		throw new Error(
			`workflow_artifact page does not fit the output limit ${limit}`,
		);
	return { text, start, end, total };
}

async function serveWorkflowArtifactPage(options: {
	manifest: WorkflowSourceManifest;
	config: WorkflowArtifactToolConfig;
	accessMode: WorkflowArtifactAccessMode;
	runDir: string;
	source: string;
	artifact: string;
	offset: number;
	limit: number;
	recordRead: (record: WorkflowArtifactReadLedgerRecord) => Promise<void>;
}): Promise<WorkflowArtifactToolResult> {
	const read = await readWorkflowArtifact(
		options.manifest,
		options.source,
		options.artifact,
		{ accessMode: options.accessMode, runDir: options.runDir, whole: true },
	);
	const contentSha256 = read.contentSha256 as string;
	const page = workflowArtifactPage({
		source: read.source,
		artifact: read.artifact,
		content: read.content,
		offset: options.offset,
		limit: options.limit,
		rawAssurance: read.rawAssurance,
	});
	const returnedBytes = Buffer.byteLength(
		read.content.slice(page.start, page.end),
		"utf8",
	);
	const truncated = !(page.start === 0 && page.end === page.total);
	await options.recordRead({
		schema: WORKFLOW_ARTIFACT_READ_SCHEMA,
		runId: options.config.runId,
		taskId: options.config.taskId,
		source: read.source,
		artifact: read.artifact,
		at: new Date().toISOString(),
		bytes: read.bytes,
		returnedBytes,
		truncated,
		...(read.rawAssurance ? { rawAssurance: read.rawAssurance } : {}),
		rangeStart: page.start,
		rangeEnd: page.end,
		totalChars: page.total,
		contentSha256,
		deliveryUnverified: false,
	});
	return {
		content: [{ type: "text", text: page.text }],
		details: {
			action: "read",
			runId: options.config.runId,
			taskId: options.config.taskId,
			source: read.source,
			artifact: read.artifact,
			bytes: read.bytes,
			returnedBytes,
			truncated,
			mediaType: read.mediaType,
			page: {
				rangeStart: page.start,
				rangeEnd: page.end,
				totalChars: page.total,
				contentSha256,
			},
			...(read.rawAssurance ? { rawAssurance: read.rawAssurance } : {}),
		},
	};
}

export function inferRunDirFromManifestPath(manifestPath: string): string {
	return resolve(dirname(resolve(manifestPath)), "..", "..");
}

function normalizeReadLedgerRecord(
	value: unknown,
	lineNumber: number,
): WorkflowArtifactReadLedgerRecord {
	if (!isRecord(value))
		throw new Error(`read ledger line ${lineNumber} must be an object`);
	if (value.schema !== WORKFLOW_ARTIFACT_READ_SCHEMA)
		throw new Error(`read ledger line ${lineNumber} has unsupported schema`);
	const runId = requiredString(value.runId, `line ${lineNumber}.runId`);
	const taskId = requiredString(value.taskId, `line ${lineNumber}.taskId`);
	const source = requiredString(value.source, `line ${lineNumber}.source`);
	validateSourceName(source, `line ${lineNumber}.source`);
	const artifact = requiredString(
		value.artifact,
		`line ${lineNumber}.artifact`,
	);
	assertArtifactKind(artifact, `line ${lineNumber}.artifact`);
	const at = requiredString(value.at, `line ${lineNumber}.at`);
	const bytes = requiredNumber(value.bytes, `line ${lineNumber}.bytes`);
	const returnedBytes = requiredNumber(
		value.returnedBytes,
		`line ${lineNumber}.returnedBytes`,
	);
	const truncated = requiredBoolean(
		value.truncated,
		`line ${lineNumber}.truncated`,
	);
	const path = normalizeProjectionPath(value.path);
	const maxItems = optionalNonNegativeInteger(
		value.maxItems,
		`line ${lineNumber}.maxItems`,
	);
	const maxChars = optionalNonNegativeInteger(
		value.maxChars,
		`line ${lineNumber}.maxChars`,
	);
	if (
		value.deliveryUnverified !== undefined &&
		typeof value.deliveryUnverified !== "boolean"
	)
		throw new Error(
			`read ledger line ${lineNumber}.deliveryUnverified must be a boolean`,
		);
	const range = normalizeReadLedgerRange(value, lineNumber, path);
	return {
		schema: WORKFLOW_ARTIFACT_READ_SCHEMA,
		runId,
		taskId,
		source,
		artifact,
		at,
		bytes,
		returnedBytes,
		truncated,
		...(path === undefined ? {} : { path }),
		...(maxItems === undefined ? {} : { maxItems }),
		...(maxChars === undefined ? {} : { maxChars }),
		...(typeof value.deliveryUnverified === "boolean"
			? { deliveryUnverified: value.deliveryUnverified }
			: {}),
		...range,
		...(value.rawAssurance === undefined
			? {}
			: { rawAssurance: normalizeRawAssurance(value.rawAssurance) }),
	};
}

/** WP5b page fields: all four or none, consistent, never with a projection path. */
function normalizeReadLedgerRange(
	value: JsonRecord,
	lineNumber: number,
	path: string | undefined,
): Pick<
	WorkflowArtifactReadLedgerRecord,
	"rangeStart" | "rangeEnd" | "totalChars" | "contentSha256"
> {
	const keys = ["rangeStart", "rangeEnd", "totalChars", "contentSha256"];
	const present = keys.filter((key) => value[key] !== undefined);
	if (present.length === 0) return {};
	const invalid = () =>
		new Error(
			`read ledger line ${lineNumber} has invalid page range fields (${keys.join(", ")})`,
		);
	if (present.length !== keys.length || path !== undefined) throw invalid();
	const rangeStart = optionalNonNegativeInteger(
		value.rangeStart,
		`line ${lineNumber}.rangeStart`,
	) as number;
	const rangeEnd = optionalNonNegativeInteger(
		value.rangeEnd,
		`line ${lineNumber}.rangeEnd`,
	) as number;
	const totalChars = optionalNonNegativeInteger(
		value.totalChars,
		`line ${lineNumber}.totalChars`,
	) as number;
	if (
		rangeStart > rangeEnd ||
		rangeEnd > totalChars ||
		typeof value.contentSha256 !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.contentSha256)
	)
		throw invalid();
	return {
		rangeStart,
		rangeEnd,
		totalChars,
		contentSha256: value.contentSha256,
	};
}

function normalizeRawAssurance(value: unknown): RawAssurance {
	if (
		!isRecord(value) ||
		(value.kind !== "host_digest_verified" &&
			value.kind !== "legacy_scoped_unattested" &&
			value.kind !== "independent_unattested") ||
		value.originalBytes !==
			(value.kind === "host_digest_verified"
				? "host_digest_verified"
				: "unattested")
	) {
		throw new Error("invalid raw assurance metadata");
	}
	return {
		kind: value.kind,
		originalBytes:
			value.kind === "host_digest_verified"
				? "host_digest_verified"
				: "unattested",
	};
}

function normalizeToolInput(value: unknown):
	| { action: "list"; source?: string; artifact?: string }
	| {
			action: "read";
			source?: string;
			artifact?: string;
			path?: string;
			maxItems?: number;
			maxChars?: number;
			offset?: number;
	  } {
	if (!isRecord(value))
		throw new Error("workflow_artifact input must be an object");
	const action = requiredString(value.action, "action");
	if (action !== "list" && action !== "read")
		throw new Error("workflow_artifact action must be list or read");
	const source = optionalString(value.source, "source");
	const artifact = optionalString(value.artifact, "artifact");
	const path = normalizeProjectionPath(value.path);
	const maxItems = optionalNonNegativeInteger(value.maxItems, "maxItems");
	const maxChars = optionalNonNegativeInteger(value.maxChars, "maxChars");
	if (source !== undefined) validateSourceName(source, "source");
	if (artifact !== undefined) assertArtifactKind(artifact, "artifact");
	if (action === "list") return { action, source, artifact };
	const offset = optionalNonNegativeInteger(value.offset, "offset");
	if (
		offset !== undefined &&
		(path !== undefined || maxItems !== undefined || maxChars !== undefined)
	)
		throw new Error(
			"workflow_artifact offset pages a whole-artifact read; it cannot be combined with path, maxItems or maxChars",
		);
	return {
		action,
		source,
		artifact,
		path,
		maxItems,
		maxChars,
		...(offset === undefined ? {} : { offset }),
	};
}

function normalizeProjectionPath(value: unknown): string | undefined {
	const path = optionalString(value, "path");
	if (path === undefined) return undefined;
	if (!isSimpleJsonPath(path)) throw new Error(SIMPLE_JSON_PATH_DIAGNOSTIC);
	return path;
}

function normalizePolicy(
	value: unknown,
): WorkflowSourceManifest["policy"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value))
		throw new Error("source manifest policy must be an object");
	const accessMode = optionalString(value.accessMode, "policy.accessMode");
	if (
		accessMode !== undefined &&
		accessMode !== "workflow-task" &&
		accessMode !== "human-debug"
	) {
		throw new Error("policy.accessMode must be workflow-task or human-debug");
	}
	const debugArtifacts =
		value.debugArtifacts === undefined
			? undefined
			: requiredBoolean(value.debugArtifacts, "policy.debugArtifacts");
	return accessMode || debugArtifacts !== undefined
		? {
				accessMode: accessMode as WorkflowArtifactAccessMode | undefined,
				debugArtifacts,
			}
		: undefined;
}

function resolveArtifactPath(
	path: string,
	runDir: string,
	options: { field: string },
): string {
	if (!isAbsolute(path)) throw new Error(`${options.field} must be absolute`);
	const absolutePath = resolve(path);
	if (!isInsidePath(resolve(runDir), absolutePath))
		throw new Error(
			`${options.field} must be inside the workflow run directory`,
		);
	return absolutePath;
}

function validateSourceName(value: string, field: string): void {
	if (!SOURCE_NAME_PATTERN.test(value) || value.includes(".."))
		throw new Error(
			`${field} must be a canonical workflow artifact source name`,
		);
}

function assertArtifactKind(
	value: string,
	field: string,
): asserts value is WorkflowArtifactKind {
	if (!WORKFLOW_ARTIFACT_KIND_SET.has(value))
		throw new Error(
			`${field} must be one of: ${WORKFLOW_ARTIFACT_KINDS.join(", ")}`,
		);
}

function isInsidePath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readUtf8Prefix(
	file: FileHandle,
	maxBytes: number,
): Promise<string> {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.alloc(maxBytes);
	const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
	return buffer.subarray(0, bytesRead).toString("utf8");
}

function truncateHead(
	text: string,
	options: { maxBytes: number; maxLines: number },
): { content: string; truncated: boolean } {
	const lines = text.split(/\r?\n/);
	let content =
		lines.length > options.maxLines
			? lines.slice(0, options.maxLines).join("\n")
			: text;
	let truncated = content !== text;
	if (Buffer.byteLength(content, "utf8") > options.maxBytes) {
		content = truncateToUtf8Bytes(content, options.maxBytes);
		truncated = true;
	}
	return { content, truncated };
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return text.slice(0, low);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${field} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function optionalStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string")
			throw new Error(`${field}[${index}] must be a string`);
	}
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`${field} must be a finite number`);
	return value;
}

function optionalNonNegativeInteger(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value as number;
}

function requiredBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}
