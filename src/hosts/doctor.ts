// New in agent-workflow (WP17): `agent-workflow doctor`, a read-only environment check with no model
// calls. For each built-in executor: installed, CLI version vs the version its capabilities were
// verified with, auth state (non-secret, from the adapter's probe), and the fix command when it is
// not usable. Then which executor a run here would use by default and why, the permission-mode
// default, the Node version, AGENT_WORKFLOW_HOME and whether it is writable, known environment
// warnings (Codex allow rules and the global AGENTS.md, counts only: the WP4d probe never records
// rule contents) and stale run-index entries (with a `prune` hint). Nothing is written. `ok` (exit 0)
// when at least one executor is usable. WP35: the executor's web-tools probe note (Pi: whether
// pi-web-access is installed, with the install command when it is not) is shown and warned about.
import { constants } from "node:fs";
import {
	enablePiWebTool,
	PI_WEB_TOOL_CONFIG_KEYS,
	type PiWebToolFixResult,
	piWebAccessConfigPath,
} from "../executors/pi/web-tools.js";
import { access, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
	type ExecutorReadiness,
	type ExecutorReadinessProber,
	executorSetupHints,
	HOST_DEFAULT_EXECUTORS,
	INSTALLED_DEFAULT_ORDER,
	unverifiedDefaultGuidance,
	probeExecutorReadiness,
	readinessFixHint,
} from "../core/executor-default.js";
import {
	AGENT_WORKFLOW_HOME_ENV,
	agentWorkflowHome,
} from "../core/home-dir.js";
import {
	isTerminalWorkflowStatus,
	readIndex,
	TERMINAL_INDEX_LIMIT,
	workflowIndexPath,
} from "../core/store.js";
import { BUILTIN_EXECUTOR_IDS } from "../core/executor-registry.js";
import type { WorkflowHostId } from "../core/types.js";
import { inspectCodexEnvironment } from "../executors/codex/environment.js";
import { readUserProfiles, userProfileFromFile } from "./user-profiles.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	hostEnv,
	result,
	toDisplayPath,
} from "./types.js";

/** Node major version the package supports (package.json `engines.node`; 24 since 2026-11-05). */
export const DOCTOR_REQUIRED_NODE_MAJOR = 24;

export interface DoctorRequest {
	/** Probe seam (tests); default: the real adapters' probe() (cached per process). */
	prober?: ExecutorReadinessProber;
	/** Bound of each probe. */
	probeTimeoutMs?: number;
	/** Node version to report (tests); default process.versions.node. */
	nodeVersion?: string;
}

export interface DoctorExecutorReport {
	id: string;
	installed: boolean;
	cliVersion: string | null;
	/** CLI version the adapter's `probed` capability rows were verified with. */
	verifiedVersion: string | null;
	/** null when not installed or no verified version is known. */
	versionMatchesVerified: boolean | null;
	auth: ExecutorReadiness["auth"];
	state: ExecutorReadiness["state"];
	usable: boolean;
	/** Install/login command when not usable. */
	fix?: string;
	notes: string[];
	/** Tools this executor cannot provide here (stages needing them are refused), with the fix. */
	unavailableTools?: Record<string, string>;
	error?: string;
}

export interface DoctorData {
	host: WorkflowHostId;
	executors: DoctorExecutorReport[];
	/** The executor a run here would use when no run flag or workflow-declared profile selects one. */
	defaultExecutor: {
		id: string | null;
		source: "default" | "user-profile" | "host-default" | "installed-default";
		profile?: string;
		usable: boolean;
		reason: string;
	};
	permissionMode: {
		mode: "free" | "safe";
		source: "user-profile" | "default";
		profile?: string;
	};
	node: { version: string; required: string; supported: boolean };
	home: {
		path: string;
		fromEnv: boolean;
		exists: boolean;
		writable: boolean;
	};
	warnings: string[];
	runIndex: {
		path: string;
		entries: number;
		/** Index entries whose run.json is gone. */
		dangling: number;
		/** Terminal runs beyond the newest TERMINAL_INDEX_LIMIT (what `prune` removes by default). */
		prunable: number;
		stale: number;
		hint?: string;
		error?: string;
	};
	usable: boolean;
}

async function verifiedVersions(): Promise<Record<string, string | null>> {
	const [claude, codex, pi, antigravity] = await Promise.all([
		import("../executors/claude/config.js").then(
			(module) => module.CLAUDE_VERIFIED_CLI_VERSION,
			() => null,
		),
		import("../executors/codex/capabilities.js").then(
			(module) => module.CODEX_VERIFIED_CLI_VERSION,
			() => null,
		),
		import("../executors/pi/executor.js").then(
			(module) =>
				/^pi (\d+\.\d+\.\d+)/u.exec(module.PI_VERIFIED_WITH)?.[1] ?? null,
			() => null,
		),
		import("../executors/acp/antigravity.js").then(
			(module) => module.ANTIGRAVITY_VERIFIED_SERVER_VERSION,
			() => null,
		),
	]);
	return { pi, claude, codex, antigravity };
}

async function nearestExistingDir(path: string): Promise<string | undefined> {
	let current = path;
	while (true) {
		try {
			if ((await stat(current)).isDirectory()) return current;
			return undefined;
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

async function homeReport(env: NodeJS.ProcessEnv): Promise<DoctorData["home"]> {
	const path = agentWorkflowHome(env);
	let exists = false;
	try {
		exists = (await stat(path)).isDirectory();
	} catch {
		exists = false;
	}
	// A missing home is created on first write: check its nearest existing ancestor instead.
	const target = exists ? path : await nearestExistingDir(dirname(path));
	let writable = false;
	if (target !== undefined)
		try {
			await access(target, constants.W_OK);
			writable = true;
		} catch {
			writable = false;
		}
	return {
		path,
		fromEnv: Boolean(env[AGENT_WORKFLOW_HOME_ENV]?.trim()),
		exists,
		writable,
	};
}

async function runIndexReport(cwd: string): Promise<DoctorData["runIndex"]> {
	const path = workflowIndexPath(cwd);
	const empty = { path, entries: 0, dangling: 0, prunable: 0, stale: 0 };
	let index: Awaited<ReturnType<typeof readIndex>>;
	try {
		index = await readIndex(cwd);
	} catch (error) {
		return {
			...empty,
			error: `unreadable index (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	const runs = Array.isArray(index?.runs) ? index.runs : [];
	const missing = await Promise.all(
		runs.map(async (entry): Promise<boolean> => {
			if (typeof entry.runJson !== "string") return false;
			const runJson = isAbsolute(entry.runJson)
				? entry.runJson
				: join(cwd, entry.runJson);
			try {
				await stat(runJson);
				return false;
			} catch {
				return true;
			}
		}),
	);
	const dangling = missing.filter(Boolean).length;
	const terminal = runs.filter(
		(entry) => !entry.parentRunId && isTerminalWorkflowStatus(entry.status),
	);
	const prunable = Math.max(0, terminal.length - TERMINAL_INDEX_LIMIT);
	const stale = dangling + prunable;
	return {
		path,
		entries: runs.length,
		dangling,
		prunable,
		stale,
		...(stale > 0
			? {
					hint: "run `agent-workflow prune` to preview the cleanup, then `agent-workflow prune --yes`",
				}
			: {}),
	};
}

function executorReport(
	readiness: ExecutorReadiness,
	verified: string | null,
): DoctorExecutorReport {
	const fix = readinessFixHint(readiness);
	return {
		id: readiness.id,
		installed: readiness.installed,
		cliVersion: readiness.cliVersion,
		verifiedVersion: verified,
		versionMatchesVerified:
			readiness.cliVersion === null || verified === null
				? null
				: readiness.cliVersion === verified,
		auth: readiness.auth,
		state: readiness.state,
		usable: readiness.usable,
		...(fix ? { fix } : {}),
		notes: readiness.notes,
		...(readiness.unavailableTools === undefined
			? {}
			: { unavailableTools: readiness.unavailableTools }),
		...(readiness.error === undefined ? {} : { error: readiness.error }),
	};
}

function codexWarnings(env: NodeJS.ProcessEnv): string[] {
	const findings = inspectCodexEnvironment(env);
	const warnings: string[] = [];
	if (findings.allowRules > 0)
		warnings.push(
			`codex: ${findings.allowRules} allow rule${findings.allowRules === 1 ? "" : "s"} in ${findings.rulesFiles} file${findings.rulesFiles === 1 ? "" : "s"} under ${findings.rulesPath} let matching commands run without approval (readOnly is emulated for Codex workers)`,
		);
	if (findings.globalAgentsMd === "present")
		warnings.push(
			`codex: global instructions ${findings.agentsPath} (1 file) are loaded into every Codex worker (context isolation is emulated)`,
		);
	for (const problem of findings.problems) warnings.push(`codex: ${problem}`);
	return warnings;
}

function stateText(report: DoctorExecutorReport): string {
	if (report.state === "unavailable")
		return `unavailable (${report.error ?? "no adapter"})`;
	if (report.state === "probe-failed")
		return `probe failed (${report.error ?? "unknown error"})`;
	if (!report.installed) return "not installed";
	const version =
		report.verifiedVersion === null
			? (report.cliVersion ?? "unknown version")
			: `${report.cliVersion ?? "unknown version"} (verified ${report.verifiedVersion}${
					report.versionMatchesVerified === false ? ", differs" : ""
				})`;
	const auth =
		report.auth === "ok"
			? "logged in"
			: report.auth === "unknown"
				? "auth unknown (counts as usable)"
				: `not logged in (auth ${report.auth})`;
	return `installed ${version}, ${auth}`;
}

function formatDoctor(data: DoctorData, cwd: string): string {
	const width = Math.max(...data.executors.map((entry) => entry.id.length), 6);
	const lines = [
		`agent-workflow doctor (host: ${data.host})`,
		"",
		"Executors:",
	];
	for (const entry of data.executors) {
		lines.push(
			`  ${entry.id.padEnd(width)}  ${entry.usable ? "usable    " : "not usable"}  ${stateText(entry)}`,
		);
		if (entry.fix) lines.push(`  ${" ".repeat(width)}  fix: ${entry.fix}`);
		// WP35: executor web tools (Pi: pi-web-access, not bundled) as the probe reported them.
		for (const note of entry.notes)
			if (note.startsWith("web tools"))
				lines.push(`  ${" ".repeat(width)}  ${note}`);
	}
	const def = data.defaultExecutor;
	lines.push(
		"",
		`Default executor here: ${def.id ?? "none"} (${def.source}${def.id !== null && !def.usable ? ", not usable" : ""}): ${def.reason}`,
		"  A run flag (--executor) or a workflow-declared profile still wins.",
		`Permission mode default: ${data.permissionMode.mode} (${
			data.permissionMode.source === "user-profile"
				? `saved user profile "${data.permissionMode.profile}"`
				: "default"
		})`,
		`Node: ${data.node.version} (requires ${data.node.required}${data.node.supported ? "" : ", UNSUPPORTED"})`,
		`AGENT_WORKFLOW_HOME: ${data.home.path}${data.home.fromEnv ? " (from $AGENT_WORKFLOW_HOME)" : ""}; ${
			data.home.exists ? "exists" : "not created yet"
		}, ${data.home.writable ? "writable" : "NOT writable"}`,
		`Run index: ${toDisplayPath(data.runIndex.path, cwd)}: ${data.runIndex.entries} entr${data.runIndex.entries === 1 ? "y" : "ies"}, ${data.runIndex.stale} stale (${data.runIndex.dangling} missing run.json, ${data.runIndex.prunable} terminal beyond the newest ${TERMINAL_INDEX_LIMIT})${
			data.runIndex.error ? `; ${data.runIndex.error}` : ""
		}`,
	);
	if (data.runIndex.hint) lines.push(`  ${data.runIndex.hint}`);
	lines.push(
		"",
		data.warnings.length === 0 ? "Warnings: none" : "Warnings:",
		...data.warnings.map((warning) => `  - ${warning}`),
		"",
		data.usable
			? `OK: ${data.executors.filter((entry) => entry.usable).length} of ${data.executors.length} executors usable.`
			: `No executor is usable. Install and log in to one of ${INSTALLED_DEFAULT_ORDER.join(", ")} (fix lines above).`,
	);
	return lines.join("\n");
}

/** One change `doctor --fix` can make, after the user agreed (2026-11-02). */
export interface DoctorFix {
	readonly executor: string;
	readonly tool: string;
	/** What would change, for the question to the user. */
	readonly description: string;
}

/**
 * Fixes for tools an executor cannot provide here. Only Pi's web tools turned off in pi-web-access's
 * own config are fixable (one key flips to true); everything else stays guidance.
 */
export function doctorFixes(
	data: DoctorData,
	env: NodeJS.ProcessEnv = process.env,
): DoctorFix[] {
	const fixes: DoctorFix[] = [];
	for (const entry of data.executors) {
		if (entry.id !== "pi") continue;
		for (const tool of Object.keys(entry.unavailableTools ?? {})) {
			const key = PI_WEB_TOOL_CONFIG_KEYS[tool];
			if (key === undefined) continue;
			fixes.push({
				executor: entry.id,
				tool,
				description: `Turn on ${tool} in pi-web-access (set tools.${key}.enabled to true in ${piWebAccessConfigPath(env)})`,
			});
		}
	}
	return fixes;
}

export function applyDoctorFix(
	fix: DoctorFix,
	env: NodeJS.ProcessEnv = process.env,
): Promise<PiWebToolFixResult> {
	return enablePiWebTool(fix.tool, env);
}

/**
 * Executors the doctor reports: the default order first, then the other built-ins (antigravity),
 * which never become the installed default.
 */
const DOCTOR_EXECUTOR_IDS: readonly string[] = [
	...INSTALLED_DEFAULT_ORDER,
	...BUILTIN_EXECUTOR_IDS.filter(
		(id) => !(INSTALLED_DEFAULT_ORDER as readonly string[]).includes(id),
	),
];

/** `doctor`: read-only environment check (no model calls, nothing written). */
export async function doctorAction(
	ctx: HostApiContext,
	request: DoctorRequest = {},
): Promise<HostResult<DoctorData>> {
	assertActionAllowed(ctx, "doctor");
	const env = hostEnv(ctx);
	const host: WorkflowHostId = ctx.host ?? "cli";
	const [readiness, verified, home, runIndex] = await Promise.all([
		Promise.all(
			DOCTOR_EXECUTOR_IDS.map((id) =>
				probeExecutorReadiness(id, {
					...(request.prober === undefined ? {} : { prober: request.prober }),
					...(request.probeTimeoutMs === undefined
						? {}
						: { timeoutMs: request.probeTimeoutMs }),
				}),
			),
		),
		verifiedVersions(),
		homeReport(env),
		runIndexReport(ctx.cwd),
	]);
	const executors = readiness.map((entry) =>
		executorReport(entry, verified[entry.id] ?? null),
	);
	const warnings = codexWarnings(env);
	// WP35 (row 57): an installed executor whose web tools are missing (Pi without pi-web-access).
	for (const entry of executors)
		if (entry.installed)
			for (const note of entry.notes)
				if (note.startsWith("web tools missing: "))
					warnings.push(`${entry.id}: ${note}`);
	for (const entry of executors)
		if (entry.versionMatchesVerified === false)
			warnings.push(
				`${entry.id}: installed ${entry.cliVersion} differs from the verified ${entry.verifiedVersion}; capability rows marked probed may not hold`,
			);

	let profileExecutor: { id: string; profile: string } | undefined;
	let permissionMode: DoctorData["permissionMode"] = {
		mode: "free",
		source: "default",
	};
	try {
		const profiles = await readUserProfiles(env);
		const saved = profiles.default
			? userProfileFromFile(profiles, profiles.default)
			: undefined;
		if (saved?.executor)
			profileExecutor = { id: saved.executor, profile: saved.name };
		if (saved?.permissionMode)
			permissionMode = {
				mode: saved.permissionMode,
				source: "user-profile",
				profile: saved.name,
			};
	} catch (error) {
		warnings.push(
			`saved user profiles: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const usableIds = new Set(
		executors.filter((entry) => entry.usable).map((entry) => entry.id),
	);
	const isUsable = (id: string) => usableIds.has(id);
	let defaultExecutor: DoctorData["defaultExecutor"];
	if (profileExecutor !== undefined)
		defaultExecutor = {
			id: profileExecutor.id,
			source: "user-profile",
			profile: profileExecutor.profile,
			usable: isUsable(profileExecutor.id),
			reason: `The default saved user profile "${profileExecutor.profile}" selects it.`,
		};
	else if (ctx.defaultExecutor)
		defaultExecutor = {
			id: ctx.defaultExecutor,
			source: "default",
			usable: isUsable(ctx.defaultExecutor),
			reason: "The host overrides the default executor.",
		};
	else if (host !== "cli" && host !== "generic") {
		const id = HOST_DEFAULT_EXECUTORS[host];
		defaultExecutor = {
			id,
			source: "host-default",
			usable: isUsable(id),
			reason: `the ${host} host uses its own CLI (${executorSetupHints(id).cli}).`,
		};
	} else {
		// WP19 (review #9): a verified login wins over an earlier unknown-auth candidate.
		const readyIds = new Set(
			executors
				.filter((entry) => entry.usable && entry.auth === "ok")
				.map((entry) => entry.id),
		);
		const verified = INSTALLED_DEFAULT_ORDER.find((id) => readyIds.has(id));
		const first = verified ?? INSTALLED_DEFAULT_ORDER.find(isUsable);
		defaultExecutor = {
			id: first ?? null,
			source: "installed-default",
			usable: first !== undefined,
			reason: `the terminal CLI uses the first installed and logged-in of ${INSTALLED_DEFAULT_ORDER.join(" → ")}, preferring a verified login over unknown auth${
				first === undefined ? "; none is usable" : ""
			}.`,
		};
		if (first !== undefined && verified === undefined)
			warnings.push(unverifiedDefaultGuidance(first));
	}

	const nodeVersion = request.nodeVersion ?? process.versions.node;
	const major = Number.parseInt(nodeVersion.replace(/^v/u, ""), 10);
	if (!home.writable)
		warnings.push(
			`AGENT_WORKFLOW_HOME ${home.path} is not writable: saved profiles and executor state cannot be stored`,
		);
	const usable = usableIds.size > 0;
	const data: DoctorData = {
		host,
		executors,
		defaultExecutor,
		permissionMode,
		node: {
			version: nodeVersion.startsWith("v") ? nodeVersion : `v${nodeVersion}`,
			required: `>=${DOCTOR_REQUIRED_NODE_MAJOR}`,
			supported: Number.isFinite(major) && major >= DOCTOR_REQUIRED_NODE_MAJOR,
		},
		home,
		warnings,
		runIndex,
		usable,
	};
	return result(
		"doctor",
		usable ? "success" : "failed",
		data,
		formatDoctor(data, ctx.cwd),
	);
}
