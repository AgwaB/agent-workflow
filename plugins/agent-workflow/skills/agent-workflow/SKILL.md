---
name: agent-workflow
description: Run, watch, stop, resume and report agent-workflow workflows (deep-review, deep-research, spec-review, impact-review or a dynamic workflow) through the agent-workflow MCP tools. Use when the user asks to run a workflow, to review/research/check something "with a workflow" or "with agent-workflow", to let agent-workflow pick the workflow for a task, to check, wait for, inspect, resume or stop a workflow run, to choose the executor, profile or permission mode of a run, or to manage saved profiles, notices, pruning or the environment check.
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
| `workflow_auto` | Let the user pick a workflow for a task: `{task}` plus launch options. Asks the user in a dialog before it sends the task to one classifier request, then lets the user choose the workflow (or none) in a second dialog and starts it. Only when the user asks you to choose a workflow. |
| `workflow_wait` | Wait for a run, **at most 45 s per call** (`runId`, `timeoutMs?` 1000-45000). |
| `workflow_status` | List runs, or one run with `runId`. |
| `workflow_inspect` | Details of a run: `failures: true` for failed tasks, `results: true` for task results. |
| `workflow_logs` | Bounded, redacted tail of task output, stderr and executor events (`runId`, `task?`, `lines?`, `stream?`). |
| `workflow_stop` | Stop a run (`runId`). Cancelling a wait call does not stop the run. |
| `workflow_dashboard` | When the user wants to watch: start the local dashboard (`run?`: full run id) and open it in their browser after a consent dialog (URL dialog in Claude Code, form dialog in Codex); clients without dialogs get terminal instructions. Never changes a run or returns credentials. |
| `workflow_validate` | Check a workflow spec (`workflow`: name or spec path). |
| `workflow_check` | Launch preflight without a run (`workflow`, optional `executor`, `model`, `effort`, `profile`): says whether the run can start on that executor and why not — unknown tools, a model the executor cannot run, effort levels. No run, no model call. Use it when the user asks whether a workflow can run here, or after a refusal. |
| `workflow_resume` | Continue a failed, interrupted or blocked run (`runId`, `detach?` default true). **Starts model calls (cost)**: only when the user asks. |
| `workflow_supervise` | Start a background supervisor for a running run that nothing drives (`runId`). Starts model calls: only when the user asks. |
| `workflow_show` | A workflow spec (`ref`: name or path) or a run (`ref`: run id, `raw?`). |
| `workflow_roles` | Compiled role context of a workflow (`workflow`). |
| `workflow_agents` | The agent definitions agent-workflow finds. |
| `workflow_doctor` | Environment check: installed and logged-in executors, the default executor and why. No model call. |
| `workflow_notices` | Unfinished-run notices: `list` (default); `acknowledge` (`runId`, `state`, `reason`) and `clear` (`runId`) need the user's confirmation. |
| `workflow_prune` | Remove finished runs (`keep?`, `olderThanDays?`). A dry run unless `dryRun: false`, which needs the user's confirmation. |
| `workflow_profile` | Saved user profiles: `op` `list` (default) or `show`; `set`, `delete`, `default`, `clear-default` need the user's confirmation. |
| `workflow_approve` | Answer a dynamic-controller approval a blocked run waits on (`runId`, `requestId`, `decision`: `approve` or `reject`, `detach?` default true). Only after the user decided; the user confirms in a dialog. An approval continues the run (**model calls**). |

**Confirmed changes.** `workflow_prune` with `dryRun: false`, `workflow_profile` `set`/`delete`/
`default`/`clear-default`, `workflow_notices` `acknowledge`/`clear` and `workflow_approve` show the
user a confirmation dialog first (MCP elicitation). Call them only when the user asked for that change. If the user
declines, nothing changes: do not retry. If the host cannot show the dialog, the tool refuses and
names the terminal command; give that command to the user instead of trying another way.

Hosts prefix the names: with the Claude Code plugin they appear as
`mcp__plugin_agent-workflow_agent-workflow__<tool>`, with `claude mcp add agent-workflow` as
`mcp__agent-workflow__<tool>`, and in Codex as `mcp__agent_workflow__<tool>` (hyphen → underscore; in
Codex code mode they are functions inside an `exec` cell: `tools.mcp__agent_workflow__<tool>(…)`).
Use whichever form your tool list shows.

## Run protocol

1. If the workflow name is not certain, call `workflow_list` (with a `query` such as `review`) and
   pick from the result. If nothing fits, say so and offer `workflow_dynamic`. If the user asks
   agent-workflow to choose the workflow, call `workflow_auto {task}` instead: the user consents to
   the one classifier request and picks the workflow in dialogs (declined = nothing sent or started;
   do not retry). Without dialog support it sends nothing and returns a local shortlist: show it,
   let the user pick, then call `workflow_run`. A launched `workflow_auto` result continues with
   step 3 (its `launch.runId`).
2. Call `workflow_run {workflow, task}` (or `workflow_dynamic {task}`). Write a self-contained `task`:
   scope, paths, exclusions and the expected output, in the user's words where possible. Pass
   declared workflow `inputs` only when the user asked for them (for example `{"depth": "quick"}`).
3. **Before waiting, tell the user the `runId` and the `Dashboard:` line from the launch result**
   — the token-free link is always there (the server auto-starts unless disabled or startup fails)
   and opens directly (no sign-in by default). If the user wants it opened for them, can't open it,
   or — on a dashboard started with `--auth` — it asks them to sign in, call `workflow_dashboard`:
   the user confirms in a dialog. People want the link first.
4. Call `workflow_wait {runId}`. While the result says `stillRunning: true`, call `workflow_wait`
   again with the same `runId`; between calls give the user at most a one-line progress note. Do not
   poll with shell `sleep`, and do not start other edits on files the run is reading.
   You get **no completion push**: the run reports only through `workflow_wait`/`workflow_status`.
   If it is still running when you stop waiting (for example a long rate-limit backoff: the wait
   result then has `nextRetry` with the retry time and reason), tell the user the `runId`, what the
   run is waiting for (the retry time and reason, or its running tasks), that they can ask you
   again later for the result, and that they can follow it live in a terminal with
   `agent-workflow watch <runId>` (in Claude Code, `agent-workflow statusline` as the `statusLine`
   command shows active runs). A line containing `agent-workflow: workflow … finished — …` in a
   later turn's context (Claude Code prefixes it, for example `UserPromptSubmit hook success: `)
   comes from the completion check (`agent-workflow notify-check`, run by the Claude Code plugin's
   prompt hook): tell the user, with the verdict and report path it names.
5. `terminal: true`: the run finished. Quote the result preview and give the report paths verbatim
   (the `reportArtifacts`/paths the tool prints), plus the `Dashboard:` link when the result has one:
   it opens the run's report in the local dashboard, where the user can read the report and each
   agent's result. Do not paraphrase or re-summarize the report; read the report file only if the
   user wants details.
6. `actionRequired: true`: the run is blocked. Report the reason, call
   `workflow_inspect {runId, failures: true}` and tell the user that the run can be resumed after
   they fix the cause. Call `workflow_resume {runId}` only when the user asks (it starts new model
   calls), then continue with step 4.
7. A result headed `Workflow finished — verdict: X (report ready)` (`verdictGate: true`) finished
   with a non-passing domain verdict, for example `PARTIAL_REVIEW`: report the verdict, quote the
   preview and give the report path. Its status says `failed` only because the verdict did not pass
   the final gate; do not call it a workflow failure.
8. `actionRequired: true` with `pendingApprovals`: a dynamic controller of the workflow needs the
   user's approval before it runs (its helper code and budget). Show the user the approval question
   (the `message` of each pending approval) and ask them to approve or reject. Only after they
   decide, call `workflow_approve {runId, requestId, decision}`; the user confirms again in a dialog.
   If they decline the approval dialog the controller is rejected for this run (it never asks
   again); if they cancel, nothing changes. After an approval, continue with step 4.
9. A failed or partial run otherwise: report status and the failed tasks from `workflow_inspect`; do
   not invent results for missing parts.

Runs are detached by default (`detach: true`): they keep running between calls and after the host
session ends. `workflow_status` finds them again later. A run launched with `detach: false` stops
progressing when the server process ends; `workflow_supervise {runId}` picks it up again (only when
the user asks).

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
  refusal, declined confirmation, duplicate run), or a confirmed change was declined or cannot be
  confirmed here (nothing changed). Explain the reason; do not retry with different options unless
  the user agrees.
- `Usage error:` text: fix the arguments (unknown workflow, bad input, bad `cwd`) and call again.
- The server may ask the user to confirm executor capability degradations before a launch; that is
  the host's confirmation dialog, not something to answer yourself.

## Without the MCP tools

The same operations exist in the CLI (`agent-workflow list|run|dynamic|auto|wait|status|inspect|logs|stop|
validate|resume|approve|show|roles|agents|notices|doctor|prune|profile|supervise`). If the CLI is not
installed, run it through npx:
`npx -y --package=@agwab/agent-workflow agent-workflow <command>`.
