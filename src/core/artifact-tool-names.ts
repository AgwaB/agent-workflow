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
	Record<"claude" | "codex" | "pi" | "antigravity", ArtifactToolNameMapping>
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
	antigravity: {
		executorId: "antigravity",
		visibleName: PREFIXED,
		rule: "MCP tools are called through call_mcp_tool(ServerName, ToolName, Arguments); the model resolves mcp__<server>__<tool> to them",
		evidence:
			"agy_acp_server 1.4.5 live 2026-11-02 (docs/executors/acp.md): told to call mcp__workflow_artifact__echo of a stub server named workflow_artifact, the model read the tool schema and called call_mcp_tool(ServerName workflow_artifact, ToolName echo); the stub logged the call",
		verified: true,
	},
};

export function artifactToolNameMapping(
	executorId: string,
): ArtifactToolNameMapping | undefined {
	return Object.hasOwn(ARTIFACT_TOOL_NAME_MAPPINGS, executorId)
		? ARTIFACT_TOOL_NAME_MAPPINGS[
				executorId as keyof typeof ARTIFACT_TOOL_NAME_MAPPINGS
			]
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
	Record<"claude" | "codex" | "antigravity", Readonly<Record<string, string>>>
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
	// agy_acp_server 1.4.5 (live 2026-11-02): the model lists view_file, write_to_file,
	// replace_file_content, run_command, search_web, read_url_content (no list/grep/find tool; asked
	// to call list_dir/grep_search/find_by_name or list_directory/search_directory/find_file, it
	// reported them unavailable). run_command is an execute request; on a read-only stage only a
	// plain read-only command passes (sdk/shell-readonly.ts).
	antigravity: {
		read: "view_file",
		grep: "run_command with rg or grep (one plain command: no pipes, redirects, $ or globs on a read-only stage)",
		find: "run_command with find (no -exec/-delete on a read-only stage; quote name patterns)",
		ls: "run_command with ls or tree",
		bash: "run_command",
		edit: "replace_file_content",
		write: "write_to_file",
		web_search: "search_web",
		fetch_content: "read_url_content",
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
		? WORKER_TOOL_NAME_MAPPINGS[
				executorId as keyof typeof WORKER_TOOL_NAME_MAPPINGS
			]
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
 * WP37 (stage-1 open problem 8): inline renames of logical tool names in task prompts, per executor.
 * Only executors whose CLI tools have plain names are listed (Claude, from the adapter's tool
 * mapping, docs/executors/claude.md). Codex maps the logical names to the shell and the hosted
 * `web_search` tool, which are not names a sentence can use in place of `read`; its task prompts
 * keep the logical names and get the M17 note. Pi uses the logical names.
 */
export const WORKER_TASK_TOOL_RENAMES: Readonly<
	Record<"claude", Readonly<Record<string, string>>>
> = {
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

// Logical tool names a task prompt may mention. `read`, `find`, `edit` and `write` are also plain
// words: they count as tool names only inside a tool list (below). The others count anywhere.
const TASK_TOOL_NAMES = [
	"web_search",
	"fetch_content",
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
] as const;
const UNAMBIGUOUS_TASK_TOOL_NAMES = new Set([
	"web_search",
	"fetch_content",
	"grep",
	"ls",
	"bash",
]);
const TASK_TOOL_NAME = `(?:${TASK_TOOL_NAMES.join("|")})`;
const TASK_TOOL_LIST_SEPARATOR = String.raw`(?:\s*/\s*|,\s+(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)`;
const TASK_TOOL_BEFORE = String.raw`(?<![A-Za-z0-9_./-])`;
const TASK_TOOL_AFTER = String.raw`(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])`;
/** `read/grep/find/ls`, `read, grep, find, or ls`, `web_search and fetch_content`. */
const TASK_TOOL_LIST = new RegExp(
	`${TASK_TOOL_BEFORE}${TASK_TOOL_NAME}(?:${TASK_TOOL_LIST_SEPARATOR}${TASK_TOOL_NAME})+${TASK_TOOL_AFTER}`,
	"gu",
);
const TASK_TOOL_LIST_PARTS = new RegExp(
	`(${TASK_TOOL_NAME})|(${TASK_TOOL_LIST_SEPARATOR})`,
	"gu",
);
const TASK_TOOL_STANDALONE = new RegExp(
	`${TASK_TOOL_BEFORE}(?:${[...UNAMBIGUOUS_TASK_TOOL_NAMES].join("|")})${TASK_TOOL_AFTER}`,
	"gu",
);

/** A list of tool names is a tool list when it names an unambiguous tool or at least three. */
function taskToolList(
	text: string,
): { names: string[]; separators: string[] } | undefined {
	const names: string[] = [];
	const separators: string[] = [];
	for (const part of text.matchAll(TASK_TOOL_LIST_PARTS)) {
		if (part[1] !== undefined) names.push(part[1]);
		else if (part[2] !== undefined) separators.push(part[2]);
	}
	if (names.length < 2 || separators.length !== names.length - 1)
		return undefined;
	if (
		names.length < 3 &&
		!names.some((name) => UNAMBIGUOUS_TASK_TOOL_NAMES.has(name))
	)
		return undefined;
	return { names, separators };
}

/** Codex code mode (live 4b): MCP tools are functions inside the model's `exec` cell. */
function codexCodeModeNote(visibleName: string): string {
	return `In Codex code mode an MCP tool is a function inside the exec cell: call ${visibleName} as tools.${visibleName}(…).`;
}

/**
 * WP37 (stage-1 open problem 8): renders a worker **task** prompt for `executorId` with the same
 * mapping the system prompt uses ({@link renderWorkerPromptToolNames}, M17).
 * - Pi and unknown executors: only the artifact tool's visible name (as before).
 * - Claude: logical tool names become Claude's tool names inline (`web_search` → `WebSearch`,
 *   `read/grep/find/ls` → `Read/Grep/Glob`). `read`, `find`, `edit` and `write` are renamed only
 *   inside a tool list, so prose ("read the brief") stays.
 * - Codex: the logical names stay and the M17 mapping note for the mentioned tools is appended,
 *   plus the code-mode form of the artifact tool when the prompt names it (live 4b).
 * Tools mentioned but not renamed get the note on Claude too. Idempotent.
 */
export function renderWorkerTaskPromptToolNames(
	text: string,
	executorId: string,
): string {
	const rendered = renderWorkerPromptToolNames(text, executorId);
	if (!Object.hasOwn(WORKER_TOOL_NAME_MAPPINGS, executorId)) return rendered;
	const marker = `\n\n${TOOL_MAPPING_NOTE_PREFIX}${executorId})`;
	if (rendered.includes(marker)) return rendered;
	const renames: Readonly<Record<string, string>> = Object.hasOwn(
		WORKER_TASK_TOOL_RENAMES,
		executorId,
	)
		? WORKER_TASK_TOOL_RENAMES[executorId as "claude"]
		: {};
	const mentioned: Array<{ at: number; name: string }> = [];
	let out = rendered.replace(TASK_TOOL_LIST, (match, offset: number) => {
		const list = taskToolList(match);
		if (!list) return match;
		if (!list.names.every((name) => Object.hasOwn(renames, name))) {
			for (const name of list.names) mentioned.push({ at: offset, name });
			return match;
		}
		const kept = [...new Set(list.names.map((name) => renames[name]!))];
		const separators = list.separators.slice(
			list.separators.length - (kept.length - 1),
		);
		return kept
			.map((name, index) => (index === 0 ? name : separators[index - 1] + name))
			.join("");
	});
	// Snake-case names are never prose: rename them anywhere. grep/ls/bash outside a list (a
	// command line, say) stay and are mapped by the note.
	out = out.replace(TASK_TOOL_STANDALONE, (name, offset: number) => {
		if (Object.hasOwn(renames, name) && name.includes("_"))
			return renames[name]!;
		mentioned.push({ at: offset, name });
		return name;
	});
	const names = [
		...new Set(
			mentioned.sort((a, b) => a.at - b.at).map((entry) => entry.name),
		),
	];
	const note = workerToolMappingNote(names, executorId);
	const visible = artifactToolVisibleName(executorId);
	const parts = [
		...(note ? [note] : []),
		...(executorId === "codex" && out.includes(visible)
			? [codexCodeModeNote(visible)]
			: []),
	];
	return parts.length === 0 ? out : `${out}\n\n${parts.join(" ")}`;
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
