// New in agent-workflow (WP11b): shared plumbing of the Pi host. Every `/aw` action and `aw_*` tool
// calls one host API handler (../api.ts) with a HostApiContext built from the Pi context: the
// project cwd, the Pi model registry (`availableModels`, so per-workflow Pi profile preferences are
// consulted) and Pi's current model/thinking level as the lowest-precedence runtime defaults.
// Interactive launches use Pi's extension UI (`ctx.ui.confirm` / `ctx.ui.select`) when the session
// has a dialog-capable UI (TUI or RPC); otherwise launches are non-interactive (degradations are
// recorded and the run proceeds, as in the CLI with --yes). WP16: without a dialog UI, a declared
// profile choice falls back to text (the headless choice is made and the choices are listed with
// `--profile`), and `deps.feedback` carries the status line and completion delivery (feedback.ts).
// WP35: a native codemode/MCP Pi session lends its host tools to Pi workers (piNativeHostTools).
import * as hostApi from "../api.js";
import type { HostApiContext, HostOutcome, LaunchRequestBase } from "../api.js";
import { toWorkflowModelInfo } from "../../core/workflow-runtime.js";
import { PiRunFeedback } from "./feedback.js";
import type {
	PiExtensionApi,
	PiExtensionContext,
	PiNotifyLevel,
} from "./pi-types.js";

/** The host API surface the Pi host calls (tests pass a recording wrapper). */
export type PiHostApi = Pick<
	typeof hostApi,
	| "helpAction"
	| "listWorkflowsAction"
	| "validateWorkflowAction"
	| "workflowRolesAction"
	| "listAgentsAction"
	| "profileAction"
	| "runWorkflowAction"
	| "runDynamicAction"
	| "statusAction"
	| "showAction"
	| "inspectAction"
	| "waitAction"
	| "resumeAction"
	| "stopAction"
	| "pruneAction"
	| "noticesAction"
	| "logsAction"
	| "registerTestExecutorFromEnv"
>;

export interface PiHostOptions {
	/** Host API implementation (default: `@agwab/agent-workflow/hosts/api`). */
	api?: PiHostApi;
	/** Environment for role checks, the user home and the test-executor hook (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Clock for unfinished-run notices (tests). */
	now?: () => number;
	/** Status-line/delivery poll interval (tests; capped at 1 s). */
	feedbackPollMs?: number;
}

export interface PiHostDeps {
	api: PiHostApi;
	env: NodeJS.ProcessEnv;
	now: () => number;
	/** Resolves once the guarded test-executor hook ran (a no-op unless its env is set). */
	ready: () => Promise<void>;
	pi: PiExtensionApi;
	/** WP16: status line and completion delivery of runs this session launched. */
	feedback: PiRunFeedback;
}

export function createPiHostDeps(
	pi: PiExtensionApi,
	options: PiHostOptions = {},
): PiHostDeps {
	const api = options.api ?? hostApi;
	const env = options.env ?? process.env;
	let registration: Promise<void> | undefined;
	const now = options.now ?? Date.now;
	return {
		api,
		env,
		now,
		pi,
		feedback: new PiRunFeedback(pi, {
			now,
			...(options.feedbackPollMs ? { pollMs: options.feedbackPollMs } : {}),
		}),
		// AGENT_WORKFLOW_TEST_EXECUTOR_MODULE + ACK=test-only (WP11a hook): registers a `test-*`
		// executor that a run must still select with `--executor`. Never set in production.
		ready: () => {
			registration ??= api
				.registerTestExecutorFromEnv(env)
				.then(() => undefined);
			return registration;
		},
	};
}

function currentRuntimeDefaults(
	ctx: PiExtensionContext,
	pi: PiExtensionApi,
): HostApiContext["runtimeDefaults"] {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const rawThinking = pi.getThinkingLevel?.();
	const thinking = hostApi.isThinkingLevel(rawThinking)
		? rawThinking
		: undefined;
	if (!model && !thinking) return undefined;
	// Tagged so the engine applies them only when the run's executor is pi (profiles may pick another).
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		executor: "pi",
	};
}

function availableModels(
	ctx: PiExtensionContext,
): HostApiContext["availableModels"] {
	const registry = ctx.modelRegistry;
	if (typeof registry?.getAvailable !== "function") return undefined;
	try {
		return registry
			.getAvailable()
			.map((model) =>
				toWorkflowModelInfo(model as Parameters<typeof toWorkflowModelInfo>[0]),
			);
	} catch {
		return undefined;
	}
}

/**
 * WP35 (row 40): Pi's native host tools, captured like pi-workflow's native host context: a Pi 1.1
 * session with native MCP (`pi.getMcpServers`) and project trust (`ctx.isProjectTrusted`) lends
 * codemode, tool_search, `mcp__*` and the MCP resource tools to Pi workers. Older Pi hosts lend
 * nothing (their launches are unchanged).
 */
export function piNativeHostTools(
	pi: PiExtensionApi,
	ctx: PiExtensionContext,
): HostApiContext["hostTools"] {
	if (
		typeof pi.getMcpServers !== "function" ||
		typeof ctx.isProjectTrusted !== "function"
	)
		return undefined;
	try {
		return { projectTrusted: ctx.isProjectTrusted() === true };
	} catch {
		return undefined;
	}
}

/**
 * Host context of one call. Pi's current model is a runtime default for Pi workers only: when the
 * caller selects another executor (`--executor codex`), the Pi model is not passed on.
 */
export function hostContext(
	deps: PiHostDeps,
	ctx: PiExtensionContext,
	launch: { executor?: string } = {},
): HostApiContext {
	const models = availableModels(ctx);
	const hostTools = piNativeHostTools(deps.pi, ctx);
	const runtimeDefaults =
		launch.executor === undefined || launch.executor === "pi"
			? currentRuntimeDefaults(ctx, deps.pi)
			: undefined;
	return {
		cwd: ctx.cwd,
		env: deps.env,
		// WP17: the Pi host's own CLI (`pi`) is the default executor when nothing selects one.
		host: "pi",
		...(models ? { availableModels: models } : {}),
		...(runtimeDefaults ? { runtimeDefaults } : {}),
		...(hostTools ? { hostTools } : {}),
	};
}

export const DEGRADATION_CONFIRM_TITLE =
	"Proceed with these executor capability degradations?";

export const PROFILE_TEXT_FALLBACK_NOTE = "Execution profile (no dialog UI):";

export interface PiLaunchHooks {
	hooks: Pick<
		LaunchRequestBase,
		"interactive" | "confirmDegradations" | "selectProfile"
	>;
	/** Text-fallback note after a launch without a dialog UI that offered a profile choice. */
	note(): string | undefined;
}

/**
 * WP4d confirmation and the declared-profile chooser through Pi's extension UI, when present
 * (`ctx.ui.select`). Without a dialog UI (print/JSON mode) the chooser falls back to text: the
 * headless choice (the declared default, else the base spec) is made and the launch output lists
 * every choice with the `--profile` value that selects it.
 */
export function launchHooks(ctx: PiExtensionContext): PiLaunchHooks {
	if (ctx.hasUI)
		return {
			hooks: {
				interactive: true,
				confirmDegradations: async (preview) =>
					(await ctx.ui.confirm(DEGRADATION_CONFIRM_TITLE, preview.text)) ===
					true,
				selectProfile: (title, options) => ctx.ui.select(title, options),
			},
			note: () => undefined,
		};
	let offered: { options: string[]; chosen: string } | undefined;
	return {
		hooks: {
			selectProfile: async (_title, options, meta) => {
				const chosen = meta?.headlessOption ?? options[0]!;
				offered = { options, chosen };
				return chosen;
			},
		},
		note: () => {
			if (!offered) return undefined;
			const choices = offered.options.map((option) => {
				const name = option.startsWith("Profile: ")
					? option.slice("Profile: ".length)
					: undefined;
				const marker = option === offered!.chosen ? " (used)" : "";
				return name ? `  --profile ${name}${marker}` : `  ${option}${marker}`;
			});
			return [
				`${PROFILE_TEXT_FALLBACK_NOTE} the workflow declares execution profiles; this launch used "${offered.chosen}". Choose another with:`,
				...choices,
			].join("\n");
		},
	};
}

export function levelForOutcome(outcome: HostOutcome): PiNotifyLevel {
	if (outcome === "success" || outcome === "completed") return "info";
	if (
		outcome === "running" ||
		outcome === "blocked" ||
		outcome === "refused" ||
		outcome === "existing"
	)
		return "warning";
	return "error";
}

function printMode(ctx: PiExtensionContext): boolean {
	return (
		ctx.mode === "print" ||
		process.argv.includes("--print") ||
		process.argv.includes("-p")
	);
}

/**
 * WP18b: run texts already carry `/aw …` hints (the Pi host passes `host: "pi"`, the host API picks
 * the hints; src/hosts/hints.ts). This remains a fallback for the few ported core messages that
 * still name pi-workflow's `/workflow …` (auto/profile/usage texts): in Pi, `/workflow` is
 * pi-workflow's command (its own run store), so they point at `/aw`; `/workflow <run>` becomes
 * `/aw status <run>` and `/workflow logs <run> [task]` becomes `/aw logs <run> [--task <task>]`.
 */
export function piHostText(text: string): string {
	return text
		.replace(
			/\/workflow logs ([A-Za-z0-9_-]+)(?: <task-or-spec-id>| ([\w.:-]+))?/g,
			(_match, runId: string, task: string | undefined) =>
				task ? `/aw logs ${runId} --task ${task}` : `/aw logs ${runId}`,
		)
		.replace(/\/workflow (workflow_[A-Za-z0-9_-]+)/g, "/aw status $1")
		.replace(
			/\/workflow (help|list|validate|roles|agents|profile|run|dynamic|status|show|inspect|logs|wait|resume|stop|prune|notices)\b/g,
			"/aw $1",
		);
}

/** Command output: a Pi notification with a UI, else stdout/stderr (print/json mode). */
export function emit(
	ctx: PiExtensionContext,
	text: string,
	level: PiNotifyLevel,
): void {
	const shown = piHostText(text);
	if (ctx.hasUI && !printMode(ctx)) {
		ctx.ui.notify(shown, level);
		return;
	}
	(level === "error" ? process.stderr : process.stdout).write(`${shown}\n`);
}
