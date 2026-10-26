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

## Support table

See "Support table (generated)" below.
