#!/usr/bin/env node
// WP14/WP15: generator of the Claude Code and Codex plugin (`plugins/agent-workflow/`) and of the
// repo marketplaces (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`).
// Sources of truth: package.json (version), skills/ (agent-workflow, workflow-guide,
// execution-router), docs/usage.md and the bundled workflow specs. docs/hosts.md#claude-code-and-codex explains the
// layout. Also generates the Pi package skills `plugins/pi/skills/` and validates their
// package.json `pi.skills` entry.
//
//   node tools/release/plugins.mjs build             regenerate the committed plugin + marketplaces
//   node tools/release/plugins.mjs check             exit 1 when the committed files drift
//   node tools/release/plugins.mjs dev <outDir> [--force]
//        write a local marketplace root whose plugin runs this checkout's server
//        (`node <checkout>/src/mcp/host-server/bin.mjs --host …`; needs `npm run build`)
//
// One plugin directory serves both hosts. Each host reads its own manifest, which registers the
// host MCP server with that host's `--host` value:
// - Claude Code: `.claude-plugin/plugin.json` (inline `mcpServers`, `--host claude-code`).
// - Codex: `.codex-plugin/plugin.json` (inline `mcpServers`, `--host codex`). Codex prefers a root
//   Agent Plugins `plugin.json`/`mcp.json`, but Codex 0.159.2 starts portable stdio servers in the
//   plugin root, while the server takes its project from its working directory; the compatibility
//   manifest starts the server in the session directory. So no root portable manifest is written.
// Neither manifest set uses a `.mcp.json` file (Claude Code would load it as a second server).
// WP36: the Claude Code manifest also declares an inline `UserPromptSubmit` hook running
// `agent-workflow notify-check` and `host-command` (no duplicate `hooks/hooks.json`).
import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);
export const PACKAGE_NAME = "@agwab/agent-workflow";
export const PLUGIN_NAME = "agent-workflow";
export const MARKETPLACE_NAME = "agent-workflow";
export const MCP_SERVER_NAME = "agent-workflow";
export const PLUGIN_DIR = "plugins/agent-workflow";
export const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
export const CODEX_MARKETPLACE_FILE = ".agents/plugins/marketplace.json";
export const HOST_IDS = Object.freeze({
	claude: "claude-code",
	codex: "codex",
});
/** Codex: first `npx` start downloads the package. */
export const CODEX_STARTUP_TIMEOUT_SEC = 120;
/**
 * 2026-11-05 (owner: fewer host model turns while waiting): 32 min, so one workflow_wait can wait
 * 30 min; the server is told the same limit (`--tool-timeout-ms`).
 */
export const CODEX_TOOL_TIMEOUT_SEC = 1920;
export const PLUGIN_SKILLS = Object.freeze([
	"agent-workflow",
	"aw",
	"execution-router",
	"workflow-guide",
]);
/** Pi exposes the authoring and routing skills; `aw_*` tools carry their own MCP guidance. */
export const PI_SKILLS_DIR = "plugins/pi/skills";
export const PI_SKILLS = Object.freeze(["workflow-guide", "execution-router"]);
/** package.json `pi.skills` (paths relative to the package root). */
export const PI_PACKAGE_SKILL_PATHS = Object.freeze(
	PI_SKILLS.map((name) => `./${PI_SKILLS_DIR}/${name}`),
);

/** Relative Markdown links of docs/usage.md (other docs, ../README.md) → the repository on GitHub. */
export function referenceDocLinks(text) {
	return text.replace(/\]\((?!https?:|#)([^)\s]+)\)/g, (_, target) => {
		const path = target.startsWith("../") ? target.slice(3) : `docs/${target}`;
		return `](${REPOSITORY}/blob/main/${path})`;
	});
}

/** Bundled specs the workflow-guide skill names as quality references. */
export const REFERENCE_WORKFLOWS = Object.freeze([
	"deep-research",
	"deep-review",
	"impact-review",
	"spec-review",
]);

const REPOSITORY = "https://github.com/AgwaB/agent-workflow";
const AUTHOR = Object.freeze({
	name: "AgwaB",
	url: "https://github.com/AgwaB",
});
const DESCRIPTION =
	"Run agent-workflow multi-agent workflows (deep-review, deep-research, spec-review, impact-review, dynamic) from the conversation: launch, wait, inspect and stop runs through the agent-workflow MCP server.";
const KEYWORDS = Object.freeze([
	"workflow",
	"agents",
	"mcp",
	"review",
	"research",
]);

/** The host's per-call limit for this server, passed on so the server can size its waits. */
function withToolTimeout(server, toolTimeoutMs) {
	return {
		...server,
		args: [...server.args, "--tool-timeout-ms", String(toolTimeoutMs)],
	};
}

/** Released plugin: the server comes from npm, pinned to the package version. */
export function npxLaunch(version, host) {
	return {
		command: "npx",
		args: [
			"-y",
			`--package=${PACKAGE_NAME}@${version}`,
			"agent-workflow-mcp",
			"--host",
			host,
		],
	};
}

/** Dev plugin: the server of a local checkout (absolute paths, current Node binary). */
export function devLaunch(checkoutRoot, host) {
	return {
		command: process.execPath,
		args: [
			join(resolve(checkoutRoot), "src/mcp/host-server/bin.mjs"),
			"--host",
			host,
		],
	};
}

/** WP36: the `agent-workflow` CLI of the released plugin (same pinned package as the server). */
export function npxCliLaunch(version) {
	return {
		command: "npx",
		args: ["-y", `--package=${PACKAGE_NAME}@${version}`, "agent-workflow"],
	};
}

/** WP36: the `agent-workflow` CLI of a local checkout (dev plugin). */
export function devCliLaunch(checkoutRoot) {
	return {
		command: process.execPath,
		args: [join(resolve(checkoutRoot), "src/hosts/cli/cli.mjs")],
	};
}

function shellWord(word) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
		? word
		: `'${word.replaceAll("'", "'\\''")}'`;
}

/** Seconds a notify-check hook may take (the first `npx` start downloads the package). */
export const NOTIFY_HOOK_TIMEOUT_SEC = 60;

/**
 * Shell lines that find the project's state base without starting the CLI (2026-11-06: run state
 * lives in `<home>/projects/<project-id>/`). The id ends in the first 12 hex digits of the sha256 of
 * the canonical project path (`projectId` in src/core/state-location.ts); `realpath` gives the same
 * canonical path as Node's realpath.native (letter case on macOS, /tmp -> /private/tmp), so a glob on
 * `*-<hash>` finds the directory. Sets P (the user directory) and h (the hash; empty when realpath or
 * a sha256 tool is missing, and the caller then leaves discovery to the CLI). No `${…}`: Claude Code
 * expands those in monitor commands itself.
 */
const SHELL_STATE_HASH = [
	'P="$AGENT_WORKFLOW_HOME"',
	'[ -n "$P" ] || P="$HOME/.agent-workflow"',
	'p=$(realpath "$d" 2>/dev/null) || p=""',
	'h=""',
	'[ -z "$p" ] || h=$(printf %s "$p" | (shasum -a 256 || sha256sum) 2>/dev/null | cut -c1-12)',
	'case "$h" in ????????????) ;; *) h="" ;; esac',
];

/**
 * WP36: the shell command of the completion hook: `agent-workflow notify-check` in the project
 * directory, only when the project has runs (otherwise a directory test and nothing else); its
 * output (one line per run that finished since the last check) is added to the conversation.
 * Always exits 0 and prints nothing on errors, so a prompt is never blocked or decorated.
 * The hook runs on every prompt, so the CLI (an `npx` start in the published plugin) is only
 * started when a `run.json` changed since the last successful check: a stamp file
 * (`<state base>/.agent-workflow/notify-check/hook-<host>.stamp`) makes the idle case a `find`.
 * WP42 (review round 1, finding 4): the shell only reads (`find -newer` writes nothing, even
 * through a symlink); the stamp is written by `notify-check --stamp hook-<host>` itself, through
 * its contained writer, after a successful check and timed to the check's start (so a change during
 * it is seen next time). WP42 finding 5: a check that left runs for later (the cap of five) removes
 * the stamp, so the next prompt checks again until the backlog is drained.
 */
export function notifyHookCommand(cli, host) {
	const stamp = `hook-${host}`;
	const run = [
		cli.command,
		...cli.args,
		"notify-check",
		"--host",
		host,
		"--stamp",
		stamp,
	]
		.map(shellWord)
		.join(" ");
	return [
		'd="$CLAUDE_PROJECT_DIR"',
		'[ -n "$d" ] || d=.',
		...SHELL_STATE_HASH,
		[
			'if [ -n "$h" ]; then set -- "$P"/projects/*-"$h"',
			'w="$1/.agent-workflow/workflows"',
			'[ -d "$w" ] || exit 0',
			`s="$1/.agent-workflow/notify-check/${stamp}.stamp"`,
			'[ -f "$s" ] && [ -z "$(find "$w" -name run.json -newer "$s" 2>/dev/null | head -n 1)" ] && exit 0',
			"fi",
		].join("; "),
		`(cd "$d" && ${run} 2>/dev/null)`,
		"exit 0",
	].join("; ");
}

/** Hook commands only start Node/npx for a possible aw invocation. JSON stays on stdin;
 * it is never evaluated, used as a path, or interpolated into the CLI's argv.
 * The TypeScript recognizer is authoritative after this inexpensive shell prefilter.
 */
export function hostCommandHookCommand(cli, host, expansion = false) {
	const space = String.raw`([[:space:]]|\\[nrt])`;
	const boundary = `(${space}|")`;
	const prefix =
		host === HOST_IDS.claude
			? String.raw`(/aw|/agent-workflow:aw)${boundary}`
			: String.raw`(\$aw${boundary}|aw("|${space}+("|(dashboard|run|dynamic|auto|stop)${boundary})))`;
	const pattern = expansion
		? String.raw`"command_name"[[:space:]]*:[[:space:]]*"(aw|agent-workflow:aw)"`
		: String.raw`"prompt"[[:space:]]*:[[:space:]]*"${space}*${prefix}`;
	const run = [cli.command, ...cli.args, "host-command", "--host", host]
		.map(shellWord)
		.join(" ");
	return [
		"input=$(cat)",
		`printf '%s' "$input" | grep -Eq ${shellWord(pattern)} || exit 0`,
		`printf '%s' "$input" | ${run} 2>/dev/null`,
		"exit 0",
	].join("; ");
}

export function hostCommandHooks(cli, host) {
	return {
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: hostCommandHookCommand(cli, host),
						timeout: 300,
					},
				],
			},
		],
		...(host === HOST_IDS.claude
			? {
					UserPromptExpansion: [
						{
							hooks: [
								{
									type: "command",
									command: hostCommandHookCommand(cli, host, true),
									timeout: 300,
								},
							],
						},
					],
				}
			: {}),
	};
}

/** Claude keeps its completion prompt hook alongside the command hooks. */
export function claudePluginHooks(cli) {
	const commands = hostCommandHooks(cli, HOST_IDS.claude);
	return {
		...commands,
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: notifyHookCommand(cli, HOST_IDS.claude),
						timeout: NOTIFY_HOOK_TIMEOUT_SEC,
					},
					...commands.UserPromptSubmit[0].hooks,
				],
			},
		],
	};
}

/**
 * 2026-11-05 (owner: wait in code, wake the host once): the Claude Code plugin's completion monitor.
 * Claude Code starts a plugin monitor in the background for an interactive session (not with -p) and
 * hands each line it prints to Claude as a notification, which wakes an idle session. The command
 * waits in the shell until the project has runs (no CLI start before), then runs
 * `notify-check --follow --session <CLAUDE_CODE_SESSION_ID>`: one line per run this session launched
 * once it has settled, and a stamp that tells the MCP server the monitor is alive, so the launch's
 * next step lets the agent end its turn instead of calling workflow_wait every 45 s. Without a
 * session id (an older Claude Code) it exits at once.
 */
export function claudeCompletionMonitor(cli) {
	const follow = [
		cli.command,
		...cli.args,
		"notify-check",
		"--follow",
		"--host",
		HOST_IDS.claude,
		"--session",
	]
		.map(shellWord)
		.join(" ");
	return {
		name: "run-completion",
		command: [
			// Plain $VAR: Claude Code expands ${...} in a monitor command itself, before the session's
			// variables exist (live probe 2026-11-05: "${CLAUDE_CODE_SESSION_ID:-unset}" gave "unset",
			// "$CLAUDE_CODE_SESSION_ID" the id), so the shell must do the expansion.
			's="$CLAUDE_CODE_SESSION_ID"',
			'[ -n "$s" ] || exit 0',
			'd="$CLAUDE_PROJECT_DIR"',
			'[ -n "$d" ] || d=.',
			...SHELL_STATE_HASH,
			// Gone with the session even before the CLI starts: $PPID is the Claude Code process that
			// started this shell; the CLI then stops itself when it is orphaned (notify-check --follow).
			// Polls every 2 s: a launch from this session waits up to 5 s for the monitor of a project's
			// first run (MONITOR_FIRST_RUN_WAIT_MS) instead of falling back to workflow_wait. Without a
			// hash (no realpath/sha256 tool) the CLI waits instead.
			'until [ -z "$h" ] || { set -- "$P"/projects/*-"$h"; [ -d "$1/.agent-workflow/workflows" ]; }; do kill -0 "$PPID" 2>/dev/null || exit 0; sleep 2; done',
			`cd "$d" && exec ${follow} "$s"`,
		].join("; "),
		description: "agent-workflow: a run this session started has finished",
	};
}

/** Both hosts share the fallback when their command hook is disabled or untrusted. */
export function awSkill() {
	return `---
name: aw
description: Run agent-workflow commands and manage detached workflows in this host session.
---

# aw

Normally the plugin hook handles this command directly, without a model call.
If you are reading this, the hook did not run (for example it is disabled or untrusted).
Fulfil the user's aw request with the agent-workflow MCP tools below. Do not ask
extra questions beyond what the tools require. No command options are supported;
the remainder after the workflow/action is the task, with one matching quote pair removed.

- aw: use \`workflow_status\` for up to three recent top-level runs, show these six command forms,
  and \`workflow_dashboard\` for the dashboard URL (follow its required dialog).
- aw dashboard [run]: \`workflow_dashboard\` (optional full \`run\`; resolve a prefix with \`workflow_status\`).
- aw run <workflow> <task…>: \`workflow_run\` with \`workflow\` and \`task\` (detached).
- aw dynamic <task…>: \`workflow_dynamic\` with \`task\` (detached).
- aw auto <task…>: \`workflow_auto\` with \`task\`; follow its consent/selection requirements
  and choose the top recommendation when the tool permits it. Classifier failure starts nothing.
- aw stop <run>: \`workflow_stop\` with \`runId\` (full id or unambiguous prefix).

For missing arguments or an unknown action, show usage, do not start anything.
Report the run id and dashboard link. Follow the tool's completion-delivery instructions.
In Codex use $aw or bare aw; custom slash commands cannot be added there.
`;
}

export async function readPackageVersion(root = REPO_ROOT) {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (pkg.name !== PACKAGE_NAME)
		throw new Error(
			`package.json name is ${pkg.name}, expected ${PACKAGE_NAME}`,
		);
	return pkg.version;
}

function json(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function claudePluginManifest(
	version,
	launch,
	cli = npxCliLaunch(version),
) {
	return {
		$schema: "https://anthropic.com/claude-code/plugin.schema.json",
		name: PLUGIN_NAME,
		version,
		description: DESCRIPTION,
		author: { ...AUTHOR },
		homepage: `${REPOSITORY}#readme`,
		repository: REPOSITORY,
		license: "MIT",
		keywords: [...KEYWORDS],
		mcpServers: { [MCP_SERVER_NAME]: launch(HOST_IDS.claude) },
		hooks: claudePluginHooks(cli),
		experimental: { monitors: [claudeCompletionMonitor(cli)] },
	};
}

export function codexPluginManifest(
	version,
	launch,
	cli = npxCliLaunch(version),
) {
	return {
		name: PLUGIN_NAME,
		version,
		description: DESCRIPTION,
		author: { ...AUTHOR },
		homepage: `${REPOSITORY}#readme`,
		repository: REPOSITORY,
		license: "MIT",
		keywords: [...KEYWORDS],
		skills: "./skills/",
		// codex-config HooksFile wraps the event map in its own `hooks` field.
		hooks: { hooks: hostCommandHooks(cli, HOST_IDS.codex) },
		mcpServers: {
			[MCP_SERVER_NAME]: {
				...withToolTimeout(
					launch(HOST_IDS.codex),
					CODEX_TOOL_TIMEOUT_SEC * 1000,
				),
				startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC,
				tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
			},
		},
		interface: {
			displayName: "agent-workflow",
			shortDescription:
				"Run multi-agent workflows (review, research) and report their results",
			developerName: AUTHOR.name,
			category: "Coding",
			websiteURL: REPOSITORY,
		},
	};
}

export function claudeMarketplace() {
	return {
		$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
		name: MARKETPLACE_NAME,
		owner: { ...AUTHOR },
		metadata: {
			description: "agent-workflow plugin for Claude Code",
		},
		plugins: [
			{
				name: PLUGIN_NAME,
				source: `./${PLUGIN_DIR}`,
				description: DESCRIPTION,
				category: "development",
				homepage: `${REPOSITORY}#readme`,
				license: "MIT",
			},
		],
	};
}

export function codexMarketplace() {
	return {
		name: MARKETPLACE_NAME,
		interface: { displayName: "agent-workflow" },
		plugins: [
			{
				name: PLUGIN_NAME,
				source: { source: "local", path: `./${PLUGIN_DIR}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: "Coding",
			},
		],
	};
}

function replaceAll(text, file, replacements) {
	let out = text;
	for (const [from, to] of replacements) {
		if (!out.includes(from))
			throw new Error(
				`${file}: expected source text not found (update tools/release/plugins.mjs): ${from.slice(0, 100)}`,
			);
		out = out.split(from).join(to);
	}
	return out;
}

/** Pi-only names that must not survive in the plugin copies of the skills. */
export const PI_ONLY_SKILL_TEXT = /\baw_[a-z]+\b|\/aw\b|\bin Pi\b|\(Pi:/u;

function npxCli(version) {
	return `npx -y --package=${PACKAGE_NAME}@${version} agent-workflow`;
}

function pluginNote(version) {
	return `> Plugin copy for Claude Code and Codex, generated from \`skills/workflow-guide/\` of \`${PACKAGE_NAME}@${version}\`. The bundled docs and specs it names are under \`../../reference/\`. Run \`agent-workflow …\` commands with the installed CLI, or as \`${npxCli(version)} …\` from the project directory. The MCP tools are described in the \`agent-workflow\` skill.\n\n`;
}

export function adaptWorkflowGuide(text, version) {
	const file = "skills/workflow-guide/SKILL.md";
	return replaceAll(text, file, [
		["# Workflow Guide\n\n", `# Workflow Guide\n\n${pluginNote(version)}`],
		["`../../docs/usage.md`", "`../../reference/docs/usage.md`"],
		["`../../workflows/", "`../../reference/workflows/"],
		[
			"check the result with `agent-workflow roles <workflow>` (Pi: `/aw roles <workflow>`).",
			"check the result with `agent-workflow roles <workflow>`.",
		],
		[
			"prefer the host's workflow list/run tools (in Pi: `aw_list`, `aw_run`, then `aw_wait`) when they are available; use the `agent-workflow` CLI (or `/aw ...` in Pi) as the deterministic manual fallback.",
			"prefer the agent-workflow MCP tools (`workflow_list`, `workflow_run`, then `workflow_wait`; see the `agent-workflow` skill) when they are available; use the `agent-workflow` CLI as the deterministic manual fallback.",
		],
		[
			"Always validate the workflow (`agent-workflow validate <workflow-or-file>`, or `/aw validate <workflow-or-file>` in Pi) before handing off or running a reusable workflow. There is no validate tool, so from an agent/tool context run the CLI non-interactively from the project directory; it prints the summary and `Warnings:` list and exits non-zero on an invalid spec.",
			"Always validate the workflow (the `workflow_validate` tool with the workflow name or spec path, or `agent-workflow validate <workflow-or-file>` run non-interactively from the project directory) before handing off or running a reusable workflow. Both report the summary and `Warnings:` list; an invalid spec is a tool error or a non-zero CLI exit.",
		],
		[
			"Run the launch preflight first (`agent-workflow check <workflow> --executor <id> --model <id>`, `/aw check` in Pi; no run, no model call).",
			"Run the launch preflight first (the `workflow_check` tool, or `agent-workflow check <workflow> --executor <id> --model <id>`; no run, no model call).",
		],
		[
			"(for example Pi's `question` tool)",
			"(for example Claude Code's `AskUserQuestion` tool)",
		],
		[
			"Example `question` tool shape:",
			"Example option set (written as a Pi `question` tool call; map it onto your host's question tool):",
		],
		[
			"(or `/aw validate <workflow-or-file>` in Pi), run from the project directory.",
			"(or the `workflow_validate` tool), run from the project directory.",
		],
		[
			"Use `agent-workflow inspect <run-id> --results` (Pi: `/aw inspect <run-id> --results`)",
			"Use `workflow_inspect {runId, results: true}` or `agent-workflow inspect <run-id> --results`",
		],
	]);
}

export function adaptScaffoldReadme(text) {
	return replaceAll(text, "skills/workflow-guide/scaffolds/README.md", [
		[
			"Then run `agent-workflow validate` (or `/aw validate` in Pi) before use.",
			"Then run `agent-workflow validate` (or the `workflow_validate` tool) before use.",
		],
	]);
}

export function adaptExecutionRouter(text) {
	return replaceAll(text, "skills/execution-router/SKILL.md", [
		[
			"(in Pi: `/aw run <name>` or `/aw dynamic`) is authoritative",
			"(or a request to launch through the `workflow_run`/`workflow_dynamic` tools) is authoritative",
		],
		[
			"such as the host's workflow list tool (for example `aw_list` in Pi) or `agent-workflow list`",
			"such as the `workflow_list` tool or `agent-workflow list`",
		],
		[
			"Never invoke `aw_run`, `aw_dynamic`, `/aw run`, `/aw dynamic`, `/aw auto`, `/aw resume`, `/aw approve`, or the matching `agent-workflow` CLI commands",
			"Never invoke `workflow_run`, `workflow_dynamic`, `workflow_auto`, `workflow_wait`, `workflow_stop`, `workflow_validate`, `workflow_resume`, `workflow_supervise`, `workflow_prune`, `workflow_profile`, `workflow_notices`, `workflow_approve`, `agent-workflow auto`, `agent-workflow resume`, `agent-workflow approve`, or the matching `agent-workflow` CLI commands",
		],
		[
			'`agent-workflow auto "<task>"` (in Pi: `/aw auto`; it asks',
			'`agent-workflow auto "<task>"` (or, as the user\'s own later request, the `workflow_auto` tool; it asks',
		],
		[
			'an existing workflow (`agent-workflow run <name> "<task>"`), a direct dynamic run (`agent-workflow dynamic "<task>"`)',
			'an existing workflow (`workflow_run {workflow, task}` or `agent-workflow run <name> "<task>"`), a direct dynamic run (`workflow_dynamic {task}` or `agent-workflow dynamic "<task>"`)',
		],
		[
			"use the compact guidance in `docs/usage.md` when it is available.",
			"use the compact guidance in `../../reference/docs/usage.md` (relative to this skill directory).",
		],
	]);
}

function pluginReadme(version) {
	return `# agent-workflow plugin (Claude Code and Codex)

Runs [agent-workflow](${REPOSITORY}) multi-agent workflows from a Claude Code or Codex
conversation. Ask for a workflow ("run deep-review on the last commit") and the agent launches it
through the \`agent-workflow\` MCP server, waits for it in calls of at most 45 seconds, and quotes the
result and report paths when the run finishes.

Contents:

- MCP server \`agent-workflow\`: \`npx ${npxLaunch(version, "<claude-code|codex>").args.join(" ")}\`
  (Node.js 22 or later; the first start downloads the package). Claude Code reads
  \`.claude-plugin/plugin.json\`, Codex reads \`.codex-plugin/plugin.json\`; each passes its own \`--host\`.
- Skills: \`agent-workflow\` (tool call protocol), \`workflow-guide\` (authoring workflows),
  \`execution-router\` (choosing a route without running anything).
- \`reference/\`: copies of the agent-workflow usage guide and bundled workflow specs used by
  \`workflow-guide\`.

Install:

- Claude Code: \`claude plugin marketplace add AgwaB/agent-workflow\`, then
  \`claude plugin install agent-workflow@agent-workflow\` (in a session:
  \`/plugin install agent-workflow --marketplace AgwaB/agent-workflow\`).
- Codex: \`codex plugin marketplace add AgwaB/agent-workflow\`, then
  \`codex plugin add agent-workflow@agent-workflow\`.

Alternatives (\`mcp add\`), local development and troubleshooting: [docs/hosts.md](${REPOSITORY}/blob/main/docs/hosts.md#claude-code-and-codex).
This directory is generated by \`node tools/release/plugins.mjs build\`; do not edit it by hand.
`;
}

async function listFiles(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(path, base)));
		else if (entry.isFile())
			out.push(relative(base, path).split(sep).join("/"));
		else
			throw new Error(`unsupported entry (not a file or directory): ${path}`);
	}
	return out.sort();
}

/**
 * Every file of the plugin directory, keyed by plugin-relative POSIX path.
 * `launch(host)` returns `{command, args}` for the MCP server entry; `cli` is the `agent-workflow`
 * CLI the Claude Code completion hook runs (WP36).
 */
export async function renderPluginFiles({
	root = REPO_ROOT,
	version,
	launch,
	cli = npxCliLaunch(version),
}) {
	const files = new Map();
	files.set(
		".claude-plugin/plugin.json",
		json(claudePluginManifest(version, launch, cli)),
	);
	files.set(
		".codex-plugin/plugin.json",
		json(codexPluginManifest(version, launch, cli)),
	);
	files.set("README.md", pluginReadme(version));
	files.set("skills/aw/SKILL.md", awSkill());

	const read = (path) => readFile(join(root, path), "utf8");
	files.set(
		"skills/agent-workflow/SKILL.md",
		await read("skills/agent-workflow/SKILL.md"),
	);
	files.set(
		"skills/execution-router/SKILL.md",
		adaptExecutionRouter(await read("skills/execution-router/SKILL.md")),
	);
	files.set(
		"skills/workflow-guide/SKILL.md",
		adaptWorkflowGuide(await read("skills/workflow-guide/SKILL.md"), version),
	);
	const scaffolds = "skills/workflow-guide/scaffolds";
	for (const rel of await listFiles(join(root, scaffolds))) {
		const path = `${scaffolds}/${rel}`;
		const bytes = await readFile(join(root, path));
		files.set(
			path,
			rel === "README.md" ? adaptScaffoldReadme(bytes.toString("utf8")) : bytes,
		);
	}
	// 2026-11-05: the copy's relative links point at docs that are not in the plugin; send them to
	// the repository (the README and docs on GitHub).
	files.set(
		"reference/docs/usage.md",
		referenceDocLinks(await read("docs/usage.md")),
	);
	files.set("reference/workflows/README.md", await read("workflows/README.md"));
	for (const name of REFERENCE_WORKFLOWS)
		files.set(
			`reference/workflows/${name}/spec.json`,
			await read(`workflows/${name}/spec.json`),
		);

	for (const [path, content] of files) {
		if (!path.endsWith(".md") || !path.startsWith("skills/")) continue;
		const match = String(content).match(PI_ONLY_SKILL_TEXT);
		if (match)
			throw new Error(
				`${path}: Pi-only text left in a plugin skill: ${match[0]}`,
			);
	}
	return files;
}

/** From `plugins/pi/skills/<name>/` back to the package root. */
const PI_SKILL_TO_ROOT = "../../../../";

/** WP33: the Pi copy of skills/workflow-guide/SKILL.md (relative paths point into the package). */
export function adaptPiWorkflowGuide(text) {
	const file = "skills/workflow-guide/SKILL.md";
	return replaceAll(text, file, [
		["`../../docs/", `\`${PI_SKILL_TO_ROOT}docs/`],
		["`../../workflows/", `\`${PI_SKILL_TO_ROOT}workflows/`],
		["./scaffolds/", `${PI_SKILL_TO_ROOT}skills/workflow-guide/scaffolds/`],
	]);
}

/** WP33: the Pi package skills, keyed by path relative to PI_SKILLS_DIR. */
export async function renderPiSkillFiles({ root = REPO_ROOT } = {}) {
	const read = (path) => readFile(join(root, path), "utf8");
	const files = new Map();
	for (const name of PI_SKILLS) {
		const text = await read(`skills/${name}/SKILL.md`);
		const content =
			name === "workflow-guide" ? adaptPiWorkflowGuide(text) : text;
		const actual = /^---\nname: ([^\n]+)\n/.exec(content)?.[1];
		if (actual !== name)
			throw new Error(
				`skills/${name}/SKILL.md: expected frontmatter "name: ${name}", got ${actual}`,
			);
		files.set(`${name}/SKILL.md`, content);
	}
	return files;
}

/** WP33: package.json `pi.skills` must list exactly the generated Pi skills. */
async function piManifestProblems(root) {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const actual = JSON.stringify(pkg.pi?.skills ?? []);
	const expected = JSON.stringify(PI_PACKAGE_SKILL_PATHS);
	const problems = [];
	if (actual !== expected)
		problems.push(
			`package.json pi.skills: expected ${expected}, got ${actual}`,
		);
	if (!(pkg.files ?? []).includes("plugins/pi"))
		problems.push('package.json files: "plugins/pi" missing');
	return problems;
}

/** Repo-root marketplace files, keyed by root-relative path. */
export function renderMarketplaceFiles() {
	return new Map([
		[CLAUDE_MARKETPLACE_FILE, json(claudeMarketplace())],
		[CODEX_MARKETPLACE_FILE, json(codexMarketplace())],
	]);
}

async function writeTree(baseDir, files) {
	for (const [path, content] of files) {
		const target = join(baseDir, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

export async function buildCommitted(root = REPO_ROOT) {
	const version = await readPackageVersion(root);
	const files = await renderPluginFiles({
		root,
		version,
		launch: (host) => npxLaunch(version, host),
	});
	await rm(join(root, PLUGIN_DIR), { recursive: true, force: true });
	await writeTree(join(root, PLUGIN_DIR), files);
	await writeTree(root, renderMarketplaceFiles());
	// The Pi package skills retain their source names.
	const piSkills = await renderPiSkillFiles({ root });
	await rm(join(root, PI_SKILLS_DIR), { recursive: true, force: true });
	await writeTree(join(root, PI_SKILLS_DIR), piSkills);
	const problems = await piManifestProblems(root);
	if (problems.length) throw new Error(problems.join("\n"));
	return { version, count: files.size, piSkills: piSkills.size };
}

/** Differences between the committed files and the generator output (empty = in sync). */
export async function checkCommitted(root = REPO_ROOT) {
	const version = await readPackageVersion(root);
	const expected = await renderPluginFiles({
		root,
		version,
		launch: (host) => npxLaunch(version, host),
	});
	const problems = [];
	const pluginRoot = join(root, PLUGIN_DIR);
	const actual = existsSync(pluginRoot) ? await listFiles(pluginRoot) : [];
	for (const path of actual)
		if (!expected.has(path))
			problems.push(`${PLUGIN_DIR}/${path}: not generated`);
	const compare = async (path, content) => {
		let bytes;
		try {
			bytes = await readFile(join(root, path));
		} catch {
			problems.push(`${path}: missing`);
			return;
		}
		if (!bytes.equals(Buffer.from(content))) problems.push(`${path}: differs`);
	};
	for (const [path, content] of expected)
		await compare(`${PLUGIN_DIR}/${path}`, content);
	for (const [path, content] of renderMarketplaceFiles())
		await compare(path, content);
	// WP33: the Pi package skills and their manifest entry.
	const piExpected = await renderPiSkillFiles({ root });
	const piRoot = join(root, PI_SKILLS_DIR);
	for (const path of existsSync(piRoot) ? await listFiles(piRoot) : [])
		if (!piExpected.has(path))
			problems.push(`${PI_SKILLS_DIR}/${path}: not generated`);
	for (const [path, content] of piExpected)
		await compare(`${PI_SKILLS_DIR}/${path}`, content);
	problems.push(...(await piManifestProblems(root)));
	return problems;
}

/** Local dev marketplace root (plugin + both marketplaces) running `checkoutRoot`'s server. */
export async function buildDev(
	outDir,
	{ root = REPO_ROOT, force = false } = {},
) {
	const out = resolve(outDir);
	if (existsSync(out)) {
		const info = await stat(out);
		if (!info.isDirectory()) throw new Error(`${out} is not a directory`);
		const entries = await readdir(out);
		if (entries.length > 0 && !force)
			throw new Error(
				`${out} is not empty (pass --force to replace the plugin files)`,
			);
	}
	if (force) {
		await rm(join(out, PLUGIN_DIR), { recursive: true, force: true });
		for (const path of renderMarketplaceFiles().keys())
			await rm(join(out, path), { force: true });
	}
	const version = await readPackageVersion(root);
	const files = await renderPluginFiles({
		root,
		version,
		launch: (host) => devLaunch(root, host),
		cli: devCliLaunch(root),
	});
	await writeTree(join(out, PLUGIN_DIR), files);
	await writeTree(out, renderMarketplaceFiles());
	const built = existsSync(join(root, "dist/mcp/host-server/server.js"));
	return { out, pluginDir: join(out, PLUGIN_DIR), version, built };
}

async function main(argv) {
	const [command, ...rest] = argv;
	if (command === "build") {
		const { version, count, piSkills } = await buildCommitted();
		console.log(
			`wrote ${PLUGIN_DIR}/ (${count} files, version ${version}), ${CLAUDE_MARKETPLACE_FILE}, ${CODEX_MARKETPLACE_FILE}, ${PI_SKILLS_DIR}/ (${piSkills} files)`,
		);
		return 0;
	}
	if (command === "check") {
		const problems = await checkCommitted();
		if (problems.length === 0) {
			console.log(
				`${PLUGIN_DIR}/, ${PI_SKILLS_DIR}/ and the marketplaces match the generator.`,
			);
			return 0;
		}
		console.error(
			`Plugin files drifted (run \`node tools/release/plugins.mjs build\`):\n${problems.map((p) => `- ${p}`).join("\n")}`,
		);
		return 1;
	}
	if (command === "dev") {
		const force = rest.includes("--force");
		const positional = rest.filter((arg) => arg !== "--force");
		if (positional.length !== 1 || positional[0].startsWith("-")) {
			console.error(
				"usage: node tools/release/plugins.mjs dev <outDir> [--force]",
			);
			return 2;
		}
		const result = await buildDev(positional[0], { force });
		console.log(
			`wrote dev plugin ${result.pluginDir} (version ${result.version})`,
		);
		console.log(`Claude Code: claude --plugin-dir ${result.pluginDir}`);
		console.log(
			`Codex: codex plugin marketplace add ${result.out}  (see docs/hosts.md#claude-code-and-codex)`,
		);
		if (!result.built)
			console.error(
				"warning: dist/ is missing; run `npm run build` before starting the server",
			);
		return 0;
	}
	console.error(
		"usage: node tools/release/plugins.mjs build | check | dev <outDir> [--force]",
	);
	return 2;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
