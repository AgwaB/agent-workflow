/**
 * Pi tool name → executor tool mapping (stage-1 plan §2.4, owner decision "Pi 도구 이름 매핑").
 * Workflow specs name tools with Pi names; each adapter ships a mapping table. A tool without a
 * mapping is recorded as `none` and handled by B4 (degrade to readOnly if the spec allows, else refuse).
 */
import type { ToolKind } from "./events.js";

export const PI_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"web_search",
	"fetch_content",
	"workflow_artifact",
] as const;
export type PiToolName = (typeof PI_TOOL_NAMES)[number];

/** ACP tool kind of each Pi tool; drives readOnly enforcement and approval policy. */
export const PI_TOOL_KINDS: Readonly<Record<PiToolName, ToolKind>> = {
	read: "read",
	grep: "search",
	find: "search",
	ls: "read",
	bash: "execute",
	edit: "edit",
	write: "edit",
	web_search: "fetch",
	fetch_content: "fetch",
	workflow_artifact: "read",
};

/** Kinds that change state. Denied in readOnly stages (D2, R#4). */
export const MUTATING_TOOL_KINDS: readonly ToolKind[] = [
	"edit",
	"delete",
	"move",
	"execute",
];

export function isMutatingKind(kind: ToolKind): boolean {
	return MUTATING_TOOL_KINDS.includes(kind);
}

export type SandboxMode = "read-only" | "workspace-write";

export type ToolMappingEntry =
	/** Fine-grained: one or more executor-native tool names (e.g. Claude `Read`). */
	| { readonly type: "tool"; readonly names: readonly string[] }
	/** Coarse: only expressible as a sandbox mode (e.g. Codex). */
	| { readonly type: "sandbox"; readonly mode: SandboxMode }
	/** Provided through an engine-injected MCP server. */
	| { readonly type: "mcp"; readonly server: string; readonly tool: string }
	/** Explicitly unavailable on this executor. */
	| { readonly type: "none"; readonly reason?: string };

export interface ToolMapping {
	readonly executorId: string;
	/** Keyed by Pi tool name (custom names allowed). Missing keys count as `none`. */
	readonly entries: Readonly<Record<string, ToolMappingEntry>>;
	/** Kinds for non-Pi tool names; Pi names fall back to PI_TOOL_KINDS, others to `other`. */
	readonly kinds?: Readonly<Record<string, ToolKind>>;
}

export interface ToolMappingResult {
	readonly executorTools: readonly string[];
	readonly mcpTools: readonly {
		readonly server: string;
		readonly tool: string;
	}[];
	/** Strongest sandbox mode any requested tool needs, or null when no tool maps to a sandbox. */
	readonly sandbox: SandboxMode | null;
	/** Requested tools with no mapping (or an explicit `none`). */
	readonly unmapped: readonly string[];
	/** Whether any requested tool is of a mutating kind. */
	readonly mutating: boolean;
	readonly kinds: Readonly<Record<string, ToolKind>>;
}

export function toolKind(name: string, mapping?: ToolMapping): ToolKind {
	const custom = mapping?.kinds?.[name];
	if (custom !== undefined) return custom;
	return (PI_TOOL_NAMES as readonly string[]).includes(name)
		? PI_TOOL_KINDS[name as PiToolName]
		: "other";
}

export function mapTools(
	requested: readonly string[],
	mapping: ToolMapping,
): ToolMappingResult {
	const executorTools: string[] = [];
	const mcpTools: { server: string; tool: string }[] = [];
	const unmapped: string[] = [];
	const kinds: Record<string, ToolKind> = {};
	let sandbox: SandboxMode | null = null;
	let mutating = false;
	for (const name of new Set(requested)) {
		const kind = toolKind(name, mapping);
		kinds[name] = kind;
		if (isMutatingKind(kind)) mutating = true;
		const entry = Object.hasOwn(mapping.entries, name)
			? mapping.entries[name]
			: undefined;
		if (entry === undefined || entry.type === "none") {
			unmapped.push(name);
			continue;
		}
		if (entry.type === "tool") {
			for (const native of entry.names)
				if (!executorTools.includes(native)) executorTools.push(native);
		} else if (entry.type === "sandbox") {
			if (entry.mode === "workspace-write" || sandbox === null)
				sandbox = entry.mode;
		} else if (
			!mcpTools.some(
				(tool) => tool.server === entry.server && tool.tool === entry.tool,
			)
		) {
			mcpTools.push({ server: entry.server, tool: entry.tool });
		}
	}
	return { executorTools, mcpTools, sandbox, unmapped, mutating, kinds };
}

/** Identity mapping (the Pi executor uses Pi names natively). */
export function identityToolMapping(
	executorId: string,
	names: readonly string[] = PI_TOOL_NAMES,
): ToolMapping {
	const entries: Record<string, ToolMappingEntry> = {};
	for (const name of names) entries[name] = { type: "tool", names: [name] };
	return { executorId, entries };
}
