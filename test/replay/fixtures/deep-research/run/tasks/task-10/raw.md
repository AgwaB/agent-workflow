<control>
{
  "schema": "deep-research-executive-render-v1",
  "digest": "## Executive summary ### Core conclusion The current MCP specification (2026-07-28) frames stdio messages with newlines. Each message is a single JSON-RPC request, notification, or response and MUST NOT contain embedded newlines. Servers MUST NOT write anything to stdout that is not a valid MCP…",
  "status": "passed",
  "renderMode": "evidence-backed-report",
  "completionSummaryMarkdown": "## Core conclusion\n\nThe current MCP specification (2026-07-28) frames stdio messages with newlines. Each message is a single JSON-RPC request, notification, or response and MUST NOT contain embedded newlines. Servers MUST NOT write anything to stdout that is not a valid MCP message. Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. Clients SHOULD NOT assume stderr output indicates an error.\n\n## Main recommendations\n\nThese recommendations are proposals based on the research, not validated outcomes.\n\n- Keep diagnostic logs and startup banners off stdout; use stderr for logging.\n\n## Limits to keep in mind\n\n- Questions remain unanswered. Verifying some facts does not establish the whole conclusion.\n- The retrieved evidence establishes UTF-8 for stderr logging, not the encoding requirement for protocol messages.",
  "executiveMarkdown": "# Research report\n\n## Executive summary\n\n### Core conclusion\n\nThe current MCP specification (2026-07-28) frames stdio messages with newlines. Each message is a single JSON-RPC request, notification, or response and MUST NOT contain embedded newlines. Servers MUST NOT write anything to stdout that is not a valid MCP message. Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. Clients SHOULD NOT assume stderr output indicates an error.\n\n### Main recommendations\n\nThese recommendations are proposals based on the research, not validated outcomes.\n\n- Keep diagnostic logs and startup banners off stdout; use stderr for logging.\n\n### Limits to keep in mind\n\n- Questions remain unanswered. Verifying some facts does not establish the whole conclusion.\n- The retrieved evidence establishes UTF-8 for stderr logging, not the encoding requirement for protocol messages.\n\n## Research scope and method\n\n- Task type: api\\_reference.\n- Research depth: quick.\n- Research questions: 3.\n- Planned fact slots: 5.\n- Expected output shape: research\\_brief.\n- Scope coverage: covered 2, partial 1.\n- Method: plan research questions, collect source evidence, normalize claims, verify selected claims, apply deterministic audit gates, and synthesize the report.\n\n## Main findings\n\n### 1. The official versioning page identifies 2026-07-28 as the current MCP protocol version.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/versioning>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28.md>)\nEvidence citations:\n- wsrc_6f2e06f5a0dd2c8d98ce75ab416660e7: quote \"The **current** protocol version is [**2026-07-28**\\](https://modelcontextprotocol.io/specification/2026-07-28.md).\"\n\nThe primary-source versioning page explicitly labels 2026-07-28 as the current MCP protocol version.\n\n### 2. The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/latest/basic/transports>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_3af3257c452fc577322dd1fe372b693b: quote \"[stdio\\](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md): newline-delimited\"\n\nThe official overview explicitly links stdio to the exact claimed dated specification URL.\n\n### 3. The stdio specification states that each message is a single JSON-RPC request, notification, or response.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"Each message is a single JSON-RPC request, notification, or response.\"\n\nThe specification explicitly describes each message as one JSON-RPC request, notification, or response.\n\n### 4. The stdio specification says messages MUST NOT contain embedded newlines.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"Messages are delimited by newlines, and **MUST NOT** contain embedded newlines.\"\n\nThe cited primary specification explicitly prohibits embedded newlines using MUST NOT.\n\n### 5. The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"The server **MUST NOT** write anything to its `stdout` that is not a valid MCP\\n  message.\"\n\nThe cited primary specification states the server stdout prohibition explicitly with MUST NOT.\n\n### 6. The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"The server **MAY** write UTF-8 strings to `stderr` for any logging purposes\\n  including informational, debug, and error messages.\"\n\nThe cited primary specification explicitly permits UTF-8 stderr logging for informational, debug, and error messages.\n\n### 7. The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"The client **MAY** capture, forward, or ignore the server's `stderr` output and\\n  **SHOULD NOT** assume `stderr` output indicates error conditions.\"\n\nThe cited primary specification explicitly says clients SHOULD NOT assume server stderr output indicates error conditions.\n\n## Recommendations\n\n1. **Keep diagnostic logs and startup banners off stdout; use stderr for logging.**\n   - Evidence status: derived\n   - Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\n\n## Evidence strength\n\n| Area | Status | Evidence | Why it matters |\n|---|---|---|---|\n| Applicable message encoding requirements | missing | — | Do not assert a general UTF-8 message requirement without further primary evidence. |\n| Current official specification version and canonical stdio section | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/versioning\\>), \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Provides version authority for the transport rules; verification remains pending. |\n| Stdio message format, delimiter, and embedded newline rules | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Framing evidence recovered from the stream-policy source; verification remains pending. |\n| Server stdout permitted content and prohibitions | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Supports the exact stdout restriction; positive stream description is preserved separately. |\n| Server stderr logging permissions and normative strength | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Preserves permission rather than obligation; client capture permission remains unverified backlog. |\n\n## Caveats and remaining gaps\n\n- **Gap:** General wire-message encoding is not established by visible evidence; stderr UTF-8 logging is a different control.\n- **Gap:** rq-002 exhausted its search budget after failed transport fetches. Other cached evidence recovered framing, but not message encoding.\n- **Caveat:** General wire-message encoding remains unestablished: slot-003 is missing, and framing scope coverage is partial despite completed research-question runs. UTF-8 permission for stderr does not establish message encoding.\n- **Unverified lead:** The stdio specification says clients MAY capture, forward, or ignore server stderr output. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))\n- **Unverified lead:** The stdio specification states that the server writes JSON-RPC messages to stdout. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))\n- **Unverified lead:** The stdio specification states that messages are delimited by newlines. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))\n\n## Source index\n\n- **modelcontextprotocol.io**: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/versioning>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28.md>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/latest/basic/transports>)\n\n## Audit summary\n\n- Claims: 8 verified, 0 partially supported, 0 unsupported, 0 conflicting, 0 verification blocked.\n- Fact slots: 4 filled, 0 partial, 1 missing/conflicting, 5 total.\n- Research questions: 3.\n\n## Related artifacts\n\n- [Evidence audit](audit.md) — claim verdicts, fact-slot coverage, gaps, and renderer diagnostics.\n- [Structured source references](refs.json) — machine-readable source pointers used by the final task.\n- [Machine-readable report](control.json) — the structured final report and completion-summary contract.",
  "reportMarkdown": "# Research report\n\n## Executive summary\n\n### Core conclusion\n\nThe current MCP specification (2026-07-28) frames stdio messages with newlines. Each message is a single JSON-RPC request, notification, or response and MUST NOT contain embedded newlines. Servers MUST NOT write anything to stdout that is not a valid MCP message. Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. Clients SHOULD NOT assume stderr output indicates an error.\n\n### Main recommendations\n\nThese recommendations are proposals based on the research, not validated outcomes.\n\n- Keep diagnostic logs and startup banners off stdout; use stderr for logging.\n\n### Limits to keep in mind\n\n- Questions remain unanswered. Verifying some facts does not establish the whole conclusion.\n- The retrieved evidence establishes UTF-8 for stderr logging, not the encoding requirement for protocol messages.\n\n## Research scope and method\n\n- Task type: api\\_reference.\n- Research depth: quick.\n- Research questions: 3.\n- Planned fact slots: 5.\n- Expected output shape: research\\_brief.\n- Scope coverage: covered 2, partial 1.\n- Method: plan research questions, collect source evidence, normalize claims, verify selected claims, apply deterministic audit gates, and synthesize the report.\n\n## Main findings\n\n### 1. The official versioning page identifies 2026-07-28 as the current MCP protocol version.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/versioning>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28.md>)\nEvidence citations:\n- wsrc_6f2e06f5a0dd2c8d98ce75ab416660e7: quote \"The **current** protocol version is [**2026-07-28**\\](https://modelcontextprotocol.io/specification/2026-07-28.md).\"\n\nThe primary-source versioning page explicitly labels 2026-07-28 as the current MCP protocol version.\n\n### 2. The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/latest/basic/transports>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_3af3257c452fc577322dd1fe372b693b: quote \"[stdio\\](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md): newline-delimited\"\n\nThe official overview explicitly links stdio to the exact claimed dated specification URL.\n\n### 3. The stdio specification states that each message is a single JSON-RPC request, notification, or response.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"Each message is a single JSON-RPC request, notification, or response.\"\n\nThe specification explicitly describes each message as one JSON-RPC request, notification, or response.\n\n### 4. The stdio specification says messages MUST NOT contain embedded newlines.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"Messages are delimited by newlines, and **MUST NOT** contain embedded newlines.\"\n\nThe cited primary specification explicitly prohibits embedded newlines using MUST NOT.\n\n### 5. The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"The server **MUST NOT** write anything to its `stdout` that is not a valid MCP\\n  message.\"\n\nThe cited primary specification states the server stdout prohibition explicitly with MUST NOT.\n\n### 6. The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"The server **MAY** write UTF-8 strings to `stderr` for any logging purposes\\n  including informational, debug, and error messages.\"\n\nThe cited primary specification explicitly permits UTF-8 stderr logging for informational, debug, and error messages.\n\n### 7. The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions.\n\nEvidence status: **verified**  \nConfidence: **high**\nSources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\nEvidence citations:\n- wsrc_ff966eae34ec1ec6ab48a4f0cf055b83: quote \"The client **MAY** capture, forward, or ignore the server's `stderr` output and\\n  **SHOULD NOT** assume `stderr` output indicates error conditions.\"\n\nThe cited primary specification explicitly says clients SHOULD NOT assume server stderr output indicates error conditions.\n\n## Recommendations\n\n1. **Keep diagnostic logs and startup banners off stdout; use stderr for logging.**\n   - Evidence status: derived\n   - Sources: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>)\n\n## Evidence strength\n\n| Area | Status | Evidence | Why it matters |\n|---|---|---|---|\n| Applicable message encoding requirements | missing | — | Do not assert a general UTF-8 message requirement without further primary evidence. |\n| Current official specification version and canonical stdio section | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/versioning\\>), \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Provides version authority for the transport rules; verification remains pending. |\n| Stdio message format, delimiter, and embedded newline rules | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Framing evidence recovered from the stream-policy source; verification remains pending. |\n| Server stdout permitted content and prohibitions | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Supports the exact stdout restriction; positive stream description is preserved separately. |\n| Server stderr logging permissions and normative strength | filled | \\[modelcontextprotocol.io\\](\\<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md\\>) | Preserves permission rather than obligation; client capture permission remains unverified backlog. |\n\n## Caveats and remaining gaps\n\n- **Gap:** General wire-message encoding is not established by visible evidence; stderr UTF-8 logging is a different control.\n- **Gap:** rq-002 exhausted its search budget after failed transport fetches. Other cached evidence recovered framing, but not message encoding.\n- **Caveat:** General wire-message encoding remains unestablished: slot-003 is missing, and framing scope coverage is partial despite completed research-question runs. UTF-8 permission for stderr does not establish message encoding.\n- **Unverified lead:** The stdio specification says clients MAY capture, forward, or ignore server stderr output. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))\n- **Unverified lead:** The stdio specification states that the server writes JSON-RPC messages to stdout. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))\n- **Unverified lead:** The stdio specification states that messages are delimited by newlines. ([modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>))\n\n## Source index\n\n- **modelcontextprotocol.io**: [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/versioning>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/2026-07-28.md>), [modelcontextprotocol.io](<https://modelcontextprotocol.io/specification/latest/basic/transports>)\n\n## Audit summary\n\n- Claims: 8 verified, 0 partially supported, 0 unsupported, 0 conflicting, 0 verification blocked.\n- Fact slots: 4 filled, 0 partial, 1 missing/conflicting, 5 total.\n- Research questions: 3.\n\n## Related artifacts\n\n- [Evidence audit](audit.md) — claim verdicts, fact-slot coverage, gaps, and renderer diagnostics.\n- [Structured source references](refs.json) — machine-readable source pointers used by the final task.\n- [Machine-readable report](control.json) — the structured final report and completion-summary contract.",
  "auditMarkdown": "# Research audit\n\nThis artifact preserves the detailed claim/gap/source ledger behind `final-report.md`.\n\n## Evidence level\n\n- Audited claims (8 total): 8 verified, 0 partially supported, 0 unsupported, 0 conflicting, 0 verification blocked.\n- Fact slots: 4 filled, 0 partial, 1 missing/conflicting, 5 total.\n- Outside the audited-claim denominator: 3 preserved unverified leads available to synthesis, 0 additional leads omitted by a schema cap, 2 coverage gaps.\n- The zero unsupported/conflicting/blocked counts apply only to the 8 audited claims; preserved leads and gaps remain separate.\n\n## Synthesis caveats\n\n- General wire-message encoding remains unestablished: slot-003 is missing, and framing scope coverage is partial despite completed research-question runs. UTF-8 permission for stderr does not establish message encoding.\n\n## Claim verdict ledger\n\n| ID | Status | Claim/support | Caveat/source |\n|---|---|---|---|\n| claim-001 | verified | The official versioning page identifies 2026-07-28 as the current MCP protocol version. | — |\n| claim-002 | verified | The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md. | — |\n| claim-003 | verified | The stdio specification states that each message is a single JSON-RPC request, notification, or response. | — |\n| claim-004 | verified | The server \\*\\*MUST NOT\\*\\* write anything to its \\`stdout\\` that is not a valid MCP message. | — |\n| claim-005 | verified | The stdio specification says messages MUST NOT contain embedded newlines. | — |\n| claim-006 | verified | The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message. | — |\n| claim-007 | verified | The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. | — |\n| claim-008 | verified | The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions. | — |\n\n## Fact slot coverage\n\n| Slot | Status | Best value | Gap/impact |\n|---|---|---|---|\n| slot-001 | filled | Official versioning identifies 2026-07-28 as current; the transport overview links its dedicated stdio binding. | Provides version authority for the transport rules; verification remains pending. |\n| slot-002 | filled | Each message is a single JSON-RPC request, notification, or response. Messages are newline-delimited and MUST NOT contain embedded newlines. | Framing evidence recovered from the stream-policy source; verification remains pending. |\n| slot-003 | missing |  | No retrieved passage establishes general message encoding. UTF-8 permission for stderr logging does not establish wire-message encoding. |\n| slot-004 | filled | Server stdout carries JSON-RPC messages; the server MUST NOT write anything to stdout that is not a valid MCP message. | Supports the exact stdout restriction; positive stream description is preserved separately. |\n| slot-005 | filled | Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages. | Preserves permission rather than obligation; client capture permission remains unverified backlog. |\n\n## Remaining gaps\n\nNo remaining gaps were reported.\n\n## Claims used in executive synthesis\n\n- **claim-001** (verified): The official versioning page identifies 2026-07-28 as the current MCP protocol version.\n- **claim-002** (verified): The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md.\n- **claim-003** (verified): The stdio specification states that each message is a single JSON-RPC request, notification, or response.\n- **claim-005** (verified): The stdio specification says messages MUST NOT contain embedded newlines.\n- **claim-006** (verified): The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message.\n- **claim-007** (verified): The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.\n- **claim-008** (verified): The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions.\n\n## Renderer diagnostics\n\n- Executive word count: 930.\n- Rendered source URLs: 4/4.\n- Render warnings: 0.",
  "wordCount": 930,
  "sourceUrlCount": 4,
  "totalSourceUrlCount": 4,
  "sourceUrls": [
    "https://modelcontextprotocol.io/specification/versioning",
    "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
    "https://modelcontextprotocol.io/specification/2026-07-28.md",
    "https://modelcontextprotocol.io/specification/latest/basic/transports"
  ],
  "sourceIndex": [
    {
      "url": "https://modelcontextprotocol.io/specification/versioning",
      "host": "modelcontextprotocol.io"
    },
    {
      "url": "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
      "host": "modelcontextprotocol.io"
    },
    {
      "url": "https://modelcontextprotocol.io/specification/2026-07-28.md",
      "host": "modelcontextprotocol.io"
    },
    {
      "url": "https://modelcontextprotocol.io/specification/latest/basic/transports",
      "host": "modelcontextprotocol.io"
    }
  ],
  "claimSummary": {
    "total": 8,
    "verified": 8,
    "partially_supported": 0,
    "unsupported": 0,
    "conflicting": 0,
    "verification_blocked": 0
  },
  "factSlotSummary": {
    "total": 5,
    "filled": 4,
    "partial": 0,
    "missingOrConflicting": 1
  },
  "sectionCounts": {
    "findings": 7,
    "renderedFindings": 7,
    "comparisonRows": 0,
    "renderedComparisonRows": 0,
    "recommendations": 1,
    "renderedRecommendations": 1,
    "actionItems": 0,
    "renderedActionItems": 0,
    "caveatsAndGaps": 6,
    "renderedCaveatsAndGaps": 6,
    "factSlots": 5,
    "renderedFactSlots": 5,
    "sourceUrls": 4,
    "renderedSourceUrls": 4
  },
  "renderWarnings": [],
  "sidecarErrors": [],
  "packetReconciliation": {
    "strict": true,
    "passed": true,
    "blockers": [],
    "checks": {
      "candidateCount": 8,
      "auditedCount": 8,
      "omittedCount": 0,
      "ledgerCount": 8,
      "ownerReconciliation": {
        "passed": true,
        "blockers": [],
        "checks": {
          "ownerRowCount": 8,
          "claimOwnerRowCount": 8
        }
      },
      "invalidNormalizedCandidateCount": 0
    }
  },
  "gates": {
    "renderedAllStructuredItems": true,
    "maxWords": null,
    "maxUrls": null,
    "truncated": false,
    "truncatedWithOpenGaps": false,
    "serializationArtifact": false,
    "expectedOutputShapeSatisfied": true,
    "sidecarWriteSucceeded": true,
    "packetReconciliationPassed": true,
    "packetReconciliationBlockers": [],
    "passed": true
  },
  "auditArtifact": "audit.md",
  "sidecarPath": "final-report.md",
  "auditSidecarPath": "audit.md"
}
</control>
<analysis>
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
</analysis>
<refs>
[
  "https://modelcontextprotocol.io/specification/versioning",
  "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
  "https://modelcontextprotocol.io/specification/2026-07-28.md",
  "https://modelcontextprotocol.io/specification/latest/basic/transports"
]
</refs>