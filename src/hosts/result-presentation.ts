// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/extension.ts (readWorkflowResultPresentation
// and its safe task-artifact helpers, used by the workflow_wait tool). MIT, same author. Changes
// (WP11a): moved into the host API; the truncation notice no longer names the Pi `/workflow` board.
// WP18b: the presentation carries the output task's domain `verdict`.
import { realpath, readFile } from "node:fs/promises";
import {
	dirname,
	isAbsolute as isAbsolutePath,
	relative,
	resolve as resolvePath,
	sep,
	win32,
} from "node:path";

import { fromProjectPath } from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";

export interface WorkflowResultArtifact {
	kind: "final-report" | "evidence-audit";
	label: "Final report" | "Evidence audit";
	path: string;
}

export interface WorkflowResultPresentation {
	preview?: string;
	artifacts: WorkflowResultArtifact[];
	/**
	 * WP18b: the workflow's domain verdict, `verdict` of the output task's control (for example
	 * deep-review's REVIEW_COMPLETE / NEEDS_WORK / PARTIAL_REVIEW). Not the run status.
	 */
	verdict?: string;
}

interface SafeRelativeTaskArtifact {
	path: string;
	text: string;
}

const RESULT_ONLY_WORKFLOW_STATUSES = new Set([
	"completed",
	"synthesized",
	"exhausted_with_output",
]);

export function isResultOnlyWorkflowSuccess(
	semanticStatus: string,
	preview: string | undefined,
): boolean {
	return (
		RESULT_ONLY_WORKFLOW_STATUSES.has(semanticStatus) &&
		Boolean(preview?.trim())
	);
}

function isDirectDynamicSynthesisTask(
	run: WorkflowRunRecord,
	task: WorkflowRunRecord["tasks"][number],
): boolean {
	return (
		run.provenance?.mode === "direct-dynamic" &&
		task.dynamicGenerated?.outputProfile === "synthesis_v1"
	);
}

function safeRelativeTaskArtifactPath(
	taskDir: string,
	candidate: string,
): string | undefined {
	// Metadata is allowed to name a file below the task directory, but never a
	// filesystem path. Reject backslashes and display-control characters too so
	// provider metadata cannot escape the task root or inject completion text.
	if (
		!candidate ||
		/[\u0000-\u001f\u007f`]/u.test(candidate) ||
		candidate.includes("\\") ||
		candidate
			.split("/")
			.some((part) => part === "" || part === "." || part === "..") ||
		isAbsolutePath(candidate) ||
		win32.isAbsolute(candidate)
	)
		return undefined;
	const root = resolvePath(taskDir);
	const resolved = resolvePath(root, candidate);
	const escaped = relative(root, resolved);
	if (
		!escaped ||
		escaped === ".." ||
		escaped.startsWith(`..${sep}`) ||
		isAbsolutePath(escaped)
	)
		return undefined;
	return resolved;
}

function isRawProtocolArtifactPath(candidate: string): boolean {
	const name = candidate.split("/").at(-1)?.toLowerCase();
	return name === "raw.md" || name === "output.log";
}

async function resolveSafeRelativeTaskArtifact(
	taskDir: string,
	candidate: string,
): Promise<SafeRelativeTaskArtifact | undefined> {
	const path = safeRelativeTaskArtifactPath(taskDir, candidate);
	if (!path) return undefined;
	try {
		// Check the resolved target as well as the lexical path. This closes the
		// symlink variant of a traversal supplied through provider metadata.
		const root = await realpath(taskDir);
		const target = await realpath(path);
		const escaped = relative(root, target);
		if (
			escaped === ".." ||
			escaped.startsWith(`..${sep}`) ||
			isAbsolutePath(escaped)
		)
			return undefined;
		const text = (await readFile(target, "utf8")).trim();
		return text ? { path, text } : undefined;
	} catch {
		return undefined;
	}
}

async function readSafeRelativeTaskArtifact(
	taskDir: string,
	candidate: string,
): Promise<string | undefined> {
	const artifact = await resolveSafeRelativeTaskArtifact(taskDir, candidate);
	return artifact?.text;
}

function safeWorkflowArtifactDisplayPath(
	cwd: string,
	artifactPath: string,
): string | undefined {
	const displayPath = relative(resolvePath(cwd), resolvePath(artifactPath));
	if (
		!displayPath ||
		/[\u0000-\u001f\u007f`\\]/u.test(displayPath) ||
		displayPath === ".." ||
		displayPath.startsWith(`..${sep}`) ||
		isAbsolutePath(displayPath)
	)
		return undefined;
	return displayPath;
}

async function collectWorkflowResultArtifacts(
	cwd: string,
	taskDir: string,
	control: Record<string, unknown> | undefined,
): Promise<WorkflowResultArtifact[]> {
	const artifacts: WorkflowResultArtifact[] = [];
	const reportCandidates = [
		stringValue(control?.sidecarPath),
		"final-report.md",
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of reportCandidates) {
		if (isRawProtocolArtifactPath(candidate)) continue;
		const artifact = await resolveSafeRelativeTaskArtifact(taskDir, candidate);
		if (!artifact) continue;
		const path = safeWorkflowArtifactDisplayPath(cwd, artifact.path);
		if (!path) continue;
		artifacts.push({ kind: "final-report", label: "Final report", path });
		break;
	}
	const auditCandidate = stringValue(control?.auditSidecarPath);
	if (auditCandidate && !isRawProtocolArtifactPath(auditCandidate)) {
		const artifact = await resolveSafeRelativeTaskArtifact(
			taskDir,
			auditCandidate,
		);
		if (artifact) {
			const path = safeWorkflowArtifactDisplayPath(cwd, artifact.path);
			if (path && !artifacts.some((candidate) => candidate.path === path)) {
				artifacts.push({
					kind: "evidence-audit",
					label: "Evidence audit",
					path,
				});
			}
		}
	}
	return artifacts;
}

export function formatWorkflowResultPresentation(
	preview: string,
	artifacts: readonly WorkflowResultArtifact[],
): string {
	if (artifacts.length === 0) return preview;
	return [
		preview,
		"## Detailed reports",
		artifacts
			.map((artifact) => `- ${artifact.label}: \`${artifact.path}\``)
			.join("\n"),
	].join("\n\n");
}

/** Bounded authoritative-result preview of a terminal run (first completed output task). */
export async function readWorkflowResultPresentation(
	cwd: string,
	run: WorkflowRunRecord,
	outputTaskIds: string[],
): Promise<WorkflowResultPresentation | undefined> {
	const task = outputTaskIds
		.map((id) =>
			run.tasks.find(
				(candidate) => candidate.specId === id || candidate.taskId === id,
			),
		)
		.find((candidate) => candidate?.status === "completed");
	if (!task) return undefined;

	const projectDir = resolvePath(cwd);
	const taskDir = dirname(fromProjectPath(cwd, task.files.output));
	const lexicalEscape = relative(projectDir, resolvePath(taskDir));
	if (
		lexicalEscape === ".." ||
		lexicalEscape.startsWith(`..${sep}`) ||
		isAbsolutePath(lexicalEscape)
	)
		return undefined;
	try {
		const canonicalProjectDir = await realpath(projectDir);
		const canonicalTaskDir = await realpath(taskDir);
		const canonicalEscape = relative(canonicalProjectDir, canonicalTaskDir);
		if (
			canonicalEscape === ".." ||
			canonicalEscape.startsWith(`..${sep}`) ||
			isAbsolutePath(canonicalEscape)
		)
			return undefined;
	} catch {
		return undefined;
	}
	const controlText = await readSafeRelativeTaskArtifact(
		taskDir,
		"control.json",
	);
	const control = controlText ? parseJsonRecord(controlText) : undefined;
	const artifacts = await collectWorkflowResultArtifacts(cwd, taskDir, control);
	const verdict = domainVerdict(control?.verdict);
	const presentation = (
		preview: string | undefined,
		preserveExact = false,
	): WorkflowResultPresentation => {
		let presentedPreview: string | undefined;
		if (preview) {
			presentedPreview = preserveExact
				? preview
				: truncateWorkflowPreview(preview);
		}
		return {
			preview: presentedPreview,
			artifacts,
			...(verdict ? { verdict } : {}),
		};
	};
	// This is the authoritative terminal-summary field. Unlike fallback prose,
	// its Markdown is an exact result payload: do not trim, normalize, or
	// preview-truncate it before wait/terminal presentation.
	const completionSummaryMarkdown =
		typeof control?.completionSummaryMarkdown === "string"
			? control.completionSummaryMarkdown
			: undefined;
	if (
		completionSummaryMarkdown !== undefined &&
		completionSummaryMarkdown.trim() !== ""
	)
		return presentation(completionSummaryMarkdown, true);

	if (isDirectDynamicSynthesisTask(run, task)) {
		// Direct dynamic workers have protocol output in raw.md/output.log. Only
		// use validated summary fields and the parser-produced analysis artifact
		// for their user-facing preview; never expose protocol wrappers.
		const summary = stringValue(control?.summary);
		if (summary) return presentation(summary);
		const analysis = await readSafeRelativeTaskArtifact(taskDir, "analysis.md");
		if (analysis) return presentation(analysis);
		const executiveMarkdown = stringValue(control?.executiveMarkdown);
		if (executiveMarkdown) return presentation(executiveMarkdown);
		const sidecarPath = stringValue(control?.sidecarPath);
		if (sidecarPath && !isRawProtocolArtifactPath(sidecarPath)) {
			const sidecar = await readSafeRelativeTaskArtifact(taskDir, sidecarPath);
			if (sidecar) return presentation(sidecar);
		}
		return presentation(
			await readSafeRelativeTaskArtifact(taskDir, "final-report.md"),
		);
	}

	const executiveMarkdown = stringValue(control?.executiveMarkdown);
	if (executiveMarkdown) return presentation(executiveMarkdown);
	for (const fileName of [
		stringValue(control?.sidecarPath),
		"final-report.md",
		"executive.md",
		"raw.md",
		"analysis.md",
		"output.log",
	].filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	)) {
		const text = stringValue(
			await readSafeRelativeTaskArtifact(taskDir, fileName),
		);
		if (text) return presentation(text);
	}
	return presentation(undefined);
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

/** A short verdict token (`NEEDS_WORK`, `Partial review`); anything else is ignored. */
function domainVerdict(value: unknown): string | undefined {
	const text = stringValue(value);
	return text && text.length <= 64 && /^[A-Za-z][A-Za-z0-9_ .-]*$/.test(text)
		? text
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncateWorkflowPreview(text: string, maxChars = 6000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars).trimEnd()}\n\n… truncated; see the run's artifacts for the full result.`;
}
