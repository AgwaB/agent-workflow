// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/tool-metadata.ts. MIT, same author. Changes: the workflow_web_* tools are not built in (C2: web tools are each CLI's own); an agent's tools authorise exactly those names. 2026-11-05: the built-in names are the ones every executor maps (read, grep, find, ls, web_search, fetch_content, edit, write, bash); Pi-only extension names (lsp_*, ast_grep_search, code_search, get_search_content, scrapling_fetch) are custom tools like any other.
import type {
	CompiledToolProvider,
	TaskCapability,
	WorkflowToolObjectSpec,
	WorkflowToolSpec,
} from "./types.js";

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

const TOOL_CLASSIFICATION_RANK: Record<TaskCapability, number> = {
	"read-only": 0,
	"write-capable": 1,
	"mutation-capable": 2,
};

const BUILTIN_TOOL_METADATA: Record<string, CompiledToolProvider> = {
	read: { classification: "read-only" },
	grep: { classification: "read-only" },
	find: { classification: "read-only" },
	ls: { classification: "read-only" },
	web_search: { classification: "read-only" },
	fetch_content: { classification: "read-only" },
	edit: { classification: "write-capable" },
	write: { classification: "write-capable" },
	bash: { classification: "mutation-capable" },
};

function builtinToolMetadata(tool: string): CompiledToolProvider | undefined {
	return Object.hasOwn(BUILTIN_TOOL_METADATA, tool)
		? BUILTIN_TOOL_METADATA[tool]
		: undefined;
}

const NON_DOWNGRADABLE_TOOL_FLOORS: Record<string, TaskCapability> = {
	edit: "write-capable",
	write: "write-capable",
	bash: "mutation-capable",
};

// This is deliberately separate from mutation classification. A read-only
// provider can still reach the network, while a shell can do both local and
// network work. Unknown/custom providers stay unknown rather than receiving a
// permissive name-based guess.
const NETWORK_CAPABLE_TOOLS = new Set(["bash", "web_search", "fetch_content"]);
const KNOWN_LOCAL_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
]);

export interface ToolSelection {
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
}

export interface AvailableToolViewItem {
	name: string;
	classification?: TaskCapability;
	optional?: boolean;
	fallbackTools?: string[];
	builtin: boolean;
	floor?: TaskCapability;
}

export interface ClassifyToolCapabilityOptions {
	unspecifiedToolsCapability?: TaskCapability;
	emptyToolsCapability?: TaskCapability;
}

export interface ToolAuthorityValidationOptions {
	allowedTools?: readonly string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	allowUnknownTools?: boolean;
}

export function toolNameForSpec(tool: WorkflowToolSpec): string | undefined {
	if (typeof tool === "string") return tool;
	if (
		tool &&
		typeof tool === "object" &&
		!Array.isArray(tool) &&
		typeof (tool as { name?: unknown }).name === "string"
	) {
		return (tool as { name: string }).name;
	}
	return undefined;
}

export function providerFromToolObject(
	tool: WorkflowToolObjectSpec,
): CompiledToolProvider | undefined {
	const provider: CompiledToolProvider = {};
	if (tool.classification !== undefined)
		provider.classification = tool.classification;
	if (tool.optional !== undefined) provider.optional = tool.optional;
	if (Array.isArray(tool.fallbackTools))
		provider.fallbackTools = [...tool.fallbackTools];
	return hasProviderMetadata(provider) ? provider : undefined;
}

export function mergeToolProviders(
	base: CompiledToolProvider | undefined,
	override: CompiledToolProvider,
): CompiledToolProvider {
	const merged: CompiledToolProvider = { ...(base ?? {}) };
	if (override.classification !== undefined)
		merged.classification = override.classification;
	if (override.optional !== undefined) merged.optional = override.optional;
	if (override.fallbackTools !== undefined)
		merged.fallbackTools = [...override.fallbackTools];
	return merged;
}

export function resolveToolSelection(
	scopes: Array<WorkflowToolSpec[] | undefined>,
	fallbackTools: string[] | undefined,
): ToolSelection {
	const metadata = new Map<string, CompiledToolProvider>();
	let selectedTools: string[] | undefined;

	for (const scope of scopes) {
		if (scope === undefined || !Array.isArray(scope)) continue;
		selectedTools = [];
		for (const tool of scope) {
			const name = toolNameForSpec(tool);
			if (name === undefined) continue;
			if (typeof tool !== "string") {
				const provider = providerFromToolObject(tool);
				if (provider)
					metadata.set(name, mergeToolProviders(metadata.get(name), provider));
			}
			selectedTools.push(name);
		}
	}

	const tools = selectedTools ?? fallbackTools;
	return { tools, toolProviders: providersForSelectedTools(tools, metadata) };
}

export function providersForSelectedTools(
	tools: string[] | undefined,
	metadata: Map<string, CompiledToolProvider>,
): Record<string, CompiledToolProvider> | undefined {
	if (!tools || tools.length === 0) return undefined;
	const providers: Record<string, CompiledToolProvider> = {};
	for (const tool of tools) {
		const provider = metadata.get(tool);
		if (provider && hasProviderMetadata(provider))
			providers[tool] = cloneToolProvider(provider);
	}
	return Object.keys(providers).length > 0 ? providers : undefined;
}

export function cloneToolProvider(
	provider: CompiledToolProvider,
): CompiledToolProvider {
	return {
		...(provider.classification !== undefined
			? { classification: provider.classification }
			: {}),
		...(provider.optional !== undefined ? { optional: provider.optional } : {}),
		...(provider.fallbackTools !== undefined
			? { fallbackTools: [...provider.fallbackTools] }
			: {}),
	};
}

export function hasProviderMetadata(provider: CompiledToolProvider): boolean {
	return (
		provider.classification !== undefined ||
		provider.optional !== undefined ||
		provider.fallbackTools !== undefined
	);
}

export function effectiveToolClassification(
	tool: string,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): TaskCapability | undefined {
	const providerClassification = toolProviders?.[tool]?.classification;
	const builtinClassification = builtinToolMetadata(tool)?.classification;
	const floor = NON_DOWNGRADABLE_TOOL_FLOORS[tool];
	return maxClassification(
		floor,
		builtinClassification,
		providerClassification,
	);
}

/** Trusted network posture for an effective selected tool. */
export function toolNetworkCapability(
	tool: string,
): "local" | "network" | "unknown" {
	if (NETWORK_CAPABLE_TOOLS.has(tool)) return "network";
	if (KNOWN_LOCAL_TOOLS.has(tool)) return "local";
	return "unknown";
}

export function classifyToolCapability(
	tools: string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	readOnlyDeclared: boolean,
	options: ClassifyToolCapabilityOptions = {},
): TaskCapability {
	if (tools === undefined)
		return options.unspecifiedToolsCapability ?? "write-capable";
	if (tools.length === 0)
		return options.emptyToolsCapability ?? "write-capable";
	if (
		tools.some(
			(tool) =>
				effectiveToolClassification(tool, toolProviders) ===
					"mutation-capable" ||
				effectiveToolClassification(tool, toolProviders) === undefined,
		)
	) {
		return "mutation-capable";
	}
	if (
		tools.some(
			(tool) =>
				effectiveToolClassification(tool, toolProviders) === "write-capable",
		)
	)
		return "write-capable";
	return readOnlyDeclared ? "read-only" : "write-capable";
}

export function buildAvailableToolView(
	tools?: readonly string[],
	toolProviders?: Record<string, CompiledToolProvider>,
): AvailableToolViewItem[] {
	const names = new Set<string>(Object.keys(BUILTIN_TOOL_METADATA));
	for (const tool of tools ?? []) names.add(tool);
	for (const tool of Object.keys(toolProviders ?? {})) names.add(tool);
	return [...names].sort().map((name) => {
		const provider = toolProviders?.[name];
		const merged = mergeToolProviders(
			builtinToolMetadata(name),
			provider ?? {},
		);
		return {
			name,
			classification: effectiveToolClassification(name, toolProviders),
			...(merged.optional !== undefined ? { optional: merged.optional } : {}),
			...(merged.fallbackTools !== undefined
				? { fallbackTools: [...merged.fallbackTools] }
				: {}),
			builtin: builtinToolMetadata(name) !== undefined,
			...(NON_DOWNGRADABLE_TOOL_FLOORS[name]
				? { floor: NON_DOWNGRADABLE_TOOL_FLOORS[name] }
				: {}),
		};
	});
}

export function validateToolAuthority(
	tools: readonly string[] | undefined,
	options: ToolAuthorityValidationOptions = {},
): string[] {
	const errors: string[] = [];
	if (!tools) return errors;
	const allowed = options.allowedTools
		? new Set(options.allowedTools)
		: undefined;
	for (const tool of tools) {
		if (allowed && !allowed.has(tool)) {
			errors.push(`tool "${tool}" is outside the allowed tool ceiling`);
			continue;
		}
		if (
			!options.allowUnknownTools &&
			effectiveToolClassification(tool, options.toolProviders) === undefined
		) {
			errors.push(`tool "${tool}" has no trusted classification`);
		}
	}
	return errors;
}

function maxClassification(
	...values: Array<TaskCapability | undefined>
): TaskCapability | undefined {
	let best: TaskCapability | undefined;
	for (const value of values) {
		if (!value) continue;
		if (
			!best ||
			TOOL_CLASSIFICATION_RANK[value] > TOOL_CLASSIFICATION_RANK[best]
		)
			best = value;
	}
	return best;
}
