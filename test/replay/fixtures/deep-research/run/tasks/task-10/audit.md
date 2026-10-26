# Research audit

This artifact preserves the detailed claim/gap/source ledger behind `final-report.md`.

## Evidence level

- Audited claims (8 total): 8 verified, 0 partially supported, 0 unsupported, 0 conflicting, 0 verification blocked.
- Fact slots: 4 filled, 0 partial, 1 missing/conflicting, 5 total.
- Outside the audited-claim denominator: 3 preserved unverified leads available to synthesis, 0 additional leads omitted by a schema cap, 2 coverage gaps.
- The zero unsupported/conflicting/blocked counts apply only to the 8 audited claims; preserved leads and gaps remain separate.

## Synthesis caveats

- General wire-message encoding remains unestablished: slot-003 is missing, and framing scope coverage is partial despite completed research-question runs. UTF-8 permission for stderr does not establish message encoding.

## Claim verdict ledger

| ID | Status | Claim/support | Caveat/source |
|---|---|---|---|
| claim-001 | verified | The official versioning page identifies 2026-07-28 as the current MCP protocol version. | — |
| claim-002 | verified | The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md. | — |
| claim-003 | verified | The stdio specification states that each message is a single JSON-RPC request, notification, or response. | — |
| claim-004 | verified | The server \*\*MUST NOT\*\* write anything to its \`stdout\` that is not a valid MCP message. | — |
| claim-005 | verified | The stdio specification says messages MUST NOT contain embedded newlines. | — |
| claim-006 | verified | The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message. | — |
| claim-007 | verified | The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. | — |
| claim-008 | verified | The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions. | — |

## Fact slot coverage

| Slot | Status | Best value | Gap/impact |
|---|---|---|---|
| slot-001 | filled | Official versioning identifies 2026-07-28 as current; the transport overview links its dedicated stdio binding. | Provides version authority for the transport rules; verification remains pending. |
| slot-002 | filled | Each message is a single JSON-RPC request, notification, or response. Messages are newline-delimited and MUST NOT contain embedded newlines. | Framing evidence recovered from the stream-policy source; verification remains pending. |
| slot-003 | missing |  | No retrieved passage establishes general message encoding. UTF-8 permission for stderr logging does not establish wire-message encoding. |
| slot-004 | filled | Server stdout carries JSON-RPC messages; the server MUST NOT write anything to stdout that is not a valid MCP message. | Supports the exact stdout restriction; positive stream description is preserved separately. |
| slot-005 | filled | Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. | Preserves permission rather than obligation; client capture permission remains unverified backlog. |

## Remaining gaps

No remaining gaps were reported.

## Claims used in executive synthesis

- **claim-001** (verified): The official versioning page identifies 2026-07-28 as the current MCP protocol version.
- **claim-002** (verified): The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md.
- **claim-003** (verified): The stdio specification states that each message is a single JSON-RPC request, notification, or response.
- **claim-005** (verified): The stdio specification says messages MUST NOT contain embedded newlines.
- **claim-006** (verified): The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message.
- **claim-007** (verified): The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.
- **claim-008** (verified): The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions.

## Renderer diagnostics

- Executive word count: 930.
- Rendered source URLs: 4/4.
- Render warnings: 0.
