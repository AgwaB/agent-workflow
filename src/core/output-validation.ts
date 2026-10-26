// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/subagent-backend.ts lines 4922-5442, 5726-5775, 6262-6319 (output-contract validation, repair and same-session repair, salvage, claim-support checks). MIT, same author. Changes: executor wording.
import { type SubagentRunStatusSnapshot } from "./runtime-port.js";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import { type JsonSchema, validateJsonSchemaSubset } from "./json-schema.js";
import {
	retryWorkflowTaskSessionId,
	workflowTaskSessionId,
} from "./launch-session.js";
import {
	checkRequiredArtifactReads,
	formatRequiredArtifactRead,
	formatRequiredReadFailureMessage,
	formatRequiredReadPolicyName,
} from "./required-reads.js";
import {
	applyTaskResultArtifact,
	resultCompletedAfterTimeout,
} from "./result.js";
import { retryOrFailArtifactGraphTask } from "./retry-policy.js";
import { fromProjectPath, isTerminalTaskStatus, nowIso } from "./store.js";
import { type SubagentArtifactRef, writeJson } from "./task-artifacts.js";
import {
	elapsedSince,
	recordTaskTimingTelemetry,
} from "./task-observability.js";
import { type WorkflowRunRecord, type WorkflowTaskRunRecord } from "./types.js";
import {
	type WorkflowTaskFailedToolCallSummary,
	buildWorkflowOutputRetryInstructions,
	parseWorkflowOutputForBundle,
	writeWorkflowTaskArtifactBundle,
} from "./workflow-output-artifacts.js";
import { writeWorkflowPartialOutputLedgerFromFile } from "./workflow-partial-output.js";

function artifactGraphRetrySession(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	subagentResult: Record<string, unknown> | undefined,
	attempt: number,
): { repairMode: "same_session" | "new_session"; sessionId: string } {
	if (task.outputRetry?.repairMode === "same_session") {
		return {
			repairMode: "new_session",
			sessionId: retryWorkflowTaskSessionId(run, task, attempt),
		};
	}
	const expectedSessionId = workflowTaskSessionId(run, task);
	const metadata = subagentResult?.metadata;
	const metadataRecord =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>)
			: undefined;
	const actualSessionId = metadataRecord?.sessionId;
	const session = metadataRecord?.session;
	const sessionRecord =
		session && typeof session === "object" && !Array.isArray(session)
			? (session as Record<string, unknown>)
			: undefined;
	const sessionDisposition = sessionRecord?.disposition;
	const sessionId = sessionRecord?.id;
	const sessionRequested = sessionRecord?.requested;
	if (
		workflowExperimentalFlagEnabled(EXPERIMENTAL_SAME_SESSION_REPAIR_ENV) &&
		typeof actualSessionId === "string" &&
		actualSessionId === expectedSessionId &&
		(typeof sessionId !== "string" || sessionId === expectedSessionId) &&
		sessionRequested !== false &&
		(sessionDisposition === "created" || sessionDisposition === "resumed")
	) {
		return { repairMode: "same_session", sessionId: expectedSessionId };
	}
	return {
		repairMode: "new_session",
		sessionId: retryWorkflowTaskSessionId(run, task, attempt),
	};
}

async function measureTerminalArtifactBundleWrite<T>(
	task: WorkflowTaskRunRecord,
	write: () => Promise<T>,
): Promise<T> {
	const startedAtMs = Date.now();
	try {
		return await write();
	} finally {
		recordTaskTimingTelemetry(task, {
			terminalArtifactBundleWriteMs: elapsedSince(startedAtMs),
		});
	}
}

export async function materializeTerminalArtifactGraphResult(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	options: {
		outputFile: string;
		stderrFile: string;
		resultFile: string;
		completedAt: string;
		startedAt?: string;
		exitCode: number;
		subagentResult?: Record<string, unknown>;
		subagentToolCalls?: {
			ref: SubagentArtifactRef;
			records: WorkflowTaskFailedToolCallSummary[];
		};
		subagentToolCallsSummary?: { ref: SubagentArtifactRef; summary: unknown };
		salvage?: {
			failureKind: string;
			subagentStatus: string;
			subagentFailureKind: string | null;
		};
	},
): Promise<boolean> {
	const startedAtMs = Date.now();
	try {
		return await materializeTerminalArtifactGraphResultInner(
			cwd,
			run,
			task,
			options,
		);
	} finally {
		recordTaskTimingTelemetry(task, {
			terminalArtifactMaterializeMs: elapsedSince(startedAtMs),
		});
	}
}

async function materializeTerminalArtifactGraphResultInner(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	options: {
		outputFile: string;
		stderrFile: string;
		resultFile: string;
		completedAt: string;
		startedAt?: string;
		exitCode: number;
		subagentResult?: Record<string, unknown>;
		subagentToolCalls?: {
			ref: SubagentArtifactRef;
			records: WorkflowTaskFailedToolCallSummary[];
		};
		subagentToolCallsSummary?: { ref: SubagentArtifactRef; summary: unknown };
		salvage?: {
			failureKind: string;
			subagentStatus: string;
			subagentFailureKind: string | null;
		};
	},
): Promise<boolean> {
	const rawOutput = await readFile(options.outputFile, "utf8").catch(() => "");
	const artifactOptions = task.artifactGraph?.output;
	if (artifactOptions?.partial && artifactOptions.partial.paths.length > 0) {
		await writeWorkflowPartialOutputLedgerFromFile({
			taskDir: dirname(options.resultFile),
			outputFile: options.outputFile,
			allowedPaths: artifactOptions.partial.paths,
		}).catch(() => undefined);
	}
	let controlJsonSchema: JsonSchema | undefined;
	try {
		controlJsonSchema = await readTaskControlJsonSchema(task);
	} catch (error) {
		return failArtifactGraphTask(task, {
			statusDetail: "control_schema_unavailable",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	const refsAllowedLocators = await directDynamicSynthesisAllowedRefLocators(
		cwd,
		run,
		task,
	);
	const parseOptions = {
		analysisRequired: artifactOptions?.analysisRequired ?? true,
		refsRequired: artifactOptions?.refsRequired ?? true,
		refsMinItems: artifactOptions?.refsMinItems,
		refsUrlValidation: artifactOptions?.refsUrlValidation,
		refsAllowedLocators,
		partialPaths: artifactOptions?.partial?.paths ?? [],
		maxDigestChars: artifactOptions?.maxDigestChars,
		controlJsonSchema,
		outputProfile: task.dynamicGenerated?.outputProfile,
	};
	const parsed = parseWorkflowOutputForBundle(rawOutput, parseOptions);
	const attempt = (task.outputRetry?.attempts ?? 0) + 1;
	const retrySession = artifactGraphRetrySession(
		run,
		task,
		options.subagentResult,
		attempt,
	);
	if (!parsed.valid) {
		await measureTerminalArtifactBundleWrite(task, () =>
			writeWorkflowTaskArtifactBundle({
				taskDir: dirname(options.resultFile),
				rawOutput,
				attempt,
				completedAt: options.completedAt,
				...parseOptions,
			}),
		);
		return retryOrFailArtifactGraphTask(task, {
			reason: "workflow_output_invalid",
			attempt,
			message: buildWorkflowOutputRetryInstructions(
				parsed.issues,
				parseOptions,
			),
			...retrySession,
		});
	}

	const readCheck = await checkRequiredArtifactReads(
		dirname(options.resultFile),
		task.artifactGraph?.requiredReads ?? [],
		task.artifactGraph?.requiredReadPolicy ?? [],
		{ startedAt: options.startedAt },
	);
	if (
		readCheck.missing.length > 0 ||
		readCheck.projectionFailures.length > 0 ||
		readCheck.ledgerError
	) {
		const reason = readCheck.ledgerError
			? "required_reads_ledger_unavailable"
			: readCheck.projectionFailures.length > 0
				? "required_read_projection_failed"
				: "required_reads_missing";
		const artifacts = readCheck.ledgerError
			? [
					...(task.artifactGraph?.requiredReads ?? []).map(
						formatRequiredArtifactRead,
					),
					...(task.artifactGraph?.requiredReadPolicy ?? []).map(
						formatRequiredReadPolicyName,
					),
				]
			: [...readCheck.missing, ...readCheck.projectionFailures];
		const message = readCheck.ledgerError
			? `required workflow artifact read ledger was unavailable or corrupt: ${readCheck.ledgerError}; required reads could not be verified: ${artifacts.join(", ")}`
			: formatRequiredReadFailureMessage(readCheck);
		await measureTerminalArtifactBundleWrite(task, () =>
			writeArtifactGraphMissingReadsAttempt(
				dirname(options.resultFile),
				rawOutput,
				attempt,
				readCheck.missing,
				options.completedAt,
				{
					failureKind: reason,
					errorMessage: message,
					projectionFailures: readCheck.projectionFailures,
				},
			),
		);
		return retryOrFailArtifactGraphTask(task, {
			reason,
			attempt,
			message,
			artifacts,
			...retrySession,
		});
	}

	const stderr = await readFile(options.stderrFile, "utf8").catch(() => "");
	const written = await measureTerminalArtifactBundleWrite(task, () =>
		writeWorkflowTaskArtifactBundle({
			taskDir: dirname(options.resultFile),
			rawOutput,
			rawIntegrityHost: task,
			startedAt: options.startedAt,
			completedAt: options.completedAt,
			exitCode: options.exitCode,
			stderr,
			subagentToolCallsPath: options.subagentToolCalls?.ref.path,
			subagentToolCallsSummaryPath: options.subagentToolCallsSummary?.ref.path,
			subagentToolCallsArtifactCwd:
				options.subagentToolCalls?.ref.artifactCwd ??
				options.subagentToolCallsSummary?.ref.artifactCwd,
			subagentFailedToolCalls: options.subagentToolCalls?.records,
			...(options.salvage
				? {
						salvagedFromFailureKind: options.salvage.failureKind,
						subagentWarning:
							"executor reported failure before a valid final workflow output was salvaged",
						subagentStatus: options.salvage.subagentStatus,
						subagentFailureKind: options.salvage.subagentFailureKind,
					}
				: {}),
			...parseOptions,
		}),
	);
	if (!written.valid) {
		return retryOrFailArtifactGraphTask(task, {
			reason: "workflow_output_invalid",
			attempt,
			message: buildWorkflowOutputRetryInstructions(
				written.parsed.issues,
				parseOptions,
			),
			...retrySession,
		});
	}
	// Retain a host-owned anchor independently of the result sidecar. Removing or
	// replacing that sidecar cannot downgrade new linked raw to legacy evidence.
	task.rawArtifactIntegrity = written.result.rawIntegrity;
	const completedAfterTimeout = resultCompletedAfterTimeout(
		task,
		written.result.completedAt,
	);
	// SAFETY: the valid writer branch returns a validated result envelope, and
	// applyTaskResultArtifact reads only its completedAt/exitCode/errorMessage
	// fields; retain the envelope object without converting or reserializing it.
	const changed = await applyTaskResultArtifact(cwd, task, {
		resultFile: options.resultFile,
		result: written.result as unknown as Record<string, unknown>,
		status: "completed",
		completedAfterTimeout,
	});
	if (isTerminalTaskStatus(task.status)) {
		delete task.backendHandle;
		delete task.backendFiles;
	}
	return changed;
}

export async function readTaskControlJsonSchema(
	task: WorkflowTaskRunRecord,
): Promise<JsonSchema | undefined> {
	const schemaPath = task.artifactGraph?.output.controlSchemaPath;
	if (!schemaPath) return undefined;
	const source = await readFile(schemaPath, "utf8");
	let schema: unknown;
	try {
		schema = JSON.parse(source);
	} catch (error) {
		throw new Error(`task ${task.taskId} control schema is not valid JSON`, {
			cause: error,
		});
	}
	const validation = validateJsonSchemaSubset(schema);
	if (!validation.valid) {
		throw new Error(
			`task ${task.taskId} control schema is not supported: ${validation.issues
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	// SAFETY: the recursive subset validator has verified every supported schema node.
	return schema as JsonSchema;
}

export async function directDynamicSynthesisAllowedRefLocators(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<string[] | undefined> {
	if (run.provenance?.mode !== "direct-dynamic") return undefined;
	if (task.dynamicGenerated?.outputProfile !== "synthesis_v1") return undefined;
	const currentIndex = run.tasks.findIndex(
		(candidate) => candidate.specId === task.specId,
	);
	const artifactLocators = new Set<string>();
	const sourceLocators = new Set<string>();
	const supportedSourceLocators = new Set<string>();
	for (const [index, candidate] of run.tasks.entries()) {
		if (candidate.specId === task.specId) continue;
		if (currentIndex >= 0 && index > currentIndex) continue;
		if (
			candidate.dynamicGenerated?.controllerSpecId !==
			task.dynamicGenerated.controllerSpecId
		)
			continue;
		if (candidate.status !== "completed") continue;
		addTaskArtifactRefLocators(artifactLocators, candidate);
		for (const locator of await readTaskRefsLocators(cwd, candidate)) {
			sourceLocators.add(locator);
		}
		for (const locator of await readTaskPositiveClaimSupportLocators(
			cwd,
			candidate,
		)) {
			supportedSourceLocators.add(locator);
		}
	}
	const allowed = new Set([
		...artifactLocators,
		...(supportedSourceLocators.size > 0
			? supportedSourceLocators
			: sourceLocators),
	]);
	return [...allowed].sort();
}

function addTaskArtifactRefLocators(
	allowed: Set<string>,
	task: WorkflowTaskRunRecord,
): void {
	for (const id of [task.specId, task.taskId]) {
		if (!id) continue;
		allowed.add(id);
		allowed.add(`workflow_artifact:${id}`);
		for (const artifact of ["control", "analysis", "refs", "raw"]) {
			allowed.add(`${id}.${artifact}`);
			allowed.add(`workflow_artifact:${id}.${artifact}`);
		}
	}
}

async function readTaskRefsLocators(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<string[]> {
	try {
		const refsPath = join(
			dirname(fromProjectPath(cwd, task.files.result)),
			"refs.json",
		);
		const parsed = JSON.parse(await readFile(refsPath, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((ref) => {
			const locator = workflowRefLocator(ref);
			return locator ? [locator] : [];
		});
	} catch {
		return [];
	}
}

async function readTaskPositiveClaimSupportLocators(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<string[]> {
	if (task.dynamicGenerated?.outputProfile !== "verification_result_v1") {
		return [];
	}
	try {
		const controlPath = join(
			dirname(fromProjectPath(cwd, task.files.result)),
			"control.json",
		);
		const parsed = JSON.parse(await readFile(controlPath, "utf8"));
		return positiveClaimSupportLocators(parsed);
	} catch {
		return [];
	}
}

function positiveClaimSupportLocators(control: unknown): string[] {
	if (!control || typeof control !== "object" || Array.isArray(control)) {
		return [];
	}
	const record = control as Record<string, unknown>;
	const entries = claimSupportEntries(record);
	return [
		...new Set(
			entries.flatMap((entry) =>
				claimSupportLocators(entry, record.verdict ?? record.status),
			),
		),
	]
		.filter(Boolean)
		.sort();
}

function claimSupportEntries(
	control: Record<string, unknown>,
): Record<string, unknown>[] {
	const raw =
		control.claimSupports ??
		control.sourceSupports ??
		control.claimSourceSupport ??
		control.sourceSupport;
	if (Array.isArray(raw)) {
		return raw.filter(
			(item): item is Record<string, unknown> =>
				!!item && typeof item === "object" && !Array.isArray(item),
		);
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return [raw as Record<string, unknown>];
	}
	return hasTopLevelClaimSupportFields(control) ? [control] : [];
}

function hasTopLevelClaimSupportFields(
	control: Record<string, unknown>,
): boolean {
	return [
		"claim",
		"sourceLocators",
		"locators",
		"sources",
		"sourceRefs",
		"excerpt",
		"quote",
	].some((key) => control[key] !== undefined);
}

function claimSupportLocators(
	entry: Record<string, unknown>,
	fallbackStatus: unknown,
): string[] {
	if (
		!isPositiveClaimSupportStatus(
			entry.status ??
				entry.supportStatus ??
				entry.support ??
				entry.verdict ??
				fallbackStatus,
		)
	) {
		return [];
	}
	return [
		...refLocatorsField(entry.sourceLocators),
		...refLocatorsField(entry.locators),
		...refLocatorsField(entry.sources),
		...refLocatorsField(entry.refs),
		...refLocatorsField(entry.urls),
		...(workflowRefLocator(entry) ? [workflowRefLocator(entry)!] : []),
	];
}

function isPositiveClaimSupportStatus(value: unknown): boolean {
	return (
		value === "supports" ||
		value === "partial" ||
		value === "verified" ||
		value === "weakened"
	);
}

function refLocatorsField(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const locator = workflowRefLocator(item);
		return locator ? [locator] : [];
	});
}

function workflowRefLocator(ref: unknown): string | undefined {
	if (typeof ref === "string") return ref;
	if (!ref || typeof ref !== "object" || Array.isArray(ref)) return undefined;
	const record = ref as Record<string, unknown>;
	for (const key of ["url", "ref", "path", "taskId", "source"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

async function writeArtifactGraphMissingReadsAttempt(
	taskDir: string,
	rawOutput: string,
	attempt: number,
	missingReads: readonly string[],
	completedAt: string,
	options: {
		failureKind?: string;
		errorMessage?: string;
		projectionFailures?: readonly string[];
	} = {},
): Promise<void> {
	await writeFile(
		join(taskDir, `raw.invalid-attempt-${attempt}.md`),
		rawOutput,
		"utf8",
	);
	await writeJson(join(taskDir, `result.invalid-attempt-${attempt}.json`), {
		schema: "workflow-task-result-v1",
		protocol: "workflow-output-sections-v1",
		status: "failed",
		completedAt,
		exitCode: 1,
		failureKind: options.failureKind ?? "required_reads_missing",
		errorMessage:
			options.errorMessage ??
			`missing required workflow artifact reads: ${missingReads.join(", ")}`,
		missingRequiredReads: [...missingReads],
		...(options.projectionFailures && options.projectionFailures.length > 0
			? { requiredReadProjectionFailures: [...options.projectionFailures] }
			: {}),
		outputValidation: { valid: true, issues: [] },
	});
}

function failArtifactGraphTask(
	task: WorkflowTaskRunRecord,
	options: { statusDetail: string; message: string },
): boolean {
	delete task.backendHandle;
	delete task.backendFiles;
	task.pid = undefined;
	task.status = "failed";
	task.statusDetail = options.statusDetail;
	task.exitCode = 1;
	task.completedAt = nowIso();
	task.lastMessage = options.message;
	return true;
}

export function hasPartialSubagentOutput(
	snapshot: SubagentRunStatusSnapshot,
	result: Record<string, unknown> | undefined,
): boolean {
	return (
		snapshot.metadata?.outputPartial === true ||
		(result?.metadata as Record<string, unknown> | undefined)?.outputPartial ===
			true
	);
}

export function shouldAttemptArtifactGraphSalvage(options: {
	task: WorkflowTaskRunRecord;
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	};
	outputBytes: number;
	outputText: string;
	exitCode: number;
	contextLengthExceeded: boolean;
	subagentResult: Record<string, unknown> | undefined;
	snapshot: SubagentRunStatusSnapshot;
}): boolean {
	if (!options.task.artifactGraph?.enabled) return false;
	if (options.statusInfo.status !== "failed") return false;
	if (hasPartialSubagentOutput(options.snapshot, options.subagentResult))
		return false;
	const failureKind =
		options.statusInfo.failureKind ?? options.snapshot.failureKind;
	if (
		failureKind !== "model" &&
		failureKind !== "context_or_request_too_large"
	) {
		return false;
	}
	if (options.outputBytes <= 0) return false;
	if (options.contextLengthExceeded) {
		return looksLikeWorkflowOutputSections(options.outputText);
	}
	if (options.exitCode !== 0) return false;
	const stopReason =
		(options.subagentResult?.metadata as Record<string, unknown> | undefined)
			?.stopReason ?? options.snapshot.metadata?.stopReason;
	return stopReason === "stop" || stopReason === "end";
}

function looksLikeWorkflowOutputSections(text: string): boolean {
	const trimmed = text.trimStart();
	return (
		trimmed.startsWith("<control>") &&
		text.includes("</control>") &&
		text.includes("<analysis>") &&
		text.includes("</analysis>") &&
		text.includes("<refs>") &&
		text.includes("</refs>")
	);
}
