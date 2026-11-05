# Worker artifact MCP server

Workers read upstream workflow artifacts through one MCP tool, `workflow_artifact`. The server is
`dist/mcp/artifact-server/server.js` (source `src/mcp/artifact-server/`). It is hand-written and has
zero runtime dependencies. It wraps the core tool body from `src/core/workflow-artifact-tool.ts`
and preserves its tool contract.

## Launch

```
node dist/mcp/artifact-server/server.js --config <task>/artifact-access.json [--max-output-chars <n>]
```

- `artifactMcpServerSpec(config)` (core) returns `[server.js, "--config", path]`.
- `artifactMcpServerSpecWithOutputLimit(config, limit)` (`src/mcp/artifact-server/spec.ts`) adds
  `--max-output-chars <limit>`. Pass `null` when the limit is unknown. It wraps the core
  `withArtifactMcpOutputLimit(spec, limit)`.
- **Measured limit.** The engine launches the server itself with the right limit; adapters
  pass the spec through unchanged. See [Measured limits](#measured-limits).
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
  - `notifications/initialized` and other notifications are accepted and get no response. A
    `notifications/cancelled` for a request still in flight suppresses that request's response
    (MCP cancellation rule).
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
- **Shared layer:** the transport and method dispatch live in `src/mcp/stdio-server.ts`,
  shared with the host MCP server ([`host-mcp.md`](host-mcp.md)); this server supplies its tool,
  instructions and call handler (`src/mcp/artifact-server/stdio.ts`).

## Tool contract

- `name`: `workflow_artifact`.
- `description`: `WORKFLOW_ARTIFACT_TOOL_DESCRIPTION`, verbatim.
- `inputSchema`: `WORKFLOW_ARTIFACT_TOOL_PARAMETERS`, verbatim:
  - `action`: `list` | `read`, required.
  - `source`: a canonical source name.
  - `artifact`: one of `control`, `analysis`, `refs`, `raw`, `prompt`, `system-prompt`, `stderr`, `result`.
  - `path`: a simple JSON path.
  - `maxItems` and `maxChars`: integers ≥ 0. They require `path`.
  - `offset`: integer ≥ 0, a character offset for a paged whole-artifact read. It cannot be
    combined with `path`, `maxItems` or `maxChars` (tool error). See [Paged reads](#paged-reads).
- `annotations`: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: false` (each read appends a ledger row), `openWorldHint: false`.
- **Guidelines:** `WORKFLOW_ARTIFACT_TOOL_GUIDELINES` are sent as the server `instructions`, one `-` bullet per line. Not every client puts server instructions into the model context (Pi 1.1 does not), so the task backend also puts the guidelines into the worker system prompt.
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
| `deliveryUnverified` | `true` when the server cut the response to fit the delivery bound. `false` on page rows: the page was delivered whole within the limit. Absent otherwise |
| `rangeStart`, `rangeEnd`, `totalChars`, `contentSha256` | Page rows only. The row covers UTF-16 chars `[rangeStart, rangeEnd)` of the artifact text (`totalChars` long). `contentSha256` is the sha256 (hex) of the whole artifact file *version* that was paged. All four are present together, never with `path` |

The core tool hands its row to the server (`appendLedger: false` + `onLedgerRecord`). The server
appends it through `appendWorkflowArtifactReadLedger`, adjusting
`truncated`/`returnedBytes`/`deliveryUnverified` when the response was cut.

**Dedup.** The core caches live for one server process, which is
one task attempt.

- Completed sources are memoized, and every read still writes a full row.
- With `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP=1` in the server env, an identical re-read is suppressed and writes a row with `returnedBytes: 0`. Raw reads are never suppressed.
- MCP clients may filter the env they pass to servers. An adapter that wants this flag must put it in `McpServerSpec.env`.
- A suppressed re-read of a read whose delivery was cut is also written `truncated: true, deliveryUnverified: true`. A repeat call therefore cannot turn into clean evidence.

The `tools/call` requests are serialized, so rows keep call order. The ledger reader rejects
inconsistent page fields: partial sets, start greater than end, end greater than total, invalid
SHA-256, or ranges combined with `path`. Non-page row shapes remain valid.

## Paged reads

Whole-artifact reads can span pages while preserving required-read assurance.

- **Contract.** `read` without `path` takes `offset` (default 0). The response is
  `# workflow_artifact: <source>.<artifact>\n\n` + the artifact text `[offset, end)` (+ the raw
  assurance line for `raw`) + a footer:
  - `[workflow_artifact page: chars X–Y of N; call again with offset=Y to continue]`, or
  - `[workflow_artifact page: chars X–N of N; end of artifact]` on the last page.
- **Size.** The whole response, footer included, fits the server's output limit in UTF-16 chars
  *and* UTF-8 bytes (the footer is budgeted at its widest). A page never starts or ends inside a
  surrogate pair: an `offset` on the second half of a pair starts one char earlier, and the footer
  and row report the real start.
- **When.** A read with `offset` is always paged. A read without `offset` uses the core text and
  row (including the core 50 KiB / 2000-line truncation) when its response fits the limit; when it does not fit, it is served as its first page instead of being cut. Projections
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
  `truncated` (`true` unless the page covers the whole artifact, so a
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
  offset and that a required read counts only once every page was read. Bundled prompts should say the same.

## Measured limits

- `probe()` declares `mcpOutputLimitChars` / `mcpOutputNoticeChars`. The run record keeps
  them in `run.capabilityNegotiation.probe`, present only when the probe reports them.
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

## Delivery bound

A CLI may cut an MCP result again after the server returns it. The server therefore cuts first:

- **Limit:** `--max-output-chars <n>` (512 … 16 MiB). Without the flag the default is **8192**.
  - The default is below every limit found for the built-in executors:
    - Pi 1.1 cuts the middle of text results over 20 KB.
    - Claude Code caps MCP output at `MAX_MCP_OUTPUT_TOKENS`, default 25,000 tokens.
    - Codex has per-tool and per-server output token limits of about 10k by default.
  - It also leaves headroom for client wrapping and escaping.
  - The engine passes the measured limit (see Measured limits).
- **Units:** a response fits when *both* its UTF-16 length and its UTF-8 byte length are ≤ the limit. This holds whether the client counts chars, code points or bytes. Cuts never split a surrogate pair.
- **Fits:** the response is returned unchanged and the row is written as the core wrote it.
- **Does not fit (whole read):** served as its first page (see Paged reads); not cut.
- **Does not fit (projected read):**
  - The server returns the longest prefix plus a notice. The notice says that the read is truncated and `deliveryUnverified`, that it does not satisfy required reads, and that a `path` + `maxItems`/`maxChars` re-read gives a smaller projection.
  - The row gets `truncated: true`, `deliveryUnverified: true` and the delivered `returnedBytes`.
- **Does not fit (list / failure):** the output is cut with a short notice. No row is written, because lists and failures are not ledgered.
- **Unknown limit:** the default applies, and every row whose content was cut is marked `deliveryUnverified: true`.
- **Engine rule:** rows with `deliveryUnverified: true` never satisfy a required read. These rows also carry `truncated: true`, which the check already rejects. Page coverage can satisfy a whole read (see Paged reads).

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
- **Ledger writes:** the server re-checks that the ledger is a single-link regular file inside the run dir, then appends with the core writer: `O_APPEND|O_CREAT|O_NOFOLLOW`, mode `0600`; the opened descriptor must be a single-link regular file, the same file as the path (dev/inode) with an unchanged, non-symlinked parent directory, and its fully resolved path must be inside the real run dir. A hard link or a symlinked directory swapped in between the check and the open is refused (`isError`) and nothing is written through it (a swapped ancestor can leave an empty file created by `O_CREAT` in the swapped-in directory).
- **Reads:** the server reads only the config, the manifest, the artifacts the manifest lists inside `runDir`, and its ledger.
- **Debug artifacts:** `prompt`, `system-prompt`, `stderr` and `result` are readable only when the *config* says `accessMode: "human-debug"`. The manifest `policy` cannot raise access, because the config `accessMode` always wins.
- **Secrets:** env values never appear in logs, results or the ledger. The spec argv carries only the entry, the config path and the limit.

## Visible tool names

`artifactToolVisibleName(executorId)` and `ARTIFACT_TOOL_NAME_MAPPINGS` live in `src/core/artifact-tool-names.ts`
(the core prompt renderer uses them); `src/mcp/visible-names.ts` and `dist/mcp/artifact-server/index.js` re-export them. MCP server name: `workflow_artifact`.

| Executor | Visible name | Naming rule |
|---|---|---|
| `claude` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>` |
| `codex` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>` unless `non_prefixed_mcp_tool_names` is enabled |
| `pi` | `mcp__workflow_artifact__workflow_artifact` | Non-alphanumeric/underscore characters become `_`; collision gets a hash suffix |
| other | `mcp__workflow_artifact__workflow_artifact` | Fallback convention |

The task backend renders worker prompts with this name and includes the tool guidelines in each
worker system prompt that has the artifact server.
