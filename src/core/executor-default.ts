// New in agent-workflow (WP17): the default executor when nothing selects one (owner decision
// "기본 실행기", 2026-10-27). Run flag, workflow-declared profile and saved user profile always win
// (B2, never second-guessed). Otherwise the host's own CLI is the default: Claude Code → `claude`,
// Codex → `codex`, Pi → `pi`. In the terminal CLI (host `cli`, also any caller that names no host)
// the default is the first installed and logged-in executor of `pi` → `claude` → `codex`, decided by
// each adapter's `probe()` (no model call): installed and auth not `missing`/`expired`; `unknown`
// counts as usable and stays visible on the run record. Nothing usable fails before any run record
// with each CLI's state and the exact install/login command (first-run guidance).
// WP19 (review #9): a positively verified candidate (installed, auth `ok`) wins over an earlier one
// whose auth is `unknown`: the order is walked until the first verified-ready candidate; only when
// none is verified does the first usable unknown-auth candidate win (`authUnverified`, with
// guidance in the launch text and in `doctor`).
//
// Probe results that are usable are cached per process for a short time (EXECUTOR_PROBE_CACHE_TTL_MS)
// so the selection probe and the capability negotiation probe of the same run share one CLI probe;
// unusable results and probe failures are never cached (a fresh login is seen on the next run).
// WP31: the saved per-workflow preference tier sits between the run flag and the declared profile.
import type { ExecutorCapabilities } from "../sdk/capabilities.js";
import type { AuthStatus, ExecutorProbe } from "../sdk/contract.js";
import { type ExecutorDescriptor, loadExecutor } from "../sdk/descriptor.js";
import type { ToolMapping } from "../sdk/tools.js";
import {
	resolveRunExecutorSelection,
	WorkflowExecutorUnavailableError,
	workflowExecutorRegistration,
} from "./executor-registry.js";
import type {
	WorkflowHostId,
	WorkflowRunExecutorCandidate,
	WorkflowRunExecutorSelection,
} from "./types.js";

export type { WorkflowHostId };

/** Host identities a host passes to the engine (the MCP server's `--host` flag, the Pi host, the CLI). */
export const WORKFLOW_HOST_IDS: readonly WorkflowHostId[] = [
	"claude-code",
	"codex",
	"pi",
	"cli",
	"generic",
];

/** The host's own CLI. The terminal CLI has none and uses INSTALLED_DEFAULT_ORDER. */
export const HOST_DEFAULT_EXECUTORS: Readonly<
	Record<Exclude<WorkflowHostId, "cli" | "generic">, string>
> = {
	"claude-code": "claude",
	codex: "codex",
	pi: "pi",
};

/** Terminal CLI order: the first installed and logged-in executor wins. */
export const INSTALLED_DEFAULT_ORDER = ["pi", "claude", "codex"] as const;

/** Bound of one readiness probe (version/auth/status commands only). */
export const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 30_000;
/** How long a usable probe result is reused within one process. */
export const EXECUTOR_PROBE_CACHE_TTL_MS = 60_000;

/** Probe seam (same shape as the engine's `executorProber`). */
export type ExecutorReadinessProber = (
	descriptor: ExecutorDescriptor,
) => Promise<{
	probe: ExecutorProbe;
	capabilities: ExecutorCapabilities;
	toolMapping?: ToolMapping;
}>;

export function isWorkflowHostId(value: unknown): value is WorkflowHostId {
	return (
		typeof value === "string" &&
		(WORKFLOW_HOST_IDS as readonly string[]).includes(value)
	);
}

export interface ExecutorSetupHints {
	/** CLI name. */
	cli: string;
	/**
	 * Command that installs the CLI; null when only the install doc is named (Pi: its package scope
	 * must not appear in Pi-free code, so the command lives in docs/usage.md).
	 */
	install: string | null;
	/** Where the install is documented (placeholder until the public install docs exist). */
	installDoc: string;
	/** How to log the CLI in, as a phrase (D1: the CLI owns its login). */
	login: string;
	/** Command that shows the CLI is runnable. */
	check: string;
}

const SETUP_HINTS: Readonly<Record<string, ExecutorSetupHints>> = {
	pi: {
		cli: "pi",
		install: null,
		installDoc: "docs/usage.md#executors",
		login: "run `pi`, then `/login`",
		check: "pi --version",
	},
	claude: {
		cli: "claude",
		install: "npm i -g @anthropic-ai/claude-code",
		installDoc: "docs/usage.md#executors",
		login: "run `claude auth login`",
		check: "claude --version",
	},
	codex: {
		cli: "codex",
		install: "npm i -g @openai/codex",
		installDoc: "docs/usage.md#executors",
		login: "run `codex login`",
		check: "codex --version",
	},
	antigravity: {
		cli: "agy_acp_server",
		install: null,
		installDoc: "docs/executors/acp.md",
		login:
			'sign the Antigravity worker home in to Google once (docs/executors/acp.md, "Antigravity preset")',
		check:
			"agy_acp_server on PATH or AGENT_WORKFLOW_AGY_ACP_SERVER (ACP initialize)",
	},
};

/** Install/login commands for an executor id (generic wording for registered executors). */
export function executorSetupHints(executorId: string): ExecutorSetupHints {
	return (
		SETUP_HINTS[executorId] ?? {
			cli: executorId,
			install: null,
			installDoc: "docs/usage.md#executors",
			login: `log in with the ${executorId} CLI`,
			check: `the ${executorId} CLI's version command`,
		}
	);
}

export type ExecutorReadinessState =
	| "ready"
	| "auth-unknown"
	| "not-installed"
	| "logged-out"
	| "probe-failed"
	| "unavailable";

/** Non-secret readiness of one executor (probe summary + derived state). */
export interface ExecutorReadiness extends WorkflowRunExecutorCandidate {
	state: ExecutorReadinessState;
	/** Probe notes (version drift, environment warnings); never secrets. */
	notes: string[];
	/** Tools the executor cannot provide here, with why and how to fix it (probe). */
	unavailableTools?: Record<string, string>;
	/** Probe failure or registry reason. */
	error?: string;
}

/** Usable = installed and auth not `missing`/`expired` (`unknown` is usable). */
export function probeIsUsable(probe: {
	installed: boolean;
	auth: AuthStatus;
}): boolean {
	return (
		probe.installed === true &&
		probe.auth !== "missing" &&
		probe.auth !== "expired"
	);
}

/** One line telling how to fix a not-usable executor (empty for a usable one). */
export function readinessFixHint(readiness: {
	id: string;
	state: ExecutorReadinessState;
}): string {
	const hints = executorSetupHints(readiness.id);
	if (readiness.state === "not-installed" || readiness.state === "probe-failed")
		return `install: ${installText(hints)}, check with \`${hints.check}\``;
	if (readiness.state === "logged-out") return `log in: ${hints.login}`;
	return "";
}

/** "`npm i -g …` (see doc)" or, without a known command, "see doc". */
export function installText(hints: ExecutorSetupHints): string {
	return hints.install === null
		? `see ${hints.installDoc}`
		: `\`${hints.install}\` (see ${hints.installDoc})`;
}

interface CacheEntry {
	at: number;
	value: Promise<{ probe: ExecutorProbe; capabilities: ExecutorCapabilities }>;
}

const probeCache = new Map<string, CacheEntry>();
let cacheNow: () => number = Date.now;

function cacheKey(descriptor: ExecutorDescriptor): string {
	return JSON.stringify([
		descriptor.id,
		descriptor.version,
		descriptor.module,
		descriptor.config ?? null,
	]);
}

/** Drop cached probes (after the environment changed, e.g. `doctor --fix`). */
export function clearExecutorProbeCache(): void {
	probeCache.clear();
}

/** Test seam: drop cached probes and (optionally) replace the cache clock. */
export function resetExecutorProbeCacheForTests(now?: () => number): void {
	probeCache.clear();
	cacheNow = now ?? Date.now;
}

/**
 * Real prober (`loadExecutor(descriptor)` + `probe()`), cached per process: a usable result is
 * reused for EXECUTOR_PROBE_CACHE_TTL_MS; unusable results and failures are dropped at once.
 */
export const cachedExecutorProber: ExecutorReadinessProber = (descriptor) => {
	const key = cacheKey(descriptor);
	const hit = probeCache.get(key);
	if (hit !== undefined && cacheNow() - hit.at < EXECUTOR_PROBE_CACHE_TTL_MS)
		return hit.value;
	const value = (async () => {
		const executor = await loadExecutor(descriptor);
		return {
			capabilities: executor.capabilities(),
			probe: await executor.probe(),
			// The pre-launch tool check (capability negotiation) uses the adapter's mapping.
			...(executor.toolMapping === undefined
				? {}
				: { toolMapping: executor.toolMapping }),
		};
	})();
	const entry: CacheEntry = { at: cacheNow(), value };
	probeCache.set(key, entry);
	value.then(
		(result) => {
			if (!probeIsUsable(result.probe) && probeCache.get(key) === entry)
				probeCache.delete(key);
		},
		() => {
			if (probeCache.get(key) === entry) probeCache.delete(key);
		},
	);
	return value;
};

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`probe did not finish within ${timeoutMs} ms`)),
				timeoutMs,
			);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}

/** Probe one executor id (no model call) and classify it. Never throws. */
export async function probeExecutorReadiness(
	executorId: string,
	options: { prober?: ExecutorReadinessProber; timeoutMs?: number } = {},
): Promise<ExecutorReadiness> {
	const base = { id: executorId, installed: false, cliVersion: null };
	const registration = workflowExecutorRegistration(executorId);
	if (registration?.descriptor === undefined)
		return {
			...base,
			auth: "unknown",
			usable: false,
			state: "unavailable",
			notes: [],
			error:
				registration?.unavailableReason ??
				`executor "${executorId}" is unknown`,
		};
	try {
		const { probe } = await withTimeout(
			(options.prober ?? cachedExecutorProber)(registration.descriptor),
			options.timeoutMs ?? DEFAULT_READINESS_PROBE_TIMEOUT_MS,
		);
		const installed = probe.installed === true;
		const auth: AuthStatus = probe.auth;
		const usable = probeIsUsable({ installed, auth });
		const state: ExecutorReadinessState = !installed
			? "not-installed"
			: !usable
				? "logged-out"
				: auth === "unknown"
					? "auth-unknown"
					: "ready";
		return {
			id: executorId,
			installed,
			cliVersion:
				typeof probe.cliVersion === "string" ? probe.cliVersion : null,
			auth,
			usable,
			state,
			notes: (probe.notes ?? [])
				.filter((note): note is string => typeof note === "string")
				.map((note) => note.slice(0, 500)),
			...(probe.unavailableTools === undefined ||
			Object.keys(probe.unavailableTools).length === 0
				? {}
				: { unavailableTools: { ...probe.unavailableTools } }),
		};
	} catch (error) {
		return {
			...base,
			auth: "unknown",
			usable: false,
			state: "probe-failed",
			notes: [],
			error: (error instanceof Error ? error.message : String(error)).slice(
				0,
				500,
			),
		};
	}
}

function describeReadiness(readiness: ExecutorReadiness): string {
	const what =
		readiness.state === "not-installed"
			? "not installed"
			: readiness.state === "probe-failed"
				? `probe failed (${readiness.error ?? "unknown error"})`
				: readiness.state === "logged-out"
					? `installed${readiness.cliVersion ? ` (${readiness.cliVersion})` : ""}, not logged in (auth ${readiness.auth})`
					: readiness.state === "unavailable"
						? `unavailable (${readiness.error ?? "no adapter"})`
						: `usable (auth ${readiness.auth})`;
	const fix = readinessFixHint(readiness);
	return `  - ${readiness.id}: ${what}${fix ? `; ${fix}` : ""}`;
}

/** The "nothing usable" message: every CLI's state and the exact install/login command. */
export function noUsableExecutorMessage(
	candidates: readonly ExecutorReadiness[],
): string {
	return [
		`no executor is usable: agent-workflow needs one of ${INSTALLED_DEFAULT_ORDER.join(", ")} installed and logged in (checked in this order). The run was not started.`,
		...candidates.map(describeReadiness),
		"Then start the run again, or choose one explicitly with --executor <id>. `agent-workflow doctor` shows the details.",
	].join("\n");
}

export interface HostDefaultExecutor {
	id: string;
	source: "host-default" | "installed-default";
	host?: WorkflowHostId;
	/** Terminal order: what each probed candidate looked like (non-secret). */
	candidates?: WorkflowRunExecutorCandidate[];
	/** Full readiness of each probed candidate (doctor output; not recorded). */
	readiness?: ExecutorReadiness[];
	/** WP19: no candidate had a verified login; the chosen one's auth is `unknown`. */
	authUnverified?: true;
}

/**
 * The lowest-precedence default for a host. Hosts other than `cli` name their own CLI without a
 * probe (the capability negotiation probe then fails with the install/login command when it is
 * not ready). `cli` (or no host) probes `pi` → `claude` → `codex` and takes the first usable one;
 * when none is usable it throws WorkflowExecutorUnavailableError (source `installed-default`).
 */
export async function resolveHostDefaultExecutor(
	input: {
		host?: WorkflowHostId;
		prober?: ExecutorReadinessProber;
		probeTimeoutMs?: number;
		/** Probe every candidate even after a usable one (doctor). */
		probeAll?: boolean;
	} = {},
): Promise<HostDefaultExecutor> {
	const host = input.host;
	if (host !== undefined && host !== "cli" && host !== "generic")
		return { id: HOST_DEFAULT_EXECUTORS[host], source: "host-default", host };
	const readiness: ExecutorReadiness[] = [];
	let ready: ExecutorReadiness | undefined;
	let firstUsable: ExecutorReadiness | undefined;
	for (const id of INSTALLED_DEFAULT_ORDER) {
		// WP19: keep probing past an unknown-auth candidate until one is verified ready.
		if (ready !== undefined && input.probeAll !== true) break;
		const probed = await probeExecutorReadiness(id, {
			...(input.prober === undefined ? {} : { prober: input.prober }),
			...(input.probeTimeoutMs === undefined
				? {}
				: { timeoutMs: input.probeTimeoutMs }),
		});
		readiness.push(probed);
		if (ready === undefined && probed.state === "ready") ready = probed;
		if (firstUsable === undefined && probed.usable) firstUsable = probed;
	}
	const chosen = ready ?? firstUsable;
	const candidates = readiness.map(candidateSummary);
	if (chosen === undefined)
		throw new WorkflowExecutorUnavailableError(
			noUsableExecutorMessage(readiness),
			"",
			"installed-default",
		);
	return {
		id: chosen.id,
		source: "installed-default",
		...(host === undefined ? {} : { host }),
		candidates,
		readiness,
		...(ready === undefined ? { authUnverified: true as const } : {}),
	};
}

/**
 * WP19: guidance when the installed default had to fall back to an unknown-auth candidate (no
 * installed CLI reported a verified login).
 */
export function unverifiedDefaultGuidance(executorId: string): string {
	const hints = executorSetupHints(executorId);
	return `Note: ${executorId} was chosen as the default executor although its login could not be verified (no installed CLI of ${INSTALLED_DEFAULT_ORDER.join(" → ")} reported a verified login). If the run fails to authenticate, log in (${hints.login}) or choose an executor with --executor <id>; \`agent-workflow doctor\` shows each CLI's state.`;
}

function candidateSummary(
	readiness: ExecutorReadiness,
): WorkflowRunExecutorCandidate {
	return {
		id: readiness.id,
		installed: readiness.installed,
		cliVersion: readiness.cliVersion,
		auth: readiness.auth,
		usable: readiness.usable,
	};
}

export interface ResolveRunExecutorInput {
	runFlag?: string;
	/** WP31: saved per-workflow preference (role `default` executor), below the run flag. */
	workflowPreferenceName?: string;
	workflowPreferenceExecutor?: string;
	workflowProfileName?: string;
	workflowProfileExecutor?: string;
	userProfileName?: string;
	userProfileExecutor?: string;
	/** Explicit host override of the default (HostApiContext.defaultExecutor); source `default`. */
	defaultExecutor?: string;
	/** Host identity; absent = terminal/library rule (`installed-default`). */
	host?: WorkflowHostId;
	prober?: ExecutorReadinessProber;
	probeTimeoutMs?: number;
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== "";
}

/**
 * B2 precedence with the WP17 default: run flag > workflow-declared profile > saved user profile >
 * host override (`defaultExecutor`) > host default. Explicit selections are resolved exactly as
 * before (unknown/unavailable ids fail, never a fallback); only when none is present is the host
 * default computed (and, for the terminal CLI, probed).
 */
export async function resolveRunExecutorForHost(
	input: ResolveRunExecutorInput,
): Promise<WorkflowRunExecutorSelection> {
	const explicit = {
		...(present(input.runFlag) ? { runFlag: input.runFlag } : {}),
		...(present(input.workflowPreferenceExecutor)
			? {
					workflowPreferenceName: input.workflowPreferenceName,
					workflowPreferenceExecutor: input.workflowPreferenceExecutor,
				}
			: {}),
		...(present(input.workflowProfileExecutor)
			? {
					workflowProfileName: input.workflowProfileName,
					workflowProfileExecutor: input.workflowProfileExecutor,
				}
			: {}),
		...(present(input.userProfileExecutor)
			? {
					userProfileName: input.userProfileName,
					userProfileExecutor: input.userProfileExecutor,
				}
			: {}),
		...(present(input.defaultExecutor)
			? { defaultExecutor: input.defaultExecutor }
			: {}),
	};
	if (Object.keys(explicit).length > 0)
		return resolveRunExecutorSelection(explicit);
	const chosen = await resolveHostDefaultExecutor({
		...(input.host === undefined ? {} : { host: input.host }),
		...(input.prober === undefined ? {} : { prober: input.prober }),
		...(input.probeTimeoutMs === undefined
			? {}
			: { probeTimeoutMs: input.probeTimeoutMs }),
	});
	return resolveRunExecutorSelection({
		defaultExecutor: chosen.id,
		defaultSource: chosen.source,
		...(chosen.host === undefined ? {} : { host: chosen.host }),
		...(chosen.candidates === undefined
			? {}
			: { candidates: chosen.candidates }),
	});
}
