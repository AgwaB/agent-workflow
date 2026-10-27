// New in agent-workflow (WP5, moved to core in WP10): how each executor's CLI surfaces the
// workflow_artifact MCP tool to the model, and the worker-prompt renderer that resolves the
// logical tool name to that visible name. `src/mcp/visible-names.ts` re-exports the mapping (core
// may import only its own siblings).
import {
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_GUIDELINES,
	WORKFLOW_ARTIFACT_TOOL_NAME,
} from "./artifact-access.js";

export interface ArtifactToolNameMapping {
	readonly executorId: string;
	/** Name the model sees and calls. */
	readonly visibleName: string;
	/** Naming rule the visible name was derived from. */
	readonly rule: string;
	/** Where the rule was taken from (documentation, CLI build inspected, live run). */
	readonly evidence: string;
	/** `true` only after a live run of that CLI called the tool by this name (WP6–WP8). */
	readonly verified: boolean;
}

/** `mcp__<server>__<tool>` with every char outside `[A-Za-z0-9_]` replaced by `_`. */
export function mcpPrefixedToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/gu, "_");
}

const PREFIXED = mcpPrefixedToolName(
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_NAME,
);

export const ARTIFACT_TOOL_NAME_MAPPINGS: Readonly<
	Record<"claude" | "codex" | "pi", ArtifactToolNameMapping>
> = {
	claude: {
		executorId: "claude",
		visibleName: PREFIXED,
		rule: "mcp__<server>__<tool>",
		evidence:
			"Claude Code MCP documentation; live WP8 #10 (docs/executors/claude.md): the model called mcp__workflow_artifact__workflow_artifact against the real artifact server (1 ledger row)",
		verified: true,
	},
	codex: {
		executorId: "codex",
		visibleName: PREFIXED,
		rule: "mcp__<server>__<tool> (unless the non_prefixed_mcp_tool_names feature is on)",
		evidence:
			"codex-cli 0.159.2 build strings; live WP7 #2 (docs/executors/codex.md): the model called mcp__workflow_artifact__workflow_artifact",
		verified: true,
	},
	pi: {
		executorId: "pi",
		visibleName: PREFIXED,
		rule: "mcp__<server>__<tool>, chars outside [A-Za-z0-9_] → _, hash suffix on collision",
		evidence:
			"Pi 1.1.0 docs/mcp.md and createMcpToolName; live WP6 #4 (docs/executors/pi.md): the model called mcp__workflow_artifact__workflow_artifact",
		verified: true,
	},
};

export function artifactToolNameMapping(
	executorId: string,
): ArtifactToolNameMapping | undefined {
	return Object.hasOwn(ARTIFACT_TOOL_NAME_MAPPINGS, executorId)
		? ARTIFACT_TOOL_NAME_MAPPINGS[executorId as "claude" | "codex" | "pi"]
		: undefined;
}

/**
 * Name the worker model should call for `executorId`. Unknown executors get the common
 * `mcp__<server>__<tool>` convention (unverified for them).
 */
export function artifactToolVisibleName(executorId: string): string {
	return artifactToolNameMapping(executorId)?.visibleName ?? PREFIXED;
}

/**
 * Explicit placeholder for the artifact tool name in prompts. Workflow prompts may also use the
 * bare logical name `workflow_artifact`; both render to the executor's visible name.
 */
export const WORKFLOW_ARTIFACT_TOOL_PLACEHOLDER = "{{workflow_artifact}}";

// The logical name as a tool mention: not part of a longer identifier (so the visible name
// `mcp__workflow_artifact__workflow_artifact` and `workflow_artifact_*` stay as they are) and not a
// `workflow_artifact:<task>` evidence locator (dynamic audit / refs syntax, not a tool name).
const LOGICAL_ARTIFACT_TOOL_MENTION =
	/(?<![A-Za-z0-9_])workflow_artifact(?![A-Za-z0-9_:])/gu;

/**
 * Live bundle 3: how the logical (Pi-vocabulary) tool names of a stage's `tools` list surface on
 * executors whose CLI names them differently. Taken from the adapters' tool mappings
 * (`docs/executors/codex.md` and `docs/executors/claude.md` "Tool mapping"). Pi uses the logical
 * names as they are, so it has no row. Codex has no `read`/`grep`/`find`/`ls` tools: a Codex worker
 * told "only read, grep, find, ls are enabled" concluded it could not read files (spec-review
 * extract-spec reported SPEC.md "unavailable").
 */
export const WORKER_TOOL_NAME_MAPPINGS: Readonly<
	Record<"claude" | "codex", Readonly<Record<string, string>>>
> = {
	codex: {
		read: "the shell tool with a read-only command (cat, sed -n)",
		grep: "the shell tool (rg or grep)",
		find: "the shell tool (rg --files or find)",
		ls: "the shell tool (ls)",
		bash: "the shell tool",
		edit: "apply_patch",
		write: "apply_patch",
		web_search: "the web_search tool",
		fetch_content: "the web_search tool (open a page)",
	},
	claude: {
		read: "Read",
		grep: "Grep",
		find: "Glob",
		ls: "Glob",
		bash: "Bash",
		edit: "Edit",
		write: "Write",
		web_search: "WebSearch",
		fetch_content: "WebFetch",
	},
};

const ENABLED_TOOLS_LINE =
	/^Only these tools are enabled for this workflow task: (.+)\.$/mu;
const TOOL_MAPPING_NOTE_PREFIX = "On this executor (";

/**
 * The note that tells a worker how the enabled logical tool names surface on `executorId`, or
 * `undefined` when the executor uses the logical names (Pi, unknown executors) or no listed tool
 * has a different name.
 */
export function workerToolMappingNote(
	tools: readonly string[],
	executorId: string,
): string | undefined {
	const mapping = Object.hasOwn(WORKER_TOOL_NAME_MAPPINGS, executorId)
		? WORKER_TOOL_NAME_MAPPINGS[executorId as "claude" | "codex"]
		: undefined;
	if (!mapping) return undefined;
	const rows = tools
		.filter((tool) => Object.hasOwn(mapping, tool))
		.map((tool) => `${tool} → ${mapping[tool]}`);
	if (rows.length === 0) return undefined;
	return `${TOOL_MAPPING_NOTE_PREFIX}${executorId}) these tool names are provided as: ${rows.join("; ")}. Use them for the listed tools; the stage's read-only and tool limits still apply.`;
}

/**
 * Renders the artifact tool name of a worker prompt for `executorId`: the placeholder and every
 * bare `workflow_artifact` tool mention become `artifactToolVisibleName(executorId)`. Evidence
 * locators (`workflow_artifact:<id>`) are left unchanged. After the system prompt's enabled-tools
 * line it adds {@link workerToolMappingNote} for executors that name the tools differently.
 * Idempotent.
 */
export function renderWorkerPromptToolNames(
	text: string,
	executorId: string,
): string {
	const visible = artifactToolVisibleName(executorId);
	const rendered = text
		.split(WORKFLOW_ARTIFACT_TOOL_PLACEHOLDER)
		.join(WORKFLOW_ARTIFACT_TOOL_NAME)
		.replace(LOGICAL_ARTIFACT_TOOL_MENTION, visible);
	const match = ENABLED_TOOLS_LINE.exec(rendered);
	if (!match || match.index === undefined) return rendered;
	const lineEnd = match.index + match[0].length;
	if (rendered.startsWith(`\n${TOOL_MAPPING_NOTE_PREFIX}`, lineEnd))
		return rendered;
	const note = workerToolMappingNote(match[1]!.split(", "), executorId);
	if (!note) return rendered;
	return `${rendered.slice(0, lineEnd)}\n${note}${rendered.slice(lineEnd)}`;
}

/**
 * Worker-prompt section with the artifact tool guidelines. MCP clients do not all show server
 * `instructions` to the model (Pi 1.1 does not), so the task backend puts them in the system
 * prompt of every task that has the artifact server. Uses the logical name; render it with
 * `renderWorkerPromptToolNames`.
 */
export function workflowArtifactToolGuidelinesSection(): string[] {
	return [
		"# Workflow Artifact Tool",
		...WORKFLOW_ARTIFACT_TOOL_GUIDELINES.map((line) => `- ${line}`),
	];
}
