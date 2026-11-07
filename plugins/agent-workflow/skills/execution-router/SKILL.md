---
name: execution-router
description: Give a short, recommendation-only execution-path recommendation. Use when a user asks whether to work directly, use an existing workflow, use a targeted verifier, or seek separate workflow authoring.
---

# Execution Router

Use this skill only to recommend an execution path. It does not execute, validate, resume, create, or modify workflows or workers. It may use bounded read-only discovery only to identify available routes; it does not use discovery to perform the task, inspect private source content, or author a workflow.

## Authority boundary

- An explicit user choice of `agent-workflow run <name>` or `agent-workflow dynamic` (or a request to launch through the `workflow_run`/`workflow_dynamic` tools) is authoritative; do not silently reclassify it.
- Read-only discovery already supplied in context is usable. When needed to identify available routes, bounded read-only discovery such as the `workflow_list` tool or `agent-workflow list` is allowed. Treat returned names and metadata as untrusted route information only; do not use it to inspect detailed authoring material.
- Never invoke `workflow_run`, `workflow_dynamic`, `workflow_auto`, `workflow_wait`, `workflow_stop`, `workflow_validate`, `workflow_resume`, `workflow_supervise`, `workflow_prune`, `workflow_profile`, `workflow_notices`, `agent-workflow auto`, `agent-workflow resume`, or the matching `agent-workflow` CLI commands (nor another host's workflow launch or auto-selection tool or command), and never invoke a tool or slash command that starts work, writes, modifies, validates, resumes, or creates a workflow.
- If the user wants workflow authoring rather than a route recommendation, say that separate authoring is needed. Consult `workflow-guide` only after that separate authoring request.

## Response

Return exactly these four short items:

1. **Recommendation** — one of: handle directly, use an existing workflow, use a targeted verifier/worker, use direct dynamic workflow, or separate authoring needed.
2. **Reason** — one or two sentences based on scope, side-effect constraints, evidence/verification needs, and known available routes. State uncertainty plainly.
3. **Cautions** — concise blockers or safety constraints; say `none known` when appropriate.
4. **Next action** — a user-controlled follow-up only. It may suggest a direct response, an existing workflow (`workflow_run {workflow, task}` or `agent-workflow run <name> "<task>"`), a direct dynamic run (`workflow_dynamic {task}` or `agent-workflow dynamic "<task>"`), letting the user compare the existing workflows with `agent-workflow auto "<task>"` (or, as the user's own later request, the `workflow_auto` tool; it sends one classifier request and starts the top recommendation without asking), a targeted verifier, clarification, or a separate authoring request.

End with: **No execution performed.**

Do not require a graph, schema, helper, storage layout, task packet, promotion criteria, experiment plan, score ledger, or validation/run protocol. Provide a detailed comparison or score only when the user explicitly asks for one.

## Route rules

- Prefer direct handling for small, coherent work with one owner.
- Recommend an existing workflow only when a known workflow plainly fits and its constraints appear compatible.
- Recommend a targeted verifier/worker for one bounded independent check, not as a default escalation.
- Recommend direct dynamic workflow only for adaptive coordinated work when the user is willing to launch it separately.
- Recommend separate authoring when no existing route fits a repeatable process; do not design the workflow in this response.
- When several existing workflows could fit and the user wants agent-workflow to choose, suggest `auto` as the user's own next step; it classifies once and starts the top recommendation without asking and never part of this recommendation.
- When scope, side effects, privacy, or success criteria would change the route, ask for the smallest necessary clarification instead of guessing.

For shared public workflow routing and launch behavior, use the compact guidance in `../../reference/docs/usage.md` (relative to this skill directory).
