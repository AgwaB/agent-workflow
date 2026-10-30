/**
 * Model and effort names belong to an executor (2026-10-30 owner decision). The same model has a
 * different name in each agentic coding tool:
 *
 * | model            | codex          | claude                       | pi                          |
 * |------------------|----------------|------------------------------|-----------------------------|
 * | GPT-6.1 Sol      | `gpt-6.1-sol`  | —                            | `openai-codex/gpt-6.1-sol`  |
 * | Claude Opus 5.5  | —              | `opus`, `claude-opus-5-5`    | `anthropic/claude-opus-5-5` |
 *
 * A model written without an executor (spec `model`, agent `model:`, `--model`) is resolved for
 * the executor that runs the stage: its vendor is recognised, the name is rewritten to that tool's
 * form, and a model the tool cannot run is refused before the run starts — never sent to a CLI that
 * would fail the stage mid-run. Probe model lists (no model call) settle ambiguous cases.
 */

/** Who makes a model, from its name: `openai`, `anthropic`, a Pi provider id, or undefined. */
export function modelVendor(model: string): string | undefined {
	const prefix = /^([a-z0-9][a-z0-9-]*)\//u.exec(model)?.[1];
	if (prefix !== undefined)
		return prefix === "openai-codex" || prefix === "openai" ? "openai" : prefix;
	if (/^(?:gpt-|o\d|codex-)/u.test(model)) return "openai";
	if (/^(?:claude-|(?:opus|sonnet|haiku)$)/u.test(model)) return "anthropic";
	return undefined;
}

/** Vendors whose models each built-in CLI runs. */
const EXECUTOR_VENDORS: Readonly<Record<string, string>> = {
	codex: "openai",
	claude: "anthropic",
};
const VENDOR_EXECUTOR: Readonly<Record<string, string>> = {
	openai: "codex",
	anthropic: "claude",
};
/** Pi providers preferred for a bare id of a vendor (ChatGPT login first, as Pi users have it). */
const PI_PROVIDER_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
	openai: ["openai-codex", "openai"],
	anthropic: ["anthropic"],
};

export type ExecutorNameResolution =
	| { value: string; changed: boolean; notice?: string }
	| { refused: string };

function bare(model: string): string {
	return model.replace(/^[a-z0-9][a-z0-9-]*\//u, "");
}

/**
 * `model` as `executorId` names it. `listed` is the executor's probe list (null: not listable);
 * `listComplete` says whether a missing name is certainly unknown.
 */
export function resolveExecutorModel(
	executorId: string,
	model: string,
	listed: readonly string[] | null = null,
	listComplete = false,
): ExecutorNameResolution {
	const vendor = modelVendor(model);
	if (listed?.includes(model)) return { value: model, changed: false };
	const own = EXECUTOR_VENDORS[executorId];
	if (own !== undefined) {
		if (vendor !== undefined && vendor !== own) {
			const other = VENDOR_EXECUTOR[vendor] ?? "pi";
			return {
				refused: `model "${model}" is ${vendorLabel(vendor)} model; ${executorId} cannot run it (use the ${other} executor for this stage: --executor ${other}, or a role/preset such as --preset mixed)`,
			};
		}
		const value = vendor === own ? bare(model) : model;
		const changed = value !== model;
		if (listed === null || listed.includes(value)) return { value, changed };
		if (listComplete)
			return {
				refused: `model "${model}" is not offered by ${executorId} (its models: ${listed.join(", ") || "none"})`,
			};
		return {
			value,
			changed,
			notice: `model "${value}" is not in ${executorId}'s model list (${listed.join(", ") || "none"}); it runs only if ${executorId} accepts that name`,
		};
	}
	if (executorId === "pi") {
		if (/^[a-z0-9][a-z0-9-]*\//u.test(model)) {
			if (listed === null || listComplete === false)
				return {
					value: model,
					changed: false,
					...(listed === null
						? {}
						: {
								notice: `model "${model}" is not in Pi's model list (providers with configured auth); it runs only if Pi can resolve it`,
							}),
				};
			return {
				refused: `model "${model}" is not offered by pi (its models: ${listed.join(", ")})`,
			};
		}
		// A bare id (codex/claude form): find the Pi provider that offers it.
		if (listed === null)
			return {
				value: model,
				changed: false,
				notice: `model "${model}" has no provider prefix and Pi's model list is not available; Pi resolves it itself`,
			};
		const matches = listed.filter((entry) => bare(entry) === model);
		if (matches.length === 1) return { value: matches[0]!, changed: true };
		const preferred = (PI_PROVIDER_PREFERENCE[vendor ?? ""] ?? [])
			.map((provider) => `${provider}/${model}`)
			.find((candidate) => matches.includes(candidate));
		if (preferred !== undefined) return { value: preferred, changed: true };
		return {
			refused:
				matches.length > 1
					? `model "${model}" is offered by several Pi providers (${matches.join(", ")}); name one`
					: `model "${model}" is not offered by pi${
							vendor === "anthropic" && !model.startsWith("claude-")
								? ` (Pi names Claude models "anthropic/claude-…", not the Claude Code alias "${model}")`
								: ""
						}`,
		};
	}
	return { value: model, changed: false };
}

function vendorLabel(vendor: string): string {
	return vendor === "openai"
		? "an OpenAI"
		: vendor === "anthropic"
			? "an Anthropic"
			: `a ${vendor}`;
}

/** Effort/thinking levels each built-in executor accepts. */
const EFFORT_LEVELS: Readonly<Record<string, readonly string[]>> = {
	codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
	claude: ["low", "medium", "high", "xhigh", "max"],
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};
/** A level one tool has and another lacks, mapped to the nearest one it has. */
const EFFORT_NEAREST: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	codex: { off: "low", minimal: "low" },
	claude: { off: "low", minimal: "low", ultra: "max" },
	pi: { ultra: "max" },
};

export function resolveExecutorEffort(
	executorId: string,
	effort: string,
): ExecutorNameResolution {
	const levels = EFFORT_LEVELS[executorId];
	if (levels === undefined || levels.includes(effort))
		return { value: effort, changed: false };
	const nearest = EFFORT_NEAREST[executorId]?.[effort];
	if (nearest !== undefined)
		return {
			value: nearest,
			changed: true,
			notice: `effort "${effort}" is "${nearest}" on ${executorId} (it has no "${effort}")`,
		};
	return {
		refused: `effort "${effort}" is not a ${executorId} level (${levels.join(", ")})`,
	};
}

/**
 * Back-compat helper for adapters (a last line of defence at submit; the run-level resolution
 * happens before launch in capability negotiation).
 */
export function executorModelId(
	executorId: string,
	model: string,
): { model: string } | { refused: string } {
	const resolved = resolveExecutorModel(executorId, model);
	return "refused" in resolved
		? { refused: resolved.refused }
		: { model: resolved.value };
}
