/**
 * Google Antigravity ACP server specifics (agy_acp_server; reference study
 * internal acp-references-20261102, live checks 2026-11-02 on 1.4.5).
 *
 * - Tool results: for MCP tools the ACP `rawOutput` is a display summary ("Echo tool"), not the
 *   result. The server records each turn in `<GEMINI_HOME>/antigravity-acp/brain/<session>/
 *   .system_generated/logs/transcript_full.jsonl` before `session/prompt` returns: a
 *   PLANNER_RESPONSE step lists the calls (`call_mcp_tool` with ServerName/ToolName/Arguments) and
 *   the following steps hold their results; a large result is saved to
 *   `.system_generated/steps/<n>/output.txt` and the step names that file (live: all 200,000
 *   chars). Shell output is cut by the server itself; its rawOutput object keeps the most and is
 *   left as it is.
 * - Failures that arrive as an answer (OpenBot `acp-flavor-antigravity.ts:7-11`, against 1.3.0 /
 *   1.4.4; not observed here): a spent quota, an SDK execution error, an MCP server that failed to
 *   start.
 * - Inherited environment that would switch the account, project or harness (Orca
 *   `antigravity-acp-environment.ts:10-28`).
 */
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FailureClass } from "../../sdk/errors.js";
import type { ToolMapping } from "../../sdk/tools.js";
import type { AgentToolResult, SummaryCall } from "./config.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Same JSON for the same value whatever the key order. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value ?? null);
}

function mcpKey(server: string, tool: string, args: unknown): string {
	return `${server}\u0000${tool}\u0000${stableJson(args ?? {})}`;
}

/**
 * A completed call whose rawOutput is only a summary: an engine MCP tool (title `<server>_<tool>`,
 * rawInput `{ arguments }`) reporting a string. Returns its match key, else undefined.
 */
/**
 * The built-in a tool report is about: permission/tool titles read "Run read_url_content?" or
 * "Running view_file" (live 1.4.5); MCP calls ("<server>_<tool>") and descriptive titles stay as
 * they are. Lets evidence receipts and policies see the tool's real name.
 */
export function antigravityToolName(title: string): string {
	const name = /^(?:Run|Running) ([a-z_]+)\??$/.exec(title.trim())?.[1];
	return name !== undefined && ANTIGRAVITY_FILTER_TOOLS.includes(name)
		? name
		: title;
}

/** Engine kinds for built-ins whose ACP kind differs from the Pi tool they serve (web_search → fetch). */
export function antigravityPermissionKind(title: string, kind: string): string {
	return antigravityToolName(title) === "search_web" ? "fetch" : kind;
}

const urlKey = (url: string) => `read_url_content\u0000${url.trim()}`;

export function antigravitySummaryKey(
	call: SummaryCall,
	mcpServers: readonly string[],
): string | undefined {
	if (typeof call.rawOutput !== "string") return undefined;
	// read_url_content reports a title ("Fetch globals docs"); the page is in a step file.
	if (call.title === "read_url_content") {
		// rawInput is {Url} on the tool_call and {url, title, summary, content_path} once it runs
		// (live deep-research run, 2026-11-02).
		const url = isRecord(call.input)
			? (call.input.Url ?? call.input.url)
			: undefined;
		return typeof url === "string" ? urlKey(url) : undefined;
	}
	const server = [...mcpServers]
		.sort((a, b) => b.length - a.length)
		.find((name) => call.title.startsWith(`${name}_`));
	if (server === undefined) return undefined;
	const input = call.input;
	if (!isRecord(input) || !isRecord(input.arguments)) return undefined;
	return mcpKey(server, call.title.slice(server.length + 1), input.arguments);
}

const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const RESULT_MAX_BYTES = 8 * 1024 * 1024;

/** Transcript values are objects in transcript_full.jsonl, JSON strings in transcript.jsonl. */
function jsonish(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

async function resultText(
	content: string,
	sessionDir: string,
): Promise<string> {
	const body = content.replace(
		/^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?\n?/,
		"",
	);
	// "The output was large and was saved to: file://…" (MCP) or "…has been saved to: /abs/…/content.md"
	// (read_url_content).
	// The read_url_content notice goes on: "…\n\nYou can use the view_file tool to read specific
	// sections if needed." (live 2026-11-02).
	const saved =
		/(?:The output was large and was saved to|has been saved to): (\S+)/.exec(
			body,
		);
	if (saved?.[1] === undefined) return body;
	const named = saved[1].replace(/[.,;]$/, "");
	// Only the session's own step files, never a path elsewhere the transcript might name.
	const target = named.startsWith("file://") ? fileURLToPath(named) : named;
	if (!isAbsolute(target)) return body;
	const path = await realpath(target);
	const root = await realpath(sessionDir);
	if (!path.startsWith(`${root}${sep}`)) return body;
	const info = await stat(path);
	const bytes = await readFile(path);
	const text = bytes.subarray(0, RESULT_MAX_BYTES).toString("utf8");
	return info.size > RESULT_MAX_BYTES
		? `${text}\n[agent-workflow: result clipped at ${RESULT_MAX_BYTES} of ${info.size} bytes]`
		: text;
}

/** MCP results of the session's last turn, in order, keyed like `antigravitySummaryKey`. */
export async function readAntigravityToolResults(
	agentHome: string,
	sessionId: string,
): Promise<AgentToolResult[]> {
	if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return [];
	const sessionDir = join(agentHome, "antigravity-acp", "brain", sessionId);
	const file = join(
		sessionDir,
		".system_generated",
		"logs",
		"transcript_full.jsonl",
	);
	const info = await stat(file).catch(() => undefined);
	if (info === undefined || info.size > TRANSCRIPT_MAX_BYTES) return [];
	const rows: Record<string, unknown>[] = [];
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (line.trim() === "") continue;
		try {
			const row = JSON.parse(line) as unknown;
			if (isRecord(row)) rows.push(row);
		} catch {}
	}
	let start = -1;
	rows.forEach((row, index) => {
		if (row.type === "USER_INPUT") start = index;
	});
	// Each call of a PLANNER_RESPONSE is answered, in order, by one of the steps that follow it.
	const calls: Record<string, unknown>[] = [];
	const results: AgentToolResult[] = [];
	for (const row of rows.slice(start + 1)) {
		if (row.type === "PLANNER_RESPONSE") {
			if (Array.isArray(row.tool_calls))
				for (const call of row.tool_calls) if (isRecord(call)) calls.push(call);
			continue;
		}
		const call = calls.shift();
		if (
			call?.name === "read_url_content" &&
			row.type === "READ_URL_CONTENT" &&
			row.status === "DONE" &&
			typeof row.content === "string"
		) {
			const url = isRecord(call.args) ? jsonish(call.args.Url) : undefined;
			const text = await resultText(row.content, sessionDir).catch(
				() => undefined,
			);
			if (typeof url === "string" && text !== undefined)
				results.push({ key: urlKey(url), text });
			continue;
		}
		if (call === undefined || call.name !== "call_mcp_tool") continue;
		if (
			row.type !== "MCP_TOOL" ||
			row.status !== "DONE" ||
			typeof row.content !== "string"
		)
			continue;
		const args = isRecord(call.args) ? call.args : {};
		const server = jsonish(args.ServerName);
		const tool = jsonish(args.ToolName);
		if (typeof server !== "string" || typeof tool !== "string") continue;
		const text = await resultText(row.content, sessionDir).catch(
			() => undefined,
		);
		if (text !== undefined)
			results.push({
				key: mcpKey(server, tool, jsonish(args.Arguments)),
				text,
			});
	}
	return results;
}

const QUOTA = /^\s*Usage Limit Reached\n\n([\s\S]*)$/u;
const EXECUTION_ERROR = /^\s*Agent execution error: ([\s\S]*)$/u;
const MCP_LOAD =
	/^\s*The MCP server '([A-Za-z0-9_-]+)' failed to initialize\b([\s\S]*)$/u;

/** An answer that is the server's failure report, not the model's work. */
export function antigravityAnswerFailure(
	text: string,
	classify: (message: string) => FailureClass,
): { readonly class: FailureClass; readonly message: string } | undefined {
	const clip = (value: string) => value.trim().slice(0, 500);
	const quota = QUOTA.exec(text);
	if (quota)
		return {
			class: "rate_limit",
			message: `Antigravity usage limit reached: ${clip(quota[1] ?? "")}`,
		};
	const mcp = MCP_LOAD.exec(text);
	if (mcp)
		return {
			class: "unknown",
			message: `Antigravity: MCP server ${mcp[1]} failed to initialize${clip(mcp[2] ?? "")}`,
		};
	const execution = EXECUTION_ERROR.exec(text);
	if (execution) {
		const detail = clip(execution[1] ?? "");
		return {
			class: classify(detail),
			message: `Antigravity agent execution error: ${detail}`,
		};
	}
	return undefined;
}

/**
 * The server finds its `localharness_external` beside itself; started through a symlink (e.g.
 * `~/.local/bin/agy_acp_server`) it needs ANTIGRAVITY_HARNESS_PATH (agent-orchestrator
 * `agyacp/resolve.go`, which sets it the same way).
 */
export async function antigravityLaunchEnv(
	command: string,
): Promise<Record<string, string>> {
	const candidates = isAbsolute(command)
		? [command]
		: command.includes(sep)
			? []
			: (process.env.PATH ?? "")
					.split(delimiter)
					.filter((dir) => dir !== "")
					.map((dir) => join(dir, command));
	for (const path of candidates) {
		const real = await realpath(path).catch(() => undefined);
		if (real === undefined) continue;
		if (real === path) return {};
		const harness = join(dirname(real), "localharness_external");
		return (await access(harness).then(
			() => true,
			() => false,
		))
			? { ANTIGRAVITY_HARNESS_PATH: harness }
			: {};
	}
	return {};
}

/** agy_acp_server version the live tier passed on (docs/executors/acp.md). */
export const ANTIGRAVITY_VERIFIED_SERVER_VERSION = "1.4.5";

/**
 * Names the server's per-session tool filter knows (agy_acp_server 1.4.5 no-model probe: it warns
 * "Unknown tool name" for anything else; they are the SDK BuiltinTools names, not the names the model
 * sees, e.g. `create_file` is shown as write_to_file).
 */
export const ANTIGRAVITY_FILTER_TOOLS: readonly string[] = [
	"ask_question",
	"create_file",
	"edit_file",
	"find_file",
	"finish",
	"generate_image",
	"invoke_subagent",
	"list_directory",
	"read_url_content",
	"run_command",
	"run_workflow",
	"schedule",
	"search_directory",
	"search_web",
	"view_file",
];

/**
 * Pi tool names → Antigravity built-ins. grep/find/ls go through `run_command` (1.4.5 offers no
 * list/search tool even when enabled), so the allowlist is coarse: a stage with grep can run any
 * command it is allowed to (readOnly stages: plain read-only commands only, sdk/shell-readonly.ts).
 * Web tools are not wired: their results are not captured as evidence yet (webTools none).
 */
export const ANTIGRAVITY_TOOL_MAPPING: ToolMapping = {
	executorId: "antigravity",
	entries: {
		read: { type: "tool", names: ["view_file"] },
		grep: { type: "tool", names: ["run_command"] },
		find: { type: "tool", names: ["run_command"] },
		ls: { type: "tool", names: ["run_command"] },
		bash: { type: "tool", names: ["run_command"] },
		edit: { type: "tool", names: ["edit_file"] },
		write: { type: "tool", names: ["create_file"] },
		// search_web returns a grounded summary with links (receipt form search-results);
		// read_url_content saves the page as Markdown in a step file, released as its output.
		web_search: { type: "tool", names: ["search_web"] },
		fetch_content: { type: "tool", names: ["read_url_content"] },
		workflow_artifact: {
			type: "mcp",
			server: "workflow_artifact",
			tool: "workflow_artifact",
		},
	},
};

/**
 * Session `_meta` for a request: `enabledTools` is an allowlist of built-ins (live 2026-11-02: only
 * the listed tools were offered; engine MCP tools are not affected). It holds the request's mapped
 * tools (readOnly: without the writing ones). Everything else is off, including run_workflow
 * (its startup SKILL.md write), schedule, invoke_subagent and ask_question (no one answers an
 * unattended worker). With no built-in left, every known tool is disabled instead (an empty
 * allowlist's meaning is unverified). `_meta.agy` is logged as legacy; `_meta.antigravity` is used.
 */
export function antigravitySessionMeta(req: {
	readonly tools: readonly string[];
	readonly readOnly: boolean;
}): Record<string, unknown> {
	const enabled = new Set<string>();
	for (const tool of req.tools) {
		const entry = ANTIGRAVITY_TOOL_MAPPING.entries[tool];
		if (entry?.type !== "tool") continue;
		for (const name of entry.names)
			if (!(req.readOnly && (name === "edit_file" || name === "create_file")))
				enabled.add(name);
	}
	return enabled.size > 0
		? { antigravity: { enabledTools: [...enabled].sort() } }
		: { antigravity: { disabledTools: [...ANTIGRAVITY_FILTER_TOOLS] } };
}

/** Inherited variables that would switch the account, project or harness of an isolated worker. */
export function antigravityInheritedEnvBlocked(key: string): boolean {
	return (
		key === "GEMINI_API_KEY" ||
		key === "ANTIGRAVITY_HARNESS_PATH" ||
		key === "GCLOUD_PROJECT" ||
		key === "CLOUDSDK_CORE_PROJECT" ||
		key.startsWith("GOOGLE_") ||
		key.startsWith("AGY_ACP_")
	);
}
