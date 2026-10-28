# Permission modes: `free` (default) and `safe`

Owner decision "D2 revised" (2026-10-26, WP4e). Inside agent-workflow, parent and worker agents run
freely by default. The original D2 behavior stays available as `safe`.

## The two modes

| | `free` (default) | `safe` |
|---|---|---|
| Approval prompts | none: the worker CLI is started without them. A request that still arrives is answered `allow` by the engine and audited `engine-policy:free` | policy-based: kinds the stage's tools imply are allowed, everything else is denied (fail-closed) unless an interactive host answers |
| Sandbox | none for stages that are not `readOnly` | the adapter's narrowest mapping (no bypass flags) |
| Write-capable stage with spec `worktreePolicy: "off"` | runs in the shared checkout as written (pi-workflow behavior) | still gets a worktree (R#5) unless the run option `allowSharedCheckoutWrites` waives it |
| `worktreePolicy: "auto"` / `"on"` | as before: a worktree for write-capable stages | same |
| Coarse tool allowlist (Codex) | accepted for every stage; recorded as a degradation `CAPABILITY_MISSING:toolAllowlist.fine` | refused, or run as readOnly when the spec sets `allowReadOnlyDowngrade` (B4) |
| Environment warnings (Codex `~/.codex/rules` allow rules, global `AGENTS.md`) | recorded degradations; never refused (not even by a profile's `strictCapabilities`), no confirmation prompt | recorded degradations; interactive hosts confirm; `strictCapabilities` refuses |

**Kept in both modes:**

- A stage the spec declares `readOnly` stays read-only: Claude read-only tool set with
  `--permission-mode default`, Codex `read-only` sandbox with approvals `on-request`, Pi read-only tool
  list. Approval requests for mutating kinds on a readOnly stage are denied.
- B5 context isolation: workers do not load the user's settings, instructions, hooks or skills unless the
  stage sets `inherit` (`inheritProjectContext` / `inheritSkills`).
- Every other B4 rule (missing or unverified capabilities, MCP injection, web tools).

## Choosing a mode

Precedence (same as executor selection, B2): **run flag > workflow-declared profile > saved user profile >
default (`free`)**.

| Where | How |
|---|---|
| Run flag | engine run option `permissionMode: "safe"` (or `"free"`) on `runWorkflowSpec` / `runDynamicTask` |
| Workflow-declared profile | spec top level `"executionProfilePermissionModes": { "<declared profile>": "safe" }`, selected with `executionProfile` |
| Saved user profile | `permissionMode: "safe"` on the captured profile (`WorkflowCapturedExecutionProfile`) |

An invalid value from any source fails before any run record or launch, naming the source. Nested runs
follow the parent run's recorded mode. Runs recorded before WP4e carry no mode and keep running as
`safe`.

## Where the mode is visible

- Run record: `run.permissionMode = { mode, source, profile? }` (`source`: `run-flag`,
  `workflow-profile`, `user-profile`, `default`, `parent-run`).
- Capability preview, first line: `Capability check (<executor>@<version>, <n> stages, permission
  mode: free): …`; free-accepted entries are marked `(accepted: free mode)`. The recorded negotiation
  policy carries `permissionMode` too.
- Mixed runs (WP31): the mode is one per run; each stage's executor applies it its own way (the
  table in [usage.md](usage.md#permission-modes)), so a `free` run whose planning stage runs on Claude
  and research on Codex gets `bypassPermissions` there and `danger-full-access` here. The preview
  names every executor (`Capability check (mixed: claude@… ×n + codex@… ×m, …)`).
- Each attempt: `SubmitRequest.permissionMode` (execution plan, `executor.json`, durable worker payload);
  adapters record their resulting invocation (`claude-invocation.json`, the Codex raw transcript).
- Approvals: `approvals.jsonl` and the result metadata record `by: "engine-policy:free"` for answers made
  by the free-mode policy.

## SDK contract and adapter obligations

`SubmitRequest.permissionMode?: "free" | "safe"` is additive and validated (`validateSubmitRequest`).
**Absent means `safe`** (`effectivePermissionMode`), so a third-party caller that omits it gets the
conservative behavior. The engine always sets it. `isUnrestricted(req)` is true only for `free` on a
request that is not `readOnly`.

An adapter must:

1. For `safe` (or absent): use no bypass/auto-accept setting; route approvals to `respond()`.
2. For `free` on a non-readOnly request: start the CLI without approval prompts and without sandbox
   restrictions, using the CLI's documented setting (prefer a documented mode value over a
   `--dangerously-*` alias). Keep the approval channel wired, so a request that still arrives reaches
   the engine.
3. For a readOnly request: use exactly the `safe` settings in both modes.
4. Keep B5 isolation independent of the mode.
5. Document both mappings and register them with the conformance kit (`harness.permissionModes`,
   offline check `permission.mode_mapping`). An adapter whose CLI has no approval or sandbox concept sets
   `equivalent` with the reason.

| Adapter | `free` (not readOnly) | `safe` / readOnly |
|---|---|---|
| Claude (2.1.310) | `--permission-mode bypassPermissions` | `--permission-mode default` (+ `--disallowedTools` for readOnly) |
| Codex (0.159.2) | `thread/start` `sandbox: "danger-full-access"`, `approvalPolicy: "never"` | mapped sandbox (`workspace-write` / `read-only`), `approvalPolicy: "on-request"` |
| Pi (1.1.0) | same argv as `safe`: every requested tool (Pi has no approvals or sandbox) | readOnly drops mutating tools from `--tools` |

The engine's approval decision (`decideApproval(policy, request, {readOnly, permissionMode})`): `free`
allows everything except mutating kinds on a readOnly stage; `safe` is unchanged (D2).
