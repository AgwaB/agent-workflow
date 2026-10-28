// New in agent-workflow (WP11a): the host-neutral `agent-workflow` CLI. A thin argv layer over the
// host API (../api.ts): every command parses its flags, calls one handler and prints the handler's
// text (or, with --json, one `{action, ok, outcome, data}` object). Exit codes: 0 success or a
// completed run, 1 failed/blocked/interrupted/refused/still running at --timeout, 2 usage error.
// Replaces pi-workflow's src/cli.mjs (inspect/prune/notices/supervise), whose prune path imported
// the Pi extension (R#14).
// WP17: passes host "cli" (installed-default executor) and adds `doctor`. WP16: `logs`.
// WP31: `profile set --preset/--role`, `profile presets`, `profile workflow list|show|set|clear`.
// WP29: on a terminal, foreground runs/waits/resumes ask y/n to approve a dynamic controller
// (cliDynamicUi); `approve <run>` answers an approval a run is blocked on.
// WP32: `auto <task>`: consent y/N on a terminal (or --yes), then a pick-list of the ranked workflows.
import { readFileSync } from "node:fs";
import { parseRoleAssignmentText } from "../../core/role-profiles.js";
import { addWorkflowInputAssignment } from "../args.js";
import { cliLaunchCommand } from "../launch-capture.js";
import { createInterface } from "node:readline";

import {
	type AutoChoicePrompt,
	type AutoConsent,
	approveAction,
	autoAction,
	doctorAction,
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
	type LogsRequest,
	noticesAction,
	type ProfileRequest,
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
	runWorkflowAction,
	showAction,
	statusAction,
	stopAction,
	superviseAction,
	TestExecutorHookError,
	type WaitData,
	validateWorkflowAction,
	waitAction,
	type WorkflowPreferenceRequest,
	workflowPreferenceAction,
	workflowRolesAction,
} from "../api.js";
import { notifyCheck } from "../notify-check.js";
import { runWatch, WATCH_DEFAULT_INTERVAL_MS } from "../watch.js";
import { runStatusLine } from "./statusline.js";

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
	/** Bound of each underlying wait call (default and cap 45 s; tests use less). */
	waitSliceMs?: number;
	/** WP36: terminal height for `watch` (bounds the task rows). */
	rows?: number;
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
 * WP29 (parity row 43): the CLI's dynamic-controller approval on a terminal, the port of
 * pi-workflow's `ctx.ui.confirm` (src/extension.ts `dynamicUiFromContext`): the approval scope on
 * stderr, then "Run dynamic workflow controller? [y/n]". `y` runs the controller; `n` rejects it for
 * this run (no re-prompt on resume); no answer (empty line, end of input, or the engine's 5-minute
 * timeout) leaves it blocked and resumable. Used by foreground `run`/`dynamic`/`wait`/`resume` on a
 * terminal only; without a terminal, and for `--detach`, the run blocks with the `approve` command.
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

interface OptionSpec {
	/** Boolean flags. */
	flags?: readonly string[];
	/** Options taking one value. */
	values?: readonly string[];
	/** Options taking one value that may be given more than once (WP12a: `--input`). */
	repeatable?: readonly string[];
	/** Option aliases → canonical name. */
	aliases?: Readonly<Record<string, string>>;
}

interface ParsedArgs {
	positionals: string[];
	flags: Set<string>;
	values: Map<string, string>;
	lists: Map<string, string[]>;
}

/** Strict argv parser: `--name value`, `--name=value`, `--` ends options, duplicates rejected. */
export function parseCommandArgs(
	argv: readonly string[],
	spec: OptionSpec,
): ParsedArgs {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const positionals: string[] = [];
	const known = new Set([
		...(spec.flags ?? []),
		...(spec.values ?? []),
		...(spec.repeatable ?? []),
	]);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--") || arg === "--") {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		let name = eq < 0 ? arg : arg.slice(0, eq);
		name = spec.aliases?.[name] ?? name;
		if (!known.has(name))
			throw new HostUsageError(`Unknown option ${arg.split("=")[0]}`);
		if (spec.flags?.includes(name)) {
			if (eq >= 0) throw new HostUsageError(`${name} takes no value`);
			if (flags.has(name)) throw new HostUsageError(`Duplicate option ${name}`);
			flags.add(name);
			continue;
		}
		const value = eq >= 0 ? arg.slice(eq + 1) : argv[++index];
		if (
			value === undefined ||
			value === "" ||
			(eq < 0 && value.startsWith("--"))
		)
			throw new HostUsageError(`${name} requires a value`);
		if (spec.repeatable?.includes(name)) {
			lists.set(name, [...(lists.get(name) ?? []), value]);
			continue;
		}
		if (values.has(name)) throw new HostUsageError(`Duplicate option ${name}`);
		values.set(name, value);
	}
	return { positionals, flags, values, lists };
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

function intValue(raw: string | undefined, option: string): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
		throw new HostUsageError(`${option} requires a non-negative integer`);
	return Number(raw);
}

function only(parsed: ParsedArgs, count: number, usage: string): string[] {
	if (parsed.positionals.length !== count)
		throw new HostUsageError(`Usage: ${usage}`);
	return parsed.positionals;
}

const LAUNCH_SPEC: OptionSpec = {
	flags: ["--detach", "--force-new", "--yes", "--json"],
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
	return { request, json, detach, totalTimeoutMs, interactive };
}

/** After a launch: print it and, unless detached, wait in the foreground until it settles. */
async function followLaunch(
	command: "run" | "dynamic" | "auto",
	launched: HostResult<unknown>,
	data: { runId?: string; status?: string } | undefined,
	options: CliLaunchOptions,
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	const { json, detach, totalTimeoutMs } = options;
	if (!json) io.stdout(`${launched.text}\n`);
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

/** WP31: `--role` values → a role map (each `<role>=<executor>[:<model>[:<effort>]]`). */
export function parseRoleFlags(
	values: readonly string[] | undefined,
): Record<string, unknown> | undefined {
	if (values === undefined || values.length === 0) return undefined;
	const roles: Record<string, unknown> = {};
	for (const value of values) {
		let parsed: ReturnType<typeof parseRoleAssignmentText>;
		try {
			parsed = parseRoleAssignmentText(value, "--role");
		} catch (error) {
			throw new HostUsageError(
				error instanceof Error ? error.message : String(error),
			);
		}
		if (Object.hasOwn(roles, parsed[0]))
			throw new HostUsageError(`--role ${parsed[0]} is given twice`);
		roles[parsed[0]] = parsed[1];
	}
	return roles;
}

const WORKFLOW_PREFERENCE_USAGE =
	"profile workflow list | show <workflow> | set <workflow> [--profile <name>] [--role <role>=<executor>[:<model>[:<effort>]]]... [--unset profile,roles,roles.<role>] | clear <workflow>";

/** WP31: `profile workflow …` → a per-workflow preference request (also the Pi `/aw` command). */
export function workflowPreferenceRequest(
	argv: readonly string[],
): WorkflowPreferenceRequest {
	const [op = "list", ...rest] = argv;
	if (op === "list") {
		only(
			parseCommandArgs(rest, { flags: ["--json"] }),
			0,
			WORKFLOW_PREFERENCE_USAGE,
		);
		return { op: "list" };
	}
	if (op === "show" || op === "clear") {
		const [workflow] = only(
			parseCommandArgs(rest, { flags: ["--json"] }),
			1,
			WORKFLOW_PREFERENCE_USAGE,
		);
		return { op, workflow: workflow! };
	}
	if (op === "set") {
		const parsed = parseCommandArgs(rest, {
			flags: ["--json"],
			values: ["--profile", "--unset"],
			repeatable: ["--role"],
		});
		const [workflow] = only(parsed, 1, WORKFLOW_PREFERENCE_USAGE);
		const roles = parseRoleFlags(parsed.lists.get("--role"));
		const unset = parsed.values
			.get("--unset")
			?.split(",")
			.map((field) => field.trim())
			.filter(Boolean);
		return {
			op: "set",
			workflow: workflow!,
			...(parsed.values.has("--profile")
				? { profile: parsed.values.get("--profile")! }
				: {}),
			...(roles ? { roles } : {}),
			...(unset ? { unset } : {}),
		};
	}
	throw new HostUsageError(`Usage: ${WORKFLOW_PREFERENCE_USAGE}`);
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
	const [op = "list", ...rest] = argv;
	let request: ProfileRequest;
	if (op === "list") {
		only(parseCommandArgs(rest, { flags: ["--json"] }), 0, "profile list");
		request = { op: "list" };
	} else if (op === "show") {
		const parsed = parseCommandArgs(rest, { flags: ["--json"] });
		if (parsed.positionals.length > 1)
			throw new HostUsageError("Usage: profile show [<name>]");
		request = parsed.positionals[0]
			? { op: "show", name: parsed.positionals[0] }
			: { op: "show" };
	} else if (op === "set") {
		const parsed = parseCommandArgs(rest, {
			flags: ["--json", "--default"],
			values: [
				"--executor",
				"--model",
				"--effort",
				"--permission-mode",
				"--strict-capabilities",
				"--unset",
				"--preset",
			],
			repeatable: ["--role"],
			aliases: { "--thinking": "--effort" },
		});
		const [name] = only(parsed, 1, "profile set <name> [options]");
		const values: Record<string, unknown> = {};
		const v = parsed.values;
		if (v.has("--executor")) values.executor = v.get("--executor");
		if (v.has("--model")) values.model = v.get("--model");
		if (v.has("--effort"))
			values.effort = parseThinkingLevel(v.get("--effort")!);
		if (v.has("--permission-mode"))
			values.permissionMode = parsePermissionMode(v.get("--permission-mode")!);
		if (v.has("--strict-capabilities"))
			values.strictCapabilities = parseCapabilityList(
				v.get("--strict-capabilities")!,
				"--strict-capabilities",
			);
		// WP31: `--role <role>=<executor>[:<model>[:<effort>]]` (repeatable) and `--preset <id>`.
		const roles = parseRoleFlags(parsed.lists.get("--role"));
		if (roles) values.roles = roles;
		const unset = v
			.get("--unset")
			?.split(",")
			.map((field) => field.trim())
			.filter(Boolean);
		request = {
			op: "set",
			name: name!,
			values,
			...(unset ? { unset } : {}),
			...(parsed.flags.has("--default") ? { makeDefault: true } : {}),
			...(v.has("--preset") ? { preset: v.get("--preset")! } : {}),
		};
	} else if (op === "presets") {
		only(parseCommandArgs(rest, { flags: ["--json"] }), 0, "profile presets");
		request = { op: "presets" };
	} else if (op === "workflow") {
		return emit(
			await workflowPreferenceAction(ctx, workflowPreferenceRequest(rest)),
		);
	} else if (op === "delete") {
		const parsed = parseCommandArgs(rest, { flags: ["--json"] });
		request = {
			op: "delete",
			name: only(parsed, 1, "profile delete <name>")[0]!,
		};
	} else if (op === "default") {
		const parsed = parseCommandArgs(rest, { flags: ["--json", "--clear"] });
		if (parsed.flags.has("--clear")) {
			only(parsed, 0, "profile default <name> | --clear");
			request = { op: "default", name: null };
		} else
			request = {
				op: "default",
				name: only(parsed, 1, "profile default <name> | --clear")[0]!,
			};
	} else
		throw new HostUsageError(
			`Unknown profile operation "${op}". Usage: profile list|show|set|delete|default|presets|workflow`,
		);
	return emit(await profileAction(ctx, request));
}

async function dispatch(
	command: string,
	argv: readonly string[],
	ctx: HostApiContext,
	io: CliIo,
	emit: Emit,
): Promise<number> {
	const jsonOnly: OptionSpec = { flags: ["--json"] };
	switch (command) {
		case "list": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json"],
				values: ["--query", "--offset", "--limit"],
			});
			only(parsed, 0, "list [--query <text>] [--offset N] [--limit N]");
			const offset = intValue(parsed.values.get("--offset"), "--offset");
			const limit = intValue(parsed.values.get("--limit"), "--limit");
			return emit(
				await listWorkflowsAction(ctx, {
					...(parsed.values.has("--query")
						? { query: parsed.values.get("--query")! }
						: {}),
					...(offset === undefined ? {} : { offset }),
					...(limit === undefined ? {} : { limit }),
				}),
			);
		}
		case "validate":
		case "roles": {
			const [workflow] = only(
				parseCommandArgs(argv, jsonOnly),
				1,
				`${command} <workflow-name-or-path>`,
			);
			return emit(
				command === "validate"
					? await validateWorkflowAction(ctx, { workflow: workflow! })
					: await workflowRolesAction(ctx, { workflow: workflow! }),
			);
		}
		case "agents":
			only(parseCommandArgs(argv, jsonOnly), 0, "agents");
			return emit(await listAgentsAction(ctx));
		case "profile":
			return profileCommand(argv, ctx, emit);
		case "run":
		case "dynamic":
			return launchCommand(command, argv, ctx, io, emit);
		case "auto":
			return autoCommand(argv, ctx, io, emit);
		case "status": {
			const parsed = parseCommandArgs(argv, jsonOnly);
			if (parsed.positionals.length > 1)
				throw new HostUsageError("Usage: status [<run-id-or-prefix>]");
			return emit(
				await statusAction(
					ctx,
					parsed.positionals[0] ? { runId: parsed.positionals[0] } : {},
				),
			);
		}
		case "show": {
			const parsed = parseCommandArgs(argv, { flags: ["--json", "--raw"] });
			const [ref] = only(parsed, 1, "show <run-id-or-workflow> [--raw]");
			return emit(
				await showAction(ctx, {
					ref: ref!,
					...(parsed.flags.has("--raw") ? { raw: true } : {}),
				}),
			);
		}
		case "inspect": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json", "--failures", "--results"],
			});
			const [runId] = only(parsed, 1, "inspect <run-id-or-prefix>");
			return emit(
				await inspectAction(ctx, {
					runId: runId!,
					failures: parsed.flags.has("--failures"),
					results: parsed.flags.has("--results"),
				}),
			);
		}
		case "logs": {
			const parsed = parseCommandArgs(argv, {
				flags: ["--json"],
				values: ["--task", "--lines", "--stream"],
			});
			const [runId] = only(
				parsed,
				1,
				"logs <run-id-or-prefix> [--task <id>] [--lines N] [--stream output|stderr|events|all]",
			);
			return emit(await logsAction(ctx, logsRequest(runId!, parsed.values)));
		}
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
		case "stop": {
			const [runId] = only(
				parseCommandArgs(argv, jsonOnly),
				1,
				"stop <run-id-or-prefix>",
			);
			return emit(await stopAction(ctx, { runId: runId! }));
		}
		case "prune":
			return emit(
				await pruneAction(ctx, {
					argv: argv.filter((arg) => arg !== "--json"),
				}),
			);
		case "notices":
			return emit(await noticesAction(ctx, { argv: [...argv] }), undefined);
		case "doctor":
			only(parseCommandArgs(argv, jsonOnly), 0, "doctor [--json]");
			return emit(await doctorAction(ctx));
		case "statusline":
			// Never fails loudly (the bin takes a faster path to the same function).
			return runStatusLine({
				cwd: io.cwd,
				stdout: io.stdout,
				...(io.now ? { now: io.now } : {}),
			});
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
				values: ["--host", "--interval"],
			});
			only(
				parsed,
				0,
				"notify-check [--host cli|claude-code|codex|generic] [--json] [--follow [--interval <seconds>]]",
			);
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
				});
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
				while (!io.signal?.aborted) {
					const checked = await check().catch(() => undefined);
					if (checked?.text) io.stdout(`${checked.text}\n`);
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

/** `logs` options shared by the CLI and `/aw logs`. */
export function logsRequest(
	runId: string,
	values: ReadonlyMap<string, string>,
): LogsRequest {
	const lines = intValue(values.get("--lines"), "--lines");
	const stream = values.get("--stream");
	return {
		runId,
		...(values.has("--task") ? { task: values.get("--task")! } : {}),
		...(lines === undefined ? {} : { lines }),
		...(stream === undefined
			? {}
			: { stream: stream as NonNullable<LogsRequest["stream"]> }),
	};
}

/** Run one CLI invocation; resolves with the process exit code. */
export async function runAgentWorkflowCli(
	argv: readonly string[],
	io: CliIo = processCliIo(),
): Promise<number> {
	const [command, ...rest] = argv;
	const json = rest.includes("--json");
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
		const message = formatHostError(error);
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
