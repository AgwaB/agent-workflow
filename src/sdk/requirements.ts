/**
 * Requirement negotiation: declare → match → record (design §8.2/§8.3, owner decisions B4/B5/C1/C2, plan §6.5).
 * The engine matches each stage's requirements against an executor's capabilities before start.
 * Nothing is dropped silently: every gap is either refused with a named error, degraded with a
 * record, or emulated by the engine with a record.
 */
import type {
	CapabilityName,
	ExecutorCapabilities,
	Level,
} from "./capabilities.js";
import { LEVEL_CAPABILITY_NAMES } from "./capabilities.js";
import { EXECUTOR_CONTRACT_VERSION } from "./contract.js";
import { SdkError } from "./errors.js";
import type { PermissionMode } from "./permission.js";
import { mapTools, type ToolMapping } from "./tools.js";

export type Need = "required" | "preferred" | "optional";
export type OnMissing = "refuse" | "degrade" | "emulate";

export interface Requirement {
	readonly need: Need;
	readonly onMissing: OnMissing;
}

/** Capability name, optionally qualified by a detail: `toolAllowlist.fine`, `usage.cost`. */
export type RequirementKey = CapabilityName | `${CapabilityName}.${string}`;

/** Defaults from design §8.2 as amended by B4/B5 (R#6) and plan §6.5 (webTools). */
export const DEFAULT_REQUIREMENTS = {
	readOnly: { need: "required", onMissing: "refuse" },
	mcpInjection: { need: "required", onMissing: "refuse" },
	"toolAllowlist.fine": { need: "preferred", onMissing: "degrade" },
	"usage.cost": { need: "preferred", onMissing: "emulate" },
	partialStream: { need: "optional", onMissing: "degrade" },
	resume: { need: "preferred", onMissing: "degrade" },
	contextIsolation: { need: "required", onMissing: "refuse" },
	contextIsolationInherit: { need: "optional", onMissing: "degrade" },
	toolResultBudget: { need: "optional", onMissing: "degrade" },
	fastTier: { need: "optional", onMissing: "degrade" },
	webTools: { need: "required", onMissing: "refuse" },
} as const satisfies Record<string, Requirement>;

/** What one stage needs. Built by the engine from the spec, the agent definition and run flags. */
export interface StageRequirementContext {
	/** readOnly stage → `readOnly` required/refuse. */
	readonly readOnly: boolean;
	/** Stage has required reads → `mcpInjection` required/refuse. */
	readonly hasRequiredReads: boolean;
	/** Precise `tools: [...]` list (Pi names). Non-empty → `toolAllowlist.fine` preferred. */
	readonly tools?: readonly string[];
	/** Adapter's Pi→executor mapping. Unmapped tools follow the same B4 rule as `toolAllowlist.fine`. */
	readonly toolMapping?: ToolMapping;
	/** The spec allows running as readOnly when precise tool limits are unavailable. */
	readonly allowReadOnlyDowngrade?: boolean;
	/** B5 `inherit`. Default false: `contextIsolation` required, unverified/none refused. */
	readonly inherit?: boolean;
	/** Record cost (default true) → `usage.cost` preferred/emulate. */
	readonly wantsCost?: boolean;
	readonly partialStream?: boolean;
	readonly sameSessionRepair?: boolean;
	readonly toolResultBudget?: boolean;
	readonly fastTier?: boolean;
	/** Stage uses web tools (also inferred from `web_search`/`fetch_content` in tools). */
	readonly webTools?: boolean;
	/** Explicit `requires` / profile overrides; also adds capabilities beyond the defaults. */
	readonly requirements?: Readonly<
		Partial<Record<RequirementKey, Requirement>>
	>;
	/** User opt-in to treat these `unverified` capabilities as available (B4: default refuse). */
	readonly allowUnverified?: readonly RequirementKey[];
	/**
	 * Capabilities that must be `native` (profile `strictCapabilities`, WP4d). A strict key whose
	 * outcome would be `emulated` or `degraded` is refused with `CAPABILITY_STRICT:<key>`. A name
	 * also covers its qualified keys (`toolAllowlist` covers `toolAllowlist.fine`).
	 */
	readonly strict?: readonly RequirementKey[];
	/** Interactive host: degradations need user confirmation (B4). Non-interactive: record only. */
	readonly interactive?: boolean;
	/**
	 * D2 revised (WP4e). `free`: a missing precise tool allowlist (`toolAllowlist.fine`, e.g. Codex
	 * `coarse`) and environment warnings (`CAPABILITY_WARNING`) are recorded degradations that are
	 * never refused (not even by `strict`) and never need confirmation. Default `safe`: B4 as before.
	 */
	readonly permissionMode?: PermissionMode;
}

export type NegotiationOutcome = "native" | "emulated" | "degraded" | "refused";

export interface NegotiationEntry {
	readonly key: string;
	readonly need: Need;
	readonly onMissing: OnMissing;
	readonly observed: {
		readonly level: Level["level"];
		readonly source: Level["source"];
		readonly detail?: string;
		/** Environment warning carried by the observed level (WP4d). */
		readonly warning?: string;
	} | null;
	readonly outcome: NegotiationOutcome;
	/** Who provides an `emulated` outcome. */
	readonly emulatedBy?: "executor" | "engine";
	/** Named code for any gap, e.g. `CAPABILITY_MISSING:toolAllowlist.fine`. */
	readonly code?: string;
	readonly note?: string;
	/** `free` permission mode accepted this degradation: no refusal, no confirmation (WP4e). */
	readonly acceptedByFreeMode?: true;
	/**
	 * Recorded degradation that changes nothing about how the worker runs (WP12a: unknown cost);
	 * it never needs a confirmation. `strict` still refuses it.
	 */
	readonly recordOnly?: true;
}

export interface NegotiationReport {
	readonly contractVersion: string;
	readonly executorId: string;
	readonly executorVersion: string;
	readonly accepted: boolean;
	/** B4 toolAllowlist/unmapped-tool degradation: the stage must run with readOnly enforced. */
	readonly forcedReadOnly: boolean;
	/** Interactive host and at least one degradation: ask the user before start. */
	readonly needsConfirmation: boolean;
	readonly entries: readonly NegotiationEntry[];
	readonly refusals: readonly string[];
	readonly degradations: readonly string[];
	/** Permission mode the stage was negotiated under, when the caller set one (WP4e). */
	readonly permissionMode?: PermissionMode;
}

const DETAIL_RANK: Partial<Record<CapabilityName, readonly string[]>> = {
	toolAllowlist: ["none", "coarse", "fine"],
	usage: ["none", "tokens", "cost"],
	webTools: ["none", "search", "search+fetch"],
};

const DEGRADE_NOTES: Partial<Record<CapabilityName, string>> = {
	partialStream: "foreach starts only after completion",
	resume: "same-session repair uses a new session",
	contextIsolation: "inherit: worker may read user context; recorded",
	toolResultBudget:
		"no cumulative tool-result budget; adapter output caps only (C1)",
	fastTier: "runs without fast tier",
	usage: "usage recorded as unknown",
	webTools: "web safety controls are not engine-enforced (C2, plan §6.5)",
};

function splitKey(key: string): {
	name: CapabilityName;
	detail: string | undefined;
} {
	const dot = key.indexOf(".");
	const name = (dot < 0 ? key : key.slice(0, dot)) as CapabilityName;
	if (!(LEVEL_CAPABILITY_NAMES as readonly string[]).includes(name))
		throw new SdkError(
			"INVALID_REQUEST",
			`unknown capability in requirement: ${key}`,
		);
	return { name, detail: dot < 0 ? undefined : key.slice(dot + 1) };
}

function detailOf(entry: Level): string | undefined {
	const detail = (entry as Level & { detail?: unknown }).detail;
	return typeof detail === "string" ? detail : undefined;
}

function detailSatisfies(
	name: CapabilityName,
	have: string | undefined,
	want: string | undefined,
): boolean {
	if (want === undefined) return have !== "none";
	const rank = DETAIL_RANK[name];
	if (rank !== undefined && have !== undefined)
		return rank.indexOf(have) >= rank.indexOf(want) && rank.indexOf(want) >= 0;
	return have === want;
}

function isAvailable(entry: Level, allowUnverified: boolean): boolean {
	return (
		entry.level !== "none" && (entry.source !== "unverified" || allowUnverified)
	);
}

/** Collect the requirement set for a stage (defaults + explicit overrides). */
export function stageRequirements(
	ctx: StageRequirementContext,
): Map<string, Requirement> {
	const set = new Map<string, Requirement>();
	const tools = ctx.tools ?? [];
	if (ctx.readOnly) set.set("readOnly", DEFAULT_REQUIREMENTS.readOnly);
	if (ctx.hasRequiredReads)
		set.set("mcpInjection", DEFAULT_REQUIREMENTS.mcpInjection);
	if (tools.length > 0)
		set.set("toolAllowlist.fine", DEFAULT_REQUIREMENTS["toolAllowlist.fine"]);
	if (ctx.wantsCost ?? true)
		set.set("usage.cost", DEFAULT_REQUIREMENTS["usage.cost"]);
	if (ctx.partialStream)
		set.set("partialStream", DEFAULT_REQUIREMENTS.partialStream);
	if (ctx.sameSessionRepair) set.set("resume", DEFAULT_REQUIREMENTS.resume);
	set.set(
		"contextIsolation",
		ctx.inherit
			? DEFAULT_REQUIREMENTS.contextIsolationInherit
			: DEFAULT_REQUIREMENTS.contextIsolation,
	);
	if (ctx.toolResultBudget)
		set.set("toolResultBudget", DEFAULT_REQUIREMENTS.toolResultBudget);
	if (ctx.fastTier) set.set("fastTier", DEFAULT_REQUIREMENTS.fastTier);
	if (
		ctx.webTools ||
		tools.includes("web_search") ||
		tools.includes("fetch_content")
	)
		set.set("webTools", DEFAULT_REQUIREMENTS.webTools);
	for (const [key, requirement] of Object.entries(ctx.requirements ?? {})) {
		if (requirement === undefined) continue;
		splitKey(key);
		set.set(key, requirement);
	}
	return set;
}

/** Match a stage against an executor. Pure; does not throw for refusals (see `assertAccepted`). */
export function negotiateCapabilities(
	executor: { readonly id: string; readonly version: string },
	caps: ExecutorCapabilities,
	ctx: StageRequirementContext,
): NegotiationReport {
	const entries: NegotiationEntry[] = [];
	const unverifiedOptIn = new Set<string>(ctx.allowUnverified ?? []);
	const strictKeys = new Set<string>(ctx.strict ?? []);
	for (const key of strictKeys) splitKey(key);
	const free = ctx.permissionMode === "free";
	let forcedReadOnly = false;

	const readOnlyDowngrade = (
		key: string,
		code: string,
		note: string,
	): NegotiationEntry | null => {
		if (!(ctx.allowReadOnlyDowngrade ?? false)) return null;
		if (!isAvailable(caps.readOnly, unverifiedOptIn.has("readOnly")))
			return null;
		forcedReadOnly = true;
		return {
			key,
			need: "preferred",
			onMissing: "degrade",
			observed: null,
			outcome: "degraded",
			code,
			note: `${note}; running as readOnly (spec allows)`,
		};
	};

	const negotiateKey = (
		key: string,
		requirement: Requirement,
	): NegotiationEntry => {
		const { name, detail } = splitKey(key);
		const observedLevel = caps[name];
		const observedDetail = detailOf(observedLevel);
		const observedWarning =
			typeof observedLevel.warning === "string" && observedLevel.warning !== ""
				? observedLevel.warning
				: undefined;
		const observed = {
			level: observedLevel.level,
			source: observedLevel.source,
			...(observedDetail === undefined ? {} : { detail: observedDetail }),
			...(observedWarning === undefined ? {} : { warning: observedWarning }),
		};
		const optIn = unverifiedOptIn.has(key) || unverifiedOptIn.has(name);
		const detailOk = detailSatisfies(name, observedDetail, detail);
		const base = {
			key,
			need: requirement.need,
			onMissing: requirement.onMissing,
			observed,
		};
		let entry: NegotiationEntry;

		if (detailOk && isAvailable(observedLevel, optIn)) {
			const viaOptIn = observedLevel.source === "unverified";
			entry = {
				...base,
				outcome: observedLevel.level === "emulated" ? "emulated" : "native",
				...(observedLevel.level === "emulated"
					? { emulatedBy: "executor" as const }
					: {}),
				...(viaOptIn
					? { note: "unverified capability used by user opt-in" }
					: {}),
			};
			if (observedLevel.level === "emulated" && observedWarning !== undefined) {
				// Environment-weakened capability (WP4d): never a silent pass.
				entry = {
					...entry,
					outcome: "degraded",
					code: `CAPABILITY_WARNING:${key}`,
					note:
						entry.note === undefined
							? observedWarning
							: `${observedWarning}; ${entry.note}`,
				};
			}
			if (name === "webTools" && caps.webTools.safetyPolicy !== "engine") {
				entry = {
					...entry,
					outcome: "degraded",
					note: `webTools.safetyPolicy: ${caps.webTools.safetyPolicy}; ${DEGRADE_NOTES.webTools}${
						entry.outcome === "degraded" && entry.note !== undefined
							? `; ${entry.note}`
							: ""
					}`,
				};
			}
		} else {
			const unverified =
				detailOk &&
				observedLevel.level !== "none" &&
				observedLevel.source === "unverified";
			const code = `${unverified ? "CAPABILITY_UNVERIFIED" : "CAPABILITY_MISSING"}:${key}`;
			// WP35: the executor's environment warning (e.g. how to install a missing extension)
			// travels with a refusal, so the preview and the refusal message say what to do.
			const refused: NegotiationEntry = {
				...base,
				outcome: "refused",
				code,
				...(observedWarning === undefined ? {} : { note: observedWarning }),
			};
			if (requirement.onMissing === "refuse") {
				entry = refused;
			} else if (requirement.onMissing === "emulate") {
				// WP12a: the engine has no model price table, so it cannot emulate a missing cost.
				// A preferred `usage.cost` is recorded as unknown (`null`, never 0); this changes
				// nothing about the worker, so it never needs a confirmation (`recordOnly`).
				if (key === "usage.cost" && requirement.need !== "required") {
					entry = {
						...base,
						outcome: "degraded",
						code,
						note: isAvailable(caps.usage, optIn)
							? "cost recorded as unknown: the executor reports tokens only and the engine has no model prices"
							: DEGRADE_NOTES.usage,
						recordOnly: true,
					};
				} else if (requirement.need === "required") {
					entry = { ...refused, note: "no engine emulation available" };
				} else {
					entry = {
						...base,
						outcome: "degraded",
						code,
						note: DEGRADE_NOTES[name] ?? "no engine emulation available",
					};
				}
			} else if (name === "toolAllowlist" && free) {
				// WP4e: free mode accepts a coarse allowlist for every stage (recorded, never refused).
				entry = {
					...base,
					outcome: "degraded",
					code,
					note: "free permission mode: precise tool allowlist unavailable; the worker may use tools outside the stage's list",
					acceptedByFreeMode: true,
				};
			} else if (name === "toolAllowlist") {
				entry = readOnlyDowngrade(
					key,
					code,
					"precise tool allowlist unavailable",
				) ?? { ...refused, note: "spec does not allow readOnly downgrade" };
				if (entry.outcome === "degraded")
					entry = { ...entry, observed, need: requirement.need };
			} else if (
				name === "toolResultBudget" &&
				caps.toolLoop === "agent" &&
				requirement.need === "required"
			) {
				entry = {
					...refused,
					note: "agent owns the tool loop; engine cannot enforce a budget",
				};
			} else {
				entry = {
					...base,
					outcome: "degraded",
					code,
					note: DEGRADE_NOTES[name] ?? "capability unavailable; recorded",
				};
			}
		}
		if (
			free &&
			entry.outcome === "degraded" &&
			entry.code?.startsWith("CAPABILITY_WARNING:") === true
		)
			entry = { ...entry, acceptedByFreeMode: true };
		if (
			(entry.outcome === "emulated" || entry.outcome === "degraded") &&
			entry.acceptedByFreeMode !== true &&
			(strictKeys.has(key) || strictKeys.has(name))
		) {
			const { recordOnly: _recordOnly, ...unstrict } = entry;
			entry = {
				...unstrict,
				outcome: "refused",
				code: `CAPABILITY_STRICT:${key}`,
				note: `strict: ${key} must be native (was ${entry.outcome}${
					entry.note === undefined ? "" : `: ${entry.note}`
				})`,
			};
		}
		return entry;
	};

	for (const [key, requirement] of stageRequirements(ctx))
		entries.push(negotiateKey(key, requirement));

	if (ctx.tools !== undefined && ctx.toolMapping !== undefined) {
		for (const tool of mapTools(ctx.tools, ctx.toolMapping).unmapped) {
			const key = `tool.${tool}`;
			const code = `CAPABILITY_MISSING:${key}`;
			entries.push(
				readOnlyDowngrade(
					key,
					code,
					`no ${ctx.toolMapping.executorId} mapping for ${tool}`,
				) ?? {
					key,
					need: "required",
					onMissing: "refuse",
					observed: null,
					outcome: "refused",
					code,
					note: "tool has no mapping and spec does not allow readOnly downgrade",
				},
			);
		}
	}

	// WP12d-1 (review #7): a forced downgrade makes `readOnly` a requirement of this stage, so it is
	// negotiated like an authored readOnly stage (strictness, environment warning, confirmation).
	if (forcedReadOnly && !entries.some((entry) => entry.key === "readOnly"))
		entries.push(negotiateKey("readOnly", DEFAULT_REQUIREMENTS.readOnly));

	const refusals = entries
		.filter((entry) => entry.outcome === "refused")
		.map((entry) => entry.code ?? entry.key);
	const degradations = entries
		.filter((entry) => entry.outcome === "degraded")
		.map((entry) => entry.code ?? entry.key);
	const confirmable = entries.filter(
		(entry) =>
			entry.outcome === "degraded" &&
			entry.acceptedByFreeMode !== true &&
			entry.recordOnly !== true,
	).length;
	return {
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		executorId: executor.id,
		executorVersion: executor.version,
		accepted: refusals.length === 0,
		forcedReadOnly,
		needsConfirmation:
			refusals.length === 0 && confirmable > 0 && (ctx.interactive ?? false),
		entries,
		refusals,
		degradations,
		...(ctx.permissionMode === undefined
			? {}
			: { permissionMode: ctx.permissionMode }),
	};
}

/** Throw the first refusal as a named error (`CAPABILITY_MISSING` / `CAPABILITY_UNVERIFIED`). */
export function assertAccepted(report: NegotiationReport): void {
	if (report.accepted) return;
	const first = report.refusals[0] ?? "CAPABILITY_MISSING:unknown";
	const [code, ...rest] = first.split(":");
	throw new SdkError(
		code === "CAPABILITY_UNVERIFIED"
			? "CAPABILITY_UNVERIFIED"
			: "CAPABILITY_MISSING",
		`executor ${report.executorId}@${report.executorVersion} refused: ${report.refusals.join(", ")}`,
		{ subject: rest.join(":") },
	);
}

/** Human-readable pre-start preview lines (extends the compiler's permission preview, design §8.3). */
export function formatNegotiationPreview(
	report: NegotiationReport,
	label?: string,
): string[] {
	const head = `${label === undefined ? "" : `${label}: `}${report.executorId}@${report.executorVersion} — ${
		report.accepted
			? report.degradations.length > 0
				? "accepted with degradation"
				: "accepted"
			: "REFUSED"
	}${report.forcedReadOnly ? " (forced readOnly)" : ""}`;
	const lines = [head];
	for (const entry of report.entries) {
		const observed =
			entry.observed === null
				? "unmapped"
				: `${entry.observed.level}/${entry.observed.source}${entry.observed.detail === undefined ? "" : `/${entry.observed.detail}`}`;
		const by = entry.emulatedBy === undefined ? "" : ` by ${entry.emulatedBy}`;
		const code = entry.code === undefined ? "" : ` [${entry.code}]`;
		const note = entry.note === undefined ? "" : ` — ${entry.note}`;
		const free =
			entry.acceptedByFreeMode === true ? " (accepted: free mode)" : "";
		lines.push(
			`  ${entry.key}: ${entry.outcome}${by}${free} (${entry.need}, ${observed})${code}${note}`,
		);
	}
	return lines;
}

/** One stage's negotiation, labelled for the run-level preview. */
export interface StageNegotiation {
	readonly label: string;
	readonly report: NegotiationReport;
}

export interface CapabilityPreview {
	/** Every stage accepted (no refusal). */
	readonly accepted: boolean;
	/** At least one stage needs interactive confirmation (B4). */
	readonly needsConfirmation: boolean;
	/** `<label>: <code>` for every refused entry. */
	readonly refusals: readonly string[];
	/** `<label>: <code>` for every degraded entry. */
	readonly degradations: readonly string[];
	/** Labels of stages that run with readOnly enforced. */
	readonly forcedReadOnly: readonly string[];
	/** Human-readable pre-start preview (design §8.3). */
	readonly text: string;
	/**
	 * The same check, short, for a confirmation dialog (2026-11-03, owner: the dialog showed every
	 * stage's full report — 30+ lines for one reason to ask): what needs the user's OK, once across
	 * stages, and in one line what is only recorded. `text` stays the full report (terminal, record).
	 */
	readonly prompt: string;
	/** Capability keys (e.g. `webTools`) whose degradation needs the user's OK, once each. */
	readonly needsOk: readonly string[];
}

/** Plain words for a capability limit in a confirmation dialog; unknown keys show their name. */
const LIMIT_WORDS: Readonly<Record<string, string>> = {
	readOnly: "read-only is not strictly enforced",
	mcpInjection: "required reads cannot be injected",
	toolAllowlist: "the stage's tool list is not enforced",
	"toolAllowlist.fine": "the stage's tool list is enforced only coarsely",
	"usage.cost": "cost is recorded as unknown (tokens only)",
	partialStream: "results arrive only when a worker finishes",
	resume: "a repair starts a new session",
	contextIsolation: "workers are not fully isolated from your own setup",
	contextIsolationInherit: "workers inherit your context",
	toolResultBudget: "no overall budget for tool output",
	fastTier: "runs without the fast tier",
	webTools: "web search safety rules are not enforced by the engine",
};

/** Stages a limit applies to: "all 4 stages", or up to three names. */
function stageList(labels: readonly string[], total: number): string {
	const names = [
		...new Set(labels.map((label) => label.replace(/\.(main|item)$/u, ""))),
	];
	if (total > 1 && labels.length === total) return `all ${total} stages`;
	return names.length <= 3
		? names.join(", ")
		: `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

/** The dialog text of {@link CapabilityPreview.prompt}. */
function confirmationPrompt(
	stages: readonly StageNegotiation[],
	heading: string,
): string {
	const ask = new Map<string, { words: string; labels: string[] }>();
	const asked = new Set<string>();
	const recorded = new Map<string, string>();
	for (const { label, report } of stages)
		for (const entry of report.entries) {
			if (entry.outcome !== "degraded") continue;
			const words = LIMIT_WORDS[entry.key] ?? entry.key;
			if (entry.acceptedByFreeMode === true || entry.recordOnly === true) {
				recorded.set(entry.key, words);
				continue;
			}
			// An environment warning names what was found (a rules file, a global AGENTS.md).
			const found =
				entry.code?.startsWith("CAPABILITY_WARNING:") === true &&
				entry.note !== undefined
					? `${words}: ${entry.note}`
					: words;
			const group = ask.get(found) ?? { words: found, labels: [] };
			group.labels.push(label);
			ask.set(found, group);
			asked.add(entry.key);
		}
	const lines = [heading];
	if (ask.size > 0) {
		lines.push("", "Needs your OK:");
		// 2026-11-04 (live Claude Code host, haiku): "a repair starts a new session (all 4 stages)" was
		// relayed as "all 4 stages run again"; "in" says where the limit applies.
		for (const { words, labels } of ask.values())
			lines.push(`• ${words} (in ${stageList(labels, stages.length)})`);
	}
	// A limit that some stage asks about is not repeated as recorded-only for the others.
	const quiet = [...recorded.entries()]
		.filter(([key]) => !asked.has(key))
		.map(([, words]) => words);
	if (quiet.length > 0)
		lines.push("", "Recorded only, no OK needed:", `• ${quiet.join("; ")}`);
	lines.push(
		"",
		"If you accept, the full per-stage report is saved with the run.",
	);
	return lines.join("\n");
}

/**
 * Run-level pre-start preview (design §8.3): one block per stage from `formatNegotiationPreview`,
 * headed by a summary line and optional executor readiness lines (probe summary, no secrets).
 */
export function buildCapabilityPreview(
	stages: readonly StageNegotiation[],
	options: {
		readonly executor?: { readonly id: string; readonly version: string };
		/** Replaces the executor in the summary line (a mixed run names every executor). */
		readonly executorLabel?: string;
		readonly header?: readonly string[];
		/** Effective run permission mode, shown on the first line (WP4e). */
		readonly permissionMode?: PermissionMode;
		/** Extra lines under a stage's block, by stage label (e.g. its host-tool decision). */
		readonly stageNotes?: ReadonlyMap<string, readonly string[]>;
		/** Replaces "<n> stages" in the summary line (a dynamic run generates its stages later). */
		readonly stagesLabel?: string;
	} = {},
): CapabilityPreview {
	const refusals: string[] = [];
	const degradations: string[] = [];
	const forcedReadOnly: string[] = [];
	let needsConfirmation = false;
	for (const { label, report } of stages) {
		for (const code of report.refusals) refusals.push(`${label}: ${code}`);
		for (const code of report.degradations)
			degradations.push(`${label}: ${code}`);
		if (report.forcedReadOnly) forcedReadOnly.push(label);
		if (report.needsConfirmation) needsConfirmation = true;
	}
	const accepted = refusals.length === 0;
	const executor =
		options.executorLabel ??
		(options.executor === undefined
			? (stages[0]?.report.executorId ?? "executor")
			: `${options.executor.id}@${options.executor.version}`);
	const mode =
		options.permissionMode === undefined
			? ""
			: `, permission mode: ${options.permissionMode}`;
	const stagesText =
		options.stagesLabel ??
		`${stages.length} stage${stages.length === 1 ? "" : "s"}`;
	const summary = `Capability check (${executor}, ${stagesText}${mode}): ${
		accepted
			? degradations.length > 0
				? `accepted with ${degradations.length} degradation${degradations.length === 1 ? "" : "s"}`
				: "accepted"
			: `REFUSED (${refusals.length})`
	}${forcedReadOnly.length > 0 ? `; forced readOnly: ${forcedReadOnly.join(", ")}` : ""}`;
	const lines = [summary, ...(options.header ?? [])];
	for (const { label, report } of stages) {
		lines.push(...formatNegotiationPreview(report, label));
		lines.push(...(options.stageNotes?.get(label) ?? []));
	}
	return {
		accepted,
		needsConfirmation: accepted && needsConfirmation,
		refusals,
		degradations,
		forcedReadOnly,
		text: lines.join("\n"),
		needsOk: [
			...new Set(
				stages.flatMap(({ report }) =>
					report.entries
						.filter(
							(entry) =>
								entry.outcome === "degraded" &&
								entry.acceptedByFreeMode !== true &&
								entry.recordOnly !== true,
						)
						.map((entry) => entry.key),
				),
			),
		],
		prompt: confirmationPrompt(
			stages,
			`${executor} · ${stagesText}${options.permissionMode === undefined ? "" : ` · permission mode ${options.permissionMode}`}${forcedReadOnly.length > 0 ? ` · runs read-only: ${stageList(forcedReadOnly, stages.length)}` : ""}`,
		),
	};
}
