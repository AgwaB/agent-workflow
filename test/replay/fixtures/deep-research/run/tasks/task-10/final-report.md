# Research report

## Executive summary

### Core conclusion

The current MCP specification (2026-07-28) frames stdio messages with newlines. Each message is a single JSON-RPC request, notification, or response and MUST NOT contain embedded newlines. Servers MUST NOT write anything to stdout that is not a valid MCP message. Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. Clients SHOULD NOT assume stderr output indicates an error.

### Main recommendations

These recommendations are proposals based on the research, not validated outcomes.

- Keep diagnostic logs and startup banners off stdout; use stderr for logging.

### Limits to keep in mind

- Questions remain unanswered. Verifying some facts does not establish the whole conclusion.
- The retrieved evidence establishes UTF-8 for stderr logging, not the encoding requirement for protocol messages.

## Research scope and method

- Task type: api\_reference.
- Research depth: quick.
- Research questions: 3.
- Planned fact slots: 5.
- Expected output shape: research\_brief.
- Scope coverage: covered 2, partial 1.
- Method: plan research questions, collect source evidence, normalize claims, verify selected claims, apply deterministic audit gates, and synthesize the report.

## Main findings

### 1. The official versioning page identifies 2026-07-28 as the current MCP protocol version.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/versioning>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28.md>)
Evidence citations:
- wsrc_6f2e06f5a0dd2c8d98ce75ab416660e7: quote "The **current** protocol version is [**2026-07-28**\](https://modelcontextprotocol.io/specification/2026-07-28.md)."

The primary-source versioning page explicitly labels 2026-07-28 as the current MCP protocol version.

### 2. The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/latest/basic/transports>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)
Evidence citations:
- wsrc_3af3257c452fc577322dd1fe372b693b: quote "[stdio\](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md): newline-delimited"

The official overview explicitly links stdio to the exact claimed dated specification URL.

### 3. The stdio specification states that each message is a single JSON-RPC request, notification, or response.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)
Evidence citations:
- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote "Each message is a single JSON-RPC request, notification, or response."

The specification explicitly describes each message as one JSON-RPC request, notification, or response.

### 4. The stdio specification says messages MUST NOT contain embedded newlines.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)
Evidence citations:
- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote "Messages are delimited by newlines, and **MUST NOT** contain embedded newlines."

The cited primary specification explicitly prohibits embedded newlines using MUST NOT.

### 5. The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)
Evidence citations:
- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote "The server **MUST NOT** write anything to its `stdout` that is not a valid MCP\n  message."

The cited primary specification states the server stdout prohibition explicitly with MUST NOT.

### 6. The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)
Evidence citations:
- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote "The server **MAY** write UTF-8 strings to `stderr` for any logging purposes\n  including informational, debug, and error messages."

The cited primary specification explicitly permits UTF-8 stderr logging for informational, debug, and error messages.

### 7. The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions.

Evidence status: **verified**  
Confidence: **high**
Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)
Evidence citations:
- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote "The client **MAY** capture, forward, or ignore the server's `stderr` output and\n  **SHOULD NOT** assume `stderr` output indicates error conditions."

The cited primary specification explicitly says clients SHOULD NOT assume server stderr output indicates error conditions.

## Recommendations

1. **Keep diagnostic logs and startup banners off stdout; use stderr for logging.**
   - Evidence status: derived
   - Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)

## Evidence strength

| Area | Status | Evidence | Why it matters |
|---|---|---|---|
| Applicable message encoding requirements | missing | — | Do not assert a general UTF-8 message requirement without further primary evidence. |
| Current official specification version and canonical stdio section | filled | \[modelcontextprotocol.io\](\<https://modelcontextprotocol.io/specification/versioning\>), \[modelcontextprotocol.io\](\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\>) | Provides version authority for the transport rules; verification remains pending. |
| Stdio message format, delimiter, and embedded newline rules | filled | \[modelcontextprotocol.io\](\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\>) | Framing evidence recovered from the stream-policy source; verification remains pending. |
| Server stdout permitted content and prohibitions | filled | \[modelcontextprotocol.io\](\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\>) | Supports the exact stdout restriction; positive stream description is preserved separately. |
| Server stderr logging permissions and normative strength | filled | \[modelcontextprotocol.io\](\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\>) | Preserves permission rather than obligation; client capture permission remains unverified backlog. |

## Caveats and remaining gaps

- **Gap:** General wire-message encoding is not established by visible evidence; stderr UTF-8 logging is a different control.
- **Gap:** rq-002 exhausted its search budget after failed transport fetches. Other cached evidence recovered framing, but not message encoding.
- **Caveat:** General wire-message encoding remains unestablished: slot-003 is missing, and framing scope coverage is partial despite completed research-question runs. UTF-8 permission for stderr does not establish message encoding.
- **Unverified lead:** The stdio specification says clients MAY capture, forward, or ignore server stderr output. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))
- **Unverified lead:** The stdio specification states that the server writes JSON-RPC messages to stdout. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))
- **Unverified lead:** The stdio specification states that messages are delimited by newlines. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))

## Source index

- **modelcontextprotocol.io**: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/versioning>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28.md>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/latest/basic/transports>)

## Audit summary

- Claims: 8 verified, 0 partially supported, 0 unsupported, 0 conflicting, 0 verification blocked.
- Fact slots: 4 filled, 0 partial, 1 missing/conflicting, 5 total.
- Research questions: 3.

## Related artifacts

- [Evidence audit](audit.md) — claim verdicts, fact-slot coverage, gaps, and renderer diagnostics.
- [Structured source references](refs.json) — machine-readable source pointers used by the final task.
- [Machine-readable report](control.json) — the structured final report and completion-summary contract.
