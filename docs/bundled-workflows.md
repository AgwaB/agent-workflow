# Bundled workflows, skills and agents (WP10)

Source: `@agwab/pi-workflow` 0.16.4, commit `b83cc4f` (MIT, same author). The owner decision on F5
(plan §9 Q1) applies: the four bundled workflows are not a compatibility target, so they change as
far as the executor-neutral engine needs. User-authored pi-workflow specs keep F5 (unchanged on Pi).

## Provenance

| Destination | Source (b83cc4f) | Header |
|---|---|---|
| `workflows/README.md` | `workflows/README.md` | none (listed here) |
| `workflows/{deep-research,deep-review,impact-review,spec-review}/spec.json`, `deep-research/tiered-verification.spec.json` | same paths | none: the spec schema rejects unknown top-level keys (no `$comment`) |
| `workflows/*/schemas/*.schema.json` | same paths | none (listed here; schemas are runtime inputs) |
| `workflows/*/helpers/*.mjs` | same paths | `// Ported from …` first line (after the shebang, if any) |
| `skills/workflow-guide/SKILL.md`, `skills/execution-router/SKILL.md` | same paths | none (YAML front matter; listed here) |
| `skills/workflow-guide/scaffolds/**` | same paths | `.mjs` files carry the header; JSON/Markdown are listed here |
| `agents/scout.md`, `agents/researcher.md` | same paths | none (front matter; shipped since WP0) |

The port commit copies every file byte-for-byte except the added `.mjs` header line. The files under
`workflows/`, `skills/` and `agents/` are not reformatted (biome covers `src/`, `test/`, `tools/` only).
`test/fixtures/core/workflow-guide-scaffolds/` (WP4b) stays a separate, formatted fixture copy.

`skills/agent-workflow/SKILL.md` is new in agent-workflow (WP14/WP15): the MCP tool call protocol
for the Claude Code and Codex plugin. The plugin's copies of the skills (`plugins/agent-workflow/`)
are generated from `skills/` with the Pi names replaced by the MCP tool names
([plugins.md](plugins.md)).

## Change log (migration)

Paths and env:

- **M1.** `spec-review/helpers/spec-requirement-source.mjs` reads upstream `source-manifest.json` /
  `control.json` from `.agent-workflow/workflows/<run>/tasks/<task>/` (was `.pi/workflows/…`; the
  WP1b replay showed `missing_requirement_source_proof` with the old literal).
- **M2.** The four report renderers (`render-executive.mjs`, `render-review-report.mjs`,
  `render-spec-review-report.mjs`, `render-impact-report.mjs`) write their sidecars
  (`final-report.md`, `executive.md`, `audit.md`, `review.md`, `source-ledger.json`) under
  `.agent-workflow/workflows/<run>/tasks/<task>/` (was `.pi/workflows/…`, outside the run directory).
- **M3.** deep-review's trusted OCR artifact root is `.agent-workflow/ocr-artifacts/` (was `.pi/ocr-artifacts/`;
  helper constant, reviewer prompt and README). Existing OCR artifacts under `.pi/` are not read.
- **M4.** No bundled asset used `PI_WORKFLOW_*`. Docs and skills name `.agent-workflow/workflows/`,
  `~/.agent-workflow/workflows/` (`$AGENT_WORKFLOW_HOME`) and the `agent-workflow` CLI; the legacy
  pi-workflow locations are mentioned only as "legacy pi-workflow locations (read-only)" (no path
  literal), so `grep -rn "workflow_web_\|\.pi/workflows\|PI_WORKFLOW_" workflows skills agents` is empty.

deep-research (C2: the executors' own web tools):

- **M5.** Both deep-research specs request `web_search` and `fetch_content` (Pi vocabulary; the adapters map
  them: Claude `WebSearch`/`WebFetch`, Codex hosted `web_search`, Pi `pi-web-access`) instead of
  `workflow_web_search`, `workflow_web_fetch_source`, `workflow_web_source_read`.
- **M6.** Prompts (research-questions, normalize-claims, verify-claims / verify-core-claims /
  verify-tail-claims): the batched source-card instructions (`urls:[…]`, `reads:[…]`, sourceRef
  source reads, claim+terms candidate windows, `candidateOnly`/match metadata) are replaced by
  "search with web_search, read with fetch_content, quote only text you saw in fetched content".
  Each research/verify prompt says that source verification is model-reported. sourceRefs remain for
  local evidence (`sourceType: "local_repo"`).
- **M7.** `claim-evidence-gate.mjs`: the web part is removed — no read of the run's
  `web-source-cache/index.json` (it no longer exists) and no `source_ref_not_available` join failure
  for web claims without a `wsrc_*` sourceRef. `sourceRefJoinFailures` stays in the output (always
  empty) for the packet schema. The local part is unchanged: local quotes are byte-checked by
  `local-quote-gate.mjs`, and a `verified` verdict still needs a structured evidence row with a
  source (URL or located local file) plus a quote (`requireFetchedEvidenceForVerified`), else it is
  downgraded. A web row's URL and quote are what the model reported.
- **M8.** `sanitize-verification-candidates.mjs`: no read of the web-source cache index, and URL-only web
  candidates are no longer demoted to backlog (nor replaced by promoted preserved claims). With the
  CLI web tools no candidate has a `wsrc_*` sourceRef, so the old rule would have dropped every web
  claim before verification. `webUrlOnlyDemotedCount`/`promotedCandidateCount` stay (always 0).
- **M9.** `render-executive.mjs` exports `SOURCE_VERIFICATION_STATEMENT` = "Source verification:
  model-reported (byte-level source verification is not performed)." — the plan's
  "출처 검증: 모델 보고" (source verification: model reported). It ends the parent-facing completion
  summary (and so the report's executive summary) and follows the intro of `audit.md`. The wording is
  English in every language of the report.

All bundled specs:

- **M10.** Top-level `"allowReadOnlyDowngrade": true` (every bundled stage is already `readOnly`). On an
  executor without a fine tool allowlist (Codex, `toolAllowlist: coarse`) B4 then degrades the precise
  `tools` lists to "readOnly enforced" instead of refusing the run.
- **M11.** No bundled spec uses a Pi-only capability: no `toolResultBudget`, no `fast`, no `inheritHostTools`
  (checked by `test/unit/bundled-workflows.test.mjs`). None is kept.

Agents and skills:

- **M12.** `agents/researcher.md` tools: `read, grep, find, ls, web_search, fetch_content` (the three
  `workflow_web_*` tools are removed); its Tools section describes the CLI web tools and the
  model-reported source verification. `agents/scout.md`: "workflow subagent" (was "Pi workflow
  subagent").
- **M13.** `skills/workflow-guide/SKILL.md`: agent-workflow wording, storage scopes and name priority with the
  new paths, `agent-workflow validate`/`inspect` next to the host's `/workflow` command, and the rule
  to write the logical artifact tool name `workflow_artifact` in prompts (rendered per executor).
  `skills/execution-router/SKILL.md`: host-neutral tool wording (the host's workflow list/run tools,
  the `agent-workflow` CLI).
- **M14.** Scaffold `object-tool-fallback`: required `fetch_content` plus optional `web_search` (object form,
  `fallbackTools: ["fetch_content"]`); prompt and `fetchToolUsed` enum follow
  (`fetch_content | web_search | none`). Scaffold `README.md`: new paths, `agent-workflow validate`.
- **M15.** `workflows/README.md`: agent-workflow wording, paths, the CLI web tools and the source-verification
  statement; the web-source cache / `fetch_content` cache paragraphs are removed.

Live bundle 3 (stage-1 acceptance, `docs/live-acceptance-stage1.md`):

- **M16.** deep-research synthesis pages: `synthesis-pages.mjs` uses 16 pages of 16,000 (was 8 of 24,000)
  and measures a page as max(UTF-16 units, UTF-8 bytes). Both specs require the header plus
  `pages[0]`…`pages[15]` at `maxChars: 16000` (prompt: "Read all sixteen indexed pages"); the
  final-audit-packet schema pins `pageCount` 16 / `maxChars` 16000. Why: one projected page read
  must fit the smallest workflow_artifact delivery limit (Pi 1.1 server `--max-output-chars`
  18,432, both units; `docs/mcp.md` "Measured limits") with the read header and projection envelope.
  A 23,301-unit page 0 was cut by the server (`deliveryUnverified`), so `final-audit` failed
  `required_reads_missing_exhausted` and the live Pi run ended `blocked` (Claude's 21,375 limit has
  the same problem). The bank grows from 192k to 256k (the 48-claim max fixture needs 13 pages).
  Regression test: `core-deep-research-synthesis-pages.test.mjs` "every synthesis read fits each
  stage-1 executor's workflow_artifact delivery limit" (real artifact reads of the max fixture and
  of a full multi-byte page against the Pi, Claude and Codex server limits).

WP12c (stage-1 doc sync):

- **M18.** `skills/workflow-guide/SKILL.md`, `skills/workflow-guide/scaffolds/README.md`,
  `skills/execution-router/SKILL.md` and `workflows/README.md`: pi-workflow's `/workflow …` commands
  and `workflow_list`/`workflow_run` tool names are replaced by the `agent-workflow …` CLI and the Pi
  host's `/aw …` / `aw_*` equivalents (the router forbids launching through `aw_run`, `aw_dynamic`,
  `/aw run|dynamic|resume`, the matching CLI commands and other hosts' launch commands; there is no
  `auto` action, so a dynamic run is suggested instead). The workflows README drops pi-workflow's
  profile-picker text (`/workflow profile`, Codex / Codex High / Claude / Mixed / Custom) and shows
  `--input depth=…` instead of "Use max depth." in the task.

After stage 2 (2026-11-01):

- **M19.** `impact-review/helpers/render-impact-report.mjs`: report rows (synthesis, contract, regression,
  ship) are free-form objects — the schemas only require an object — and the renderer printed every
  object row as JSON (200 rows in five recorded Codex reports). A flat row (string, number, boolean or
  string-array values) now renders as its main text (`text`, `issue`, `title`, `summary`, …, first
  present) followed by ` — key: value; …` for every other field; a row with nested values keeps the
  stable JSON form. Replaying the five recorded runs: status, verdict and gates unchanged, all 318
  field values present. The ledger text and row keys are unchanged. Test:
  `core-impact-review-row-text.test.mjs`.
- **M20.** deep-review line corrections (`finding-pipeline.mjs`, `render-review-report.mjs`). Models
  often read files without line numbers (Codex `sed -n`, Pi `read`); in nine recorded Codex runs
  that alone left 6 of 9 reviews `PARTIAL_REVIEW` (triage planned ranges past the end of the file;
  verifiers quoted correctly but one to six lines off). Two code corrections, both recorded:
  - A planned coverage range that starts inside the file but ends past it is checked through the
    last line (`reviewerLedger.plannedRangeCorrections`). One that starts past the file still fails.
    This changes pi-workflow's D04 rule (2026-09-07 audit: reject ranges past EOF), which guarded
    against silently accepting such a range; the correction is now listed instead.
  - A verifier quote that is not at its cited lines is accepted when the exact quote occurs exactly
    once in the cited file; the evidence row moves to those lines. An absent or repeated quote still
    fails. The quoted bytes are never changed or normalized.
  Partition output carries `evidenceCorrections` (only when there are any) and the report lists them
  under "Line corrections". Replaying the nine runs (report stage emulated with a consistent verdict):
  7 `NEEDS_WORK`, 2 `PARTIAL_REVIEW` (a reviewer quote outside its planned range; a quote not in the
  file); the four runs without corrections produce byte-identical stage output. Tests:
  `core-deep-review-line-corrections.test.mjs`, D04 in `core-deep-review-d01-d10.test.mjs`.
- **M21.** deep-review evidence tolerance (owner decision, 2026-11-01), refining M20. Evidence is
  accepted with a recorded correction when it differs from the file only in (a) cited lines, a
  planned range end, or a coverage quote's position — at most 10 lines off; or (b) whitespace, line
  endings, or quote/dash/space characters (each line trimmed and folded the way Codex `apply_patch`
  and Pi `edit` match text). The match must be unique in the file; a folded match stores the file's
  own lines as the evidence. Different words, farther positions, repeated text, escape typos (a
  literal `\t`) and invalid UTF-8 still fail. M20's unbounded relocation is now capped (D04's
  original `1-99` case is rejected again). The report section is renamed "Evidence corrections".
  Replaying the 14 recorded Codex runs (report stage emulated with a consistent verdict): 11
  `NEEDS_WORK`, 3 `PARTIAL_REVIEW` (a repeated short quote, a literal `\t`, a quote with a missing
  word); the three runs without corrections produce byte-identical stage output.

## Worker prompt rendering (core)

Workers see the artifact tool under an executor-specific name (`mcp__workflow_artifact__workflow_artifact`
on Pi, Codex and Claude, all verified live in WP6–WP8). Bundled prompts and the engine's own prompt
text name it by the logical name `workflow_artifact` (or the placeholder `{{workflow_artifact}}`).

- `src/core/artifact-tool-names.ts` holds `ARTIFACT_TOOL_NAME_MAPPINGS` (moved from
  `src/mcp/visible-names.ts`, which re-exports it; every row is now `verified: true` with the live
  evidence) and `renderWorkerPromptToolNames(text, executorId)`: the placeholder and every bare
  `workflow_artifact` tool mention become `artifactToolVisibleName(executorId)`; evidence locators
  (`workflow_artifact:<id>`) and longer identifiers are left alone.
- The task backend (`launchSubagentTask`) renders the task prompt and the system prompt with the run's
  executor id just before the SubmitRequest. `task.md`, `system-prompt.md` and the launch provenance
  keep the engine's canonical text (logical name), so `prompt.sha256` still equals `sha256(task.md)`.
- Tasks that have the artifact server get a `# Workflow Artifact Tool` section with
  `WORKFLOW_ARTIFACT_TOOL_GUIDELINES` in the system prompt (MCP server instructions are not shown by
  every client; Pi 1.1 does not show them).
- **Live bundle 3 (M17):** `renderWorkerPromptToolNames` also adds, right after the system prompt's
  `Only these tools are enabled for this workflow task: …` line, a note naming how the enabled
  logical tools surface on the executor (`WORKER_TOOL_NAME_MAPPINGS`, from the adapters' tool
  mapping tables): Codex `read`/`grep`/`find`/`ls` → the shell tool with read-only commands,
  `web_search`/`fetch_content` → the hosted `web_search`; Claude `read` → `Read`, `grep` → `Grep`,
  `find`/`ls` → `Glob`, `web_search` → `WebSearch`, `fetch_content` → `WebFetch`. Pi keeps the
  logical names (no note). Why: the live Codex spec-review `extract-spec` worker, told that only
  `read, grep, find, ls` were enabled, ran no command and reported SPEC.md "unavailable" (domain
  verdict INCONCLUSIVE); Codex impact-review workers likewise never read the code. Regression test:
  `core-worker-prompt-render.test.mjs` "the renderer maps the enabled logical tool names for Codex
  and Claude, not for Pi".

## Support table

Offline B4 negotiation of every bundled spec on each adapter's capability table (no CLI or model
call): the spec is compiled with its default execution profile, every negotiated stage gets
`workflowTaskRequirementContext` with the default run policy (non-interactive, no unverified
opt-in, no strict profile, the spec's `allowReadOnlyDowngrade`) in each permission mode
(`docs/permissions.md`): **`free`**, the default of every run, and **`safe`**. "Declared table" uses
`createExecutor(null).capabilities()`; "Probed, clean environment" merges the rows the adapter's
probe reports in a clean environment (Pi with `pi-web-access` installed, Codex without a global
`AGENTS.md` or `~/.codex/rules` allow rules; Claude's probe changes no negotiated row).
Generator: `test/helpers/bundled-support-table.mjs` (`--write` updates this section);
`test/unit/bundled-workflows.test.mjs` fails when it is stale.

This table is offline. The live stage-1 results (every bundled workflow run end to end on Pi, Codex
and Claude, default `free` mode) are in [`docs/support.md`](support.md) and, with the evidence, in
[`docs/live-acceptance-stage1.md`](live-acceptance-stage1.md).

Statuses: **accept** (no degradation), **degrade** (accepted non-interactively and recorded; an
interactive host asks once in `safe` mode), **refuse** (the run is not started). Reading the rows:

- `webTools.safetyPolicy:unknown`: the stage uses the CLI's own web tools; their URL, private-network
  and redaction controls are not engine-enforced (C2, plan §6.5). Shown to the user, never silent.
- `CAPABILITY_MISSING:toolAllowlist.fine`: Codex has only a coarse sandbox, so the precise `tools`
  lists cannot be enforced. In `free` mode this is accepted for every stage and recorded (the
  preview marks it `(accepted: free mode)`); every bundled stage is declared `readOnly`, which
  Codex still enforces with its `read-only` sandbox in both modes.
- `forcedReadOnly` (`safe` only): the spec opts in (`allowReadOnlyDowngrade`), so instead of
  refusing, B4 degrades the precise tool lists to "readOnly enforced".
- `CAPABILITY_UNVERIFIED:webTools` (Pi, declared table): Pi's web tools come from the `pi-web-access`
  extension; only the probe (`pi list`) establishes them. Without the extension the probe reports
  `none` and deep-research is refused with `CAPABILITY_MISSING:webTools`.
- Codex `contextIsolation` is `emulated` in the declared table (no warning, silent); the probe makes
  it `native`, or `emulated` with a warning (a recorded degradation) when a global `AGENTS.md`
  exists; likewise `readOnly` with `~/.codex/rules` allow rules (docs/executors/codex.md). In
  `free` mode these environment warnings are recorded, never refused or confirmed; in `safe` mode
  an interactive host confirms them and `strictCapabilities` refuses them. The live runs showed
  both on a machine with allow rules and a global `AGENTS.md`.

<!-- bundled-support-table:start -->
<!-- Generated by test/helpers/bundled-support-table.mjs; do not edit by hand. -->

| Workflow | Executor | Mode | Stages | Declared table | Probed, clean environment |
|---|---|---|---|---|---|
| `deep-research/spec.json` | pi | free | 5 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | pi | safe | 5 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | codex | free | 5 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | codex | safe | 5 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | claude | free | 5 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | claude | safe | 5 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | pi | free | 6 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | pi | safe | 6 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | codex | free | 6 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | codex | safe | 6 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | claude | free | 6 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | claude | safe | 6 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-review/spec.json` | pi | free | 4 | accept | accept |
| `deep-review/spec.json` | pi | safe | 4 | accept | accept |
| `deep-review/spec.json` | codex | free | 4 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `deep-review/spec.json` | codex | safe | 4 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `deep-review/spec.json` | claude | free | 4 | accept | accept |
| `deep-review/spec.json` | claude | safe | 4 | accept | accept |
| `impact-review/spec.json` | pi | free | 12 | accept | accept |
| `impact-review/spec.json` | pi | safe | 12 | accept | accept |
| `impact-review/spec.json` | codex | free | 12 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `impact-review/spec.json` | codex | safe | 12 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `impact-review/spec.json` | claude | free | 12 | accept | accept |
| `impact-review/spec.json` | claude | safe | 12 | accept | accept |
| `spec-review/spec.json` | pi | free | 6 | accept | accept |
| `spec-review/spec.json` | pi | safe | 6 | accept | accept |
| `spec-review/spec.json` | codex | free | 6 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `spec-review/spec.json` | codex | safe | 6 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `spec-review/spec.json` | claude | free | 6 | accept | accept |
| `spec-review/spec.json` | claude | safe | 6 | accept | accept |

<!-- bundled-support-table:end -->

## Tests

- Ported pi-workflow tests: 31 files (`test/unit/core-<name>.test.mjs`) plus the bundled half of
  `core-graph-schema-contracts`; the table, every changed assertion and every test not ported are in
  `docs/core-port.md` "WP10 tests".
- `test/unit/bundled-workflows.test.mjs`: compile + no forbidden references + no Pi-only capability +
  source-verification statement + support table in sync.
- `test/unit/core-worker-prompt-render.test.mjs`: per-executor rendering and the task-backend launch.

## Open problems for the live bundle

- Web tool names in prompts: prompts and the system prompt's tool list name `web_search` /
  `fetch_content` (Pi vocabulary). Claude shows `WebSearch`/`WebFetch`, Codex one hosted
  `web_search`. Since M17 (live bundle 3) the system prompt maps the enabled names per executor;
  since WP37 the task prompts are rendered per executor too (Claude names inline, the Codex mapping
  note; docs/core-port.md WP37 change log 1).
- Quality of model-reported web evidence (no byte check) and of the URL-only verification pool is
  unmeasured (plan §7: stage 1 checks completion and format only).
- Pi needs `pi-web-access` for deep-research (refused otherwise). Codex shows `forcedReadOnly` only
  in `safe` mode; the default `free` mode records the coarse allowlist instead (table above).
- User-authored pi-workflow specs that still list `workflow_web_*` compile and are refused at launch
  (`CAPABILITY_MISSING`); they need the new tool names.
