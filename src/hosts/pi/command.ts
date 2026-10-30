// New in agent-workflow (WP11b): the `/aw <action> …` slash command. Each action parses its
// arguments and calls exactly one host API handler; the output is the handler's `text`. Ported in
// spirit from pi-workflow 0.16.4 (b83cc4f) `handleWorkflowCommand` (the `/workflow` actions), without
// `auto` (WP34 adds the board and the TUI profile picker). The command is `/aw`, never `/workflow`, so it can
// run next to pi-workflow (A2-1). WP16: `/aw logs`; launches and resumes from this session are
// tracked for the status line and completion delivery (feedback.ts); without a dialog UI the
// declared-profile choice falls back to text (host.ts `launchHooks`). WP28 (Q9): `/aw wait <run>
// [timeout]` waits until the run is terminal or needs action, or the timeout passes (pi-workflow
// `/workflow wait <run> [timeout-ms]`: default 60 s, max 4 h; the host API `longWait`).
// WP31: `/aw profile set --preset/--role`, `/aw profile presets`, `/aw profile workflow …`.
// WP29: `/aw approve <run>` answers a dynamic-controller approval through ctx.ui.confirm.
// WP34: in the TUI, `/aw` with no arguments and `/aw <run>` open the board (board.ts); other modes
// keep the text behavior (`/aw` = help, `/aw <run>` = unknown action).
// WP32: `/aw auto <task>` (pi-workflow `/workflow auto`): consent through ctx.ui.confirm, then the
// ranked workflows in ctx.ui.select and a final ctx.ui.confirm; print/JSON mode sends nothing.
import {
	type AutoChoicePrompt,
	COMMAND_HELP,
	HOST_LONG_WAIT_MAX_TIMEOUT_MS,
	type HostResult,
	HostUsageError,
	formatHostError,
	type ProfileRequest,
	parseCapabilityList,
	parseDuration,
	parsePermissionMode,
	parseThinkingLevel,
	parseWorkflowAutoArgs,
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
	tokenizeWorkflowArgs,
} from "../api.js";
import {
	logsRequest,
	parseCommandArgs,
	parseRoleFlags,
	workflowPreferenceRequest,
} from "../cli/index.js";
import { FOREGROUND_CANCELLED, withForegroundLoader } from "./active-ui.js";
import { boardAvailable, showAwBoard } from "./board.js";
import { piBoardSource } from "./board-source.js";
import { runProfilePicker } from "./profile-picker.js";
import { piProfilePickerUi } from "./profile-tui.js";
import { beginRunParentUsage } from "./parent-usage.js";
import {
	emit,
	hasDialogUi,
	hostContext,
	launchHooks,
	levelForOutcome,
	type PiHostDeps,
	type PiLaunchHooks,
} from "./host.js";
import {
	ensureDashboard,
	mintLaunchUrl,
	openInBrowser,
} from "../dashboard/discovery.js";
import { AW_COMMAND, AW_TOOL_NAMES } from "./names.js";
import type { PiExtensionContext } from "./pi-types.js";

/** Every `/aw` action (the host API actions except `supervise`, which is CLI-only). */
export const AW_ACTIONS = [
	"help",
	"list",
	"validate",
	"check",
	"roles",
	"agents",
	"profile",
	"run",
	"dynamic",
	"auto",
	"status",
	"show",
	"inspect",
	"logs",
	"wait",
	"resume",
	"approve",
	"stop",
	"prune",
	"notices",
	"dashboard",
] as const;

/** `/aw wait` without a timeout: pi-workflow's `/workflow wait` default (the engine's 60 s). */
export const AW_WAIT_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;

const RUN_OPTIONS =
	"--executor <id> --profile <name> --permission-mode free|safe --allow-unverified <a,b> --model <id> --effort <level> --input <key=value> --detach --force-new";

export const AW_HELP = `/aw — agent-workflow in Pi. Workers run on the selected executor (default pi; --executor codex or claude).

Workflows:
  /aw list [--query <text>] [--offset N] [--limit N]   list discoverable workflows
  /aw validate <workflow>                              validate a workflow spec
  /aw check <workflow> [options]                       launch preflight: executor, tools, models, effort (no run)
  /aw roles <workflow>                                 show compiled role context
  /aw agents                                           list agent definitions
  /aw show <workflow>                                  print a workflow spec
  /aw profile                                          (TUI) the profile picker: presets, saved, Custom
  /aw profile list|show|set|delete|default|presets …   manage saved user profiles (roles, presets)
  /aw profile workflow list|show|set|clear …           saved per-workflow preferences

Runs:
  /aw [<run>]                           open the run board (TUI only; r refresh, v launch, c copy, s stop, u resume, a approve, q close)
  /aw run <workflow> <task> [options]   start a workflow; returns once it is launched
  /aw dynamic <task> [options]          start a spec-less dynamic workflow
  /aw auto <task> [options]             recommend a workflow and start the one you choose (asks
                                        before one classifier call; nothing is sent without a UI)
  /aw status [run]                      show runs
  /aw show <run> [--raw]                show run details
  /aw inspect <run> [--failures] [--results]
  /aw logs <run> [--task <id>] [--lines N] [--stream output|stderr|events|all]
  /aw wait <run> [timeout]             wait until finished or the timeout (default 60s, max 4h)
  /aw resume <run> [--detach]           resume a failed, interrupted or blocked run
  /aw approve <run> [--request <id>] [--reject] [--detach] [--yes]
                                        approve or reject a dynamic controller the run waits on
  /aw stop <run>                        stop a run
  /aw prune [--keep N] [--older-than DAYS] [--yes]
  /aw notices list | acknowledge <run> --state <sha256> --reason <text> | clear <run>

Run options: ${RUN_OPTIONS}
With a Pi UI, dynamic controllers that need approval are asked ("Run dynamic workflow controller?": yes runs it, no rejects it for the run) while this session drives the run; detached runs wait for /aw approve. With a Pi UI, capability degradations that need confirmation are asked and a declared execution profile is chosen in a dialog; without one degradations are recorded, the default profile is used and the choices are listed. Runs launched here show their progress in the status line and report back into this session when they finish or need action.
Agent tools: ${AW_TOOL_NAMES.join(", ")}. /aw help <action> shows the agent-workflow help of one action.

Dashboard:
  /aw dashboard [<run-id-or-prefix>]                   open the local web dashboard in your browser (starts it when needed; never prints the token)`;

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
				"--preset",
			],
			repeatable: ["--role"],
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
		// WP31: roles and presets (same syntax as the CLI).
		const roles = parseRoleFlags(parsed.lists.get("--role"));
		if (roles) values.roles = roles;
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
			...(v.has("--preset") ? { preset: v.get("--preset")! } : {}),
		};
	}
	if (op === "presets") {
		only(parseCommandArgs(rest, {}).positionals, 0, "profile presets");
		return { op: "presets" };
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
		`Unknown profile operation "${op}". Usage: /${AW_COMMAND} profile list|show|set|delete|default|presets|workflow`,
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
	return `${deps.api.helpAction(topic).text.replaceAll("agent-workflow ", `/${AW_COMMAND} `)}\n\nIn Pi: --json, --yes and --timeout on run/resume are CLI-only; /${AW_COMMAND} run returns once the run is launched and /${AW_COMMAND} wait <run> [timeout] waits until the run finishes or the timeout passes (default 60s, max 4h).`;
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
		case "check": {
			// The launch preflight only: `/aw run` options, task optional, no run.
			const parsed = parseWorkflowRunArgs(
				args.trim().replace(/^check(?:\s+|$)/iu, ""),
			);
			if (!parsed.specPath)
				throw new HostUsageError(
					`Usage: /${AW_COMMAND} check <workflow-name-or-path> ["<task>"] [options]`,
				);
			const { detach: _detach, ...request } = launchRequest({
				...parsed,
				task: parsed.task || "preflight check",
			});
			return api.checkWorkflowAction(
				hostContext(deps, ctx, { executor: parsed.executor }),
				{ workflow: parsed.specPath, ...request },
			);
		}
		case "agents":
			only(parseCommandArgs(rest, {}).positionals, 0, "agents");
			return api.listAgentsAction(host());
		case "profile":
			// WP34: `/aw profile` alone opens the picker in the TUI (the text operations stay).
			if (rest.length === 0 && boardAvailable(ctx)) {
				const picked = await runProfilePicker(
					piProfilePickerUi(ctx),
					api,
					host(),
				);
				return {
					text:
						picked.status === "saved"
							? picked.text
							: "Profile picker closed; nothing saved.",
				};
			}
			// WP31: `/aw profile workflow …` manages saved per-workflow preferences.
			if (rest[0] === "workflow")
				return api.workflowPreferenceAction(
					host(),
					workflowPreferenceRequest(rest.slice(1)),
				);
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
			// WP34: in the TUI the declared-profile chooser also offers "Custom…" (the picker).
			const hooks = launchHooks(ctx, { customProfile: boardAvailable(ctx) });
			const launch = (with_: PiLaunchHooks) =>
				api.runWorkflowAction(
					hostContext(deps, ctx, { executor: parsed.executor }),
					{
						workflow: parsed.specPath!,
						...launchRequest(parsed),
						// WP33: launch capture (redacted by the host API): the command as typed.
						launchOrigin: {
							kind: "command",
							text: `/${AW_COMMAND} ${args.trim()}`,
						},
						...with_.hooks,
					},
				);
			try {
				const launched = await launch(hooks);
				return { ...launched, note: hooks.note() };
			} catch (error) {
				if (!hooks.customRequested()) throw error;
			}
			// "Custom…": nothing started. Save a per-workflow preference, then launch with it.
			const picked = await runProfilePicker(
				piProfilePickerUi(ctx),
				api,
				host(),
				{
					workflow: parsed.specPath,
				},
			);
			if (picked.status !== "saved")
				return {
					text: "Launch cancelled: the profile picker was closed without saving; nothing started.",
				};
			const relaunched = await launch(launchHooks(ctx));
			return { ...relaunched, note: picked.text };
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
				{
					...launchRequest(parsed),
					launchOrigin: {
						kind: "command",
						text: `/${AW_COMMAND} ${args.trim()}`,
					},
					...hooks.hooks,
				},
			);
			return { ...launched, note: hooks.note() };
		}
		case "auto": {
			const parsed = parseWorkflowAutoArgs(args);
			if (!parsed.task)
				throw new HostUsageError(
					`Missing task. Usage: /${AW_COMMAND} auto "<task>" [options]`,
				);
			const hooks = launchHooks(ctx);
			const dialog = hasDialogUi(ctx);
			const signal = deps.sessionSignal();
			const auto = await api.autoAction(
				hostContext(deps, ctx, { executor: parsed.executor }),
				{
					...launchRequest(parsed),
					launchOrigin: {
						kind: "command",
						text: `/${AW_COMMAND} ${args.trim()}`,
					},
					...hooks.hooks,
					// pi-workflow: a session that ends cancels the pending auto selection.
					signal,
					// pi-workflow: only an interactive session can authorize the transmission.
					...(dialog
						? {
								consent: {
									source: "prompt" as const,
									confirm: async (title: string, message: string) =>
										(await ctx.ui.confirm(title, message)) === true,
								},
								// WP38b: pi-workflow's comparison loader (TUI; Escape aborts the request).
								compare: async <T>(
									operation: (signal: AbortSignal | undefined) => Promise<T>,
								): Promise<T | undefined> => {
									if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function")
										ctx.ui.notify("Comparing workflow candidates…", "info");
									const compared = await withForegroundLoader(
										ctx,
										AUTO_COMPARE_LOADER_LABEL,
										operation,
										deps.foregroundLoader,
									);
									return compared === FOREGROUND_CANCELLED
										? undefined
										: compared;
								},
								choose: (prompt: AutoChoicePrompt) => piAutoChoice(ctx, prompt),
							}
						: {}),
				},
			);
			return { ...auto, note: hooks.note() };
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
			const usage = "wait <run-id-or-prefix> [timeout | --timeout <duration>]";
			if (parsed.positionals.length < 1 || parsed.positionals.length > 2)
				throw new HostUsageError(`Usage: /${AW_COMMAND} ${usage}`);
			const [runId, positional] = parsed.positionals;
			const option = parsed.values.get("--timeout");
			if (positional !== undefined && option !== undefined)
				throw new HostUsageError(
					`Usage: /${AW_COMMAND} ${usage} (one timeout, not both)`,
				);
			const timeout = positional ?? option;
			const timeoutMs =
				timeout === undefined
					? AW_WAIT_COMMAND_DEFAULT_TIMEOUT_MS
					: parseDuration(timeout, "timeout");
			if (timeoutMs > HOST_LONG_WAIT_MAX_TIMEOUT_MS)
				throw new HostUsageError(
					`timeout must be at most ${HOST_LONG_WAIT_MAX_TIMEOUT_MS}ms (4h)`,
				);
			// WP33: the wait blocks the session: a cancellable loader in the TUI (Escape cancels
			// only the wait; the run continues).
			const waited = await withForegroundLoader(
				ctx,
				`Waiting for ${runId} (Esc stops waiting; the run continues)…`,
				(signal) =>
					api.waitAction(host(), {
						runId: runId!,
						longWait: true,
						timeoutMs,
						...(signal ? { signal } : {}),
					}),
				deps.foregroundLoader,
			);
			if (waited === FOREGROUND_CANCELLED)
				return {
					text: `Stopped waiting for ${runId}; the run continues. Check it with /${AW_COMMAND} status ${runId} or wait again with /${AW_COMMAND} wait ${runId}.`,
				};
			return waited;
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
		case "approve": {
			const parsed = parseCommandArgs(rest, {
				flags: ["--reject", "--yes", "--detach"],
				values: ["--request"],
			});
			const [runId] = only(
				parsed.positionals,
				1,
				"approve <run-id-or-prefix> [--request <id>] [--reject] [--detach] [--yes]",
			);
			const dialog = hasDialogUi(ctx) && !parsed.flags.has("--yes");
			if (!dialog && !parsed.flags.has("--yes"))
				throw new HostUsageError(
					`/${AW_COMMAND} approve without a dialog UI needs --yes (review the approval first: /${AW_COMMAND} status ${runId})`,
				);
			return api.approveAction(host(), {
				runId: runId!,
				decision: parsed.flags.has("--reject") ? "reject" : "approve",
				...(parsed.values.has("--request")
					? { requestId: parsed.values.get("--request")! }
					: {}),
				...(parsed.flags.has("--detach") ? { detach: true } : {}),
				// pi-workflow's dialog: yes = as decided, no on the approval question = reject.
				...(dialog
					? {
							confirm: async (title: string, message: string) =>
								(await ctx.ui.confirm(title, message)) === true,
						}
					: {}),
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
		case "dashboard": {
			// WP43b: open the local web dashboard from Pi. Pi is a local TUI, so opening the browser
			// is the right move (like `agent-workflow dashboard --open`); the one-time URL goes to the
			// browser only — the session token and launch key never reach the chat.
			const positionals = parseCommandArgs(rest, {}).positionals;
			if (positionals.length > 1)
				throw new HostUsageError(
					`Usage: /${AW_COMMAND} dashboard [<run-id-or-prefix>]`,
				);
			const env = host().env ?? process.env;
			const ref = positionals[0];
			const runId = ref
				? (await api.statusAction(host(), { runId: ref })).data.run?.runId
				: undefined;
			const dashboard = await ensureDashboard(ctx.cwd, env, { start: true });
			if (!dashboard)
				throw new HostUsageError(
					"The dashboard could not be started; run `agent-workflow dashboard --open` from a terminal.",
				);
			const url = await mintLaunchUrl(dashboard, runId ? { run: runId } : {});
			const opened = await openInBrowser(url, env);
			return {
				text: opened
					? `Opened the dashboard in your browser (127.0.0.1:${dashboard.port}${runId ? `, run ${runId}` : ""}).`
					: `Dashboard is running on 127.0.0.1:${dashboard.port}; open it with \`agent-workflow dashboard --open\` from a terminal.`,
			};
		}
		default:
			throw new HostUsageError(
				`Unknown /${AW_COMMAND} action "${action}". Try /${AW_COMMAND} help.`,
			);
	}
}

export const AUTO_CANCEL_CHOICE = "Cancel (start nothing)";
export const AUTO_COMPARE_LOADER_LABEL =
	"Comparing workflow candidates… (Esc cancels; nothing starts)";
export const AUTO_LAUNCH_CONFIRM_TITLE = "Confirm selected workflow launch";

/**
 * WP32: pi-workflow's auto picker (`selectWorkflowAutoChoice`) and its separate final confirmation:
 * the ranked workflows (recommended first) and Cancel in ctx.ui.select, then ctx.ui.confirm.
 */
async function piAutoChoice(
	ctx: PiExtensionContext,
	prompt: AutoChoicePrompt,
): Promise<string | undefined> {
	const labels = prompt.choices.map(
		(choice, index) =>
			`${index + 1}. ${choice.label}${choice.recommended ? " · recommended" : ""} — ${choice.reason ?? choice.description}`,
	);
	const picked = await ctx.ui.select(`${prompt.title}\n${prompt.message}`, [
		...labels,
		AUTO_CANCEL_CHOICE,
	]);
	const index = picked === undefined ? -1 : labels.indexOf(picked);
	const choice = prompt.choices[index];
	if (!choice) return undefined;
	const confirmed = await ctx.ui.confirm(
		AUTO_LAUNCH_CONFIRM_TITLE,
		`Start ${choice.label}${choice.recommended ? " (recommended)" : " (not the recommendation)"} with this task now?`,
	);
	return confirmed === true ? choice.candidateId : undefined;
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
		if (await openBoardFor(deps, args, ctx)) return;
		const outcome = await dispatch(deps, args, ctx);
		if (!("action" in outcome)) {
			emit(ctx, outcome.text, "info");
			return;
		}
		const data = outcome.data as
			| {
					stillRunning?: unknown;
					runId?: unknown;
					status?: unknown;
					launch?: { runId?: unknown; status?: unknown };
			  }
			| undefined;
		// WP32: an auto launch carries the run in `launch`.
		if (outcome.action === "auto")
			await trackLaunched(deps, ctx, "run", data?.launch, "command");
		else await trackLaunched(deps, ctx, outcome.action, data, "command");
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
 * WP34: `/aw` (no arguments) and `/aw <run-id-or-prefix>` open the board in the TUI. Returns false
 * (the text command runs) outside the TUI, for an action name, and for a token that is no run.
 */
async function openBoardFor(
	deps: PiHostDeps,
	args: string,
	ctx: PiExtensionContext,
): Promise<boolean> {
	if (!boardAvailable(ctx)) return false;
	const tokens = tokenizeWorkflowArgs(args).map((token) => token.text);
	let runId: string | undefined;
	if (tokens.length === 1) {
		const token = tokens[0]!;
		if (
			(AW_ACTIONS as readonly string[]).includes(token) ||
			token.startsWith("-")
		)
			return false;
		try {
			runId = (
				await deps.api.statusAction(hostContext(deps, ctx), { runId: token })
			).data.run?.runId;
		} catch {
			return false;
		}
		if (!runId) return false;
	} else if (tokens.length > 1) return false;
	const source = piBoardSource(deps, ctx, (action, data) =>
		trackLaunched(deps, ctx, action, data, "command"),
	);
	await showAwBoard(ctx, source, runId ? { initialRunId: runId } : {});
	return true;
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
	if (
		action !== "run" &&
		action !== "dynamic" &&
		action !== "resume" &&
		action !== "approve"
	)
		return;
	if (typeof data?.runId !== "string") return;
	const active = data.status === "running" || data.status === "pending";
	// WP39b (live bundle 5, O10): a run that settled inside the approve (or resume) call is
	// tracked too, so its completion message is delivered (exactly once: the delivery receipts).
	const settledHere =
		(action === "approve" || action === "resume") &&
		(data.status === "completed" ||
			data.status === "failed" ||
			data.status === "interrupted" ||
			data.status === "blocked");
	if (!active && !settledHere) return;
	await deps.feedback.track(ctx, data.runId, launchedBy).catch(() => undefined);
	// WP33: count the parent session's usage while the run runs (parent-usage.json).
	if (active) await beginRunParentUsage(ctx, data.runId);
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
