// Pi executor using pi --mode json --print in its own process group.
// Consume authority immediately before spawn; attempts are idempotent by attemptKey
// with durable launch evidence. Save raw streams under artifactsDir.
// Cancellation sends SIGTERM, then SIGKILL.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveWorkflowFastModeConfig } from "../../core/fast-tier.js";
import { agentWorkflowHome } from "../../core/home-dir.js";
import { durableWorkerBindingEnv } from "../../runtime/durable-authority.js";
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../runtime/process-identity.js";
import { DURABLE_WORKER_BINDING_ENV } from "../../runtime/workers/durable-worker-binding.js";
import { requireReleased } from "../../sdk/authority.js";
import { type ExecutorCapabilities, level } from "../../sdk/capabilities.js";
import {
	type ApprovalResponseResult,
	type CancelResult,
	type CancelScope,
	type DeleteOwnedSessionResult,
	EXECUTOR_CONTRACT_VERSION,
	type ExecRef,
	type ExecutorProbe,
	type ReconcileResult,
	type SubmitRequest,
	validateSubmitRequest,
	type WorkflowExecutor,
} from "../../sdk/contract.js";
import { SdkError } from "../../sdk/errors.js";
import type { ExecEvent, OwnedSession } from "../../sdk/events.js";
import type { JsonValue } from "../../sdk/json.js";
import { enforcesReadOnly } from "../../sdk/permission.js";
import { mapTools } from "../../sdk/tools.js";
import {
	ARTIFACT_SERVER,
	buildPiArgv,
	INHERITED_HOST_TOOLS,
	PI_EFFORT_LEVELS,
	PI_EXECUTOR_TOOL_MAPPING,
	PI_WEB_TOOLS,
	piMcpServerPattern,
	piMcpToolName,
	readOnlyTools,
} from "./argv.js";
import { type PiExecutorConfig, parsePiExecutorConfig } from "./config.js";
import { PiEventNormalizer, PiJsonlSplitter } from "./parse.js";
import {
	PI_FAST_TIER_STATE_FILE,
	PI_PARENT_WATCH_FD,
	PI_RUN_SECRETS_ENV,
	type PiFastTierState,
	type PiRunConfig,
	piRunExtensionSource,
} from "./run-extension.js";
import {
	attemptDigest,
	type PiAttemptExit,
	type PiAttemptLookup,
	type PiAttemptRecord,
	PiAttemptStore,
	classifyPiAttemptRecord,
} from "./state.js";
import { schedulePeriodicAdapterStatePrune } from "../state-retention.js";
import { TOOL_RESULT_BUDGET_STATE_FILENAME } from "./tool-result-budget.js";
import {
	createSecretRedactor,
	requestSecrets,
	type SecretRedactor,
} from "../redact.js";

import { PI_EXECUTOR_ID, PI_EXECUTOR_VERSION } from "./version.js";
import {
	listPiWebSessionTools,
	piWebToolUnavailableGuidance,
} from "./web-tools.js";

export { PI_EXECUTOR_ID, PI_EXECUTOR_VERSION };
/** Pi version the adapter was built and verified against (A2-4 native MCP needs 1.1). */
export const PI_MIN_CLI_VERSION = "1.1.0";
/** Pi 1.1 cuts MCP text results above 20 KiB (`MCP_OUTPUT_MAX_BYTES`, measured live, docs/executors.md#pi). */
export const PI_MCP_OUTPUT_LIMIT_CHARS = 20 * 1024;
/**
 * Upper bound of what Pi adds around a cut MCP result: "Warning: truncated output (…)" header,
 * `…N chars truncated…` marker and "[Full output: <temp file> (read it with offset/limit)]" footer
 * (≈ 220 chars measured, plus the temp path length).
 */
export const PI_MCP_OUTPUT_NOTICE_CHARS = 1024;
/** Evidence string for capability rows proven against a live Pi (live-calls.md). */
export const PI_VERIFIED_WITH = "pi 1.1.0, WP6 live runs 2026-10-26";
/** Rows proven offline with the real Pi CLI and a scripted (faux) provider: no model turn. */
export const PI_VERIFIED_OFFLINE =
	"pi 1.1.0, faux provider (no model call), WP6 2026-10-26";

export const PI_RAW_STDOUT = "pi-stdout.jsonl";
export const PI_RAW_STDERR = "pi-stderr.log";
export const PI_EXTENSION_FILE = "pi-extension.mjs";
export const PI_SYSTEM_PROMPT_FILE = "pi-system-prompt.md";
export const PI_MCP_LOG_FILE = "pi-mcp.log";
export const PI_SESSION_KIND = "pi-session-dir";

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const STDERR_LIMIT = 256 * 1024;
// Live bundle 5 (WP39): `pi --list-models` took 4.2–5.4 s and a cold `pi list` 4.1 s on a loaded
// machine (Pi 1.1.0 with the user's packages); the former 4 s bound turned both into failures
// (auth "unknown", pi-web-access "could not check" → web stages refused). These are read-only
// commands without a model call, so the bound only stops a hung CLI. 2026-11-01: 10.6 s on a busy
// machine and several runs probing at once crossed 15 s; the model list was then missing, a bare id
// such as "gpt-6-luna" reached Pi unresolved and Pi refused it as ambiguous across providers.
const PROBE_TIMEOUT_MS = 30_000;
const REDACT_MIN_CHARS = 6;

export interface PiExecutorProbe extends ExecutorProbe {
	/** `provider/id` from `pi --list-models` (no model turn); null when not listable. */
	readonly models: readonly string[] | null;
	/** `pi-web-access` package found through `pi list` (C2), or null. */
	readonly webAccessExtension: string | null;
}

/** Declared capability table (docs/executors.md#pi lists the evidence for every row). */
export function piCapabilities(): ExecutorCapabilities {
	const live = (name: "native" | "emulated") =>
		level(name, "probed", PI_VERIFIED_WITH);
	return {
		toolLoop: "agent",
		context: "agent",
		// The attempt is bound to the process that owns Pi's stdout pipe: a fresh process can
		// reconcile it (`found`) but cannot attach to a still-running Pi.
		sessionBound: true,
		mcpInjection: live("native"),
		// Pi has no sandbox; readOnly = an allowlist without mutating tools (bash/edit/write).
		readOnly: live("emulated"),
		toolAllowlist: { ...live("native"), detail: "fine" },
		systemPrompt: {
			...level("native", "probed", PI_VERIFIED_OFFLINE),
			detail: "replace",
		},
		modelSelect: live("native"),
		effortLevels: [...PI_EFFORT_LEVELS],
		resume: { ...live("native"), detail: "native" },
		partialStream: live("native"),
		usage: { ...live("native"), detail: "cost" },
		toolTelemetry: live("native"),
		cancel: { ...live("native"), detail: "kill" },
		nativeSchema: level("none"),
		contextIsolation: live("native"),
		fastTier: level("native", "unverified"),
		toolResultBudget: level("native", "probed", PI_VERIFIED_OFFLINE),
		webTools: {
			...level("native", "unverified"),
			detail: "search+fetch",
			safetyPolicy: "unknown",
		},
	};
}

interface LiveRun {
	readonly ref: ExecRef;
	readonly log: ExecEvent[];
	done: boolean;
	readonly waiters: (() => void)[];
	readonly child: ChildProcess;
	cancelled: boolean;
	killTimer?: ReturnType<typeof setTimeout>;
}

/** Process-global: a restarted executor instance in the same process sees the running attempt. */
const LIVE_RUNS = new Map<string, LiveRun>();
const INFLIGHT = new Map<string, Promise<ExecRef>>();

function sdkInvalid(message: string): never {
	throw new SdkError("INVALID_REQUEST", message);
}

function versionAtLeast(actual: string, minimum: string): boolean {
	const parse = (value: string) =>
		/^(\d+)\.(\d+)\.(\d+)/u.exec(value)?.slice(1).map(Number);
	const a = parse(actual);
	const b = parse(minimum);
	if (a === undefined || b === undefined) return false;
	for (let index = 0; index < 3; index += 1)
		if ((a[index] ?? 0) !== (b[index] ?? 0))
			return (a[index] ?? 0) > (b[index] ?? 0);
	return true;
}

function runCli(
	command: string,
	args: readonly string[],
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		execFile(
			command,
			[...args],
			{
				timeout: timeoutMs,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			},
			(error, stdout, stderr) => {
				const code =
					error === null
						? 0
						: typeof (error as { code?: unknown }).code === "number"
							? ((error as { code: number }).code as number)
							: null;
				resolvePromise({
					code,
					stdout: String(stdout),
					stderr: String(stderr),
				});
			},
		);
	});
}

/**
 * Parse `pi --list-models` (table: provider, model, …). WP19: only rows after the header count, so
 * Pi's "No models available. …" text is an empty list, not a model.
 */
export function parsePiModelList(text: string): string[] {
	const models: string[] = [];
	let header = false;
	for (const line of text.split("\n")) {
		const [provider, model] = line.trim().split(/\s+/u);
		if (provider === "provider" && model === "model") {
			header = true;
			continue;
		}
		if (!header || !provider || !model) continue;
		models.push(`${provider}/${model}`);
	}
	return models;
}

/**
 * Models `pi --list-models` marks without thinking (`thinking` column `no`): their only effort is
 * `off`, so the engine maps a stage's effort to `off` for them before launch (with a notice).
 */
export function parsePiModelEfforts(
	text: string,
): Record<string, readonly string[]> {
	const efforts: Record<string, readonly string[]> = {};
	let thinkingColumn = -1;
	for (const line of text.split("\n")) {
		const cells = line.trim().split(/\s+/u);
		if (cells[0] === "provider" && cells[1] === "model") {
			thinkingColumn = cells.indexOf("thinking");
			continue;
		}
		if (thinkingColumn < 0 || cells.length <= thinkingColumn) continue;
		if (cells[thinkingColumn] === "no")
			efforts[`${cells[0]}/${cells[1]}`] = ["off"];
	}
	return efforts;
}

/** Install command of Pi's web tools (C2: not bundled; the user's Pi provides them). */
export const PI_WEB_ACCESS_INSTALL = "pi install npm:pi-web-access";

/**
 * WP35 (row 57): what to tell the user when Pi's web tools are not available. `listFailed`: `pi list`
 * could not run, so their presence is unknown rather than known missing.
 */
export function piWebAccessGuidance(listFailed = false): string {
	return `${
		listFailed
			? "could not check for pi-web-access (`pi list` failed)"
			: "pi-web-access (Pi's web_search/fetch_content tools) is not installed in this Pi"
	}; stages that use web tools (deep-research) are refused on the pi executor. Install it: \`${PI_WEB_ACCESS_INSTALL}\` (check with \`pi list\`), or run them with --executor claude or codex`;
}

/** Probe-note prefixes (doctor shows them; the missing one is also a warning). */
export const PI_WEB_TOOLS_NOTE = "web tools: ";
export const PI_WEB_TOOLS_MISSING_NOTE = "web tools missing: ";

/** Path of the `pi-web-access` package in `pi list` output (line after the source). */
export function parsePiWebAccessPath(text: string): string | null {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1)
		if (/(?:^|[:/\s])pi-web-access(?:@|\s|$)/u.test(lines[index] ?? "")) {
			const path = lines[index + 1]?.trim();
			if (path?.startsWith("/")) return path;
		}
	return null;
}

/** WP35: the fast-tier guard report of an attempt (`pi-fast-tier.json`), if the extension wrote one. */
export async function readPiFastTierState(
	runDir: string,
): Promise<PiFastTierState | undefined> {
	try {
		const value = JSON.parse(
			await readFile(join(runDir, PI_FAST_TIER_STATE_FILE), "utf8"),
		) as PiFastTierState;
		return value?.schema === "agent-workflow-pi-fast-tier-v1"
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * WP35: a fast-tier guard failure (binding mismatch → request aborted) is a configuration
 * failure of the attempt, reported with the guard's reason instead of Pi's generic abort.
 * Degradation (`payload-only`) does not change the outcome; it stays in the state file and stderr.
 */
export function piFastTierOutcome(
	event: ExecEvent,
	state: PiFastTierState | undefined,
): ExecEvent {
	if (state?.status !== "failed" || event.type === "approval_request")
		return event;
	if (event.type === "failed" && event.class === "cancelled") return event;
	const message = `fast tier failed: ${state.reason ?? "binding check failed"}`;
	if (event.type === "failed")
		return {
			...event,
			class: "config",
			message,
			raw: {
				...(typeof event.raw === "object" &&
				event.raw !== null &&
				!Array.isArray(event.raw)
					? event.raw
					: {}),
				message,
			},
		};
	if (event.type === "completed")
		return {
			type: "failed",
			class: "config",
			message,
			raw: { message },
			...(event.ownedSession === undefined
				? {}
				: { ownedSession: event.ownedSession }),
		};
	return event;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

function createRedactor(req: SubmitRequest): SecretRedactor {
	return createSecretRedactor(requestSecrets(req), {
		minLength: REDACT_MIN_CHARS,
		replacement: () => "[redacted]",
	});
}

interface LaunchPlan {
	readonly argv: [string, ...string[]];
	readonly isolated: boolean;
	readonly session?: {
		readonly dir: string;
		readonly id: string;
		readonly resumePath?: string;
	};
	readonly ownedSession?: OwnedSession;
	readonly runConfig: Omit<PiRunConfig, "mcpLogPath" | "toolResultBudget"> & {
		readonly toolResultBudget?: { readonly maxTotalChars: number };
	};
	readonly extensionsBefore: readonly string[];
	readonly extensionsAfter: readonly string[];
	readonly tools: readonly string[];
	readonly notes: readonly string[];
}

export interface PiExecutor extends WorkflowExecutor {
	probe(): Promise<PiExecutorProbe>;
	/** Delete a worker session this adapter kept (D3, R#10). Only paths under its own state dir. */
	deleteOwnedSession(session: OwnedSession): Promise<DeleteOwnedSessionResult>;
	readonly config: PiExecutorConfig;
	readonly stateDir: string;
}

export function createPiExecutor(rawConfig: JsonValue = null): PiExecutor {
	const config = parsePiExecutorConfig(rawConfig);
	const stateDir = resolve(
		config.stateDir ?? join(agentWorkflowHome(), "executors", "pi"),
	);
	const store = new PiAttemptStore(stateDir);
	const sessionsRoot = join(stateDir, "sessions");
	const runExtensionUrl = pathToFileURL(
		fileURLToPath(new URL("./run-extension.js", import.meta.url)),
	).href;
	const liveKey = (attemptKey: string) => `${stateDir}\0${attemptKey}`;
	let discoveredWebAccess: Promise<string | null> | undefined;

	const discoverWebAccess = (): Promise<string | null> => {
		if (config.webAccessExtension !== undefined)
			return Promise.resolve(config.webAccessExtension);
		// Live bundle 5: a failed `pi list` (for example a timeout under load) is not cached, so a
		// later submit asks again instead of refusing web stages for the life of this executor.
		const pending =
			discoveredWebAccess ??
			runCli(config.piCommand, ["list"]).then((result) => {
				if (result.code === 0) return parsePiWebAccessPath(result.stdout);
				if (discoveredWebAccess === pending) discoveredWebAccess = undefined;
				return null;
			});
		discoveredWebAccess = pending;
		return pending;
	};

	async function plan(req: SubmitRequest): Promise<LaunchPlan> {
		const notes: string[] = [];
		const isolated = req.isolation?.inherit !== true;
		if (
			req.effort !== undefined &&
			!(PI_EFFORT_LEVELS as readonly string[]).includes(req.effort)
		)
			sdkInvalid(
				`effort ${req.effort} is not a Pi thinking level (${PI_EFFORT_LEVELS.join(", ")})`,
			);
		const mapped = mapTools(req.tools, PI_EXECUTOR_TOOL_MAPPING);
		if (mapped.unmapped.length > 0)
			throw new SdkError(
				"CAPABILITY_MISSING",
				`Pi executor has no mapping for tools: ${mapped.unmapped.join(", ")}`,
				{ subject: "toolAllowlist" },
			);
		const serverNames = new Set(req.mcpServers.map((server) => server.name));
		for (const tool of mapped.mcpTools)
			if (!serverNames.has(tool.server))
				throw new SdkError(
					"CAPABILITY_MISSING",
					`tool ${tool.tool} needs the MCP server ${tool.server}, which the request does not inject`,
					{ subject: "mcpInjection" },
				);
		for (const server of req.mcpServers)
			if (!/^[A-Za-z0-9_-]+$/u.test(server.name))
				sdkInvalid(
					`MCP server name ${server.name} is not valid for Pi (letters, digits, _ and -)`,
				);
		let tools = [...mapped.executorTools];
		if (enforcesReadOnly(req)) {
			const { kept, dropped } = readOnlyTools(tools);
			tools = kept;
			if (dropped.length > 0)
				notes.push(`readOnly: dropped mutating tools ${dropped.join(", ")}`);
		}
		const inheritHost =
			config.inheritHostTools === true && !enforcesReadOnly(req);
		if (config.inheritHostTools === true && enforcesReadOnly(req))
			notes.push("inheritHostTools ignored for a readOnly request");
		// Review #6: the engine's artifact server is declared by its one read-only tool name, never
		// server-wide. Pi has no approval gate, so a readOnly request that injects any other server
		// (whose tools may mutate) is refused before any effect.
		const foreignServers = req.mcpServers
			.map((server) => server.name)
			.filter((name) => name !== ARTIFACT_SERVER);
		if (enforcesReadOnly(req) && foreignServers.length > 0)
			throw new SdkError(
				"CAPABILITY_MISSING",
				`readOnly request injects MCP servers whose tools may mutate (${foreignServers.join(", ")}); the Pi executor cannot enforce readOnly on them`,
				{ subject: "readOnly" },
			);
		if (inheritHost) tools = [...new Set([...tools, ...INHERITED_HOST_TOOLS])];
		else
			for (const server of req.mcpServers)
				tools.push(
					server.name === ARTIFACT_SERVER
						? piMcpToolName(ARTIFACT_SERVER, "workflow_artifact")
						: // non-readOnly only: the caller injected it into a mutation-capable stage.
							piMcpServerPattern(server.name),
				);
		const extensionsBefore: string[] = [];
		const extensionsAfter: string[] = [];
		if (isolated && inheritHost)
			extensionsAfter.push(
				"builtin:mcp",
				"builtin:codemode",
				"builtin:tool-search",
			);
		if (
			isolated &&
			tools.some((tool) => (PI_WEB_TOOLS as readonly string[]).includes(tool))
		) {
			const webAccess = await discoverWebAccess();
			if (webAccess === null)
				throw new SdkError(
					"CAPABILITY_MISSING",
					`web tools need the pi-web-access extension, which \`pi list\` does not show: ${piWebAccessGuidance()}`,
					{ subject: "webTools" },
				);
			extensionsAfter.push(webAccess);
		}
		const sessionId = req.resumeSessionId ?? req.sessionId;
		if (
			req.resumeSessionId !== undefined &&
			req.sessionId !== undefined &&
			req.resumeSessionId !== req.sessionId
		)
			sdkInvalid(
				"Pi resumes a kept session under its own id; sessionId must equal resumeSessionId",
			);
		if (sessionId !== undefined && !SESSION_ID.test(sessionId))
			sdkInvalid(`session id ${sessionId} is not a valid Pi session id`);
		let session: LaunchPlan["session"];
		if (sessionId !== undefined) {
			const dir = join(sessionsRoot, sessionId);
			if (req.resumeSessionId !== undefined) {
				const files = (await readdir(dir).catch(() => [] as string[]))
					.filter((name) => name.endsWith(".jsonl"))
					.sort();
				const latest = files.at(-1);
				if (latest === undefined)
					sdkInvalid(
						`no kept Pi session ${sessionId} to resume (D3: only sessions this adapter kept)`,
					);
				session = { dir, id: sessionId, resumePath: join(dir, latest) };
			} else session = { dir, id: sessionId };
		}
		let fastTier: PiRunConfig["fastTier"];
		if (config.fast === "on") {
			try {
				fastTier = resolveWorkflowFastModeConfig({
					fast: "on",
					...(req.model === undefined ? {} : { model: req.model }),
					...(config.fastApi === undefined ? {} : { api: config.fastApi }),
				});
			} catch (error) {
				sdkInvalid(error instanceof Error ? error.message : String(error));
			}
		}
		const argv = buildPiArgv({
			piCommand: config.piCommand,
			isolated,
			...(session === undefined ? {} : { session }),
			...(req.systemPrompt === undefined
				? {}
				: { systemPromptPath: "<system-prompt>" }),
			...(req.model === undefined ? {} : { model: req.model }),
			...(req.effort === undefined ? {} : { thinking: req.effort }),
			tools,
			extensions: [],
		});
		return {
			argv,
			isolated,
			...(session === undefined ? {} : { session }),
			...(session === undefined
				? {}
				: { ownedSession: { kind: PI_SESSION_KIND, locator: session.dir } }),
			runConfig: {
				schema: "agent-workflow-pi-run-v1",
				privateMcp: isolated && !inheritHost,
				mcpServers: req.mcpServers.map((server) => ({
					name: server.name,
					command: server.command,
					args: [...server.args],
					envKeys: Object.keys(server.env ?? {}).sort(),
				})),
				...(config.toolResultBudget === undefined
					? {}
					: { toolResultBudget: config.toolResultBudget }),
				...(fastTier === undefined ? {} : { fastTier }),
				parentWatch: true,
			},
			extensionsBefore,
			extensionsAfter,
			tools,
			notes,
		};
	}

	const emit = (run: LiveRun, event: ExecEvent) => {
		if (run.done) return;
		run.log.push(event);
		if (event.type === "completed" || event.type === "failed") run.done = true;
		for (const wake of run.waiters.splice(0)) wake();
	};

	async function launch(
		req: SubmitRequest,
		launchPlan: LaunchPlan,
	): Promise<ExecRef> {
		const key = req.attemptKey;
		const fromLookup = (
			lookup: PiAttemptLookup,
		): PiAttemptRecord | undefined => {
			if (lookup.status === "unreadable")
				// Unreadable evidence may hide a launch: refuse before consuming (review #3).
				throw new SdkError(
					"AUTHORITY_ALREADY_CONSUMED",
					`attempt ${key} has launch evidence that cannot be trusted (${lookup.reason}); reconcile reports unknown`,
					{ subject: key },
				);
			return lookup.status === "found" ? lookup.record : undefined;
		};
		const known = fromLookup(await store.lookup(key));
		const fromRecord = (record: PiAttemptRecord): ExecRef => {
			if (
				(record.phase === "spawned" || record.phase === "exited") &&
				record.ref
			)
				return record.ref;
			if (record.phase === "revoked")
				throw new SdkError("AUTHORITY_REVOKED", `attempt ${key} was revoked`, {
					subject: key,
				});
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`attempt ${key} consumed its authority without launch evidence (reconcile: unknown)`,
				{ subject: key },
			);
		};
		if (known !== undefined) return fromRecord(known);
		// WP18b: old terminal attempt records are pruned in the background (at most every 6 h).
		schedulePeriodicAdapterStatePrune({
			stateDir,
			classify: (record) => classifyPiAttemptRecord(stateDir, record),
			attemptDigestLength: 64,
		});
		const runDir =
			req.artifactsDir ?? join(stateDir, "runs", attemptDigest(key));
		if (!(await store.create({ attemptKey: key, phase: "pending", runDir }))) {
			const raced = fromLookup(await store.lookup(key));
			if (raced === undefined)
				throw new SdkError(
					"AUTHORITY_ALREADY_CONSUMED",
					`attempt ${key} is claimed by another submit`,
					{ subject: key },
				);
			return fromRecord(raced);
		}
		// R#1: consume immediately before the first effect (the spawn below).
		const decision = await req.authority.consume();
		if (decision.kind === "revoked")
			await store.write({ attemptKey: key, phase: "revoked", runDir });
		requireReleased(decision);
		await store.write({ attemptKey: key, phase: "consumed", runDir });

		await mkdir(runDir, { recursive: true, mode: 0o700 });
		const extensionPath = join(runDir, PI_EXTENSION_FILE);
		const { toolResultBudget: budget, ...baseRunConfig } = launchPlan.runConfig;
		const runConfig: PiRunConfig = {
			...baseRunConfig,
			mcpLogPath: join(runDir, PI_MCP_LOG_FILE),
			...(baseRunConfig.fastTier === undefined
				? {}
				: {
						fastTier: {
							...baseRunConfig.fastTier,
							statePath: join(runDir, PI_FAST_TIER_STATE_FILE),
						},
					}),
			...(budget === undefined
				? {}
				: {
						toolResultBudget: {
							maxTotalChars: budget.maxTotalChars,
							statePath: join(runDir, TOOL_RESULT_BUDGET_STATE_FILENAME),
						},
					}),
		};
		await writeFile(
			extensionPath,
			piRunExtensionSource({ runExtensionUrl, config: runConfig }),
			{ mode: 0o600 },
		);
		await chmod(extensionPath, 0o600);
		const argv = [...launchPlan.argv];
		if (req.systemPrompt !== undefined) {
			const promptPath = join(runDir, PI_SYSTEM_PROMPT_FILE);
			await writeFile(promptPath, req.systemPrompt, { mode: 0o600 });
			argv[argv.indexOf("<system-prompt>")] = promptPath;
		}
		argv.push(
			"-e",
			extensionPath,
			...launchPlan.extensionsAfter.flatMap((extension) => ["-e", extension]),
		);
		if (launchPlan.session !== undefined)
			await mkdir(launchPlan.session.dir, { recursive: true, mode: 0o700 });

		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env[DURABLE_WORKER_BINDING_ENV];
		delete env.AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON;
		Object.assign(env, req.env);
		const binding = durableWorkerBindingEnv(req.authority);
		Object.assign(env, binding);
		env[PI_RUN_SECRETS_ENV] = JSON.stringify({
			mcpEnv: req.mcpServers.map((server) => server.env ?? null),
		});
		env.PI_SKIP_VERSION_CHECK = "1";
		const secrets = createRedactor(req);
		const redact = secrets.text;

		const child = spawn(argv[0] as string, argv.slice(1), {
			cwd: req.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		try {
			await new Promise<void>((resolveSpawn, rejectSpawn) => {
				child.once("spawn", () => resolveSpawn());
				child.once("error", rejectSpawn);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await store.write({
				attemptKey: key,
				phase: "consumed",
				runDir,
				spawnError: message,
			});
			throw new SdkError("INVALID_REQUEST", `pi failed to start: ${message}`, {
				cause: error,
			});
		}
		const pid = child.pid as number;
		const ref: ExecRef = {
			executorId: PI_EXECUTOR_ID,
			attemptKey: key,
			handle: `pid:${pid}`,
			...(launchPlan.session === undefined
				? {}
				: { sessionId: launchPlan.session.id }),
		};
		const run: LiveRun = {
			ref,
			log: [],
			done: false,
			waiters: [],
			child,
			cancelled: false,
		};
		LIVE_RUNS.set(liveKey(key), run);
		const normalizer = new PiEventNormalizer({
			sessionId: launchPlan.session?.id ?? null,
			...(launchPlan.ownedSession === undefined
				? {}
				: { ownedSession: launchPlan.ownedSession }),
		});
		emit(run, normalizer.started());
		const spawnedRecord = {
			attemptKey: key,
			phase: "spawned" as const,
			runDir,
			ref,
			pid,
			processGroupId: pid,
			sessionId: launchPlan.session?.id ?? null,
			...(launchPlan.ownedSession === undefined
				? {}
				: { ownedSession: launchPlan.ownedSession }),
		};
		// Review #10: the handlers below are attached before any await, so an early exit is never
		// missed. Record writes are serialized: the `exited` record always lands after the
		// `spawned` one, and a late identity write never overwrites `exited`.
		const spawnedWrite = store.write({ ...spawnedRecord, identity: null });
		let exitRecorded = false;
		let recordQueue: Promise<void> = spawnedWrite.catch(() => {});
		const queueRecord = (write: () => Promise<void>) => {
			recordQueue = recordQueue.then(write).catch(() => {});
			return recordQueue;
		};

		child.stdin?.on("error", () => {});
		child.stdin?.end(req.prompt);
		const watch = child.stdio[PI_PARENT_WATCH_FD];
		const rawOut: WriteStream = createWriteStream(join(runDir, PI_RAW_STDOUT), {
			flags: "a",
			mode: 0o600,
		});
		const rawErr: WriteStream = createWriteStream(join(runDir, PI_RAW_STDERR), {
			flags: "a",
			mode: 0o600,
		});
		rawOut.on("error", () => {});
		rawErr.on("error", () => {});
		const splitter = new PiJsonlSplitter();
		const handleLines = (lines: string[]) => {
			for (const line of lines) {
				const clean = redact(line);
				rawOut.write(`${clean}\n`);
				for (const event of normalizer.line(clean)) emit(run, event);
			}
		};
		child.stdout?.on("data", (chunk: Buffer) =>
			handleLines(splitter.push(chunk)),
		);
		let stderr = "";
		// A value split across stderr chunks is held back until it can be redacted (review #5).
		const stderrRedact = secrets.stream();
		const onStderr = (text: string) => {
			if (text === "") return;
			rawErr.write(text);
			if (stderr.length < STDERR_LIMIT)
				stderr = (stderr + text).slice(0, STDERR_LIMIT);
		};
		child.stderr?.on("data", (chunk: Buffer) =>
			onStderr(stderrRedact.push(chunk.toString("utf8"))),
		);
		child.stderr?.on("end", () => onStderr(stderrRedact.flush()));
		child.once("close", (code, signal) => {
			void (async () => {
				handleLines(splitter.finish());
				onStderr(stderrRedact.flush());
				if (run.killTimer !== undefined) clearTimeout(run.killTimer);
				(watch as { destroy?: () => void } | null)?.destroy?.();
				await Promise.all([
					new Promise((done) => rawOut.end(done)),
					new Promise((done) => rawErr.end(done)),
				]);
				const exit: PiAttemptExit = {
					exitCode: code,
					signal,
					cancelled: run.cancelled,
				};
				exitRecorded = true;
				await queueRecord(() =>
					store.write({ ...spawnedRecord, phase: "exited", exit }),
				);
				const fastState =
					runConfig.fastTier === undefined
						? undefined
						: await readPiFastTierState(runDir);
				emit(
					run,
					piFastTierOutcome(normalizer.finish({ ...exit, stderr }), fastState),
				);
			})();
		});
		await spawnedWrite;
		void captureProcessIdentity(pid).then(
			(identity) =>
				queueRecord(async () => {
					if (!exitRecorded && !run.done)
						await store.write({ ...spawnedRecord, identity });
				}),
			() => {},
		);
		return ref;
	}

	/** Re-derive the events of an exited attempt from its raw stream (fresh process, D3). */
	async function replay(record: PiAttemptRecord): Promise<ExecEvent[]> {
		const runDir = record.runDir as string;
		const normalizer = new PiEventNormalizer({
			sessionId: record.sessionId ?? null,
			...(record.ownedSession === undefined
				? {}
				: { ownedSession: record.ownedSession }),
		});
		const events: ExecEvent[] = [normalizer.started()];
		const splitter = new PiJsonlSplitter();
		const text = await readFile(join(runDir, PI_RAW_STDOUT), "utf8").catch(
			() => "",
		);
		for (const line of [...splitter.push(text), ...splitter.finish()])
			events.push(...normalizer.line(line));
		const stderr = await readFile(join(runDir, PI_RAW_STDERR), "utf8").catch(
			() => "",
		);
		events.push(
			piFastTierOutcome(
				normalizer.finish({
					...(record.exit ?? {
						exitCode: null,
						signal: null,
						cancelled: false,
					}),
					stderr,
				}),
				await readPiFastTierState(runDir),
			),
		);
		return events;
	}

	const executor: PiExecutor = {
		id: PI_EXECUTOR_ID,
		version: PI_EXECUTOR_VERSION,
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		config,
		stateDir,

		async probe(): Promise<PiExecutorProbe> {
			const [version, models, auth, list] = await Promise.all([
				runCli(config.piCommand, ["--version"]),
				runCli(config.piCommand, ["--list-models"]),
				config.authCheckModel === undefined
					? Promise.resolve(undefined)
					: runCli(config.piCommand, [
							"auth",
							"check",
							"--model",
							config.authCheckModel,
							"--json",
							"--no-refresh",
						]),
				config.webAccessExtension === undefined
					? runCli(config.piCommand, ["list"])
					: Promise.resolve(undefined),
			]);
			const cliVersion =
				version.code === 0
					? (version.stdout.trim().split(/\s+/u).at(-1) ?? null)
					: null;
			const installed = cliVersion !== null && cliVersion !== "";
			const notes: string[] = [];
			let authStatus: ExecutorProbe["auth"] = "unknown";
			if (auth === undefined) {
				// WP19 (review #9): `pi --list-models` lists only models whose provider has
				// configured auth in Pi (pi-ai ModelRuntime.getAvailable → authenticated
				// providers). Pi reads its own credentials; the engine reads none and no model is
				// called. A non-empty list = logged in to at least one provider; an empty list =
				// not logged in anywhere.
				if (installed && models.code === 0) {
					const listed = parsePiModelList(models.stdout);
					authStatus = listed.length > 0 ? "ok" : "missing";
					notes.push(
						listed.length > 0
							? `auth: ok (pi --list-models lists ${listed.length} model(s) whose provider has configured auth; not validated by a request)`
							: "auth: missing (pi --list-models lists no model with configured auth; run `pi` and /login, or set a provider API key)",
					);
				} else
					notes.push(
						"auth: unknown (pi --list-models failed; set config.authCheckModel to run `pi auth check`)",
					);
			} else {
				const status = /"status"\s*:\s*"(\w+)"/u.exec(auth.stdout)?.[1];
				authStatus =
					status === "ready"
						? "ok"
						: status === "not_ready"
							? "missing"
							: "unknown";
				notes.push(
					`auth: pi auth check ${status ?? "failed"} (credentials present, not validated by a request)`,
				);
			}
			const webAccess =
				config.webAccessExtension ??
				(list?.code === 0 ? parsePiWebAccessPath(list.stdout) : null);
			// WP35 (row 57): web tools are not bundled (C2); say whether this Pi has them and how to
			// install them (doctor shows the note, negotiation the warning).
			const webGuidance =
				webAccess === null
					? piWebAccessGuidance(list !== undefined && list.code !== 0)
					: undefined;
			// 2026-11-02: pi-web-access can turn single tools off in its own config, and Pi then drops
			// them from --tools silently. List what a worker-like session registers (it exits before
			// any model request) so a stage that needs a missing tool is refused before the run.
			const modernPi =
				installed && versionAtLeast(cliVersion as string, PI_MIN_CLI_VERSION);
			const registered =
				modernPi && webAccess !== null
					? await listPiWebSessionTools(config.piCommand, webAccess, {
							timeoutMs: PROBE_TIMEOUT_MS,
						})
					: null;
			const missingWebTools =
				registered === null
					? []
					: (PI_WEB_TOOLS as readonly string[]).filter(
							(tool) => !registered.includes(tool),
						);
			const unavailableTools = Object.fromEntries(
				missingWebTools.map((tool) => [
					tool,
					piWebToolUnavailableGuidance(tool),
				]),
			);
			if (installed)
				notes.push(
					webGuidance === undefined
						? `${PI_WEB_TOOLS_NOTE}pi-web-access ${webAccess} (${
								registered === null
									? "web_search, fetch_content; registration not checked"
									: (PI_WEB_TOOLS as readonly string[])
											.filter((tool) => registered.includes(tool))
											.join(", ") || "none registered"
							})`
						: `${PI_WEB_TOOLS_MISSING_NOTE}${webGuidance}`,
				);
			for (const [tool, guidance] of Object.entries(unavailableTools))
				notes.push(`${PI_WEB_TOOLS_MISSING_NOTE}${tool}: ${guidance}`);
			if (
				installed &&
				!versionAtLeast(cliVersion as string, PI_MIN_CLI_VERSION)
			)
				notes.push(
					`pi ${cliVersion} is older than ${PI_MIN_CLI_VERSION} (native MCP needs 1.1)`,
				);
			const modern =
				installed && versionAtLeast(cliVersion as string, PI_MIN_CLI_VERSION);
			return {
				installed,
				cliVersion: installed ? cliVersion : null,
				auth: authStatus,
				mcpOutputLimitChars: modern ? PI_MCP_OUTPUT_LIMIT_CHARS : null,
				mcpOutputNoticeChars: modern ? PI_MCP_OUTPUT_NOTICE_CHARS : null,
				models: models.code === 0 ? parsePiModelList(models.stdout) : null,
				...(models.code === 0 &&
				Object.keys(parsePiModelEfforts(models.stdout)).length > 0
					? { modelEfforts: parsePiModelEfforts(models.stdout) }
					: {}),
				// WP31 follow-up: `pi --list-models` lists the registry models Pi can run here, but
				// Pi's `--model` also resolves patterns ("sonnet", "provider/…"), so an exact-id
				// check would refuse valid requests: the list is not treated as exhaustive (a model
				// missing from it is noted, Pi itself reports a model it cannot resolve).
				modelListComplete: false,
				webAccessExtension: webAccess,
				...(missingWebTools.length > 0 ? { unavailableTools } : {}),
				capabilities: {
					...(modern ? {} : { mcpInjection: level("none", "probed") }),
					webTools:
						webAccess === null
							? {
									...level("none", "probed"),
									detail: "none",
									safetyPolicy: "unknown",
									...(webGuidance === undefined
										? {}
										: { warning: webGuidance }),
								}
							: missingWebTools.length === PI_WEB_TOOLS.length
								? {
										...level("none", "probed"),
										detail: "none",
										safetyPolicy: "unknown",
										warning: piWebToolUnavailableGuidance("web_search"),
									}
								: {
										...level("native", "probed", `pi-web-access via pi list`),
										detail: missingWebTools.includes("fetch_content")
											? "search"
											: "search+fetch",
										safetyPolicy: "unknown",
										...(missingWebTools.length > 0
											? {
													warning: piWebToolUnavailableGuidance(
														missingWebTools[0] as string,
													),
												}
											: {}),
									},
				},
				notes,
			};
		},

		capabilities: piCapabilities,
		toolMapping: PI_EXECUTOR_TOOL_MAPPING,

		async submit(req: SubmitRequest): Promise<ExecRef> {
			const problems = validateSubmitRequest(req);
			if (problems.length > 0) sdkInvalid(problems.join("; "));
			const key = liveKey(req.attemptKey);
			const pending = INFLIGHT.get(key);
			if (pending !== undefined) return pending;
			const launching = plan(req).then((launchPlan) => launch(req, launchPlan));
			INFLIGHT.set(key, launching);
			try {
				return await launching;
			} finally {
				INFLIGHT.delete(key);
			}
		},

		async *observe(ref: ExecRef): AsyncIterable<ExecEvent> {
			const run = LIVE_RUNS.get(liveKey(ref.attemptKey));
			if (run !== undefined) {
				if (run.ref.handle !== ref.handle)
					throw new SdkError(
						"UNKNOWN_EXEC_REF",
						`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
					);
				let index = 0;
				for (;;) {
					while (index < run.log.length) yield run.log[index++] as ExecEvent;
					if (run.done) return;
					await new Promise<void>((wake) => run.waiters.push(wake));
				}
			}
			const record = await store.read(ref.attemptKey);
			if (record?.ref === undefined || record.ref.handle !== ref.handle)
				throw new SdkError(
					"UNKNOWN_EXEC_REF",
					`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
				);
			if (record.phase !== "exited")
				throw new SdkError(
					"UNKNOWN_EXEC_REF",
					`attempt ${ref.attemptKey} runs in another process (Pi attempts are session-bound); reconcile instead`,
				);
			yield* await replay(record);
		},

		async cancel(ref: ExecRef, _scope: CancelScope): Promise<CancelResult> {
			const run = LIVE_RUNS.get(liveKey(ref.attemptKey));
			if (run !== undefined && run.ref.handle === ref.handle) {
				if (run.done) return "too_late";
				if (!run.cancelled) {
					run.cancelled = true;
					// Pi print mode has no turn-level interrupt: both scopes stop the process group.
					killGroup(run.child.pid, "SIGTERM");
					run.killTimer = setTimeout(
						() => killGroup(run.child.pid, "SIGKILL"),
						config.killGraceMs ?? 3_000,
					);
					run.killTimer.unref();
				}
				return "cancelled";
			}
			const lookup = await store.lookup(ref.attemptKey);
			// Unreadable evidence cannot prove nothing runs (review #3).
			if (lookup.status === "unreadable") return "uncertain";
			const record = lookup.status === "found" ? lookup.record : undefined;
			if (record?.ref === undefined || record.ref.handle !== ref.handle)
				return "no_active";
			if (record.phase === "exited") return "too_late";
			if (record.identity === undefined || record.identity === null)
				return "uncertain";
			const state = await verifyProcessIdentity(record.identity);
			if (state === "dead" || state === "mismatch") return "no_active";
			if (state === "unknown") return "uncertain";
			killGroup(record.identity.processGroupId, "SIGTERM");
			return "uncertain";
		},

		async reconcile(attemptKey: string): Promise<ReconcileResult> {
			const lookup = await store.lookup(attemptKey);
			// Only a missing record proves absence; unreadable evidence is ambiguous (review #3).
			if (lookup.status === "missing") return { absent: true };
			if (lookup.status === "unreadable")
				return { unknown: true, reason: lookup.reason };
			const record = lookup.record;
			if (record.phase === "revoked") return { absent: true };
			if (
				(record.phase === "spawned" || record.phase === "exited") &&
				record.ref
			)
				return { found: record.ref };
			return {
				unknown: true,
				reason:
					record.spawnError === undefined
						? "authority consumed (or being consumed) without launch evidence"
						: `authority consumed; pi failed to start: ${record.spawnError}`,
			};
		},

		async respond(ref: ExecRef): Promise<ApprovalResponseResult> {
			const run = LIVE_RUNS.get(liveKey(ref.attemptKey));
			const record =
				run === undefined ? await store.read(ref.attemptKey) : undefined;
			if (run === undefined && record?.ref?.handle !== ref.handle)
				throw new SdkError(
					"UNKNOWN_EXEC_REF",
					`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
				);
			// Pi never asks: tools outside the allowlist do not exist for the worker (D2).
			return "unknown_request";
		},

		async deleteOwnedSession(
			session: OwnedSession,
		): Promise<DeleteOwnedSessionResult> {
			// Only session dirs this adapter created directly under its own state dir.
			if (session.kind !== PI_SESSION_KIND) return "refused";
			const target = resolve(session.locator);
			const rel = relative(sessionsRoot, target);
			if (rel === "" || rel.startsWith("..") || rel.includes(sep))
				return "refused";
			const existed = await stat(target).then(
				() => true,
				() => false,
			);
			if (!existed) return "not_found";
			await rm(target, { recursive: true, force: true });
			return "deleted";
		},
	};
	return executor;
}
