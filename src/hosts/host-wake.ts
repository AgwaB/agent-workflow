// 2026-11-05 (owner: wait in code, wake the host once). When a run that an interactive Codex session
// launched has settled, its detached supervisor puts the completion line into that session with
// `codex queue --thread <id> --message <line>`: an open Codex TUI or app session runs one turn with it
// (live check: a queued message appeared in an idle TUI session, which answered at once); a closed
// one gets it when it is resumed. The session id is the thread Codex names in each tool call
// (`_meta["x-codex-turn-metadata"].thread_id`, recorded by the MCP server at launch); `codex exec`
// launches (turn_trigger "exec") are not linked and wait with workflow_wait instead. Each settled
// state is delivered once (notify-check receipts): a result the agent already got from workflow_wait
// wakes nothing. AGENT_WORKFLOW_HOST_WAKE=0 turns it off.
import { execFile } from "node:child_process";

import type { WorkflowRunRecord } from "../core/types.js";
import { notifyCheck, runHostSessions } from "./notify-check.js";

export const HOST_WAKE_ENV = "AGENT_WORKFLOW_HOST_WAKE";

export function hostWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[HOST_WAKE_ENV]?.trim() !== "0";
}

/** What a Codex tool call says about its session (`params._meta`). */
export function codexTurnSession(
	meta: Record<string, unknown> | undefined,
): { threadId: string; interactive: boolean } | undefined {
	const turn = meta?.["x-codex-turn-metadata"];
	if (!turn || typeof turn !== "object" || Array.isArray(turn))
		return undefined;
	const { thread_id: threadId, turn_trigger: trigger } = turn as Record<
		string,
		unknown
	>;
	if (typeof threadId !== "string" || !/^[0-9a-f-]{8,64}$/u.test(threadId))
		return undefined;
	return { threadId, interactive: trigger !== "exec" };
}

export type HostWakeRunner = (
	command: string,
	args: readonly string[],
) => Promise<{ ok: boolean; output: string }>;

const runCommand: HostWakeRunner = (command, args) =>
	new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{ timeout: 30_000, encoding: "utf8" },
			(error, stdout, stderr) =>
				resolve({
					ok: !error,
					output: `${stdout}${stderr}`.trim().slice(0, 500),
				}),
		);
	});

/** Called by the detached supervisor once the run has settled. Never throws. */
export async function wakeLaunchingHostSessions(
	cwd: string,
	run: WorkflowRunRecord,
	options: {
		env?: NodeJS.ProcessEnv;
		log?: (line: string) => void;
		run?: HostWakeRunner;
	} = {},
): Promise<void> {
	const log = options.log ?? (() => undefined);
	try {
		const env = options.env ?? process.env;
		if (!hostWakeEnabled(env) || run.launch?.source !== "mcp:codex") return;
		const sessions = await runHostSessions(cwd, run.runId);
		if (sessions.length === 0) return;
		const checked = await notifyCheck(cwd, {
			host: "codex",
			runId: run.runId,
			env,
		});
		const line = checked.data.notifications[0]?.text;
		if (!line) {
			log(`host wake: ${run.runId} already reported; no Codex session woken`);
			return;
		}
		const message = `${line}\n(agent-workflow: the run you started from this session has finished; tell the user the verdict, the run id and the link.)`;
		for (const thread of sessions) {
			const queued = await (options.run ?? runCommand)("codex", [
				"queue",
				"--thread",
				thread,
				"--message",
				message,
			]);
			log(
				`host wake: codex queue ${thread}: ${queued.ok ? "queued" : "failed"} ${queued.output}`,
			);
		}
	} catch (error) {
		log(
			`host wake failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
