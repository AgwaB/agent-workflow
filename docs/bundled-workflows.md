# Bundled workflows, skills and agents

The bundled workflows originated in `@agwab/pi-workflow` 0.16.4. They ship as directory-local
bundles with a spec, schemas and support helpers.

## Workflows

| Workflow | Agent | Purpose |
|---|---|---|
| `deep-research` | `researcher` | Source-backed research, claim verification, synthesis and evidence audit |
| `deep-review` | `scout` | Independent code/design review, finding verification and deterministic report |
| `spec-review` | `scout` | Requirements extraction, implementation/test coverage and gap verification |
| `impact-review` | `scout` | Change scope, contract impact, regression risk and ship readiness |

`deep-research/tiered-verification.spec.json` is an alternative research spec that separates core
and tail verification. Every bundled spec opts into `allowReadOnlyDowngrade`; all model-backed
stages are readOnly. None requires Pi-only `fast`, `toolResultBudget` or `inheritHostTools`.

```sh
agent-workflow list
agent-workflow show deep-review
agent-workflow run deep-review "Review the current change." --executor claude
agent-workflow run deep-research "Compare the storage designs." --input depth=max --profile high
```

Pi exposes the same actions through `/aw`; MCP hosts use `workflow_list`, `workflow_run` and
`workflow_wait`. See [usage](usage.md) for inputs, profiles, roles and bundle lookup priority.
Deep-research declares `low`, `medium` and `high` execution profiles, defaulting to `medium`.
`low` and `medium` use max-2 batching for eligible verification items; `high` keeps singleton
verification.

## Reports and evidence

Each workflow emits `completionSummaryMarkdown`, a project-relative `final-report.md` link and
explicit limitations. Full reports end with Related artifacts. Deep-research also writes
`executive.md` and `audit.md`; deep-review writes `review.md`; spec-review and impact-review write
`source-ledger.json`. Missing or inconsistent canonical inputs fail or block rendering rather than
produce a clean report.

Review verdicts are deterministic. Kept/weakened findings make deep-review `NEEDS_WORK`, with
incomplete coverage named as limitations; without findings, incomplete coverage is `PARTIAL_REVIEW`.
Grounded spec-review gaps on an intact ledger yield `GAPS_FOUND`; without gaps, unresolved
requirements yield `INCONCLUSIVE`, and `CONFORMS` requires complete coverage. Spec-review rechecks
at most eight `unclear` requirements; only byte-grounded `covered` answers resolve them.
`needsHuman` rows are not rechecked.

Local review citations are checked against repository bytes. Unique matches can receive recorded
corrections for positions at most 10 lines away, whitespace/line endings, quote/dash/space folding,
soft-wrapped lines, and omitted inline-code/emphasis markers in Markdown files. Different words,
ambiguous matches and invalid UTF-8 still fail. Reports list Evidence corrections. See
[local review evidence](usage.md#local-review-evidence) for reader boundaries and source accounting.

Deep-research uses the CLI's `web_search` and `fetch_content` mappings. Its quote check first uses
captured page text for the cited URL, otherwise fetches the page itself (public addresses only;
5 MB response cap, PDFs up to 10 MB through system `pdftotext`). It checks exact and formatting-folded
quotes, with symbol-spacing tolerance only for math; it does not change claim verdicts. Reports
count found quotes and list unchecked ones with reasons. `AGENT_WORKFLOW_EVIDENCE_REFETCH=0` at
launch disables the check; without it, source verification is model-reported. The evidence cache
under `.agent-workflow/evidence-cache/` is capped at 1 GiB with a 24-hour lifetime.

Research synthesis requires a header and all sixteen indexed pages at `maxChars: 16000`, including
empty tails, exactly once. Pages are bounded in UTF-16 units and UTF-8 bytes, with 256,000 aggregate
page units plus a bounded header. Oversized rows or bank exhaustion block explicitly; larger/root
reads do not substitute for the required projections.

Reports use the task's requested language (otherwise its language), retaining verdict tokens,
identifiers, paths, code and evidence quotes. Impact-review's completion summary lists at most four
action rows, blocking first, and counts the remainder; the full report retains every row.

## Skills and agents

| Asset | Purpose |
|---|---|
| `skills/agent-workflow/SKILL.md` | Host MCP tool protocol |
| `skills/workflow-guide/SKILL.md` and `scaffolds/` | Workflow authoring, validation and starter patterns |
| `skills/execution-router/SKILL.md` | Recommendation-only execution-path selection |
| `agents/scout.md` | Local exploration for review workflows |
| `agents/researcher.md` | Research with `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content` |

Plugin skill copies are generated for the host's MCP tool names; see [plugins](plugins.md).
Unknown tool names do not grant tools: use `web_search` / `fetch_content`, not `workflow_web_*`.

## Worker prompt rendering

Write `workflow_artifact` or `{{workflow_artifact}}` in prompts. The engine renders it to the
executor-visible name, leaving evidence locators such as `workflow_artifact:<id>` unchanged.
Persisted prompts and their hashes retain canonical logical names. Workers with the artifact server
also receive its guidelines in the system prompt.

Logical tools are rendered per executor: Claude uses `Read`, `Grep`, `Glob`, `WebSearch` and
`WebFetch`; Codex uses read-only shell commands and hosted `web_search`; Pi keeps the logical names.
See [MCP](mcp.md#visible-tool-names) for artifact tool naming.

## Support table

This is offline capability negotiation, not a model-quality comparison. Each spec is compiled with
its default profile, then negotiated in `free` (the run default) and `safe` modes. The policy is
non-interactive, with no unverified opt-in or strict profile, and uses the spec's
`allowReadOnlyDowngrade`.

“Declared table” uses `createExecutor(null).capabilities()`. “Probed, clean environment” merges
probe rows for Pi with `pi-web-access`, Codex without global `AGENTS.md` or allow rules, and Claude
with no changed negotiated row. Generator: `test/helpers/bundled-support-table.mjs --write`.

- **accept**: no degradation. **degrade**: accepted and recorded. **refuse**: nothing starts.
- `webTools.safetyPolicy:unknown`: CLI browsing policy is not engine-enforced.
- `CAPABILITY_MISSING:toolAllowlist.fine`: Codex cannot enforce precise tool lists. `free` records
  this; `safe` uses `forcedReadOnly` because these specs opt in. Bundled stages remain readOnly in
  both modes.
- `CAPABILITY_MISSING:usage.cost`: token-only usage; unknown cost is `null`.
- `CAPABILITY_UNVERIFIED:webTools`: Pi's declared table cannot confirm `pi-web-access`; the probe
  must find it. Without it, research is refused with `CAPABILITY_MISSING:webTools`.
- Codex global instructions or allow rules can add isolation/readOnly warnings. `free` records
  them; `safe` asks an interactive host, and strict capabilities can refuse them.

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
| `spec-review/spec.json` | pi | free | 7 | accept | accept |
| `spec-review/spec.json` | pi | safe | 7 | accept | accept |
| `spec-review/spec.json` | codex | free | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `spec-review/spec.json` | codex | safe | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `spec-review/spec.json` | claude | free | 7 | accept | accept |
| `spec-review/spec.json` | claude | safe | 7 | accept | accept |

<!-- bundled-support-table:end -->
