// New in agent-workflow (WP11b): the `/aw <action> …` slash command. Each action parses its
// arguments and calls exactly one host API handler; the output is the handler's `text`. Ported in
// spirit from pi-workflow 0.16.4 (b83cc4f) `handleWorkflowCommand` (the `/workflow` actions), without
// the board, `auto` and the TUI profile picker. The command is `/aw`, never `/workflow`, so it can
// run next to pi-workflow (A2-1). WP16: `/aw logs`; launches and resumes from this session are
// tracked for the status line and completion delivery (feedback.ts); without a dialog UI the
// declared-profile choice falls back to text (host.ts `launchHooks`).
import {
	COMMAND_HELP,
	HOST_WAIT_MAX_TIMEOUT_MS,
	type HostResult,
	HostUsageError,
	formatHostError,
	type ProfileRequest,
	parseCapabilityList,
	parseDuration,
	parsePermissionMode,
	parseThinkingLevel,
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
	tokenizeWorkflowArgs,
} from "../api.js";
import { logsRequest, parseCommandArgs } from "../cli/index.js";
import {
	emit,
	hostContext,
	launchHooks,
	levelForOutcome,
	type PiHostDeps,
} from "./host.js";
import { AW_COMMAND, AW_TOOL_NAMES } from "./names.js";
import type { PiExtensionContext } from "./pi-types.js";

/** Every `/aw` action (the host API actions except `supervise`, which is CLI-only). */
export const AW_ACTIONS = [
	"help",
	"list",
	"validate",
	"roles",
	"agents",
	"profile",
	"run",
	"dynamic",
	"status",
	"show",
	"inspect",
	"logs",
	"wait",
	"resume",
	"stop",
	"prune",
	"notices",
] as const;

const RUN_OPTIONS =
	"--executor <id> --profile <name> --permission-mode free|safe --allow-unverified <a,b> --model <id> --effort <level> --input <key=value> --detach --force-new";

export const AW_HELP = `/aw — agent-workflow in Pi. Workers run on the selected executor (default pi; --executor codex or claude).

Workflows:
  /aw list [--query <text>] [--offset N] [--limit N]   list discoverable workflows
  /aw validate <workflow>                              validate a workflow spec
  /aw roles <workflow>                                 show compiled role context
  /aw agents                                           list agent definitions
  /aw show <workflow>                                  print a workflow spec
  /aw profile list|show|set|delete|default …           manage saved user profiles

Runs:
  /aw run <workflow> <task> [options]   start a workflow; returns once it is launched
  /aw dynamic <task> [options]          start a spec-less dynamic workflow
  /aw status [run]                      show runs
  /aw show <run> [--raw]                show run details
  /aw inspect <run> [--failures] [--results]
  /aw logs <run> [--task <id>] [--lines N] [--stream output|stderr|events|all]
  /aw wait <run> [--timeout <duration>] one bounded wait (at most 45 s); repeat while running
  /aw resume <run> [--detach]           resume a failed, interrupted or blocked run
  /aw stop <run>                        stop a run
  /aw prune [--keep N] [--older-than DAYS] [--yes]
  /aw notices list | acknowledge <run> --state <sha256> --reason <text> | clear <run>

Run options: ${RUN_OPTIONS}
With a Pi UI, capability degradations that need confirmation are asked and a declared execution profile is chosen in a dialog; without one degradations are recorded, the default profile is used and the choices are listed. Runs launched here show their progress in the status line and report back into this session when they finish or need action.
Agent tools: ${AW_TOOL_NAMES.join(", ")}. /aw help <action> shows the agent-workflow help of one action.`;

function only(positionals: string[], count: number, usage: string): string[] {
	if (positionals.length !== count)
		throw new HostUsageError(`Usage: /${AW_COMMAND} ${usage}`);
	return positionals;
}

function intValue(raw: string | undefined, option: string): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
		throw new HostUsageError(`${option} requires a non-negative integer`);
	return Number(raw);
}

function profileRequest(argv: string[]): ProfileRequest {
	const [op = "list", ...rest] = argv;
	if (op === "list") {
		only(parseCommandArgs(rest, {}).positionals, 0, "profile list");
		return { op: "list" };
	}
	if (op === "show") {
		const { positionals } = parseCommandArgs(rest, {});
		if (positionals.length > 1)
			throw new HostUsageError(`Usage: /${AW_COMMAND} profile show [<name>]`);
		return positionals[0]
			? { op: "show", name: positionals[0] }
			: { op: "show" };
	}
	if (op === "set") {
		const parsed = parseCommandArgs(rest, {
			flags: ["--default"],
			values: [
				"--executor",
				"--model",
				"--effort",
				"--permission-mode",
				"--strict-capabilities",
				"--unset",
			],
			aliases: { "--thinking": "--effort" },
		});
		const [name] = only(parsed.positionals, 1, "profile set <name> [options]");
		const v = parsed.values;
		const values: Record<string, unknown> = {};
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
		const unset = v
			.get("--unset")
			?.split(",")
			.map((field) => field.trim())
			.filter(Boolean);
		return {
			op: "set",
			name: name!,
			values,
			...(unset ? { unset } : {}),
			...(parsed.flags.has("--default") ? { makeDefault: true } : {}),
		};
	}
	if (op === "delete")
		return {
			op: "delete",
			name: only(
				parseCommandArgs(rest, {}).positionals,
				1,
				"profile delete <name>",
			)[0]!,
		};
	if (op === "default") {
		const parsed = parseCommandArgs(rest, { flags: ["--clear"] });
		if (parsed.flags.has("--clear")) {
			only(parsed.positionals, 0, "profile default <name> | --clear");
			return { op: "default", name: null };
		}
		return {
			op: "default",
			name: only(parsed.positionals, 1, "profile default <name> | --clear")[0]!,
		};
	}
	throw new HostUsageError(
		`Unknown profile operation "${op}". Usage: /${AW_COMMAND} profile list|show|set|delete|default`,
	);
}

/** `/aw help [action]`: the Pi command list, or the shared help of one action. */
function helpText(deps: PiHostDeps, topic: string | undefined): string {
	if (topic === undefined) return AW_HELP;
	if (
		!(AW_ACTIONS as readonly string[]).includes(topic) ||
		!COMMAND_HELP[topic]
	)
		throw new HostUsageError(
			`Unknown /${AW_COMMAND} action "${topic}". Try /${AW_COMMAND} help.`,
		);
	return `${deps.api.helpAction(topic).text.replaceAll("agent-workflow ", `/${AW_COMMAND} `)}\n\nIn Pi: --json, --yes and --timeout on run/resume are CLI-only; /${AW_COMMAND} run returns once the run is launched and /${AW_COMMAND} wait waits at most 45 s per call.`;
}

type Dispatched =
	| (HostResult<unknown> & { note?: string | undefined })
	| { text: string };

async function dispatch(
	deps: PiHostDeps,
	args: string,
	ctx: PiExtensionContext,
): Promise<Dispatched> {
	const tokens = tokenizeWorkflowArgs(args).map((token) => token.text);
	const [action = "help", ...rest] = tokens;
	if (action === "help" || action === "--help" || action === "-h") {
		if (rest.length > 1)
			throw new HostUsageError(`Usage: /${AW_COMMAND} help [<action>]`);
		return { text: helpText(deps, rest[0]) };
	}
	const api = deps.api;
	const host = () => hostContext(deps, ctx);
	switch (action) {
		case "list": {
			const parsed = parseCommandArgs(rest, {
				values: ["--query", "--offset", "--limit"],
			});
			only(
				parsed.positionals,
				0,
				"list [--query <text>] [--offset N] [--limit N]",
			);
			const offset = intValue(parsed.values.get("--offset"), "--offset");
			const limit = intValue(parsed.values.get("--limit"), "--limit");
			return api.listWorkflowsAction(host(), {
				...(parsed.values.has("--query")
					? { query: parsed.values.get("--query")! }
					: {}),
				...(offset === undefined ? {} : { offset }),
				...(limit === undefined ? {} : { limit }),
			});
		}
		case "validate":
		case "roles": {
			const [workflow] = only(
				parseCommandArgs(rest, {}).positionals,
				1,
				`${action} <workflow-name-or-path>`,
			);
			return action === "validate"
				? api.validateWorkflowAction(host(), { workflow: workflow! })
				: api.workflowRolesAction(host(), { workflow: workflow! });
		}
		case "agents":
			only(parseCommandArgs(rest, {}).positionals, 0, "agents");
			return api.listAgentsAction(host());
		case "profile":
			return api.profileAction(host(), profileRequest(rest));
		case "run": {
			const parsed = parseWorkflowRunArgs(args);
			if (!parsed.specPath)
				throw new HostUsageError(
					`Usage: /${AW_COMMAND} run <workflow-name-or-path> "<task>" [options]`,
				);
			if (!parsed.task)
				throw new HostUsageError(
					`Missing task. Usage: /${AW_COMMAND} run ${parsed.specPath} "<task>"`,
				);
			const hooks = launchHooks(ctx);
			const launched = await api.runWorkflowAction(
				hostContext(deps, ctx, { executor: parsed.executor }),
				{
					workflow: parsed.specPath,
					...launchRequest(parsed),
					...hooks.hooks,
				},
			);
			return { ...launched, note: hooks.note() };
		}
		case "dynamic": {
			const parsed = parseWorkflowDynamicArgs(args);
			if (!parsed.task)
				throw new HostUsageError(
					`Missing task. Usage: /${AW_COMMAND} dynamic "<task>" [options]`,
				);
			const hooks = launchHooks(ctx);
			const launched = await api.runDynamicAction(
				hostContext(deps, ctx, { executor: parsed.executor }),
				{ ...launchRequest(parsed), ...hooks.hooks },
			);
			return { ...launched, note: hooks.note() };
		}
		case "status": {
			const { positionals } = parseCommandArgs(rest, {});
			if (positionals.length > 1)
				throw new HostUsageError(
					`Usage: /${AW_COMMAND} status [<run-id-or-prefix>]`,
				);
			return api.statusAction(
				host(),
				positionals[0] ? { runId: positionals[0] } : {},
			);
		}
		case "show": {
			const parsed = parseCommandArgs(rest, { flags: ["--raw"] });
			const [ref] = only(
				parsed.positionals,
				1,
				"show <run-id-or-workflow> [--raw]",
			);
			return api.showAction(host(), {
				ref: ref!,
				...(parsed.flags.has("--raw") ? { raw: true } : {}),
			});
		}
		case "inspect": {
			const parsed = parseCommandArgs(rest, {
				flags: ["--failures", "--results"],
			});
			const [runId] = only(parsed.positionals, 1, "inspect <run-id-or-prefix>");
			return api.inspectAction(host(), {
				runId: runId!,
				failures: parsed.flags.has("--failures"),
				results: parsed.flags.has("--results"),
			});
		}
		case "logs": {
			const parsed = parseCommandArgs(rest, {
				values: ["--task", "--lines", "--stream"],
			});
			const [runId] = only(
				parsed.positionals,
				1,
				"logs <run-id-or-prefix> [--task <id>] [--lines N] [--stream output|stderr|events|all]",
			);
			return api.logsAction(host(), logsRequest(runId!, parsed.values));
		}
		case "wait": {
			const parsed = parseCommandArgs(rest, { values: ["--timeout"] });
			const [runId] = only(
				parsed.positionals,
				1,
				"wait <run-id-or-prefix> [--timeout <duration>]",
			);
			const timeout = parsed.values.get("--timeout");
			return api.waitAction(host(), {
				runId: runId!,
				timeoutMs:
					timeout === undefined
						? HOST_WAIT_MAX_TIMEOUT_MS
						: parseDuration(timeout),
			});
		}
		case "resume": {
			const parsed = parseCommandArgs(rest, { flags: ["--detach"] });
			const [runId] = only(
				parsed.positionals,
				1,
				"resume <run-id-or-prefix> [--detach]",
			);
			return api.resumeAction(host(), {
				runId: runId!,
				...(parsed.flags.has("--detach") ? { detach: true } : {}),
			});
		}
		case "stop": {
			const [runId] = only(
				parseCommandArgs(rest, {}).positionals,
				1,
				"stop <run-id-or-prefix>",
			);
			return api.stopAction(host(), { runId: runId! });
		}
		case "prune":
			return api.pruneAction(host(), { argv: rest });
		case "notices":
			return api.noticesAction(host(), { argv: rest });
		default:
			throw new HostUsageError(
				`Unknown /${AW_COMMAND} action "${action}". Try /${AW_COMMAND} help.`,
			);
	}
}

function launchRequest(parsed: {
	task: string;
	detach: boolean;
	forceNew?: boolean;
	model?: string;
	thinking?: ReturnType<typeof parseThinkingLevel>;
	profile?: string;
	executor?: string;
	permissionMode?: "free" | "safe";
	allowUnverifiedCapabilities?: string[];
	inputs?: Record<string, string>;
}) {
	return {
		task: parsed.task,
		...(parsed.inputs ? { inputOverrides: parsed.inputs } : {}),
		...(parsed.executor ? { executor: parsed.executor } : {}),
		...(parsed.profile ? { profile: parsed.profile } : {}),
		...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
		...(parsed.allowUnverifiedCapabilities?.length
			? { allowUnverifiedCapabilities: parsed.allowUnverifiedCapabilities }
			: {}),
		...(parsed.model ? { model: parsed.model } : {}),
		...(parsed.thinking ? { effort: parsed.thinking } : {}),
		...(parsed.detach ? { detach: true } : {}),
		...(parsed.forceNew ? { forceNew: true } : {}),
	};
}

/** Run one `/aw` invocation and show its text. Errors become an error notification. */
export async function handleAwCommand(
	deps: PiHostDeps,
	args: string,
	ctx: PiExtensionContext,
): Promise<void> {
	try {
		await deps.ready();
		const outcome = await dispatch(deps, args, ctx);
		if (!("action" in outcome)) {
			emit(ctx, outcome.text, "info");
			return;
		}
		const data = outcome.data as
			| { stillRunning?: unknown; runId?: unknown; status?: unknown }
			| undefined;
		await trackLaunched(deps, ctx, outcome.action, data, "command");
		emit(
			ctx,
			outcome.note ? `${outcome.text}\n${outcome.note}` : outcome.text,
			data?.stillRunning === true
				? "warning"
				: levelForOutcome(outcome.outcome),
		);
		if (!ctx.hasUI && !outcome.ok) process.exitCode = 1;
	} catch (error) {
		emit(ctx, formatHostError(error), "error");
		if (!ctx.hasUI) process.exitCode = 1;
	}
}

/**
 * WP16: a run launched (or resumed, or returned by the duplicate guard) from this session is
 * tracked for the status line and completion delivery. Never throws.
 */
export async function trackLaunched(
	deps: PiHostDeps,
	ctx: PiExtensionContext,
	action: string,
	data: { runId?: unknown; status?: unknown } | undefined,
	launchedBy: "command" | "tool",
): Promise<void> {
	if (action !== "run" && action !== "dynamic" && action !== "resume") return;
	if (typeof data?.runId !== "string") return;
	if (data.status !== "running" && data.status !== "pending") return;
	await deps.feedback.track(ctx, data.runId, launchedBy).catch(() => undefined);
}

export function awArgumentCompletions(
	prefix: string,
): Array<{ value: string; label: string }> | null {
	if (/\s/.test(prefix)) return null;
	const matches = AW_ACTIONS.filter((action) => action.startsWith(prefix));
	return matches.length
		? matches.map((action) => ({ value: action, label: action }))
		: null;
}
