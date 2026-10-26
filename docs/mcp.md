# Worker artifact MCP server (WP5)

Workers read upstream workflow artifacts through one MCP tool, `workflow_artifact`. The server is
`dist/mcp/artifact-server/server.js` (source `src/mcp/artifact-server/`). It is hand-written and has
zero runtime dependencies. It wraps the core tool body from `src/core/workflow-artifact-tool.ts`
(ported from pi-workflow) and does not change it.

## Launch

```
node dist/mcp/artifact-server/server.js --config <task>/artifact-access.json [--max-output-chars <n>]
```

- `artifactMcpServerSpec(config)` (core) returns `[server.js, "--config", path]`.
- `artifactMcpServerSpecWithOutputLimit(config, limit)` (`src/mcp/artifact-server/spec.ts`) adds
  `--max-output-chars <limit>`. Pass `null` when the limit is unknown. Since WP5b it wraps the core
  `withArtifactMcpOutputLimit(spec, limit)`.
- **Measured limit (WP5b).** The engine launches the server itself with the right limit; adapters
  pass the spec through unchanged. See [Measured limits](#measured-limits-wp5b).
- The limit is a flag and not a config field. Launch provenance digests the config bytes, and
  `assertArtifactAccessConfig` rejects unknown keys.
- Exit codes:
  - `2`: usage error (missing `--config`, unknown flag, bad `--max-output-chars`).
  - `1`: the server refused to start (see Security).
  - `0`: graceful exit on stdin EOF, SIGTERM or SIGINT. Requests already in flight are answered first, and their ledger rows are written. SIGTERM gives them at most 5 s.

## Protocol

- **Transport:** stdio, newline-delimited UTF-8 JSON-RPC 2.0.
  - stdout carries protocol messages only. `console.*` is redirected to stderr.
  - stderr carries short diagnostics only: startup refusal, internal errors. It never prints env values or artifact content.
- **Accepted input framing:** `\r\n`, blank lines, messages split across chunks, and a final line without a newline. Lines over 4 MiB get a parse error and are discarded.
- **Versions:** `2025-11-25` (latest), `2025-06-18`, `2025-03-26`, `2024-11-05`.
  - This is the `SUPPORTED_PROTOCOL_VERSIONS` list of `@modelcontextprotocol/sdk` 1.32 without `2024-10-07`, which is a pre-release draft and not a published spec revision. A unit test keeps the list in sync with the SDK constants.
  - The server only uses lifecycle, `ping` and tools with text content, and these are the same in all four revisions.
  - **Negotiation:** if the client's `protocolVersion` is supported, the server echoes it. Otherwise it answers `2025-11-25` and the client decides.
- **Version-gated details:**
  - JSON-RPC batches are accepted only in a `2025-03-26` session, the only revision that has them. Other sessions get `-32600`.
  - Tool `annotations` are sent from `2025-03-26` on.
  - Tool `title` is sent from `2025-06-18` on.
- **Methods:**
  - `initialize` returns:
    - `capabilities: {tools: {listChanged: false}}`
    - `serverInfo: {name: "agent-workflow-artifact", version}`
    - `instructions`: the tool guidelines
  - `notifications/initialized` and other notifications are accepted and get no response.
  - `ping` → `{}`.
  - `tools/list` and `tools/call` need a completed `initialize`. The server does not wait for `notifications/initialized`, because some clients pipeline requests.
- **Errors:**

  | Code | When |
  |---|---|
  | `-32700` | parse error (`id: null`) |
  | `-32600` | bad request: no `jsonrpc: "2.0"`, null or invalid id, unsupported batch, request before `initialize`, second `initialize` |
  | `-32601` | unknown method |
  | `-32602` | bad params: `initialize` without `protocolVersion`, missing tool name, unknown tool, non-object `arguments` |
  | `-32603` | unexpected internal failure |

  Invalid tool *arguments* are not protocol errors. They return a tool result with `isError: true`, so the model can correct itself (2025-11-25 guidance).
- **Interop proof:** the official SDK `Client` + `StdioClientTransport` connects, lists tools, calls the tool, pings and closes (`test/unit/mcp-artifact-sdk-interop.test.mjs`). The server's responses for every supported version validate against the SDK's result schemas. The SDK is a **devDependency only**.

## Tool contract

- `name`: `workflow_artifact`.
- `description`: `WORKFLOW_ARTIFACT_TOOL_DESCRIPTION`, verbatim.
- `inputSchema`: `WORKFLOW_ARTIFACT_TOOL_PARAMETERS`, verbatim:
  - `action`: `list` | `read`, required.
  - `source`: a canonical source name.
  - `artifact`: one of `control`, `analysis`, `refs`, `raw`, `prompt`, `system-prompt`, `stderr`, `result`.
  - `path`: a simple JSON path.
  - `maxItems` and `maxChars`: integers ≥ 0. They require `path`.
  - `offset` (WP5b): integer ≥ 0, a character offset for a paged whole-artifact read. It cannot be
    combined with `path`, `maxItems` or `maxChars` (tool error). See [Paged reads](#paged-reads-wp5b).
- `annotations`: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: false` (each read appends a ledger row), `openWorldHint: false`.
- **Guidelines:** `WORKFLOW_ARTIFACT_TOOL_GUIDELINES` are sent as the server `instructions`, one `-` bullet per line. Not every client puts server instructions into the model context (Pi 1.1 does not), so the task backend also puts the guidelines into the worker system prompt (WP10).
- **Results:**
  - The result is a single `content` text item. Its text is identical to the core tool's text whenever it fits the delivery bound.
  - Tool-level failures return `isError: true` and the core failure payload (`status: "blocked"`, `code: "artifact_read_failed"`, …).
  - **No `structuredContent`.** Some clients prefer `structuredContent` over `content` when both are present, so the model would lose the artifact text. It would also double the bytes counted against the client limit.

## Read ledger

Every successful `read` appends one row to `config.ledgerPath` (`<task>/read-ledger.jsonl`). The
row is the core `WorkflowArtifactReadLedgerRecord`, with the same keys and key order, written as one
JSON object per line:

| Field | Meaning |
|---|---|
| `schema` | `workflow-artifact-read-v1` |
| `runId`, `taskId` | from the config |
| `source`, `artifact` | what was read |
| `at` | ISO time of the read |
| `bytes` | artifact size in bytes |
| `returnedBytes` | artifact bytes returned. `0` for a duplicate-suppressed read. If the response was cut, this is the prefix that was actually delivered |
| `truncated` | the content is incomplete (core limits, projection limits, or the delivery bound) |
| `rawAssurance` | only for `raw` reads |
| `path`, `maxItems`, `maxChars` | projection parameters as the core resolved them |
| `deliveryUnverified` | **new, WP5.** `true` when the server cut the response to fit the delivery bound. `false` (WP5b) on page rows: the page was delivered whole within the limit. Absent otherwise |
| `rangeStart`, `rangeEnd`, `totalChars`, `contentSha256` | **new, WP5b, page rows only.** The row covers UTF-16 chars `[rangeStart, rangeEnd)` of the artifact text (`totalChars` long). `contentSha256` is the sha256 (hex) of the whole artifact file *version* that was paged. All four are present together, never with `path` |

**Parity.** The core tool appends its row to a server-private scratch ledger (a `mkdtemp` directory,
removed on exit). The server then copies that row to the real ledger byte-for-byte, or with
`truncated`/`returnedBytes`/`deliveryUnverified` adjusted if the response was cut. Unit tests
compare text and rows against direct core calls on the same fixture run, ignoring `at`. They cover
whole reads, projections, core `maxBytes` truncation, raw reads, failures, the completed-read cache
and duplicate suppression.

**Dedup.** This is the same as pi-workflow. The core caches live for one server process, which is
one task attempt.

- Completed sources are memoized, and every read still writes a full row.
- With `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP=1` in the server env, an identical re-read is suppressed and writes a row with `returnedBytes: 0`. Raw reads are never suppressed.
- MCP clients may filter the env they pass to servers. An adapter that wants this flag must put it in `McpServerSpec.env`.
- A suppressed re-read of a read whose delivery was cut is also written `truncated: true, deliveryUnverified: true`. A repeat call therefore cannot turn into clean evidence.

The `tools/call` requests are serialized, so rows keep call order.

## Paged reads (WP5b)

A required read used to need one whole, uncut read. An artifact larger than the worker CLI's MCP
output limit could therefore never satisfy it. Whole-artifact reads are now paged.

- **Contract.** `read` without `path` takes `offset` (default 0). The response is
  `# workflow_artifact: <source>.<artifact>\n\n` + the artifact text `[offset, end)` (+ the raw
  assurance line for `raw`) + a footer:
  - `[workflow_artifact page: chars X–Y of N; call again with offset=Y to continue]`, or
  - `[workflow_artifact page: chars X–N of N; end of artifact]` on the last page.
- **Size.** The whole response, footer included, fits the server's output limit in UTF-16 chars
  *and* UTF-8 bytes (the footer is budgeted at its widest). A page never starts or ends inside a
  surrogate pair: an `offset` on the second half of a pair starts one char earlier, and the footer
  and row report the real start.
- **When.** A read with `offset` is always paged. A read without `offset` is unchanged (same text
  and row as before, including the core 50 KiB / 2000-line truncation) when its response fits the
  limit; when it does not fit, it is served as its first page instead of being cut. Projections
  (`path`) and `list` are never paged; they are still cut (see Delivery bound).
- **Whole file.** A paged read decodes the whole file (UTF-8), so config `maxBytes`/`maxLines` do
  not apply to it; the page size is the bound. Files over 64 MiB are refused. Each page re-reads
  and re-validates the file (raw integrity included), so an artifact that changes between pages
  gets a new `contentSha256`.
- **Errors (tool results, no row).** `offset` ≥ the length (except 0 on an empty artifact), a
  negative or non-integer `offset`, `offset` with `path`/`maxItems`/`maxChars`.
- **Caches.** Paged reads never use the duplicate-read or completed-read caches, and they never
  populate the duplicate-read cache.
- **Rows.** One row per page: `bytes` (artifact), `returnedBytes` (UTF-8 bytes of the page),
  `truncated` (`true` unless the page covers the whole artifact, so a pi-workflow-style
  `!truncated` check never takes one page for a whole read), the four range fields and
  `deliveryUnverified: false`. A page row the server had to cut anyway (it should not happen) gets
  `deliveryUnverified: true` like any cut read.
- **Coverage rule (engine, `src/core/required-reads.ts`).** A whole-artifact required read is
  satisfied by one whole verified row, as before, **or** by verified page rows
  (`deliveryUnverified: false`, `truncated: true`) of the **same** `contentSha256`/`totalChars`
  whose ranges cover `[0, totalChars)` (any order, overlaps allowed). Unverified or cut rows never
  count, and pages of different versions never combine. With `count`, each complete page set counts
  as one read. Projected requirements (`path`/`maxItems`/`maxChars`) and `requiredReadPolicy`
  checks are unchanged (pages carry no `path`; a page is `truncated`). When coverage is incomplete,
  the failure message names the missing ranges, e.g. `incomplete paged reads (read the missing
  ranges with offset): producer.analysis: paged read incomplete, missing chars 300–500, 900–1000 of
  1000`; with pages of several versions it says so.
- **Tool text.** The description and guidelines tell the worker to page on with the footer's
  offset and that a required read counts only once every page was read. Bundled prompts (WP10)
  should say the same.

## Measured limits (WP5b)

- `probe()` declares `mcpOutputLimitChars` / `mcpOutputNoticeChars`. Since WP5b the run record keeps
  them in `run.capabilityNegotiation.probe` (WP4d), present only when the probe reports them.
- The server limit is `artifactServerOutputLimit(probe)` (`src/sdk/mcp-delivery.ts`):
  `limit − notice − max(256, ⌈5 % × limit⌉)`, clamped to 512 … 16 MiB; `null` without a declared
  limit (the server then keeps 8192).
  - The notice allowance is subtracted although results up to the declared limit pass unchanged:
    a CLI whose real cut point is a little lower than declared still never cuts a page.
  - The margin covers client framing the declaration may not count (content joins, escaping,
    token-vs-char rounding).

  | Executor | Declared limit | Notice | Margin | Server `--max-output-chars` |
  |---|---|---|---|---|
  | Pi 1.1 | 20,480 bytes | 1,024 (declared bound; ~220 measured) | 1,024 | **18,432** |
  | Claude | 22,500 chars (`floor(0.9 × MAX_MCP_OUTPUT_TOKENS 25,000)`) | 0 | 1,125 | **21,375** |
  | Codex | 32,000 chars (`tool_output_token_limit` 10,000 pinned) | 0 | 1,600 | **30,400** |
  | unknown | — | — | — | none (server default 8,192) |
- `preparedMcpServers(launch, {artifactOutputLimitChars})` (task backend) appends the flag to the
  `workflow_artifact` server, with `artifactServerOutputLimitForRun(run)`. Other servers are not
  touched.
- **Provenance.** `launch-bootstrap-provenance` digests `artifacts.serverSpecSha256` over the spec
  *with* the same flag (same derivation from the same recorded probe), so the digest binds the
  limit actually launched. Runs without a recorded limit digest the plain spec as before.
  `effectiveLaunch.artifactBinding.serverSpecSha256` still digests the sealed (plain) spec.
- The replay starts the server with `--max-output-chars 16777216` (appended after the engine's
  flag; the last flag wins) and its probe declares no limit, so recorded reads still fit whole.

## Delivery bound (R#9)

A CLI may cut an MCP result again after the server returns it. The server therefore cuts first:

- **Limit:** `--max-output-chars <n>` (512 … 16 MiB). Without the flag the default is **8192**.
  - The default is below every limit found for the stage-1 executors:
    - Pi 1.1 cuts the middle of text results over 20 KB.
    - Claude Code caps MCP output at `MAX_MCP_OUTPUT_TOKENS`, default 25,000 tokens.
    - Codex has per-tool and per-server output token limits of about 10k by default.
  - It also leaves headroom for client wrapping and escaping.
  - WP6–WP8 measured them; since WP5b the engine passes the measured limit (see Measured limits).
- **Units:** a response fits when *both* its UTF-16 length and its UTF-8 byte length are ≤ the limit. This holds whether the client counts chars, code points or bytes. Cuts never split a surrogate pair.
- **Fits:** the response is returned unchanged and the row is written as the core wrote it.
- **Does not fit (whole read, WP5b):** served as its first page (see Paged reads); not cut.
- **Does not fit (projected read):**
  - The server returns the longest prefix plus a notice. The notice says that the read is truncated and `deliveryUnverified`, that it does not satisfy required reads, and that a `path` + `maxItems`/`maxChars` re-read gives a smaller projection.
  - The row gets `truncated: true`, `deliveryUnverified: true` and the delivered `returnedBytes`.
- **Does not fit (list / failure):** the output is cut with a short notice. No row is written, because lists and failures are not ledgered.
- **Unknown limit:** the default applies, and every row whose content was cut is marked `deliveryUnverified: true`.
- **Engine rule (WP4c-1):** rows with `deliveryUnverified: true` never satisfy a required read. These rows also carry `truncated: true`, which pi-workflow's check already rejects. WP5b adds the page coverage rule (see Paged reads).

## Security

- **Startup refuses** (exit 1, no stdout) on:
  - a missing, unreadable, symlinked or non-regular config;
  - invalid JSON, or anything `assertArtifactAccessConfig` rejects (unknown keys, version ≠ 1, relative paths, bad `accessMode` or limits);
  - NUL bytes in config paths;
  - a config that is not the task's `artifact-access.json` next to its manifest;
  - `manifestPath` or `ledgerPath` outside `runDir`;
  - a missing `runDir`;
  - a manifest that is missing, symlinked or a non-regular file;
  - a manifest or ledger whose real path leaves the real `runDir`;
  - a symlinked, hard-linked or non-regular ledger;
  - a manifest that fails core validation (for example an artifact path outside `runDir`);
  - a manifest `runId`/`taskId` that differs from the config.
- **Per call:** the tool accepts no filesystem paths. Sources must match `^[A-Za-z0-9_.:-]+$` without `..`, so traversal, absolute paths, `/` and NUL are rejected. Artifacts must be one of the enum kinds. The core then refuses symlinked or hard-linked artifacts, artifacts whose real path leaves the run dir (including through symlinked directories), and files that change during validation. The file is opened with `O_NOFOLLOW`.
- **Ledger writes:** the ledger is opened with `O_APPEND|O_CREAT|O_NOFOLLOW`, mode `0600`. Before each write the server re-checks that the ledger is a single-link regular file inside the run dir.
- **Reads:** the server reads only the config, the manifest, the artifacts the manifest lists inside `runDir`, and its own scratch ledger.
- **Debug artifacts:** `prompt`, `system-prompt`, `stderr` and `result` are readable only when the *config* says `accessMode: "human-debug"`. The manifest `policy` cannot raise access, because the config `accessMode` always wins.
- **Secrets:** env values never appear in logs, results or the ledger. The spec argv carries only the entry, the config path and the limit.

## Visible tool names

`artifactToolVisibleName(executorId)` and `ARTIFACT_TOOL_NAME_MAPPINGS` live in `src/core/artifact-tool-names.ts` since WP10
(the core prompt renderer uses them); `src/mcp/visible-names.ts` and `dist/mcp/artifact-server/index.js` re-export them. MCP server name: `workflow_artifact`.

| Executor | Visible name | Rule / evidence | verified |
|---|---|---|---|
| `claude` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>`. Claude Code MCP docs and permission rules; live WP8 #10 | `true` |
| `codex` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>` unless the `non_prefixed_mcp_tool_names` feature is on. codex-cli 0.159 build strings; live WP7 #2 | `true` |
| `pi` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>`, chars outside `[A-Za-z0-9_]` → `_`, hash suffix on collision. Pi 1.1 `docs/mcp.md`; live WP6 #4 | `true` |
| other | `mcp__workflow_artifact__workflow_artifact` | common convention, fallback | — |

WP10 flipped `verified` with the WP6–WP8 live evidence. The task backend renders worker prompts with this name (`renderWorkerPromptToolNames`, docs/core-port.md WP10 change log 1) and puts the tool guidelines (see "Guidelines" above) into the system prompt of every task with the artifact server.

## Core changes wanted (not made here; `src/core` belongs to WP4c-1)

Items 1 and 4 are done (WP4c and WP5b); item 2 exists as `onLedgerRecord`/`appendLedger` (WP4c-2)
but the server still uses its scratch ledger.

1. **Keep `deliveryUnverified` in the core reader.** `readWorkflowArtifactReadLedger` (`normalizeReadLedgerRecord`) currently drops it. Add it to `WorkflowArtifactReadLedgerRecord`. The required-read and projection-policy checks should reject `deliveryUnverified` rows explicitly.
2. **Add a ledger-row hook to `handleWorkflowArtifactToolCall`.** An option such as `recordRead(record) => Promise<void>`, or returning the record, would let the server decide delivery without the scratch ledger.
3. **Stop following symlinks in `appendWorkflowArtifactReadLedger`.** It uses `appendFile`, which follows a symlinked ledger. It should use `O_NOFOLLOW` as the server does.
4. **Let `artifactMcpServerSpec` add the output limit.** Its type is the fixed tuple `[entry, "--config", path]`, and `artifact-graph-runtime` copies it into `toolProviders`. Either accept an optional output limit there, or have the adapters use `artifactMcpServerSpecWithOutputLimit` when they inject the server.

## WP5b change log (behavior-relevant)

1. **Paged whole-artifact reads.** New `offset` input. A whole read that does not fit the output
   limit is served as its first page with a continuation footer instead of a cut,
   `deliveryUnverified` prefix. Responses that fit are unchanged (text and row).
2. **Page rows.** `rangeStart`, `rangeEnd`, `totalChars`, `contentSha256`, `deliveryUnverified:
   false`, `truncated` unless the page is the whole artifact. The core ledger reader keeps them and
   `deliveryUnverified: false`, and refuses inconsistent range fields (partial set, start > end,
   end > total, bad sha, range with `path`). Old row shapes stay valid.
3. **Coverage-based required reads**, with the missing ranges in the failure message
   (`RequiredArtifactReadCheckResult.incompleteCoverage`).
4. **Measured limits.** The probe summary records `mcpOutputLimitChars`/`mcpOutputNoticeChars`; the
   task backend launches the server with `artifactServerOutputLimit`, and provenance digests that
   spec.
5. **Tool text.** `WORKFLOW_ARTIFACT_TOOL_PARAMETERS` gains `offset`; the description and the
   guidelines mention paging (one new guideline line).
6. **Shared helpers.** `fitsDeliveryLimit`, `cutToDeliveryBudget` and the 8192/512/16 MiB constants
   moved to `src/sdk/mcp-delivery.ts` (re-exported here unchanged) so the core and the conformance kit
   use the same arithmetic.
7. **Conformance.** New kit check `mcp.paged_read` (docs/conformance.md).
