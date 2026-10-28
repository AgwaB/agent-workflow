// New in agent-workflow (WP18b): `agent-workflow prune` also prunes the built-in executor adapters'
// attempt state under `<AGENT_WORKFLOW_HOME>/executors/{claude,codex,pi}` (src/executors/
// state-retention.ts): terminal attempt records older than the retention window (default 7 days,
// `--older-than <days>` when given) with their companions. Dry run unless `--yes`, like run pruning.
// Adapters configured with a custom `stateDir` prune it themselves on submit.
import { join } from "node:path";

import { agentWorkflowHome } from "../core/home-dir.js";
import { classifyClaudeAttemptRecord } from "../executors/claude/state.js";
import { classifyCodexAttemptRecord } from "../executors/codex/state.js";
import { classifyPiAttemptRecord } from "../executors/pi/state.js";
import {
	ADAPTER_STATE_RETENTION_MS,
	type AdapterStatePruneSummary,
	pruneAdapterAttemptState,
} from "../executors/state-retention.js";

export interface ExecutorStatePruneResult extends AdapterStatePruneSummary {
	executor: "claude" | "codex" | "pi";
}

export async function pruneExecutorAdapterState(options: {
	env: NodeJS.ProcessEnv;
	dryRun: boolean;
	retentionMs?: number;
	nowMs?: number;
}): Promise<ExecutorStatePruneResult[]> {
	const root = join(agentWorkflowHome(options.env), "executors");
	const retentionMs = options.retentionMs ?? ADAPTER_STATE_RETENTION_MS;
	const common = {
		retentionMs,
		dryRun: options.dryRun,
		...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
	};
	const piDir = join(root, "pi");
	return [
		{
			executor: "claude" as const,
			...(await pruneAdapterAttemptState({
				...common,
				stateDir: join(root, "claude"),
				classify: classifyClaudeAttemptRecord,
			})),
		},
		{
			executor: "codex" as const,
			...(await pruneAdapterAttemptState({
				...common,
				stateDir: join(root, "codex"),
				classify: classifyCodexAttemptRecord,
			})),
		},
		{
			executor: "pi" as const,
			...(await pruneAdapterAttemptState({
				...common,
				stateDir: piDir,
				classify: (record) => classifyPiAttemptRecord(piDir, record),
			})),
		},
	];
}

export function formatExecutorStatePrune(
	results: readonly ExecutorStatePruneResult[],
): string {
	const days = Math.round((results[0]?.retentionMs ?? 0) / 86_400_000);
	const dryRun = results[0]?.dryRun ?? true;
	const lines = [
		`Executor attempt state (terminal attempts older than ${days} day(s)):`,
	];
	for (const result of results)
		lines.push(
			`- ${result.executor}: ${result.prunedRecords} of ${result.records} record(s) ${dryRun ? "would be removed" : "removed"} (${result.removedPaths.length} path(s)); ${result.keptActive} active or unreadable kept${result.errors.length ? `; errors: ${result.errors.join("; ")}` : ""}`,
		);
	return lines.join("\n");
}
