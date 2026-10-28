---
name: agent-workflow
description: Run, watch, stop and report agent-workflow workflows (deep-review, deep-research, spec-review, impact-review or a dynamic workflow) through the agent-workflow MCP tools. Use when the user asks to run a workflow, to review/research/check something "with a workflow" or "with agent-workflow", to check, wait for, inspect or stop a workflow run, or to choose the executor, profile or permission mode of a run.
---

# agent-workflow

The `agent-workflow` MCP server (`agent-workflow-mcp`) runs multi-agent workflows whose workers are
coding-agent CLIs (Claude Code, Codex, Pi). A run takes minutes, so it is launched in the background
and watched with short wait calls. This skill is the call protocol; the server's own instructions
say the same.

## Tools

| Tool | Use |
|---|---|
| `workflow_list` | Find workflow names (`query?`, `offset?`, `limit?`). Never guess a name. |
| `workflow_run` | Launch a named workflow: `{workflow, task}` plus launch options. Returns the `runId` at once. |
| `workflow_dynamic` | Launch a spec-less dynamic workflow: `{task}` plus launch options. |
| `workflow_wait` | Wait for a run, **at most 45 s per call** (`runId`, `timeoutMs?` 1000-45000). |
| `workflow_status` | List runs, or one run with `runId`. |
| `workflow_inspect` | Details of a run: `failures: true` for failed tasks, `results: true` for task results. |
| `workflow_logs` | Bounded, redacted tail of task output, stderr and executor events (`runId`, `task?`, `lines?`, `stream?`). |
| `workflow_stop` | Stop a run (`runId`). Cancelling a wait call does not stop the run. |
| `workflow_validate` | Check a workflow spec (`workflow`: name or spec path). |

Hosts prefix the names: with the Claude Code plugin they appear as
`mcp__plugin_agent-workflow_agent-workflow__<tool>`, with `claude mcp add agent-workflow` as
`mcp__agent-workflow__<tool>`, and in Codex as `mcp__agent-workflow__<tool>`. Use whichever form your
tool list shows.

## Run protocol

1. If the workflow name is not certain, call `workflow_list` (with a `query` such as `review`) and
   pick from the result. If nothing fits, say so and offer `workflow_dynamic`.
2. Call `workflow_run {workflow, task}` (or `workflow_dynamic {task}`). Write a self-contained `task`:
   scope, paths, exclusions and the expected output, in the user's words where possible. Pass
   declared workflow `inputs` only when the user asked for them (for example `{"depth": "quick"}`).
3. Call `workflow_wait {runId}`. While the result says `stillRunning: true`, call `workflow_wait`
   again with the same `runId`; between calls give the user at most a one-line progress note. Do not
   poll with shell `sleep`, and do not start other edits on files the run is reading.
4. `terminal: true`: the run finished. Quote the result preview and give the report paths verbatim
   (the `reportArtifacts`/paths the tool prints). Do not paraphrase or re-summarize the report; read
   the report file only if the user wants details.
5. `actionRequired: true`: the run is blocked. Report the reason, call
   `workflow_inspect {runId, failures: true}` and tell the user that `agent-workflow resume <runId>`
   (CLI) continues it after they fix the cause.
6. A failed or partial run: report status and the failed tasks from `workflow_inspect`; do not
   invent results for missing parts.

Runs are detached by default (`detach: true`): they keep running between calls and after the host
session ends. `workflow_status` finds them again later.

## Launch options

- **Permission mode**: `free` is the default (workers run without approval prompts; stages that the
  workflow declares read-only stay read-only). Set `permissionMode: "safe"` only when the user asks
  for approvals or sandboxing.
- **Executor**: omit `executor` so the server uses the workflow profile or this host's default
  executor. Set `executor` (`"claude"`, `"codex"`, `"pi"`) only when the user names one ("run it on
  codex").
- **Profile**: set `profile` only when the user names one (a profile the workflow declares, or a saved
  user profile).
- **Model / effort**: set `model` or `effort` only on request; they override every stage.
- **allowUnverified**: never add capability keys on your own. If a launch is refused because a
  capability is unverified, show the refusal and ask the user.
- **forceNew**: only when the user wants a second identical run on purpose.
- **cwd**: omit it (the project root). If you launched with a `cwd`, pass the same `cwd` on every later
  call for that run.

## Errors

- `isError` with `outcome: "refused"`: the launch did not start (unavailable executor, capability
  refusal, declined confirmation, duplicate run). Explain the reason; do not retry with different
  options unless the user agrees.
- `Usage error:` text: fix the arguments (unknown workflow, bad input, bad `cwd`) and call again.
- The server may ask the user to confirm executor capability degradations before a launch; that is
  the host's confirmation dialog, not something to answer yourself.

## Without the MCP tools

The same operations exist in the CLI (`agent-workflow list|run|dynamic|wait|status|inspect|logs|stop|
validate|resume`). If the CLI is not installed, run it through npx:
`npx -y --package=@agwab/agent-workflow agent-workflow <command>`.
