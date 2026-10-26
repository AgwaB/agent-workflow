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
  `--max-output-chars <limit>` when the executor knows its CLI's MCP output limit, for example
  `probe().mcpOutputLimitChars`. Pass `null` when the limit is unknown.
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
| `deliveryUnverified` | **new, WP5.** Present and `true` only when the server cut the response to fit the delivery bound |

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

## Delivery bound (R#9)

A CLI may cut an MCP result again after the server returns it. The server therefore cuts first:

- **Limit:** `--max-output-chars <n>` (512 … 16 MiB). Without the flag the default is **8192**.
  - The default is below every limit found for the stage-1 executors:
    - Pi 1.1 cuts the middle of text results over 20 KB.
    - Claude Code caps MCP output at `MAX_MCP_OUTPUT_TOKENS`, default 25,000 tokens.
    - Codex has per-tool and per-server output token limits of about 10k by default.
  - It also leaves headroom for client wrapping and escaping.
  - These figures are **unverified** until WP6–WP8 measure them. Adapters should pass the measured limit.
- **Units:** a response fits when *both* its UTF-16 length and its UTF-8 byte length are ≤ the limit. This holds whether the client counts chars, code points or bytes. Cuts never split a surrogate pair.
- **Fits:** the response is returned unchanged and the row is written as the core wrote it.
- **Does not fit (read):**
  - The server returns the longest prefix plus a notice. The notice says that the read is truncated and `deliveryUnverified`, that it does not satisfy required reads, and that a `path` + `maxItems`/`maxChars` re-read gives a smaller projection.
  - The row gets `truncated: true`, `deliveryUnverified: true` and the delivered `returnedBytes`.
- **Does not fit (list / failure):** the output is cut with a short notice. No row is written, because lists and failures are not ledgered.
- **Unknown limit:** the default applies, and every row whose content was cut is marked `deliveryUnverified: true`.
- **Engine rule (WP4c-1):** rows with `deliveryUnverified: true` never satisfy a required read. These rows also carry `truncated: true`, which pi-workflow's check already rejects.

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

1. **Keep `deliveryUnverified` in the core reader.** `readWorkflowArtifactReadLedger` (`normalizeReadLedgerRecord`) currently drops it. Add it to `WorkflowArtifactReadLedgerRecord`. The required-read and projection-policy checks should reject `deliveryUnverified` rows explicitly.
2. **Add a ledger-row hook to `handleWorkflowArtifactToolCall`.** An option such as `recordRead(record) => Promise<void>`, or returning the record, would let the server decide delivery without the scratch ledger.
3. **Stop following symlinks in `appendWorkflowArtifactReadLedger`.** It uses `appendFile`, which follows a symlinked ledger. It should use `O_NOFOLLOW` as the server does.
4. **Let `artifactMcpServerSpec` add the output limit.** Its type is the fixed tuple `[entry, "--config", path]`, and `artifact-graph-runtime` copies it into `toolProviders`. Either accept an optional output limit there, or have the adapters use `artifactMcpServerSpecWithOutputLimit` when they inject the server.
