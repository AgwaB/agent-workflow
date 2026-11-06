---
name: aw
description: Run agent-workflow commands and manage detached workflows in this host session.
---

# aw

Normally the plugin hook handles this command directly, without a model call.
If you are reading this, the hook did not run (for example it is disabled or untrusted).
Fulfil the user's aw request with the agent-workflow MCP tools below. Do not ask
extra questions beyond what the tools require. No command options are supported;
the remainder after the workflow/action is the task, with one matching quote pair removed.

- aw: use `workflow_status` for up to three recent top-level runs, show these six command forms,
  and `workflow_dashboard` for the dashboard URL (follow its required dialog).
- aw dashboard [run]: `workflow_dashboard` (optional full `run`; resolve a prefix with `workflow_status`).
- aw run <workflow> <task…>: `workflow_run` with `workflow` and `task` (detached).
- aw dynamic <task…>: `workflow_dynamic` with `task` (detached).
- aw auto <task…>: `workflow_auto` with `task`; it classifies once and starts the top recommendation without asking
  and choose the top recommendation when the tool permits it. Classifier failure starts nothing.
- aw stop <run>: `workflow_stop` with `runId` (full id or unambiguous prefix).

For missing arguments or an unknown action, show usage, do not start anything.
Report the run id and dashboard link. Follow the tool's completion-delivery instructions.
In Codex use $aw or bare aw; custom slash commands cannot be added there.
