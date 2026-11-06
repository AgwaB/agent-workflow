import { runHostCommandHook } from "../host-command.js";
import { projectId, stateBase } from "../../core/state-location.js";
// Thin host-neutral CLI: parse flags, call one host API handler, and print text or JSON.
// Exit codes: 0 success/completed, 1 failed/blocked/interrupted/refused/timeout, 2 usage error.
// Terminal dialogs handle controller approvals and consent-gated auto comparison.
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as dashboardSleep } from "node:timers/promises";
import {
	dashboardDiscoveryPath,
	acquireDashboardStartLock,
	DASHBOARD_PROTOCOL,
	readDashboardDiscovery,
	shutdownDashboard,
	resetDashboardSession,
	detectAgentEnvironment,
	ensureDashboard,
	mintLaunchUrl,
	openInBrowser,
} from "../dashboard/discovery.js";
import { resolve } from "node:path";
import { agentWorkflowHome } from "../../core/home-dir.js";
import { startDashboardServer } from "../dashboard/server.js";
import { addWorkflowInputAssignment } from "../args.js";
import { cliLaunchCommand } from "../launch-capture.js";
import { createInterface } from "node:readline";

import {
	type AutoChoicePrompt,
	type AutoConsent,
	applyDoctorFix,
	approveAction,
	autoAction,
	doctorAction,
	doctorFixes,
	formatHostError,
	HOST_WAIT_MAX_TIMEOUT_MS,
	type HostApiContext,
	type HostResult,
	HostUsageError,
	helpAction,
	type LaunchRequestBase,
	inspectAction,
	listAgentsAction,
	listWorkflowsAction,
	logsAction,
	noticesAction,
	parseCapabilityList,
	parseDuration,
	parsePermissionMode,
	parseSuperviseArgs,
	parseThinkingLevel,
	profileAction,
	pruneAction,
	registerTestExecutorFromEnv,
	resumeAction,
	runDynamicAction,
	checkWorkflowAction,
	runWorkflowAction,
	showAction,
	statusAction,
	stopAction,
	superviseAction,
	TestExecutorHookError,
	type WaitData,
	validateWorkflowAction,
	waitAction,
	workflowPreferenceAction,
	workflowRolesAction,
} from "../api.js";
import {
	assertNotifyStampName,
	isHostSessionId,
	notifyCheck,
	runSettledStateSeen,
} from "../notify-check.js";
import { runWatch, WATCH_DEFAULT_INTERVAL_MS } from "../watch.js";
import { runStatusLine } from "./statusline.js";
import { findProjectRoot, runProject } from "../project-root.js";
import { clearExecutorProbeCache } from "../../core/executor-default.js";
import { readRunRecord } from "../../core/store.js";
import {
	agentsRequest,
	CLI_SYNTAX,
	inspectRequest,
	intValue,
	listRequest,
	logsCommandRequest,
	type OptionSpec,
	onlyPositionals,
	type ParsedArgs,
	parseCommandArgs,
	profileRequest,
	showRequest,
	statusRequest,
	stopRequest,
	workflowPreferenceRequest,
	workflowRefRequest,
} from "../command-args.js";

// The Pi host and tests import these from the CLI module.
export {
	logsRequest,
	parseCommandArgs,
	parseRoleFlags,
	workflowPreferenceRequest,
} from "../command-args.js";

export const MODULE = "src/hosts/cli";

export interface CliIo {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** stdin and stdout are terminals: `run` may ask y/N. */
	isTTY: boolean;
	/** Ask one question; resolves with the typed line (WP29: `signal` closes an open question). */
	prompt?: (
		question: string,
		options?: { signal?: AbortSignal },
	) => Promise<string>;
	signal?: AbortSignal;
	/** Browser opener; explicit --open may run even without a TTY. */
	open?: (url: string) => boolean | Promise<boolean>;
	/** Bound of each underlying wait call (default and cap 45 s; tests use less). */
	waitSliceMs?: number;
	/** WP36: terminal height for `watch` (bounds the task rows). */
	rows?: number;
	/** 2026-11-05: `notify-check --follow` stops when this turns false (tests pass a fake). */
	parentAlive?: () => boolean;
	/** WP36: `watch` sleeps between frames (tests pass a fake). */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** WP36: clock of `watch`, `statusline` and `notify-check` (tests pass a fake). */
	now?: () => number;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/**
 * One terminal question on `input`/`output` (the CLI passes stdin/stderr). Resolves with the typed
 * line, or "" at end of input or when `signal` aborts. Live bundle 5 (WP39): the answer is settled
 * before `rl.close()`, whose synchronous `close` event used to resolve "" first, so every y/N
 * typed on a real terminal (auto consent, degradation confirmation, dynamic approval, `approve`)
 * was read as no answer.
 */
export function readlinePrompt(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): (question: string, options?: { signal?: AbortSignal }) => Promise<string> {
	return (question, options = {}) =>
		new Promise((resolveAnswer) => {
			const rl = createInterface({ input, output });
			let settled = false;
			const onAbort = () => rl.close();
			const settle = (answer: string) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				resolveAnswer(answer);
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			rl.once("close", () => settle(""));
			rl.question(question, (answer) => {
				settle(answer);
				rl.close();
			});
		});
}

/**
 * WP39b (live bundle 5, O14): terminal questions open on this io. While one is open, foreground
 * progress output pauses (it was printed on the question's line); the newest progress line is
 * printed once the question is answered.
 */
const openPrompts = new WeakMap<CliIo, { count: number; held?: string }>();

async function withOpenPrompt<T>(io: CliIo, ask: () => Promise<T>): Promise<T> {
	const state = openPrompts.get(io) ?? { count: 0 };
	state.count += 1;
	openPrompts.set(io, state);
	try {
		return await ask();
	} finally {
		state.count -= 1;
		if (state.count === 0) {
			openPrompts.delete(io);
			if (state.held !== undefined) io.stderr(state.held);
		}
	}
}

/** Progress output: held (newest line only) while a question is open on this io. */
function progressOutput(io: CliIo, text: string): void {
	const state = openPrompts.get(io);
	if (state && state.count > 0) {
		state.held = text;
		return;
	}
	io.stderr(text);
}

function defaultPrompt(
	question: string,
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	return readlinePrompt(process.stdin, process.stderr)(question, options);
}

/**
 * Terminal dynamic-controller approval shows scope on stderr and asks y/n.
 * Yes runs the controller; no rejects it permanently for this run; no answer or the
 * five-minute timeout leaves it blocked and resumable. Non-terminal or detached
 * calls leave the run blocked with an approve command.
 */
export function cliDynamicUi(
	io: CliIo,
): NonNullable<HostApiContext["dynamicUi"]> {
	const prompt = io.prompt ?? defaultPrompt;
	return {
		hasUI: true,
		host: "cli",
		confirm: async (title, message, options) => {
			const answer = (
				await withOpenPrompt(io, async () => {
					io.stderr(`\n${message}\n`);
					return prompt(
						`${title} [y/n] `,
						options?.signal ? { signal: options.signal } : {},
					);
				})
			)
				.trim()
				.toLowerCase();
			if (answer === "y" || answer === "yes") return true;
			if (answer === "n" || answer === "no") return false;
			throw new Error("dynamic controller approval was not answered");
		},
	};
}

export function processCliIo(): CliIo {
	return {
		cwd: process.cwd(),
		env: process.env,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		prompt: defaultPrompt,
		...(process.stdout.rows ? { rows: process.stdout.rows } : {}),
	};
}

function packageVersion(): string {
	try {
		const raw = readFileSync(
			new URL("../../../package.json", import.meta.url),
			"utf8",
		);
		const version = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof version === "string" ? version : "unknown";
	} catch {
		return "unknown";
	}
}

function only(parsed: ParsedArgs, count: number, usage: string): string[] {
	return onlyPositionals(parsed, count, usage, CLI_SYNTAX);
}

const LAUNCH_SPEC: OptionSpec = {
	flags: ["--detach", "--force-new", "--yes", "--json", "--open"],
	values: [
		"--executor",
		"--profile",
		"--permission-mode",
		"--allow-unverified",
		"--model",
		"--effort",
		"--timeout",
	],
	repeatable: ["--input"],
	aliases: { "--thinking": "--effort", "--reasoning": "--effort" },
};

type Emit = (result: HostResult<unknown>, exitCode?: number) => number;

/** Exit code of a handler result: still-running waits, unconfirmed stops and failed/refused outcomes are 1. */
export function exitCodeFor(result: HostResult<unknown>): number {
	const data = result.data as
		| { stillRunning?: unknown; pending?: unknown }
		| undefined;
	if (data?.stillRunning === true || data?.pending === true) return EXIT_FAILED;
	return result.ok ? EXIT_OK : EXIT_FAILED;
}

async function waitUntilSettled(
	ctx: HostApiContext,
	io: CliIo,
	runId: string,
	totalTimeoutMs: number | undefined,
	quiet: boolean,
): Promise<HostResult<WaitData>> {
	const deadline =
		totalTimeoutMs === undefined ? undefined : Date.now() + totalTimeoutMs;
	let lastProgress = "";
	const slice = Math.min(
		HOST_WAIT_MAX_TIMEOUT_MS,
		io.waitSliceMs ?? HOST_WAIT_MAX_TIMEOUT_MS,
	);
	while (true) {
		const remaining = deadline === undefined ? slice : deadline - Date.now();
		const waited = await waitAction(ctx, {
			runId,
			timeoutMs: Math.max(1_000, Math.min(slice, remaining)),
			...(io.signal ? { signal: io.signal } : {}),
			onProgress: (run) => {
				if (quiet) return;
				const line = `${run.runId}: ${run.taskSummary.completed}/${run.taskSummary.total} completed, ${run.taskSummary.running} running (${run.status})`;
				if (line === lastProgress) return;
				lastProgress = line;
				progressOutput(io, `${line}\n`);
			},
		});
		if (!waited.data.stillRunning) return waited;
		if (deadline !== undefined && Date.now() >= deadline) return waited;
		if (!quiet)
			progressOutput(
				io,
				`${runId}: still running after a ${waited.data.timeoutMs}ms wait; waiting again\n`,
			);
	}
}

async function launchCommand(
	command: "run" | "dynamic",
	argv: readonly string[],
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	const parsed = parseCommandArgs(argv, LAUNCH_SPEC);
	const [workflow, ...taskWords] =
		command === "run" ? parsed.positionals : [undefined, ...parsed.positionals];
	if (command === "run" && !workflow)
		throw new HostUsageError(
			"Usage: agent-workflow run <workflow> <task...> [options]",
		);
	const task = taskWords.join(" ").trim();
	if (!task)
		throw new HostUsageError(
			command === "run"
				? 'Missing task. Usage: agent-workflow run <workflow> "<task>"'
				: 'Missing task. Usage: agent-workflow dynamic "<task>"',
		);
	const options = launchOptionsFromArgs(parsed, io);
	const request = {
		task,
		...options.request,
		// WP33: launch capture (redacted by the host API): the command line as typed.
		launchOrigin: {
			kind: "command" as const,
			text: cliLaunchCommand([command, ...argv]),
		},
	};
	const launched =
		command === "run"
			? await runWorkflowAction(ctx, { workflow: workflow!, ...request })
			: await runDynamicAction(ctx, request);
	return followLaunch(command, launched, launched.data, options, ctx, io, emit);
}

interface CliLaunchOptions {
	open: boolean;
	request: Omit<LaunchRequestBase, "task" | "launchOrigin">;
	json: boolean;
	detach: boolean;
	totalTimeoutMs: number | undefined;
	/** On a terminal without --yes. */
	interactive: boolean;
}

/** The launch options shared by `run`, `dynamic` and `auto`. */
function launchOptionsFromArgs(
	parsed: ParsedArgs,
	io: CliIo,
): CliLaunchOptions {
	const json = parsed.flags.has("--json");
	const detach = parsed.flags.has("--detach");
	const timeout = parsed.values.get("--timeout");
	const totalTimeoutMs =
		timeout === undefined ? undefined : parseDuration(timeout);
	if (detach && totalTimeoutMs !== undefined)
		throw new HostUsageError("--timeout cannot be combined with --detach");
	const interactive = io.isTTY && !parsed.flags.has("--yes");
	const prompt = io.prompt ?? defaultPrompt;
	const permission = parsed.values.get("--permission-mode");
	const allow = parsed.values.get("--allow-unverified");
	const effort = parsed.values.get("--effort");
	// WP12a: --input key=value (repeatable); typed against the spec's declared inputs at launch.
	const assignments = parsed.lists.get("--input") ?? [];
	const inputs: Record<string, string> = {};
	for (const assignment of assignments)
		addWorkflowInputAssignment(inputs, assignment);
	const request = {
		...(assignments.length > 0 ? { inputOverrides: inputs } : {}),
		...(parsed.values.has("--executor")
			? { executor: parsed.values.get("--executor")! }
			: {}),
		...(parsed.values.has("--profile")
			? { profile: parsed.values.get("--profile")! }
			: {}),
		...(permission ? { permissionMode: parsePermissionMode(permission) } : {}),
		...(allow
			? {
					allowUnverifiedCapabilities: parseCapabilityList(
						allow,
						"--allow-unverified",
					),
				}
			: {}),
		...(parsed.values.has("--model")
			? { model: parsed.values.get("--model")! }
			: {}),
		...(effort ? { effort: parseThinkingLevel(effort) } : {}),
		...(detach ? { detach: true } : {}),
		...(parsed.flags.has("--force-new") ? { forceNew: true } : {}),
		...(interactive
			? {
					interactive: true,
					confirmDegradations: async (preview: { text: string }) => {
						io.stderr(`${preview.text}\n`);
						const answer = await prompt(
							"Proceed with these capability degradations? [y/N] ",
						);
						return /^y(es)?$/i.test(answer.trim());
					},
				}
			: {}),
	};
	return {
		request,
		json,
		detach,
		totalTimeoutMs,
		interactive,
		open: parsed.flags.has("--open"),
	};
}

/** After a launch: print it and, unless detached, wait in the foreground until it settles. */
async function followLaunch(
	command: "run" | "dynamic" | "auto",
	launched: HostResult<unknown>,
	data:
		| {
				runId?: string;
				status?: string;
				dashboard?: { url: string; port: number };
		  }
		| undefined,
	options: CliLaunchOptions,
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	const { json, detach, totalTimeoutMs } = options;
	if (!json) io.stdout(`${launched.text}\n`);
	if (launched.ok && data?.runId) {
		const fromEnv = io.env.AGENT_WORKFLOW_DASHBOARD_OPEN === "1";
		if (
			!options.open &&
			fromEnv &&
			detectAgentEnvironment(io.env, ctx.host).detected
		) {
			// The launch text (stdout) already carries the token-free link when a dashboard runs;
			// the notice only explains why nothing opened.
			io.stderr(
				"Dashboard not opened (AI agent environment; pass --open to force).\n",
			);
		} else if (options.open || (fromEnv && io.isTTY)) {
			try {
				const dashboard = await ensureDashboard(ctx.cwd, io.env, {
					start: true,
				});
				if (!dashboard) throw new Error("dashboard unavailable");
				const url = await mintLaunchUrl(dashboard, {
					project: projectId(ctx.cwd),
					run: data.runId,
				});
				if (!(await (io.open ? io.open(url) : openInBrowser(url, io.env))))
					throw new Error("opener unavailable");
				// The launch text had no link when the dashboard was started just now; print the
				// token-free one so the terminal has it too.
				if (!data.dashboard && !json)
					io.stdout(
						`Dashboard: http://127.0.0.1:${dashboard.port}/?project=${projectId(ctx.cwd)}&run=${data.runId}\n`,
					);
			} catch {
				io.stderr(
					"Could not open the browser; use `agent-workflow dashboard --open` from a terminal.\n",
				);
			}
		}
	}
	if (detach || data?.status !== "running" || !data.runId)
		return json ? emit(launched) : exitCodeFor(launched);
	if (!json)
		io.stderr(
			`Waiting for ${data.runId} (Ctrl-C stops waiting; the run can be continued with \`agent-workflow wait ${data.runId}\`)\n`,
		);
	const waited = await waitUntilSettled(
		ctx,
		io,
		data.runId,
		totalTimeoutMs,
		json,
	);
	const final: HostResult<unknown> = {
		...waited,
		action: command,
		data: { ...(launched.data as object), wait: waited.data },
	};
	if (json) return emit(final, exitCodeFor(waited));
	io.stdout(`${waited.text}\n`);
	return exitCodeFor(waited);
}

/**
 * WP32: `auto <task...> [--yes] [launch options]`. On a terminal: the consent question (the task,
 * the candidates and the classifier executor/model; y/N), then a numbered pick-list of the ranked
 * candidates (Enter = the recommendation, n = cancel). Without a terminal nothing is sent unless
 * --yes (the user's explicit consent); then the ranking is printed and nothing starts.
 */
async function autoCommand(
	argv: readonly string[],
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	const parsed = parseCommandArgs(argv, LAUNCH_SPEC);
	const task = parsed.positionals.join(" ").trim();
	if (!task)
		throw new HostUsageError(
			'Missing task. Usage: agent-workflow auto "<task>"',
		);
	const options = launchOptionsFromArgs(parsed, io);
	const prompt = io.prompt ?? defaultPrompt;
	const yes = parsed.flags.has("--yes");
	const consent: AutoConsent | undefined = yes
		? { source: "flag" }
		: io.isTTY
			? {
					source: "prompt",
					confirm: async (title, message) => {
						io.stderr(`\n${message}\n`);
						const answer = await prompt(`${title} [y/N] `);
						return /^y(es)?$/i.test(answer.trim());
					},
				}
			: undefined;
	const choose = io.isTTY
		? async (shown: AutoChoicePrompt): Promise<string | undefined> => {
				io.stderr(`\n${shown.message}\n`);
				const count = shown.choices.length;
				const recommended = shown.recommendedId
					? shown.choices.findIndex(
							(choice) => choice.candidateId === shown.recommendedId,
						)
					: -1;
				const answer = (
					await prompt(
						`Start which workflow? [1-${count}${recommended >= 0 ? `, Enter = ${recommended + 1}` : ""}, n = cancel] `,
					)
				)
					.trim()
					.toLowerCase();
				if (answer === "" && recommended >= 0)
					return shown.choices[recommended]!.candidateId;
				if (!/^\d+$/.test(answer)) return undefined;
				return shown.choices[Number(answer) - 1]?.candidateId;
			}
		: undefined;
	const out = await autoAction(ctx, {
		task,
		...options.request,
		...(consent ? { consent } : {}),
		...(choose ? { choose } : {}),
		...(io.signal ? { signal: io.signal } : {}),
		launchOrigin: {
			kind: "command",
			text: cliLaunchCommand(["auto", ...argv]),
		},
	});
	return followLaunch("auto", out, out.data.launch, options, ctx, io, emit);
}

/**
 * WP29: `approve <run> [--request <id>] [--reject] [--yes] [--detach] [--timeout <d>] [--json]`.
 * On a terminal the approval question is asked y/n (n rejects, no answer records nothing); without
 * one, --yes is the explicit decision. An approval resumes the run in the foreground (as `resume`)
 * or, with --detach, in a background supervisor.
 */
async function approveCommand(
	argv: readonly string[],
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	const parsed = parseCommandArgs(argv, {
		flags: ["--json", "--reject", "--yes", "--detach"],
		values: ["--request", "--timeout"],
	});
	const usage =
		"approve <run-id-or-prefix> [--request <id>] [--reject] [--yes] [--detach] [--timeout <duration>]";
	const [runId] = only(parsed, 1, usage);
	const detach = parsed.flags.has("--detach");
	const timeout = parsed.values.get("--timeout");
	if (detach && timeout !== undefined)
		throw new HostUsageError("--timeout cannot be combined with --detach");
	const yes = parsed.flags.has("--yes");
	if (!yes && !io.isTTY)
		throw new HostUsageError(
			`approve without a terminal needs --yes (review the approval first: agent-workflow status ${runId})`,
		);
	const prompt = io.prompt ?? defaultPrompt;
	const answered = await approveAction(ctx, {
		runId: runId!,
		decision: parsed.flags.has("--reject") ? "reject" : "approve",
		...(parsed.values.has("--request")
			? { requestId: parsed.values.get("--request")! }
			: {}),
		...(detach ? { detach: true } : {}),
		...(yes
			? {}
			: {
					confirm: async (title: string, message: string) => {
						io.stderr(`\n${message}\n`);
						const answer = (await prompt(`${title} [y/n] `))
							.trim()
							.toLowerCase();
						if (answer === "y" || answer === "yes") return true;
						if (answer === "n" || answer === "no") return false;
						return undefined;
					},
				}),
	});
	const resumed = answered.data.resumed;
	if (detach || !resumed || resumed.status !== "running") return emit(answered);
	if (!parsed.flags.has("--json")) io.stdout(`${answered.text}\n`);
	const waited = await waitUntilSettled(
		ctx,
		io,
		answered.data.runId,
		timeout === undefined ? undefined : parseDuration(timeout),
		parsed.flags.has("--json"),
	);
	return emit(
		{
			...waited,
			action: "approve",
			data: { ...answered.data, status: waited.data.status, wait: waited.data },
		},
		exitCodeFor(waited),
	);
}

async function profileCommand(
	argv: readonly string[],
	ctx: HostApiContext,
	emit: Emit,
): Promise<number> {
	if (argv[0] === "workflow")
		return emit(
			await workflowPreferenceAction(
				ctx,
				workflowPreferenceRequest(argv.slice(1)),
			),
		);
	return emit(await profileAction(ctx, profileRequest(argv, CLI_SYNTAX)));
}

async function dispatch(
	command: string,
	argv: readonly string[],
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	switch (command) {
		case "list":
			return emit(
				await listWorkflowsAction(ctx, listRequest(argv, CLI_SYNTAX)),
			);
		case "validate":
		case "roles": {
			const request = workflowRefRequest(command, argv, CLI_SYNTAX);
			return emit(
				command === "validate"
					? await validateWorkflowAction(ctx, request)
					: await workflowRolesAction(ctx, request),
			);
		}
		case "check": {
			// The launch preflight only: same flags as `run` (executor, profile, model, …), no run.
			const parsed = parseCommandArgs(argv, LAUNCH_SPEC);
			const [workflow, ...taskWords] = parsed.positionals;
			if (!workflow)
				throw new HostUsageError(
					"Usage: agent-workflow check <workflow> [<task...>] [--executor <id>] [options]",
				);
			const options = launchOptionsFromArgs(parsed, io);
			const checked = await checkWorkflowAction(ctx, {
				workflow,
				...options.request,
				...(taskWords.length > 0 ? { task: taskWords.join(" ") } : {}),
			});
			return emit(checked);
		}
		case "agents":
			agentsRequest(argv, CLI_SYNTAX);
			return emit(await listAgentsAction(ctx));
		case "profile":
			return profileCommand(argv, ctx, emit);
		case "run":
		case "dynamic":
			return launchCommand(command, argv, ctx, io, emit);
		case "auto":
			return autoCommand(argv, ctx, io, emit);
		case "status":
			return emit(await statusAction(ctx, statusRequest(argv, CLI_SYNTAX)));
		case "show":
			return emit(await showAction(ctx, showRequest(argv, CLI_SYNTAX)));
		case "inspect":
			return emit(await inspectAction(ctx, inspectRequest(argv, CLI_SYNTAX)));
		case "logs":
			return emit(await logsAction(ctx, logsCommandRequest(argv, CLI_SYNTAX)));
		case "wait": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json"],
				values: ["--timeout"],
			});
			const [runId] = only(
				parsed,
				1,
				"wait <run-id-or-prefix> [--timeout <duration>]",
			);
			const timeout = parsed.values.get("--timeout");
			return emit(
				await waitUntilSettled(
					ctx,
					io,
					runId!,
					timeout === undefined ? undefined : parseDuration(timeout),
					parsed.flags.has("--json"),
				),
			);
		}
		case "resume": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json", "--detach"],
				values: ["--timeout"],
			});
			const [runId] = only(parsed, 1, "resume <run-id-or-prefix> [--detach]");
			const detach = parsed.flags.has("--detach");
			const timeout = parsed.values.get("--timeout");
			if (detach && timeout !== undefined)
				throw new HostUsageError("--timeout cannot be combined with --detach");
			const resumed = await resumeAction(ctx, {
				runId: runId!,
				...(detach ? { detach: true } : {}),
			});
			if (detach || resumed.data.status !== "running") return emit(resumed);
			if (!parsed.flags.has("--json")) io.stdout(`${resumed.text}\n`);
			const waited = await waitUntilSettled(
				ctx,
				io,
				resumed.data.runId,
				timeout === undefined ? undefined : parseDuration(timeout),
				parsed.flags.has("--json"),
			);
			return emit(
				{
					...waited,
					action: "resume",
					data: { ...resumed.data, wait: waited.data },
				},
				exitCodeFor(waited),
			);
		}
		case "approve":
			return approveCommand(argv, ctx, io, emit);
		case "stop":
			return emit(await stopAction(ctx, stopRequest(argv, CLI_SYNTAX)));
		case "prune":
			return emit(
				await pruneAction(ctx, {
					argv: argv.filter((arg) => arg !== "--json"),
				}),
			);
		case "notices":
			return emit(await noticesAction(ctx, { argv: [...argv] }), undefined);
		case "doctor": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json", "--fix", "--yes"],
			});
			only(parsed, 0, "doctor [--fix [--yes]] [--json]");
			const report = await doctorAction(ctx);
			if (!parsed.flags.has("--fix")) return emit(report);
			// 2026-11-02: a tool an executor cannot provide refuses the run before it starts; the
			// fixable ones change only after the user agreed (a question on a terminal, or --yes).
			const fixes = doctorFixes(report.data, io.env);
			if (fixes.length === 0) {
				io.stderr("doctor --fix: nothing to fix automatically.\n");
				return emit(report);
			}
			const prompt = io.prompt ?? defaultPrompt;
			for (const fix of fixes) {
				const agreed =
					parsed.flags.has("--yes") ||
					(io.isTTY &&
						/^y(es)?$/i.test(
							(await prompt(`${fix.description}? [y/N] `)).trim(),
						));
				if (!agreed) {
					io.stderr(
						`not changed (${io.isTTY ? "declined" : "no terminal to ask; add --yes to apply"}): ${fix.description}\n`,
					);
					continue;
				}
				const result = await applyDoctorFix(fix, io.env);
				io.stderr(
					result.changed
						? `changed ${result.setting} in ${result.path}\n`
						: `not changed: ${result.reason} (${result.path})\n`,
				);
			}
			clearExecutorProbeCache();
			return emit(await doctorAction(ctx));
		}
		case "statusline":
			// Never fails loudly (the bin takes a faster path to the same function).
			return runStatusLine({
				cwd: io.cwd,
				stdout: io.stdout,
				...(io.now ? { now: io.now } : {}),
			});
		case "dashboard": {
			const parsed = parseCommandArgs(argv, {
				flags: [
					"--readonly",
					"--open",
					"--auth",
					"--detached",
					"--status",
					"--stop",
					"--reset-session",
				],
				values: ["--port", "--project"],
			});
			only(
				parsed,
				0,
				"dashboard [--port <n>] [--readonly] [--auth] [--open] [--detached | --status | --stop | --reset-session] [--project <dir>]",
			);
			const cwd = resolve(io.cwd, parsed.values.get("--project") ?? ".");
			const status = parsed.flags.has("--status");
			const stopping = parsed.flags.has("--stop");
			const resetting = parsed.flags.has("--reset-session");
			if (
				(status || stopping || resetting) &&
				(parsed.flags.size !== 1 || parsed.values.has("--port"))
			)
				throw new HostUsageError(
					"--status/--stop/--reset-session only accept --project",
				);
			const startLock = await acquireDashboardStartLock(
				io.env.AGENT_WORKFLOW_DASHBOARD_START_LOCK,
			);
			try {
				let existing = await readDashboardDiscovery(cwd);
				let takeoverPort: number | undefined;
				if (
					!status &&
					!stopping &&
					!resetting &&
					existing &&
					existing.protocol < DASHBOARD_PROTOCOL
				) {
					takeoverPort = existing.port;
					await shutdownDashboard(existing);
					const deadline = Date.now() + 5000;
					while (Date.now() < deadline && (await readDashboardDiscovery(cwd)))
						await dashboardSleep(50);
					existing = await readDashboardDiscovery(cwd);
				}
				if (status || stopping || resetting) {
					if (!existing && resetting) {
						await resetDashboardSession(cwd);
						io.stdout(
							"Dashboard session reset; --auth dashboards sign in again with agent-workflow dashboard --open.\n",
						);
						return EXIT_OK;
					}
					if (!existing) {
						io.stderr("No dashboard running.\n");
						return EXIT_FAILED;
					}
					if (status) {
						io.stdout(
							`Dashboard listening on 127.0.0.1:${existing.port} (pid ${existing.pid}, since ${existing.startedAt}, auth ${existing.auth ? "on" : "off"}${existing.detached && existing.idleExitAt ? `, idle exit in ${Math.max(0, Math.ceil((Date.parse(existing.idleExitAt) - (io.now?.() ?? Date.now())) / 60_000))}m` : ""})\n`,
						);
						return EXIT_OK;
					}
					try {
						await shutdownDashboard(existing);
					} catch {
						io.stderr("Could not stop the dashboard.\n");
						return EXIT_FAILED;
					}
					const deadline = Date.now() + 5000;
					while (
						existsSync(dashboardDiscoveryPath(cwd)) &&
						Date.now() < deadline
					)
						await dashboardSleep(50);
					if (existsSync(dashboardDiscoveryPath(cwd))) {
						io.stderr("Dashboard did not stop within 5 seconds.\n");
						return EXIT_FAILED;
					}
					if (resetting) {
						await resetDashboardSession(cwd);
						io.stdout(
							"Dashboard session reset; --auth dashboards sign in again with agent-workflow dashboard --open.\n",
						);
					} else io.stdout("Dashboard stopped.\n");
					return EXIT_OK;
				}
				if (
					existing &&
					!parsed.flags.has("--open") &&
					!parsed.flags.has("--readonly") &&
					!parsed.flags.has("--auth") &&
					!parsed.values.has("--port")
				) {
					if (existing.portReason) io.stderr(`${existing.portReason}\n`);
					io.stdout(
						`Dashboard: http://127.0.0.1:${existing.port}/?project=${projectId(cwd)}\n`,
					);
					return EXIT_OK;
				}
				if (
					existing &&
					parsed.flags.has("--open") &&
					!parsed.flags.has("--readonly") &&
					!parsed.flags.has("--auth") &&
					!parsed.flags.has("--detached") &&
					!parsed.values.has("--port")
				) {
					try {
						const url = await mintLaunchUrl(existing, {
							project: projectId(cwd),
						});
						if (!(await (io.open ? io.open(url) : openInBrowser(url, io.env))))
							throw new Error("opener unavailable");
					} catch {
						io.stderr(
							"Could not open the browser; use the printed dashboard URL.\n",
						);
						return EXIT_FAILED;
					}
					if (existing.portReason) io.stderr(`${existing.portReason}\n`);
					io.stdout(
						`Dashboard: http://127.0.0.1:${existing.port}/?project=${projectId(cwd)}\n`,
					);
					return EXIT_OK;
				}
				if (existing)
					throw new HostUsageError(
						"A dashboard is already running; use --open, --status or --stop",
					);
				const port =
					intValue(parsed.values.get("--port"), "--port") ?? takeoverPort;
				const idleExitMs = parsed.flags.has("--detached")
					? Number(io.env.AGENT_WORKFLOW_DASHBOARD_IDLE_MS ?? 7_200_000)
					: undefined;
				if (
					idleExitMs !== undefined &&
					(!Number.isSafeInteger(idleExitMs) || idleExitMs < 60_000)
				)
					throw new HostUsageError(
						"AGENT_WORKFLOW_DASHBOARD_IDLE_MS must be an integer of at least 60000",
					);
				let stop!: () => void;
				const stopped = new Promise<void>((done) => {
					stop = done;
				});
				// WP43d: sign-in is opt-in (`--auth`, or AGENT_WORKFLOW_DASHBOARD_AUTH=1 so that auto-started
				// dashboards inherit it).
				const dashboard = await startDashboardServer({
					cwd,
					idleExitMs,
					onIdleExit: stop,
					discovery: true,
					env: io.env,
					...(port === undefined ? {} : { port }),
					readonly: parsed.flags.has("--readonly"),
					auth:
						parsed.flags.has("--auth") ||
						io.env.AGENT_WORKFLOW_DASHBOARD_AUTH === "1",
					...(io.now ? { now: io.now } : {}),
				});
				await startLock.release();
				if (dashboard.portReason) io.stderr(`${dashboard.portReason}\n`);
				if (io.signal) {
					io.signal.addEventListener("abort", stop, { once: true });
					if (io.signal.aborted) stop();
				} else {
					process.once("SIGINT", stop);
					process.once("SIGTERM", stop);
				}
				try {
					io.stdout(
						parsed.flags.has("--detached")
							? `Dashboard listening on 127.0.0.1:${dashboard.port}\n`
							: `Dashboard: ${dashboard.url}${parsed.flags.has("--readonly") ? " (read-only)" : ""}\n`,
					);
					if (parsed.flags.has("--open")) {
						try {
							const url = await mintLaunchUrl(dashboard, {
								project: projectId(cwd),
							});
							if (
								!(await (io.open ? io.open(url) : openInBrowser(url, io.env)))
							)
								throw new Error("opener unavailable");
						} catch {
							io.stderr(
								"Could not open the browser; use the printed dashboard URL.\n",
							);
						}
					}
					await stopped;
					return EXIT_OK;
				} finally {
					io.signal?.removeEventListener("abort", stop);
					process.removeListener("SIGINT", stop);
					process.removeListener("SIGTERM", stop);
					await dashboard.close();
				}
			} finally {
				await startLock.release();
			}
		}
		case "watch": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--follow", "--once", "--bell"],
				values: ["--interval"],
			});
			if (parsed.positionals.length > 1)
				throw new HostUsageError(
					"Usage: watch [<run-id-or-prefix>] [--follow] [--once] [--interval <seconds>] [--bell]",
				);
			const interval = parsed.values.get("--interval");
			let intervalMs = WATCH_DEFAULT_INTERVAL_MS;
			if (interval !== undefined) {
				const seconds = Number(interval);
				if (!/^\d+(\.\d+)?$/.test(interval) || seconds < 1 || seconds > 10)
					throw new HostUsageError("--interval takes seconds between 1 and 10");
				intervalMs = Math.round(seconds * 1000);
			}
			const [runRef] = parsed.positionals;
			return runWatch({
				cwd: io.cwd,
				...(runRef ? { runRef } : {}),
				follow: parsed.flags.has("--follow"),
				once: parsed.flags.has("--once"),
				bell: parsed.flags.has("--bell"),
				intervalMs,
				isTTY: io.isTTY,
				color: io.isTTY && !io.env.NO_COLOR,
				...(io.rows ? { rows: io.rows } : {}),
				env: io.env,
				write: io.stdout,
				...(io.now ? { now: io.now } : {}),
				...(io.sleep ? { sleep: io.sleep } : {}),
				...(io.signal ? { signal: io.signal } : {}),
			});
		}
		case "notify-check": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json", "--follow"],
				values: ["--host", "--interval", "--stamp", "--run", "--session"],
			});
			only(
				parsed,
				0,
				"notify-check [--host cli|claude-code|codex|generic] [--json] [--stamp <name>] [--run <run-id>] [--session <host-session-id>] [--follow [--interval <seconds>]]",
			);
			// 2026-11-05: one run only; with --follow, exit once it has settled (a Claude Code Monitor
			// started for one launch: its line wakes the session, then the monitor ends).
			const runFilter = parsed.values.get("--run");
			// 2026-11-05: the Claude Code plugin's completion monitor (its session's runs only).
			const session = parsed.values.get("--session");
			if (session !== undefined && !isHostSessionId(session))
				throw new HostUsageError(
					`invalid --session ${JSON.stringify(session)}`,
				);
			// WP42: the prompt hook's idle stamp, written by the check itself (contained writer).
			const stamp = parsed.values.get("--stamp");
			if (stamp !== undefined) {
				try {
					assertNotifyStampName(stamp);
				} catch (error) {
					throw new HostUsageError(
						error instanceof Error ? error.message : String(error),
					);
				}
			}
			const host = parsed.values.get("--host") ?? "cli";
			if (!["cli", "claude-code", "codex", "generic", "pi"].includes(host))
				throw new HostUsageError(
					`Unknown --host "${host}" (cli, claude-code, codex, generic, pi)`,
				);
			const follow = parsed.flags.has("--follow");
			if (follow && parsed.flags.has("--json"))
				throw new HostUsageError("--follow cannot be combined with --json");
			const interval = parsed.values.get("--interval");
			if (interval !== undefined && !follow)
				throw new HostUsageError("--interval needs --follow");
			if (stamp !== undefined && follow)
				throw new HostUsageError("--stamp cannot be combined with --follow");
			const seconds = interval === undefined ? 5 : Number(interval);
			if (!/^\d+$/.test(interval ?? "5") || seconds < 1 || seconds > 60)
				throw new HostUsageError(
					"--interval takes whole seconds between 1 and 60",
				);
			const check = () =>
				notifyCheck(io.cwd, {
					host: host as NonNullable<HostApiContext["host"]>,
					env: io.env,
					...(io.now ? { now: io.now() } : {}),
					...(stamp !== undefined ? { stamp } : {}),
					...(runFilter !== undefined ? { runId: runFilter } : {}),
					...(session !== undefined ? { session } : {}),
				});
			if (follow && runFilter !== undefined) {
				const run = await readRunRecord(io.cwd, runFilter).catch(
					() => undefined,
				);
				if (!run) throw new HostUsageError(`no run ${runFilter} in ${io.cwd}`);
			}
			if (follow) {
				// WP36: a long-lived feed (for example a Claude Code plugin monitor, whose output lines
				// reach the session as notifications): one line per newly settled run.
				const sleep =
					io.sleep ??
					((ms: number, signal?: AbortSignal) =>
						new Promise<void>((done) => {
							const timer = setTimeout(done, ms);
							signal?.addEventListener(
								"abort",
								() => {
									clearTimeout(timer);
									done();
								},
								{ once: true },
							);
						}));
				// 2026-11-05 (live: a Claude Code session killed with SIGKILL left its completion monitor
				// running under launchd, polling forever): stop when the process that started the
				// follower is gone (the kernel reparents an orphan, so process.ppid changes).
				const parent = process.ppid;
				const parentAlive =
					io.parentAlive ?? (() => parent <= 1 || process.ppid === parent);
				while (!io.signal?.aborted && parentAlive()) {
					const checked = await check().catch(() => undefined);
					if (checked?.text) io.stdout(`${checked.text}\n`);
					if (
						runFilter !== undefined &&
						(checked?.data.notifications.length ||
							(await runSettledStateSeen(io.cwd, runFilter)))
					)
						return EXIT_OK;
					await sleep(seconds * 1000, io.signal);
				}
				return EXIT_OK;
			}
			const checked = await check();
			if (parsed.flags.has("--json"))
				io.stdout(
					`${JSON.stringify({ action: "notify-check", ok: true, outcome: "success", data: checked.data }, null, 2)}\n`,
				);
			// Nothing to report prints nothing (a hook adds stdout to the model's context).
			else if (checked.text) io.stdout(`${checked.text}\n`);
			return EXIT_OK;
		}
		case "supervise": {
			const options = parseSuperviseArgs(argv);
			const supervised = await superviseAction(ctx, {
				...(options.runRef ? { runId: options.runRef } : { all: true }),
				pollMs: options.pollMs,
				...(options.maxRuntimeExplicit
					? { maxRuntimeMs: options.maxRuntimeMs }
					: {}),
				onLog: (line) =>
					io.stdout(`[supervise ${new Date().toISOString()}] ${line}\n`),
				...(io.signal ? { signal: io.signal } : {}),
			});
			return exitCodeFor(supervised);
		}
		default:
			throw new HostUsageError(
				`Unknown command "${command}". Run agent-workflow help.`,
			);
	}
}

/** Run one CLI invocation; resolves with the process exit code. */
/**
 * 2026-11-06: run state and the dashboard live in the user directory, which a sandboxed shell (a
 * Codex model shell: workspace-write, no network) can neither write nor reach on 127.0.0.1. The raw
 * error (`EPERM: operation not permitted, fchmod`) names no path, so say where and what to do.
 */
function permissionHint(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code !== "EPERM" && code !== "EACCES" && code !== "EROFS") return "";
	return `\nagent-workflow keeps runs and the dashboard in ${agentWorkflowHome()}. If this runs in a sandboxed shell (for example a Codex model shell), run agent-workflow from a terminal, a hook or its MCP server instead, or allow writes to that directory.`;
}

export async function runAgentWorkflowCli(
	argv: readonly string[],
	io: CliIo = processCliIo(),
): Promise<number> {
	const [command, ...rest] = argv;
	const json = rest.includes("--json");
	if (command === "host-command") {
		const host = rest[1];
		if (
			rest.length !== 2 ||
			rest[0] !== "--host" ||
			(host !== "claude-code" && host !== "codex")
		)
			return EXIT_OK;
		return runHostCommandHook(host, io);
	}
	try {
		if (
			command === undefined ||
			command === "help" ||
			command === "--help" ||
			command === "-h"
		) {
			const topic = command === "help" ? rest[0] : undefined;
			io.stdout(`${helpAction(topic).text}\n`);
			return EXIT_OK;
		}
		if (command === "--version" || command === "-v") {
			io.stdout(`${packageVersion()}\n`);
			return EXIT_OK;
		}
		// 2026-11-04: the nearest enclosing project (src/hosts/project-root.ts) is the project.
		const projectRoot = findProjectRoot(io.cwd, io.env);
		const project = runProject(projectRoot, io.env);
		if (project !== resolve(io.cwd)) {
			if (command !== "statusline" && command !== "notify-check")
				io.stderr(
					project === projectRoot
						? `agent-workflow: project ${projectRoot} (the current directory is inside it; paths in a task are read from there)\n`
						: `agent-workflow: ${projectRoot} holds the user-level agent-workflow home, so it is not a project; workers run in ${project}; run state is stored under ${stateBase(project)}\n`,
				);
			io = { ...io, cwd: project };
		}
		if (rest.includes("--help") || rest.includes("-h")) {
			io.stdout(`${helpAction(command).text}\n`);
			return EXIT_OK;
		}
		const testExecutor = await registerTestExecutorFromEnv(io.env);
		if (testExecutor)
			io.stderr(
				`agent-workflow: test executor "${testExecutor}" registered from AGENT_WORKFLOW_TEST_EXECUTOR_MODULE (tests only)\n`,
			);
		// WP17: the terminal CLI's default executor is the first installed and logged-in of
		// pi → claude → codex (host "cli").
		const ctx: HostApiContext = {
			cwd: io.cwd,
			env: io.env,
			host: "cli",
			// WP29: only a terminal can answer; detached launches/resumes never ask (host API).
			...(io.isTTY ? { dynamicUi: cliDynamicUi(io) } : {}),
		};
		// notices prints its own JSON form (`notices list --json`).
		const emit: Emit = (result, exitCode) => {
			if (json && result.action !== "notices")
				io.stdout(
					`${JSON.stringify(
						{
							action: result.action,
							ok: result.ok,
							outcome: result.outcome,
							data: result.data,
						},
						null,
						2,
					)}\n`,
				);
			else io.stdout(`${result.text}\n`);
			return exitCode ?? exitCodeFor(result);
		};
		return await dispatch(command, rest, ctx, io, emit);
	} catch (error) {
		const usage =
			error instanceof HostUsageError || error instanceof TestExecutorHookError;
		const message = `${formatHostError(error)}${permissionHint(error)}`;
		if (json)
			io.stdout(
				`${JSON.stringify(
					{
						action: command,
						ok: false,
						outcome: usage ? "usage" : "error",
						error: message,
					},
					null,
					2,
				)}\n`,
			);
		io.stderr(`${message}\n`);
		return usage ? EXIT_USAGE : EXIT_FAILED;
	}
}
