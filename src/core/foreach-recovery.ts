import { type SubagentRunStatusSnapshot } from "./runtime-port.js";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	assertForeachBatchCapability,
	issueForeachBatchCapability,
} from "./foreach-batch-capability.js";
import {
	applyForeachBatchFallback,
	assertForeachBatchRecord,
	foreachBatchLeaderTask,
	foreachBatchTasks,
	migrateForeachBatchFallbackTasks,
	parseForeachBatchEnvelope,
	reconstructForeachBatchItemOutput,
	setForeachBatchPhase,
	sha256Text,
} from "./foreach-batch-runtime.js";
import {
	directDynamicSynthesisAllowedRefLocators,
	readTaskControlJsonSchema,
} from "./output-validation.js";
import {
	fromProjectPath,
	nowIso,
	setTaskTerminal,
	toProjectPath,
	workflowRunDir,
	writeJsonAtomic,
	writeRunRecord,
} from "./store.js";
import {
	type WorkflowForeachBatchRecord,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
} from "./types.js";
import {
	type ValidParsedWorkflowOutput,
	validateWorkflowOutputForBundle,
	writeValidatedWorkflowTaskArtifactBundle,
} from "./workflow-output-artifacts.js";

type TerminalForeachBatchMaterializationInput = {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	record: WorkflowForeachBatchRecord;
	rawOutput: string;
	stderr: string;
	snapshot: SubagentRunStatusSnapshot;
	status: "completed" | "failed" | "interrupted";
	completedAt: string;
	startedAt?: string;
	exitCode: number;
};

export function terminalForeachBatchStatus(
	status: string,
): "completed" | "failed" | "interrupted" {
	if (status === "completed") return "completed";
	return status === "interrupted" ? "interrupted" : "failed";
}

function foreachBatchArtifactDirectory(
	cwd: string,
	run: WorkflowRunRecord,
	record: WorkflowForeachBatchRecord,
): string {
	// The digest prevents a corrupt persisted batch id from becoming a path.
	return join(
		workflowRunDir(cwd, run.runId),
		"foreach-batches",
		sha256Text(record.batchId),
	);
}

async function writeForeachBatchTextAtomic(
	file: string,
	value: string,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, value, "utf8");
	await rename(temporary, file);
}

async function persistTerminalForeachBatchEvidence(
	input: TerminalForeachBatchMaterializationInput,
): Promise<void> {
	const directory = foreachBatchArtifactDirectory(
		input.cwd,
		input.run,
		input.record,
	);
	const rawFile = join(directory, `raw-attempt-${input.record.attempt}.md`);
	const receiptFile = join(
		directory,
		`receipt-attempt-${input.record.attempt}.json`,
	);
	await writeForeachBatchTextAtomic(rawFile, input.rawOutput);
	await writeJsonAtomic(receiptFile, {
		schema: "workflow-foreach-batch-receipt-v1",
		batchId: input.record.batchId,
		attempt: input.record.attempt,
		phase: "terminal_received",
		members: input.record.members.map((member) => ({
			taskId: member.taskId,
			specId: member.specId,
			role: member.role,
		})),
		status: input.status,
		completedAt: input.completedAt,
		startedAt: input.startedAt,
		exitCode: input.exitCode,
		backend: {
			runId: input.snapshot.runId,
			attemptId: input.snapshot.attemptId,
			backend: input.snapshot.backend,
			failureKind: input.snapshot.failureKind,
		},
		rawSha256: sha256Text(input.rawOutput),
	});
	const receivedAt = nowIso();
	input.record.terminal = {
		receivedAt,
		rawPath: toProjectPath(input.cwd, rawFile),
		receiptPath: toProjectPath(input.cwd, receiptFile),
		rawSha256: sha256Text(input.rawOutput),
		backendRunId: input.snapshot.runId,
		backendAttemptId: input.snapshot.attemptId,
		status: input.status,
		completedAt: input.completedAt,
		...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
		exitCode: input.exitCode,
	};
	if (input.record.dispatch) {
		input.record.dispatch.state = "terminal_received";
		input.record.dispatch.terminalReceivedAt = receivedAt;
	}
	setForeachBatchPhase(input.run, input.record, "terminal_received");
	await writeRunRecord(input.cwd, input.run);
}

export async function fallbackForeachBatchAfterTerminal(
	cwd: string,
	run: WorkflowRunRecord,
	record: WorkflowForeachBatchRecord,
	reason: string,
): Promise<void> {
	const directory = foreachBatchArtifactDirectory(cwd, run, record);
	const diagnosticFile = join(
		directory,
		`fallback-attempt-${record.attempt}.json`,
	);
	await writeJsonAtomic(diagnosticFile, {
		schema: "workflow-foreach-batch-fallback-v1",
		batchId: record.batchId,
		attempt: record.attempt,
		reason,
		terminal: record.terminal,
	});
	setForeachBatchPhase(run, record, "fallback_prepared");
	record.fallback = {
		preparedAt: nowIso(),
		reason,
		diagnosticsPath: toProjectPath(cwd, diagnosticFile),
	};
	await writeRunRecord(cwd, run);
	applyForeachBatchFallback(run, record, reason);
	await writeRunRecord(cwd, run);
}

async function foreachBatchMemberParseOptions(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
) {
	const artifactOptions = task.artifactGraph?.output;
	return {
		analysisRequired: artifactOptions?.analysisRequired ?? true,
		refsRequired: artifactOptions?.refsRequired ?? true,
		refsMinItems: artifactOptions?.refsMinItems,
		refsUrlValidation: artifactOptions?.refsUrlValidation,
		refsAllowedLocators: await directDynamicSynthesisAllowedRefLocators(
			cwd,
			run,
			task,
		),
		maxDigestChars: artifactOptions?.maxDigestChars,
		controlJsonSchema: await readTaskControlJsonSchema(task),
		outputProfile: task.dynamicGenerated?.outputProfile,
	};
}

async function commitTerminalForeachBatch(
	input: Omit<TerminalForeachBatchMaterializationInput, "snapshot" | "status">,
): Promise<boolean> {
	const {
		cwd,
		run,
		record,
		rawOutput,
		stderr,
		completedAt,
		startedAt,
		exitCode,
	} = input;
	if (record.stateRootSha256 || record.capabilitySubjectSha256) {
		const capability = await issueForeachBatchCapability(cwd, record);
		await assertForeachBatchCapability(cwd, record, capability);
	}
	const tasks = foreachBatchTasks(run, record);
	setForeachBatchPhase(run, record, "committing");
	record.commit ??= { startedAt: nowIso() };
	await writeRunRecord(cwd, run);

	const expectedTaskIds = record.members.map((member) => member.taskId);
	const envelope = parseForeachBatchEnvelope(rawOutput, expectedTaskIds);
	if (!envelope.valid) {
		await fallbackForeachBatchAfterTerminal(
			cwd,
			run,
			record,
			`invalid foreach batch envelope: ${envelope.reason}`,
		);
		return true;
	}
	const itemByTaskId = new Map(envelope.items.map((item) => [item.id, item]));
	let validated: Array<{
		task: WorkflowTaskRunRecord;
		rawOutput: string;
		parsed: ValidParsedWorkflowOutput;
		parseOptions: Awaited<ReturnType<typeof foreachBatchMemberParseOptions>>;
	}>;
	try {
		validated = await Promise.all(
			tasks.map(async (task) => {
				const item = itemByTaskId.get(task.taskId);
				if (!item)
					throw new Error(
						`batch item ${task.taskId} is missing after envelope validation`,
					);
				const itemRawOutput = reconstructForeachBatchItemOutput(item);
				const parseOptions = await foreachBatchMemberParseOptions(
					cwd,
					run,
					task,
				);
				const parsed = await validateWorkflowOutputForBundle(
					itemRawOutput,
					parseOptions,
				);
				if (!parsed.valid) {
					throw new Error(
						`batch item ${task.taskId} is invalid: ${parsed.issues
							.map((issue) => issue.message)
							.join("; ")}`,
					);
				}
				return {
					task,
					rawOutput: itemRawOutput,
					parsed: parsed as ValidParsedWorkflowOutput,
					parseOptions,
				};
			}),
		);
	} catch (error) {
		await fallbackForeachBatchAfterTerminal(
			cwd,
			run,
			record,
			`invalid foreach batch member output: ${error instanceof Error ? error.message : String(error)}`,
		);
		return true;
	}

	// All controls/schemas/refs are now valid in memory. No child bundle has
	// been written before this point, so an invalid sibling cannot be accepted.
	await Promise.all(
		validated.map(async (candidate) => {
			const taskDirectory = dirname(
				fromProjectPath(cwd, candidate.task.files.result),
			);
			await mkdir(taskDirectory, { recursive: true });
			const itemStderr =
				candidate.task.foreachBatch?.role === "leader" ? stderr : "";
			await Promise.all([
				writeForeachBatchTextAtomic(
					fromProjectPath(cwd, candidate.task.files.output),
					candidate.rawOutput,
				),
				writeForeachBatchTextAtomic(
					fromProjectPath(cwd, candidate.task.files.stderr),
					itemStderr,
				),
			]);
			await writeValidatedWorkflowTaskArtifactBundle(
				{
					taskDir: taskDirectory,
					rawOutput: candidate.rawOutput,
					rawIntegrityHost: candidate.task,
					startedAt,
					completedAt,
					exitCode,
					stderr: itemStderr,
					...candidate.parseOptions,
				},
				candidate.parsed,
			);
		}),
	);

	setForeachBatchPhase(run, record, "completed");
	if (record.dispatch) {
		record.dispatch.state = "reconciled";
		record.dispatch.reconciledAt = nowIso();
	}
	record.commit = {
		startedAt: record.commit.startedAt,
		completedAt: nowIso(),
	};
	for (const task of tasks) {
		setTaskTerminal(task, "completed", "completed", {
			completedAt,
			exitCode,
			lastMessage: "completed from foreach batch demux",
		});
		delete task.backendHandle;
		delete task.backendFiles;
		if (task.foreachBatch?.role === "member") task.backendTaskId = task.taskId;
	}
	await writeRunRecord(cwd, run);
	return true;
}

export async function materializeTerminalForeachBatchResult(
	input: TerminalForeachBatchMaterializationInput,
): Promise<boolean> {
	await persistTerminalForeachBatchEvidence(input);
	if (input.status !== "completed") {
		await fallbackForeachBatchAfterTerminal(
			input.cwd,
			input.run,
			input.record,
			`batch backend terminal ${input.status}`,
		);
		return true;
	}
	return await commitTerminalForeachBatch(input);
}

/** Recover durable terminal/fallback boundaries without recomputing membership. */
export async function recoverForeachBatchRuntime(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<boolean> {
	let changed = false;
	for (const record of run.foreachBatches ?? []) {
		assertForeachBatchRecord(record);
		if (record.stateRootSha256 || record.capabilitySubjectSha256) {
			const capability = await issueForeachBatchCapability(cwd, record);
			await assertForeachBatchCapability(cwd, record, capability);
		}
		if (record.phase === "fallback_applied")
			changed = migrateForeachBatchFallbackTasks(run, record) || changed;
		foreachBatchTasks(run, record);
		if (record.phase === "fallback_prepared") {
			const reason =
				record.fallback?.reason ?? "incomplete foreach batch fallback";
			applyForeachBatchFallback(run, record, reason);
			changed = true;
			continue;
		}
		if (record.phase === "terminal_received" || record.phase === "committing") {
			const terminal = record.terminal;
			if (!terminal) {
				throw new Error(
					`foreach batch ${record.batchId} has no terminal receipt for ${record.phase}`,
				);
			}
			if (terminal.status !== "completed") {
				await fallbackForeachBatchAfterTerminal(
					cwd,
					run,
					record,
					record.fallback?.reason ??
						`batch backend terminal ${terminal.status}`,
				);
				changed = true;
				continue;
			}
			const rawOutput = await readFile(
				fromProjectPath(cwd, terminal.rawPath),
				"utf8",
			);
			if (sha256Text(rawOutput) !== terminal.rawSha256) {
				throw new Error(
					`foreach batch ${record.batchId} terminal raw evidence integrity failed`,
				);
			}
			const leader = foreachBatchLeaderTask(run, record);
			const stderr = await readFile(
				fromProjectPath(cwd, leader.files.stderr),
				"utf8",
			).catch(() => "");
			await commitTerminalForeachBatch({
				cwd,
				run,
				task: leader,
				record,
				rawOutput,
				stderr,
				completedAt: terminal.completedAt ?? nowIso(),
				startedAt: terminal.startedAt,
				exitCode: terminal.exitCode ?? 0,
			});
			changed = true;
			continue;
		}
		if (record.phase !== "launching") continue;
		const [leader, member] = foreachBatchTasks(run, record);
		if (leader.status === "pending" && !leader.backendHandle) {
			if (record.dispatch?.state === "reserved") {
				const reason =
					"dispatch reservation has no durable terminal receipt; refusing reuse";
				setForeachBatchPhase(run, record, "non_reusable");
				record.dispatch.state = "non_reusable";
				record.dispatch.reason = reason;
				for (const task of [leader, member]) {
					setTaskTerminal(task, "failed", "batch_dispatch_unresolved", {
						exitCode: 1,
						lastMessage: reason,
					});
				}
			} else {
				setForeachBatchPhase(run, record, "prepared");
				member.status = "pending";
				member.statusDetail = "pending";
				member.startedAt = undefined;
				member.lastMessage =
					"foreach batch launch was not claimed; retrying exact prepared pair";
			}
			changed = true;
		}
	}
	if (changed) await writeRunRecord(cwd, run);
	return changed;
}

export async function recoverForeachBatchRuntimeForTests(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<boolean> {
	return await recoverForeachBatchRuntime(cwd, run);
}
