// The artifact server output limit comes from the task's executor probe.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerSpec } from "../sdk/contract.js";
import {
	artifactServerOutputLimit,
	MCP_OUTPUT_LIMIT_MAX_CHARS,
	MCP_OUTPUT_LIMIT_MIN_CHARS,
} from "../sdk/mcp-delivery.js";
import type { WorkflowRunRecord } from "./types.js";
import type { WorkflowArtifactAccessMode } from "./workflow-artifact-tool.js";

export const WORKFLOW_ARTIFACT_TOOL_NAME = "workflow_artifact" as const;
/** MCP server name; executors expose its single tool as `workflow_artifact`. */
export const ARTIFACT_MCP_SERVER_NAME = "workflow_artifact" as const;
/** Written next to `source-manifest.json` in the task directory. */
export const ARTIFACT_ACCESS_CONFIG_FILE = "artifact-access.json" as const;
/** Package-relative entry of the WP5 artifact MCP server (built file). */
export const ARTIFACT_MCP_SERVER_ENTRY =
	"mcp/artifact-server/server.js" as const;

/**
 * Everything the workflow_artifact server needs for one task attempt. It is
 * JSON-serializable and written as canonical JSON, so its bytes are stable
 * and launch provenance can digest them.
 */
export interface ArtifactAccessConfig {
	version: 1;
	runId: string;
	taskId: string;
	manifestPath: string;
	ledgerPath: string;
	accessMode: WorkflowArtifactAccessMode;
	runDir: string;
	maxBytes?: number;
	maxLines?: number;
	/**
	 * 2026-11-01: the run's recorded AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP decision (duplicate-read
	 * suppression). Absent for runs created before flags were recorded: the server reads its env.
	 */
	readDedup?: boolean;
}

/** `readDedup` for a task's config, from the run's recorded flags (absent on older runs). */
export function artifactAccessReadDedup(run: {
	readonly experimentalFlags?: readonly string[];
}): { readDedup?: boolean } {
	return Array.isArray(run.experimentalFlags)
		? {
				readDedup: run.experimentalFlags.includes(
					"AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP",
				),
			}
		: {};
}

export type ArtifactMcpServerSpec = McpServerSpec & {
	readonly name: typeof ARTIFACT_MCP_SERVER_NAME;
	readonly args: readonly [string, "--config", string];
};

/** Tool input schema (JSON Schema) the MCP server advertises. */
export const WORKFLOW_ARTIFACT_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			type: "string",
			enum: ["list", "read"],
			description: "List visible workflow artifacts or read one artifact.",
		},
		source: {
			type: "string",
			description: "Canonical source name from workflow_artifact list.",
		},
		artifact: {
			type: "string",
			enum: [
				"control",
				"analysis",
				"refs",
				"raw",
				"prompt",
				"system-prompt",
				"stderr",
				"result",
			],
			description: "Artifact kind to read when action is read.",
		},
		path: {
			type: "string",
			description:
				"Optional simple JSON path for projected reads, for example $.claims or $.claimIndex.items. Required when maxItems or maxChars is provided. Supported only for JSON artifacts.",
		},
		maxItems: {
			type: "integer",
			minimum: 0,
			description:
				"Optional head-N array limit for projected reads. Requires path resolving to an array; this is not semantic top-k.",
		},
		maxChars: {
			type: "integer",
			minimum: 0,
			description:
				"Optional character limit for the projected JSON value after maxItems is applied. Requires path; omit maxChars for whole-artifact reads.",
		},
		offset: {
			type: "integer",
			minimum: 0,
			description:
				"Optional character offset for a paged whole-artifact read (not with path, maxItems or maxChars). A large artifact is returned one page at a time; continue with the offset the page footer names.",
		},
	},
	required: ["action"],
} as const;

export const WORKFLOW_ARTIFACT_TOOL_DESCRIPTION =
	"List or read artifacts produced by upstream workflow stages. Reads are recorded for workflow required-read enforcement. Large whole-artifact reads are paged: call again with the offset each page names.";

export const WORKFLOW_ARTIFACT_TOOL_GUIDELINES = [
	"Use workflow_artifact to inspect upstream workflow artifacts when the workflow prompt lists available sources or required reads.",
	"Call workflow_artifact with action=list to see visible source names before reading an artifact if unsure.",
	"When using maxItems or maxChars, include a JSON path such as $.claims; for whole-artifact reads, omit maxItems/maxChars.",
	"A whole-artifact read ending in 'call again with offset=N' is one page: read on with offset=N until a page says 'end of artifact'. A required read counts only once every page was read.",
	"Do not use repository read for workflow artifacts; workflow_artifact records required-read evidence.",
] as const;

/** Failure payload the server returns instead of throwing (unchanged wording). */
export function workflowArtifactFailureResult(
	error: unknown,
	config: Pick<ArtifactAccessConfig, "runId" | "taskId">,
) {
	const message = error instanceof Error ? error.message : "unknown failure";
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						status: "blocked",
						code: "artifact_read_failed",
						message,
						next: "Call workflow_artifact with action=list, then retry with a listed source/artifact and a path that exists in that JSON artifact.",
					},
					null,
					2,
				),
			},
		],
		details: {
			action: "error",
			runId: config.runId,
			taskId: config.taskId,
			code: "artifact_read_failed",
		},
	};
}

export function assertArtifactAccessConfig(
	value: unknown,
): asserts value is ArtifactAccessConfig {
	const allowed = new Set([
		"version",
		"runId",
		"taskId",
		"manifestPath",
		"ledgerPath",
		"accessMode",
		"runDir",
		"maxBytes",
		"maxLines",
		"readDedup",
	]);
	const record = value as Record<string, unknown> | null;
	const ok =
		record !== null &&
		typeof record === "object" &&
		!Array.isArray(record) &&
		Object.keys(record).every((key) => allowed.has(key)) &&
		record.version === 1 &&
		nonEmptyString(record.runId) &&
		nonEmptyString(record.taskId) &&
		absolutePath(record.manifestPath) &&
		absolutePath(record.ledgerPath) &&
		absolutePath(record.runDir) &&
		(record.accessMode === "workflow-task" ||
			record.accessMode === "human-debug") &&
		optionalLimit(record.maxBytes) &&
		optionalLimit(record.maxLines) &&
		(record.readDedup === undefined || typeof record.readDedup === "boolean");
	if (!ok) throw new Error("Invalid workflow artifact access config");
}

/** The config file lives next to the task's source manifest. */
export function artifactAccessConfigPath(
	config: Pick<ArtifactAccessConfig, "manifestPath">,
): string {
	return join(dirname(config.manifestPath), ARTIFACT_ACCESS_CONFIG_FILE);
}

/** Absolute path of the built WP5 server entry inside this package. */
export function artifactMcpServerEntryPath(): string {
	// dist/core/artifact-access.js → dist/mcp/artifact-server/server.js
	return fileURLToPath(
		new URL(`../${ARTIFACT_MCP_SERVER_ENTRY}`, import.meta.url),
	);
}

/**
 * stdio MCP server launch spec for one task's artifact access. Executors put it
 * into `SubmitRequest.mcpServers`. The server itself is WP5; only its path is
 * referenced here.
 */
export function artifactMcpServerSpec(
	config: ArtifactAccessConfig,
): ArtifactMcpServerSpec {
	assertArtifactAccessConfig(config);
	return {
		name: ARTIFACT_MCP_SERVER_NAME,
		command: process.execPath,
		args: [
			artifactMcpServerEntryPath(),
			"--config",
			artifactAccessConfigPath(config),
		],
	};
}

/** Server flag carrying the per-result output limit (WP5, R#9). Not a config key: see docs/extending.md#workflow-artifact-mcp-server. */
export const ARTIFACT_MCP_OUTPUT_LIMIT_FLAG = "--max-output-chars" as const;

/**
 * `spec` plus `--max-output-chars <limit>` (WP5b). `null`/`undefined` → a copy of `spec`
 * unchanged, so the server keeps its conservative default.
 */
export function withArtifactMcpOutputLimit(
	spec: McpServerSpec,
	outputLimitChars: number | null | undefined,
): McpServerSpec {
	const copy = {
		...spec,
		args: [...spec.args],
		...(spec.env === undefined ? {} : { env: { ...spec.env } }),
	};
	if (outputLimitChars === null || outputLimitChars === undefined) return copy;
	if (
		!Number.isSafeInteger(outputLimitChars) ||
		outputLimitChars < MCP_OUTPUT_LIMIT_MIN_CHARS ||
		outputLimitChars > MCP_OUTPUT_LIMIT_MAX_CHARS
	)
		throw new Error(
			`MCP output limit must be an integer between ${MCP_OUTPUT_LIMIT_MIN_CHARS} and ${MCP_OUTPUT_LIMIT_MAX_CHARS}`,
		);
	return {
		...copy,
		args: [
			...copy.args,
			ARTIFACT_MCP_OUTPUT_LIMIT_FLAG,
			String(outputLimitChars),
		],
	};
}

/**
 * WP5b: the artifact server's output limit for a run, derived only from the probe recorded in
 * `run.capabilityNegotiation` (WP4d) — `artifactServerOutputLimit` (sdk/mcp-delivery.ts). `null`
 * for runs without a recorded limit (server default). The task runner launches the server with
 * this value and launch provenance digests the same spec, so the digest binds the limit used.
 */
export function artifactServerOutputLimitForRun(
	run: Pick<WorkflowRunRecord, "capabilityNegotiation">,
	/** WP31: the task's executor in a mixed run (absent: the run's executor). */
	executorId?: string,
): number | null {
	const negotiation = run.capabilityNegotiation;
	const probe =
		executorId === undefined || executorId === negotiation?.executorId
			? negotiation?.probe
			: negotiation?.executors?.[executorId]?.probe;
	return artifactServerOutputLimit(probe);
}

/** Canonical JSON (sorted keys, undefined dropped) used for bytes and digests. */
export function canonicalArtifactAccessJson(value: unknown): string {
	return JSON.stringify(normalizeCanonical(value));
}

/** Exact file bytes written for `config`. */
export function artifactAccessConfigBytes(
	config: ArtifactAccessConfig,
): string {
	assertArtifactAccessConfig(config);
	return `${canonicalArtifactAccessJson(config)}\n`;
}

export async function writeArtifactAccessConfig(
	config: ArtifactAccessConfig,
): Promise<{ path: string; bytes: string }> {
	const path = artifactAccessConfigPath(config);
	const bytes = artifactAccessConfigBytes(config);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, bytes, { encoding: "utf8", mode: 0o600 });
	return { path, bytes };
}

export async function readArtifactAccessConfig(
	path: string,
): Promise<{ config: ArtifactAccessConfig; bytes: string }> {
	const bytes = await readFile(path, "utf8");
	let config: unknown;
	try {
		config = JSON.parse(bytes);
	} catch {
		throw new Error("Invalid workflow artifact access config");
	}
	assertArtifactAccessConfig(config);
	return { config, bytes };
}

function normalizeCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeCanonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, normalizeCanonical(entry)]),
		);
	}
	return value;
}

function nonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

function absolutePath(value: unknown): boolean {
	return typeof value === "string" && isAbsolute(value);
}

function optionalLimit(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}
