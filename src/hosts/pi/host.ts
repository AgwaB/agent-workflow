// New in agent-workflow (WP11b): shared plumbing of the Pi host. Every `/aw` action and `aw_*` tool
// calls one host API handler (../api.ts) with a HostApiContext built from the Pi context: the
// project cwd, the Pi model registry (`availableModels`, so per-workflow Pi profile preferences are
// consulted) and Pi's current model/thinking level as the lowest-precedence runtime defaults.
// Interactive launches use Pi's extension UI (`ctx.ui.confirm` / `ctx.ui.select`) when the session
// has a dialog-capable UI (TUI or RPC); otherwise launches are non-interactive (degradations are
// recorded and the run proceeds, as in the CLI with --yes).
import * as hostApi from "../api.js";
import type { HostApiContext, HostOutcome, LaunchRequestBase } from "../api.js";
import { toWorkflowModelInfo } from "../../core/workflow-runtime.js";
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
	| "registerTestExecutorFromEnv"
>;

export interface PiHostOptions {
	/** Host API implementation (default: `@agwab/agent-workflow/hosts/api`). */
	api?: PiHostApi;
	/** Environment for role checks, the user home and the test-executor hook (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Clock for unfinished-run notices (tests). */
	now?: () => number;
}

export interface PiHostDeps {
	api: PiHostApi;
	env: NodeJS.ProcessEnv;
	now: () => number;
	/** Resolves once the guarded test-executor hook ran (a no-op unless its env is set). */
	ready: () => Promise<void>;
	pi: PiExtensionApi;
}

export function createPiHostDeps(
	pi: PiExtensionApi,
	options: PiHostOptions = {},
): PiHostDeps {
	const api = options.api ?? hostApi;
	const env = options.env ?? process.env;
	let registration: Promise<void> | undefined;
	return {
		api,
		env,
		now: options.now ?? Date.now,
		pi,
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
	return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
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
 * Host context of one call. Pi's current model is a runtime default for Pi workers only: when the
 * caller selects another executor (`--executor codex`), the Pi model is not passed on.
 */
export function hostContext(
	deps: PiHostDeps,
	ctx: PiExtensionContext,
	launch: { executor?: string } = {},
): HostApiContext {
	const models = availableModels(ctx);
	const runtimeDefaults =
		launch.executor === undefined || launch.executor === "pi"
			? currentRuntimeDefaults(ctx, deps.pi)
			: undefined;
	return {
		cwd: ctx.cwd,
		env: deps.env,
		...(models ? { availableModels: models } : {}),
		...(runtimeDefaults ? { runtimeDefaults } : {}),
	};
}

export const DEGRADATION_CONFIRM_TITLE =
	"Proceed with these executor capability degradations?";

/** WP4d confirmation and the declared-profile chooser through Pi's extension UI, when present. */
export function interactiveLaunchHooks(
	ctx: PiExtensionContext,
): Pick<
	LaunchRequestBase,
	"interactive" | "confirmDegradations" | "selectProfile"
> {
	if (!ctx.hasUI) return {};
	return {
		interactive: true,
		confirmDegradations: async (preview) =>
			(await ctx.ui.confirm(DEGRADATION_CONFIRM_TITLE, preview.text)) === true,
		selectProfile: (title, options) => ctx.ui.select(title, options),
	};
}

export function levelForOutcome(outcome: HostOutcome): PiNotifyLevel {
	if (outcome === "success" || outcome === "completed") return "info";
	if (outcome === "running" || outcome === "blocked" || outcome === "refused")
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
 * Core formatters (ported from pi-workflow) print `/workflow …` hints. In Pi, `/workflow` is
 * pi-workflow's command (its own run store), so the Pi host points them at `/aw`; there is no board,
 * so `/workflow <run>` becomes `/aw status <run>` and `/workflow logs <run> …` becomes
 * `/aw inspect <run> --results`. Everything else in the handler text is unchanged.
 */
export function piHostText(text: string): string {
	return text
		.replace(
			/\/workflow logs ([A-Za-z0-9_-]+)(?: <task-or-spec-id>| [\w.:-]+)?/g,
			"/aw inspect $1 --results",
		)
		.replace(/\/workflow (workflow_[A-Za-z0-9_-]+)/g, "/aw status $1")
		.replace(
			/\/workflow (help|list|validate|roles|agents|profile|run|dynamic|status|show|inspect|wait|resume|stop|prune|notices)\b/g,
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
