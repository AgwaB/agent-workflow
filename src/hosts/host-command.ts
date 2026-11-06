// Hook-only commands: no model dispatch, shell interpolation, options or interactive questions.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	autoAction,
	formatHostError,
	type HostApiContext,
	type LaunchData,
	runDynamicAction,
	runWorkflowAction,
	statusAction,
	stopAction,
} from "./api.js";
import { projectId } from "../core/state-location.js";
import {
	ensureDashboard,
	mintLaunchUrl,
	openInBrowser,
} from "./dashboard/discovery.js";
import { hostWakeEnabled } from "./host-wake.js";
import { isHostSessionId, recordRunHostSession } from "./notify-check.js";
import { findProjectRoot, runProject } from "./project-root.js";
import { hostTextRedactor } from "./redaction.js";
import { containedProjectStateDir } from "./run-files.js";
import { runDashboardLink } from "./run-dashboard-link.js";
import { registerTestExecutorFromEnv } from "./test-executor.js";

export type CommandHost = "claude-code" | "codex";
const ACTIONS = ["dashboard", "run", "dynamic", "auto", "stop"] as const;
const USAGE = [
	"aw — help and recent runs",
	"aw dashboard [run]",
	"aw run <workflow> <task…>",
	"aw dynamic <task…>",
	"aw auto <task…>",
	"aw stop <run>",
].join("\n");

type ParsedCommand =
	| { action: "help" }
	| { action: "usage"; text: string }
	| { action: "dashboard"; run?: string }
	| { action: "stop"; run: string }
	| { action: "run"; workflow: string; task: string }
	| { action: "dynamic" | "auto"; task: string };

function word(text: string): [string, string] {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? [match[1]!, match[2]?.trim() ?? ""] : ["", ""];
}

function taskText(text: string): string {
	const first = text[0];
	return text.length >= 2 &&
		(first === '"' || first === "'") &&
		text.endsWith(first)
		? text.slice(1, -1).trim()
		: text;
}

export function parseHostCommand(args: string): ParsedCommand {
	const [action, rest] = word(args);
	if (!action) return { action: "help" };
	const usage = (text = USAGE): ParsedCommand => ({ action: "usage", text });
	switch (action) {
		case "run": {
			const [workflow, tail] = word(rest);
			const task = taskText(tail);
			return workflow && task
				? { action, workflow, task }
				: usage("aw run <workflow> <task…>");
		}
		case "dynamic":
		case "auto": {
			const task = taskText(rest);
			return task ? { action, task } : usage(`aw ${action} <task…>`);
		}
		case "dashboard":
		case "stop": {
			const [run, extra] = word(rest);
			if (extra || (action === "stop" && !run))
				return usage(`aw ${action} ${action === "stop" ? "<run>" : "[run]"}`);
			return action === "stop"
				? { action, run }
				: { action, ...(run ? { run } : {}) };
		}
		default:
			return usage();
	}
}

interface RecognizedCommand {
	args: string;
	event: "submit" | "expansion";
}

/** Treat the hook JSON as untrusted; malformed and unrelated inputs pass through. */
export function recognizeHostCommand(
	host: CommandHost,
	input: unknown,
): RecognizedCommand | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return;
	const data = input as Record<string, unknown>;
	if (host === "claude-code" && data.expansion_type === "slash_command") {
		if (data.command_name !== "aw" && data.command_name !== "agent-workflow:aw")
			return;
		if (
			data.command_args !== undefined &&
			typeof data.command_args !== "string"
		)
			return;
		return {
			args: (data.command_args as string | undefined) ?? "",
			event: "expansion",
		};
	}
	if (typeof data.prompt !== "string") return;
	const prompt = data.prompt.trimStart();
	const match = (
		host === "claude-code"
			? /^(?:\/aw|\/agent-workflow:aw)(?=\s|$)/
			: // Codex's skill picker turns `$aw` into the mention `$agent-workflow:aw` (live 2026-11-06).
				/^\$(?:agent-workflow:)?aw(?=\s|$)/
	).exec(prompt);
	if (match)
		return { args: prompt.slice(match[0].length).trim(), event: "submit" };
	if (host === "codex" && /^aw(?=\s|$)/.test(prompt)) {
		const args = prompt.slice(2).trim();
		const [action] = word(args);
		if (!action || (ACTIONS as readonly string[]).includes(action))
			return { args, event: "submit" };
	}
	return;
}

export interface HostCommandIo {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Tests may inject a browser opener; explicit dashboard requests ignore host suppression. */
	open?: (url: string) => boolean | Promise<boolean>;
}

function output(text: string, env: NodeJS.ProcessEnv): string {
	const safe = hostTextRedactor(env)(`agent-workflow: ${text}`).replace(
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
		"�",
	);
	return safe.length > 1200 ? `${safe.slice(0, 1199)}…` : safe;
}

/** Cross-process, cross-hook receipt. No task text is persisted. Same-event retries remain legal.
 * Claude exposes no common submission id on both hooks, so pair opposite events for 30 seconds.
 * O_EXCL/O_NOFOLLOW and contained state prevent prompt/workspace-controlled path writes.
 */
async function alreadyHandled(
	cwd: string,
	session: unknown,
	command: RecognizedCommand,
): Promise<boolean> {
	if (!isHostSessionId(session)) return false;
	const dir = await containedProjectStateDir(cwd, "host-command", true);
	if (!dir)
		throw new Error(
			"Cannot safely record the command receipt; nothing started.",
		);
	const key = createHash("sha256").update(session).digest("hex");
	const hash = createHash("sha256").update(command.args.trim()).digest("hex");
	const path = join(dir, `${key}.json`);
	let file;
	try {
		file = await open(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
		try {
			const old: unknown = JSON.parse(await file.readFile("utf8"));
			if (old && typeof old === "object") {
				const receipt = old as Record<string, unknown>;
				if (
					receipt.hash === hash &&
					receipt.event !== command.event &&
					typeof receipt.at === "number" &&
					Date.now() - receipt.at < 30_000
				)
					return true;
			}
		} catch {
			// A concurrent hook may still be writing its claim: fail closed, never launch twice.
			return true;
		} finally {
			await file.close();
		}
		file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
	}
	try {
		await file.truncate(0);
		await file.writeFile(
			JSON.stringify({ hash, event: command.event, at: Date.now() }),
		);
	} finally {
		await file.close();
	}
	return false;
}

async function launchText(
	ctx: HostApiContext,
	data: LaunchData,
	text: string,
	session: unknown,
): Promise<string> {
	if (!data.runId) return text;
	if (
		isHostSessionId(session) &&
		(ctx.host === "claude-code" || (hostWakeEnabled(ctx.env) && data.detached))
	)
		await recordRunHostSession(ctx.cwd, data.runId, session);
	if (data.duplicateOf) return text;
	const dashboard =
		data.dashboard ??
		(await runDashboardLink(ctx, data.runId, { start: true }));
	return [
		`${data.name ?? "dynamic"}: ${data.runId} (${data.status}; executor ${data.executor?.id ?? "default"})`,
		dashboard
			? `Dashboard: ${dashboard.url}`
			: "Dashboard unavailable; use aw dashboard.",
		"You'll get the result here when it finishes.",
	].join("\n");
}

async function dispatchCommand(
	ctx: HostApiContext,
	args: string,
	session: unknown,
	io: HostCommandIo,
): Promise<string> {
	const command = parseHostCommand(args);
	if (command.action === "usage") return command.text;
	if (command.action === "stop")
		return (await stopAction(ctx, { runId: command.run })).text;
	if (command.action === "help" || command.action === "dashboard") {
		const runId =
			command.action === "dashboard" && command.run
				? (await statusAction(ctx, { runId: command.run })).data.run?.runId
				: undefined;
		const dashboard = await ensureDashboard(ctx.cwd, io.env, { start: true });
		const url = dashboard
			? `http://127.0.0.1:${dashboard.port}/?${new URLSearchParams({ project: projectId(ctx.cwd), ...(runId ? { run: runId } : {}) })}`
			: undefined;
		if (command.action === "dashboard") {
			if (!dashboard || !url) return "Dashboard could not be started.";
			const launch = await mintLaunchUrl(dashboard, {
				project: projectId(ctx.cwd),
				...(runId ? { run: runId } : {}),
			});
			const opened = await (io.open
				? io.open(launch)
				: openInBrowser(launch, io.env));
			return `${opened ? "Opened dashboard" : "Could not open browser; dashboard"}: ${url}`;
		}
		const recent =
			(await statusAction(ctx, { snapshot: true })).data.runs?.slice(0, 3) ??
			[];
		return [
			USAGE,
			...recent.map(
				(run) => `${run.status} · ${run.name ?? run.type} · ${run.runId}`,
			),
			url ? `Dashboard: ${url}` : "Dashboard unavailable.",
		].join("\n");
	}
	const request = {
		task: command.task,
		detach: true,
		launchOrigin: { kind: "command" as const, text: `aw ${args}` },
	};
	if (command.action === "auto") {
		const result = await autoAction(ctx, {
			...request,
			consent: { source: "command" },
			// No recommendation (including classifier failure): nothing starts, no local fallback.
			choose: async (prompt) => prompt.recommendedId,
		});
		const data = result.data;
		return [
			data.launch
				? await launchText(ctx, data.launch, result.text, session)
				: result.text,
			...(data.selected
				? [
						`Pick: ${data.selected.label}`,
						`Reason: ${data.recommendation?.reason ?? data.selected.reason ?? "Top recommendation"}`,
						`Other candidates: ${
							(data.ranked ?? [])
								.filter((c) => c.candidateId !== data.selected?.candidateId)
								.map((c) => c.label)
								.join(", ") || "none"
						}`,
					]
				: []),
		].join("\n");
	}
	const result =
		command.action === "run"
			? await runWorkflowAction(ctx, { ...request, workflow: command.workflow })
			: await runDynamicAction(ctx, request);
	return launchText(ctx, result.data, result.text, session);
}

/** undefined = empty stdout; every recognized request returns block JSON, including all failures. */
export async function handleHostCommand(
	host: CommandHost,
	input: unknown,
	io: HostCommandIo,
): Promise<{ decision: "block"; reason: string } | undefined> {
	const command = recognizeHostCommand(host, input);
	if (!command) return;
	try {
		const data = input as Record<string, unknown>;
		const cwd = runProject(
			findProjectRoot(
				typeof data.cwd === "string" ? resolve(io.cwd, data.cwd) : io.cwd,
				io.env,
			),
			io.env,
		);
		if (
			host === "claude-code" &&
			(await alreadyHandled(cwd, data.session_id, command))
		)
			return {
				decision: "block",
				reason: output("Command already handled by the other hook.", io.env),
			};
		await registerTestExecutorFromEnv(io.env);
		const text = await dispatchCommand(
			{ cwd, env: io.env, host },
			command.args,
			data.session_id,
			io,
		);
		return { decision: "block", reason: output(text, io.env) };
	} catch (error) {
		return {
			decision: "block",
			reason: output(formatHostError(error), io.env),
		};
	}
}

/** Hook entry: malformed stdin is pass-through, diagnostics never escape to the host. */
export async function runHostCommandHook(
	host: CommandHost,
	io: HostCommandIo & {
		stdin?: AsyncIterable<string | Buffer>;
		stdout: (text: string) => void;
	},
): Promise<number> {
	try {
		let raw = "";
		for await (const chunk of io.stdin ?? process.stdin) {
			raw += chunk.toString();
			if (raw.length > 1_048_576) return 0;
		}
		const response = await handleHostCommand(host, JSON.parse(raw), io);
		if (response) io.stdout(`${JSON.stringify(response)}\n`);
	} catch {
		// Invalid input / closed host pipes must not fail a prompt.
	}
	return 0;
}
