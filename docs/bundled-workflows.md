# Bundled workflows, skills and agents (WP10)

Source: `@agwab/pi-workflow` 0.16.4, commit `b83cc4f` (MIT, same author). The owner decision on F5
(plan §9 Q1) applies: the four bundled workflows are not a compatibility target, so they change as
far as the executor-neutral engine needs.

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
  `~/.agent-workflow/workflows/` (`$AGENT_WORKFLOW_HOME`) and the `agent-workflow` CLI; Pi's
  locations are not mentioned (2026-10-30: they are not read), so `grep -rn "workflow_web_\|\.pi/workflows\|PI_WORKFLOW_" workflows skills agents` is empty.

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
  English in every language of the report. Since M22 (2026-11-01) a run whose web quote check ran
  says instead how many quoted web passages the engine found on the cited pages
  (`sourceVerificationStatement`); the C2 statement stays for runs without the check.

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
- **M22.** deep-research web quote check (owner decisions 2026-11-01). Both specs gain a
  support stage `check-web-quotes` (`helpers/check-web-quotes.mjs`, from the verifier stages) whose
  output is an extra `final` source. On by default; a launch with `AGENT_WORKFLOW_EVIDENCE_REFETCH=0`
  turns it off for that run. When on, the engine itself fetches every cited http(s) page (`context.evidence.checkWebQuotes`,
  `src/core/evidence-*.ts`: public addresses only, checked per redirect hop and at DNS time; 5 MB
  cap, PDF 10 MB via the system `pdftotext`; `Accept` prefers Markdown, `Accept-Language` en-US;
  pages cached by SHA-256 under `.agent-workflow/evidence-cache/`, 1 GiB cap, 24 h) and looks for
  each verifier quote: exact, then formatting-folded, then — only for quotes with math notation —
  with spaces around symbols removed. No edit-distance allowance. A quote that cannot be checked
  gets a reason (image, PDF tool missing, little page text, HTTP error, …). `render-executive.mjs`
  adds one "Quote check" line to the final report's audit summary and a "Quote check" section with
  every unchecked quote to `audit.md`; claim verdicts are unchanged. Replaying the 114 recorded
  Pi/Codex verifier quotes: 108 found (exact 88, normalized 19, math 1), 6 not checked (image 4,
  a PDF table row, one HTTP 403); 438 mutated quotes (numbers, negation, words, order, merges) 0
  found. Tests: `core-evidence-*.test.mjs`, `core-deep-research-web-quote-check.test.mjs`.
  Before fetching, the check reads what the verifier's own web tools returned (`exec-events.jsonl` of
  the task's attempts, `src/core/evidence-receipts.ts`): a quote in page text the worker fetched for
  the same URL (Pi `fetch_content`) is `verified-captured` and that URL is not fetched; a quote found
  only in a summary (Claude `WebFetch`) or search result is noted (`inWorkerSummary`) and still
  checked on the page — the report counts how often such summary quotes were on the page. Codex web
  events carry no page text. Recorded Pi run: 33 of 39 quotes verified from its own captures, 2 pages
  fetched. The decision is made at launch and recorded as `run.evidenceRefetch` (live finding: a
  stage driven by a process without the launch environment reported "off"); a quote's own trailing
  punctuation is not compared (live Claude quotes ending in "." where the page continues). Default
  on after a live comparison: three Claude Sonnet 5.5 runs, 77 quotes, 75 on the re-fetched page;
  69 were also in a `WebFetch` summary, 68 of them on the page; re-fetch costs no model tokens
  (about 2 s for 14 pages) and is the only check possible for Codex.
  Since 2026-11-02 (quality A/B review findings, reproduced): an exact or folded match may not start
  or end inside a word or number of the page ("12% of users" is not in "112% of users"; scripts
  written without spaces between words are exempt; the 103 recorded quotes and 49 cached live Claude
  and Pi quotes still match); HTML text extraction is linear on hostile markup; a compressed response
  cut off mid-stream settles instead of hanging the stage.
- **M23.** deep-research quote instructions (2026-11-01, after M22). Both specs' research and verifier
  prompts replace "Source verification is model-reported: no workflow tool re-reads source bytes" with
  what now happens: the engine looks for every quote on the cited page, so a quote must be one
  contiguous passage copied exactly — not joined list items, headings or names (the two live Claude
  quotes the check could not find), not reworded, not a tool's summary. A value read from an image or
  scanned table cannot be checked as text: prefer a text source, else name the figure/table in
  `excerptLocation`, which the audit's "Quote check" table shows next to the quote. The verify prompt
  stays under its 6,000-character ceiling (5,811).
- **M24.** deep-research reader translations (owner decision 2026-11-03). Reports read in the task's
  language except the repeated frame. `final-audit` (both specs) may add `synthesis.translations`:
  `claims[{id, text, explanation?}]` for the claims and leads the report shows and
  `factSlots[{id, area, whyItMatters?, gap?}]` for the evidence-strength rows and gaps, omitted when the text is
  already in the task's language. No new stage or model call: the same final-audit output carries
  them. `render-executive.mjs` shows them in Main findings, the Evidence strength table and the
  Unsupported/Contested/Unverified-lead lines; section titles, field labels, statuses, quotes and
  sources stay as rendered, and `audit.md` keeps the original claims plus a "Reader translations:
  N applied, M ignored" line. An entry with an unknown or repeated id or empty text is ignored (the
  original shows); a malformed container fails the schema and the renderer. The same change stops
  the Evidence strength table from escaping its source links a second time.
  A coverage gap without its own text (it had only ids: `Coverage gap — gap-coverage-001 — related
  slots: slot-001`) now names each related area (translated when given) and what is
  missing (the slot's `gapReason`, or the translated `gap`); one without related areas shows its scope
  item. The packet keeps the ids.
- **M25.** Report language for deep-review and spec-review (2026-11-03, owner: a Korean deep-review
  task got an English result). Their `report` stage prompts gain impact-review's rule: write the
  summary, risks (spec-review: and scope-limitation text) and recommended next action in the runtime
  task's requested language, or the task's language when none is requested, keeping verdict tokens,
  ids, file paths, symbols and code unchanged. deep-review's devil-advocate verifiers also write
  their own prose (digest, recommended action, counter-evidence, evidence-unavailable reason) in that
  language and add `readerTitle` / `readerRationale`, faithful translations of the finding's title and
  rationale, when those are in another language (schema: optional, 800 / 4000 characters). The
  partition carries them beside the reviewer's originals, which stay the identity and the ledger
  text; the report shows them in finding headings, rationales and the key-findings list. A missing,
  empty or oversized value is ignored. Evidence quotes, code and paths are never translated.
- **M26.** spec-review evidence tolerance (2026-11-04, live run of every bundled workflow; M21's
  owner decision applied to spec-review). A Codex verifier quoted a tab-indented function with spaces,
  so a real S6 gap became needs-human and the run INCONCLUSIVE. The partition now matches a verifier
  citation (`evidence`, `counterEvidence`) whose quote is not inside its cited lines once more: a
  unique exact occurrence, else a unique occurrence after folding each line as in M21, at most 10
  lines from the cited range (`spec-evidence-gate.mjs` `correctCitations`). The citation then holds
  the actual lines and, for a folded match, the file's own text, so the byte gate and the renderer's
  re-audit stay exact; the partition carries `evidenceCorrections` (only when there are any) and
  the report lists them under "Evidence corrections". Invalid ranges, different words, farther
  positions and repeated text still fail. Requirement-coverage citations get the same correction for
  the check only (a second live Codex run left REQ-S6 unresolved on indentation): the coverage rows
  stay as the candidate control wrote them, since their bytes are bound to it; the gate's coverage
  rows carry `corrections`, which the renderer recomputes from the same file bytes and lists too.
  extract-spec's requirement quotes are checked the same way (a third live run: two quotes joined
  soft-wrapped spec lines), recorded as `correction` on the requirement-source rows. The same run
  found a multilingual bug: a requirement statement without ASCII letters or digits was
  `missing_or_meaningless_requirement_statement`; any script's letters or digits now count. The
  locate helpers live in `local-evidence-reader.mjs`. Replaying that run: its three
  reconciliation issues are gone. Tests: `core-review-helper-byte-gates.test.mjs`.
- **M27.** impact-review completion summary (2026-11-04, same live runs). Claude and Antigravity
  runs failed at the final render: `completionSummaryMarkdown` (7,132 and 9,209 characters) broke the
  render control schema's 6,000. The summary now lists the first four action rows (blocking first,
  as spec-review's lists four) and counts the rest ("N additional action row(s) are covered in the
  full report"); the full report keeps every row. Replaying the four live renders: 2,444–3,406
  characters, statuses and verdicts unchanged. Test: `core-impact-review-row-text.test.mjs`.
- **M28.** deep-review and spec-review: two more trivial differences (2026-11-04, same live runs; a
  Codex deep-review ended PARTIAL_REVIEW on them). (1) A quote that joins a soft-wrapped line — the
  file's line break and indentation given as one space — is matched as a whitespace difference
  (`locateJoined`, after M21's per-line folding finds nothing); spacing inside a line still has to
  match, and the stored evidence is the file's lines. (2) deep-review: a `metadata-only` coverage
  row for a planned range whose lines are all blank (triage planned `SPEC.md:31` and `:37`) counts
  as covered and is listed under "Evidence corrections" ("the planned lines are blank"). Replaying
  the live run: its three partial sources become one (a quote missing a Markdown backtick, still a
  content difference); keep 2 → 4, needs-human 3 → 1. Tests:
  `core-deep-review-line-corrections.test.mjs`, `core-review-helper-byte-gates.test.mjs`.
- **M28b.** Markdown quotes (2026-11-04): in a `.md`/`.markdown`/`.mdx` file, a quote that drops
  inline-code backticks or emphasis asterisks matches as a whitespace-class difference (deep-review,
  spec-review, the support-partition scaffold); code files keep them significant. The Codex
  deep-review run whose last partial source was such a quote replays with no partial source (keep 5).
  Tests: `core-deep-review-line-corrections.test.mjs`, `core-review-helper-byte-gates.test.mjs`.
- **M29.** Confirmed findings decide the verdict first (owner decision 2026-11-04, after the live run
  of every workflow: all six non-clean verdicts had 2–6 grounded findings but read
  INCONCLUSIVE or PARTIAL_REVIEW because one or two requirements stayed "unclear" or two reviewers
  could not read their planned lines, so one review gave different verdicts on different
  executors). spec-review: grounded KEEP/WEAKEN gaps on an intact ledger (dispositions and coverage
  rows as saved, requirement set proven) with complete source and verifier coverage are
  GAPS_FOUND; unresolved requirements and needs-human rows are listed as limitations ("Requirements
  not settled by this review: REQ-005 (unclear) …") and the run passes. Without such gaps an
  unresolved requirement still makes INCONCLUSIVE; CONFORMS still needs every requirement covered;
  stage failures and ledger integrity failures are unchanged. deep-review: kept or weakened findings
  make NEEDS_WORK even when part of the review is incomplete (named in the report); a partial review
  without them stays PARTIAL_REVIEW. The verdict is no longer worked out by the report model from
  prose rules: the partition computes it (`readProjection.ledgerVerdict`, a new required read;
  deep-review: the report packet's `expectedVerdict`) with the same function the renderer uses
  (`specReviewVerdict` in `spec-evidence-gate.mjs`; `review-verdict.mjs`), and the report stage
  copies it. Replaying the 13 live spec-review and deep-review runs through every support step with
  the recorded model outputs: spec-review 8 runs → all GAPS_FOUND, passed (5 were INCONCLUSIVE);
  deep-review 5 runs → all NEEDS_WORK, passed (1 was PARTIAL_REVIEW). A first live Claude run after the
  change still failed: a verifier said NEEDS_HUMAN, its gate row sat beside the final rows and the
  renderer counted that as a broken ledger; the ledger check now allows gate rows of needs-human
  findings (every final and dropped row must still be present and recomputed equal). Tests:
  `core-review-verdict-precedence.test.mjs`, IRCF-01 `unclear-keep` and `bad-extra-gap-citation` in
  `core-spec-requirement-coverage.test.mjs`, `core-review-helper-byte-gates.test.mjs`.
- **M30.** Completion-summary sanitizer (2026-11-04, same live runs). The four renderers
  (`render-spec-review-report.mjs`, `render-impact-report.mjs`, `render-review-report.mjs`,
  `render-executive.mjs`) hid engine names with patterns that also hit reviewed content:
  `workflow[_-]…` turned `src/workflow-stop.ts` into `src/[run omitted]`, bare `control.json` /
  `refs.json` / `review.md` became `[artifact omitted]` when the reviewed code had such a file, and
  the `.pi/workflows` path rule was pi-workflow's. Now hidden: paths under `.agent-workflow/workflows`,
  run ids `workflow_<id>_<hex6>` (also after Markdown escaping, which had kept real run ids visible
  in spec-review and impact-review), task ids `task-<n>`, the sidecar names `final-report.md`,
  `audit.md`, `executive.md`, and `refs.json` / `control.json` only stage- or path-qualified
  (`final-audit.control.json`, `…/control.json`). Test: `core-impact-review-row-text.test.mjs`.
- **M31.** spec-review rechecks unclear requirements (2026-11-04, after the same live runs: two
  spec-review runs read INCONCLUSIVE only because the candidate stage left one or two requirements
  "unclear"). Two new stages between `candidate-findings` and `partition-findings`: the support
  stage `select-unclear` lists the requirements with status `unclear` and their extracted statements
  (at most 8; more are named as not rechecked), and the foreach `recheck-requirements`
  (`profileRole: verification`) answers `covered`, `gap`, `partial` or `unclear` per requirement
  with typed citations. The partition reads each recheck from the task's own `control.json`
  through the runtime source statuses (a control that names another requirement than its item, or a
  requirement rechecked twice, is ignored). Only `covered` changes a row: the unclear row becomes
  covered with the recheck's evidence, which then has to pass the same byte gate as any covered row;
  other answers keep it unclear and are shown in the coverage table (`unclear, re-checked: gap — …`).
  `needsHuman` rows are not rechecked (they ask about the spec's intent). The renderer rebuilds the
  rows from the candidate control and the rechecks found through the partition manifest
  (`applyRechecks`) and rejects a partition that differs. A failed recheck task leaves its row
  unclear and does not count as a failed source. With no unclear row the foreach has no items (no
  model call). Tests: IRCF-01 `unclear-rechecked-covered` (CONFORMS), `unclear-recheck-bad-evidence`
  and `unclear-recheck-wrong-id` (INCONCLUSIVE), `unclear-keep` (recheck says gap; GAPS_FOUND as
  before) in `core-spec-requirement-coverage.test.mjs`.
  Live (2026-11-04, after M31): four spec-review runs (claude haiku ×3, codex gpt-5.6-luna) on the
  same project left no requirement `unclear` (codex used `needsHuman`, which is not rechecked), so
  `recheck-requirements` had no items and cost nothing (claude runs $0.08–0.09 each); three of
  the 13 earlier recorded runs had one or two unclear rows. The non-empty recheck path is so far
  covered offline only (IRCF-01, the real scheduler).
- **M32.** spec-review report owner-ledger copy (2026-11-04, live claude/haiku run
  `workflow_mw2hhe44_d3766c`): the report stage copied the first owner row with `source:
  "verify-findings.finding-001"`; that row's alias is the bare stage id `verify-findings` (a
  foreach's first item, see `docs/usage.md` "Source names"), so a correct GAPS_FOUND review failed
  ("The narrative report owner ledger … does not match"). The prompt's own example showed the wrong
  form (`"source":"verify-findings.F-001"` for a single item, and a `specId` the renderer's shape
  check rejects). Now: the example shows `"source":"verify-findings"`, `"specId":"verify-findings.f-001"`
  and the prompt says the first item's source is the bare stage id; the renderer compares the
  report's copy on the identity fields only (`ownerIdentityRows`: stage, spec, task, item,
  placeholder, batch, status), not the routing alias. The partition's own ledger, which the report
  is rendered from, is still checked with its aliases against the runtime source statuses. Replaying
  all 30 recorded runs: only that run changes (failed → passed). Test:
  `core-spec-review-owner-alias.test.mjs` (another alias passes; another task, item, spec id or
  status, or a missing row, still fails; the first case fails on the old renderer).

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
| `spec-review/spec.json` | pi | free | 7 | accept | accept |
| `spec-review/spec.json` | pi | safe | 7 | accept | accept |
| `spec-review/spec.json` | codex | free | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `spec-review/spec.json` | codex | safe | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `spec-review/spec.json` | claude | free | 7 | accept | accept |
| `spec-review/spec.json` | claude | safe | 7 | accept | accept |

<!-- bundled-support-table:end -->

## Tests

- Ported pi-workflow tests: 31 files (`test/unit/core-<name>.test.mjs`) plus the bundled half of
  `core-graph-schema-contracts`; the table, every changed assertion and every test not ported are in
  `docs/core-port.md` "WP10 tests".
- `test/unit/bundled-workflows.test.mjs`: compile + no forbidden references + no Pi-only capability +
  source-verification statement + support table in sync.
- `test/unit/core-worker-prompt-render.test.mjs`: per-executor rendering and the task-backend launch.
- `test/unit/support-replay-golden.test.mjs` (2026-11-04, regression net before refactoring the
  helpers): 30 recorded live runs of the four bundled workflows on pi, claude, codex and antigravity
  (`test/fixtures/support-replay/`: worker controls, source manifests and the reviewed project files)
  are replayed through every support stage with the current helpers and must give the committed
  golden controls (verdict, report Markdown, ledgers). Intended change:
  `node test/helpers/support-replay.mjs --write` and review the golden diff; more runs:
  `--capture <project dir>`. On the replay alone the helpers are 56–100 % line-covered, with the
  whole unit suite 86–100 % (`test/helpers/coverage-report.mjs`, merged V8 coverage).
- Refactor 2026-11-04 (behavior unchanged; golden replay and coverage before/after equal or higher):
  deep-research helpers share `source-access.mjs` (`findSource`, `asArray`, `asObject`,
  `stringOf`); deep-review's renderer takes `asArray` from `review-verdict.mjs`; spec-review's
  `partitionFindings` is split into `readSourceAuthority`, `collectBatchVerifiers` /
  `collectSingletonVerifiers`, `joinCandidateVerdicts` and `reconcileCandidateUniverse`. A bundle
  cannot import another bundle, so the spec-review and scaffold evidence readers stay two copies;
  `core-review-helper-byte-gates.test.mjs` fails when they differ. Same-named functions that do
  different things (deep-review `normalizeFinding`/`locationsOf` in the pipeline and the renderer,
  spec-review `ownerKey`) were left alone.

2026-11-03 (owner: the final report listed pipeline diagnostics per claim):

- **Report caveats.** `render-executive.mjs` `renderCaveats`: claims the pre-verifier sanitizer held
  back (`evidenceState: "not_sent_to_verifier"`, reason `sanitized from verifier candidates: …`)
  read as one line — how many, why in reader words (`HELD_BACK_REASONS`, English or Korean with the
  report), their sources (up to 6, then `+N`) — instead of one `Gap:` line each; `sanitized
  verifier candidates: claim-…` notes leave slot gap text. The evidence audit keeps every row.
  Test: `core-deep-research-reader-output.test.mjs` "claims the sanitizer held back read as one
  reader line…".

- **Cross-language claims.** In Codex run `workflow_mw0y4aje_c064c4` (a Korean task) normalize-claims
  wrote its claims in Korean while the source evidence hints are English quotes, so the
  sanitizer's word check (`hintSupportsCandidate`: ≥ 4 shared tokens, ≥ 18 %) demoted all 18
  candidates as `source_hint_claim_mismatch` and nothing was verified. Two changes: (B) the
  sanitizer skips the word check when a claim and its evidence are in different scripts
  (`lexicallyComparable`: CJK/Hangul share among letters differs by 0.3 or more, a syllable
  counting twice) and records them (`sanitizerDiagnostics.crossScriptCandidateIds`); the verifier
  judges them against the source; replaying that run's sanitizer input keeps all 18. (A) normalize-input-packet adds
  `packet.instructions.claimLanguage` (the normalize-claims prompt already follows packet.instructions
  and is at its T6 length ceiling): write each claim's text in the language of its source evidence; the
  final synthesis translates what the reader sees. Test:
  `core-deep-research-sanitizer-followup.test.mjs` "claims in another script than their source
  quotes reach the verifiers". Live with (A), 2026-11-04 (Korean task, codex, tiered variant
  `workflow_mw1ipu5z_88c698`, frozen in `test/fixtures/support-replay/`): normalize-claims wrote all
  18 verification candidates and 8 preserved claims in English like their sources, the sanitizer kept
  18 of 18 (no cross-script case needed), the report was Korean.

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
- The web tools are `web_search` and `fetch_content`. Any other name (for example `workflow_web_*`)
  is an unknown tool (2026-11-02): an agent listing it does not grant the web tools, and a stage asking
  for it is refused before launch (no executor mapping) or needs review.
