<control>{
  "schema":"x",
  "digest":"Selected eight source-backed atoms covering specification currency, framing, and stream policy; general message encoding remains unestablished.",
  "claimInventory":{
    "verificationCandidates":[
      {
        "id":"claim-001",
        "claim":"The official versioning page identifies 2026-07-28 as the current MCP protocol version.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/versioning"],
        "sourceRefs":["wsrc_6f2e06f5a0dd2c8d98ce75ab416660e7"],
        "sourceQuality":"primary",
        "reasonToVerify":"Establishes controlling version for critical slot-001 rather than relying on an announcement or older discovery URL.",
        "scopeItems":["Current specification authority"],
        "factSlotIds":["slot-001"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-002",
        "claim":"The official transport overview links stdio to /specification/2026-07-28/basic/transports/stdio.md.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/latest/basic/transports","https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_3af3257c452fc577322dd1fe372b693b"],
        "sourceQuality":"primary",
        "reasonToVerify":"Supplies the canonical binding location required by slot-001.",
        "scopeItems":["Current specification authority"],
        "factSlotIds":["slot-001"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-003",
        "claim":"The stdio specification states that each message is a single JSON-RPC request, notification, or response.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reasonToVerify":"Recovers slot-002 message-format evidence despite the framing question's retrieval failure.",
        "scopeItems":["Stdio message framing"],
        "factSlotIds":["slot-002"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-004",
        "claim":"The stdio specification states that messages are delimited by newlines.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reasonToVerify":"Protects the exact delimiter requirement in critical slot-002.",
        "scopeItems":["Stdio message framing"],
        "factSlotIds":["slot-002"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-005",
        "claim":"The stdio specification says messages MUST NOT contain embedded newlines.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reasonToVerify":"Separates slot-002's embedded-newline prohibition from its delimiter statement without weakening normative strength.",
        "scopeItems":["Stdio message framing"],
        "factSlotIds":["slot-002"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-006",
        "claim":"The stdio specification says the server MUST NOT write anything to stdout that is not a valid MCP message.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reasonToVerify":"Preserves slot-004's exact source-stated prohibition instead of deriving a broader logging recommendation.",
        "scopeItems":["Server stdout and stderr rules"],
        "factSlotIds":["slot-004"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-007",
        "claim":"The stdio specification says servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reasonToVerify":"Protects slot-005's permission, logging scope, and stderr-specific encoding without asserting message encoding.",
        "scopeItems":["Server stdout and stderr rules"],
        "factSlotIds":["slot-005"],
        "verificationNeed":"core"
      },
      {
        "id":"claim-008",
        "claim":"The stdio specification says clients SHOULD NOT assume server stderr output indicates error conditions.",
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reasonToVerify":"Separates a bundled obligation and preserves slot-005 context that stderr is not limited to errors.",
        "scopeItems":["Server stdout and stderr rules"],
        "factSlotIds":["slot-005"],
        "verificationNeed":"useful"
      }
    ],
    "preservedClaims":[
      {
        "id":"claim-009",
        "claim":"The stdio specification says clients MAY capture, forward, or ignore server stderr output.",
        "factSlotIds":["slot-005"],
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reason":"budget_overflow",
        "whyItMatters":"Additional client-side permission; split from the bundled stderr claim but less central than required server rules."
      },
      {
        "id":"claim-010",
        "claim":"The stdio specification states that the server writes JSON-RPC messages to stdout.",
        "factSlotIds":["slot-004"],
        "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
        "sourceRefs":["wsrc_ff966eae34ec1ec6ab48a4f0cf055b83"],
        "sourceQuality":"primary",
        "reason":"unverified_slot_fact",
        "whyItMatters":"Preserves the positive stdout description alongside the selected prohibition."
      }
    ],
    "duplicates":[
      {
        "claim":"Repeated extracted-fact and claim rows for stdout prohibition and stderr logging permission.",
        "canonicalClaimId":"claim-006",
        "otherCanonicalClaimIds":["claim-007"]
      },
      {
        "claim":"Release announcement and versioned-page observations overlap the selected currency and canonical-location evidence.",
        "canonicalClaimId":"claim-001",
        "otherCanonicalClaimIds":["claim-002"]
      }
    ]
  },
  "factSlotCoverage":[
    {
      "slotId":"slot-001",
      "label":"Current official specification version and canonical stdio section",
      "status":"filled",
      "bestValue":"Official versioning identifies 2026-07-28 as current; the transport overview links its dedicated stdio binding.",
      "sourceUrls":["https://modelcontextprotocol.io/specification/versioning","https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
      "sourceQuality":"primary",
      "verificationCandidateIds":["claim-001","claim-002"],
      "gapReason":"",
      "parentImpact":"Provides version authority for the transport rules; verification remains pending."
    },
    {
      "slotId":"slot-002",
      "label":"Stdio message format, delimiter, and embedded newline rules",
      "status":"filled",
      "bestValue":"Each message is a single JSON-RPC request, notification, or response. Messages are newline-delimited and MUST NOT contain embedded newlines.",
      "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
      "sourceQuality":"primary",
      "verificationCandidateIds":["claim-003","claim-004","claim-005"],
      "gapReason":"",
      "parentImpact":"Framing evidence recovered from the stream-policy source; verification remains pending."
    },
    {
      "slotId":"slot-003",
      "label":"Applicable message encoding requirements",
      "status":"missing",
      "bestValue":"",
      "sourceUrls":[],
      "sourceQuality":"missing primary passage",
      "verificationCandidateIds":[],
      "gapReason":"No retrieved passage establishes general message encoding. UTF-8 permission for stderr logging does not establish wire-message encoding.",
      "parentImpact":"Do not assert a general UTF-8 message requirement without further primary evidence."
    },
    {
      "slotId":"slot-004",
      "label":"Server stdout permitted content and prohibitions",
      "status":"filled",
      "bestValue":"Server stdout carries JSON-RPC messages; the server MUST NOT write anything to stdout that is not a valid MCP message.",
      "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
      "sourceQuality":"primary",
      "verificationCandidateIds":["claim-006"],
      "gapReason":"",
      "parentImpact":"Supports the exact stdout restriction; positive stream description is preserved separately."
    },
    {
      "slotId":"slot-005",
      "label":"Server stderr logging permissions and normative strength",
      "status":"filled",
      "bestValue":"Servers MAY write UTF-8 strings to stderr for any logging purposes, including informational, debug, and error messages.",
      "sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"],
      "sourceQuality":"primary",
      "verificationCandidateIds":["claim-007","claim-008"],
      "gapReason":"",
      "parentImpact":"Preserves permission rather than obligation; client capture permission remains unverified backlog."
    }
  ],
  "coverageGaps":[
    {
      "scopeItem":"Stdio message framing",
      "relatedFactSlotIds":["slot-003"],
      "status":"missing primary source",
      "gapReason":"General wire-message encoding is not established by visible evidence; stderr UTF-8 logging is a different control.",
      "parentImpact":"Encoding must remain explicitly unresolved."
    },
    {
      "scopeItem":"Stdio message framing",
      "relatedFactSlotIds":["slot-002","slot-003"],
      "status":"budget_exhausted",
      "gapReason":"rq-002 exhausted its search budget after failed transport fetches. Other cached evidence recovered framing, but not message encoding.",
      "parentImpact":"Do not equate question completion with complete evidence coverage."
    }
  ],
  "researchScopeCoverage":[
    {
      "scopeItem":"Current specification authority",
      "status":"covered",
      "factSlotIds":["slot-001"],
      "verificationCandidateIds":["claim-001","claim-002"]
    },
    {
      "scopeItem":"Stdio message framing",
      "status":"partial",
      "factSlotIds":["slot-002","slot-003"],
      "verificationCandidateIds":["claim-003","claim-004","claim-005"],
      "gapReason":"Framing recovered; general message encoding remains unestablished."
    },
    {
      "scopeItem":"Server stdout and stderr rules",
      "status":"covered",
      "factSlotIds":["slot-004","slot-005"],
      "verificationCandidateIds":["claim-006","claim-007","claim-008"]
    }
  ],
  "normalizationNotes":[
    "Selected 8 candidates, meeting the quick hard cap. Two useful source-backed atoms remain preserved.",
    "Precision guard flagged 2 claims: normative_language=2 and multi_obligation_claim=1. Reframed the stdout rule as a specification statement; split client stderr handling into separate permission and assumption atoms.",
    "rq-002 budgetExhausted=true: searchBudget=3, searchCallsUsed=3; its ledger lists 4 attempted query strings. Other question ledgers report 2 calls used each and no exhaustion.",
    "Overflow ledger has no nonzero counts; no upstream overflow recovery was needed.",
    "Official versioning evidence supersedes the unresolved dashboard lookup and the unsupported suggestion that 2025-11-25 remains current.",
    "Cached stdio source supplied exact framing excerpts absent from extractedFacts; slot preservation was updated without inferring encoding from stderr.",
    "Coverage statuses describe available observations, not verified truth.",
    "Schema validation could not be completed: the designated local schema file was absent."
  ]
}</control>

<analysis>
The compact packet was the primary input. Exact cached excerpts independently exposed framing rules and the official current-version declaration, closing two apparent research gaps without additional discovery.

Normative clauses remain source-attributed observations rather than recommendations. The stderr UTF-8 clause was not reused as evidence for general message encoding. That required slot remains explicitly missing.

All selected candidates have primary-source references and HTTP URLs. Verification should prioritize the controlling version, framing atoms, and server stream rules. The requested schema file could not be read, so schema validation is unconfirmed.
</analysis>

<refs>[
  {
    "sourceRef":"wsrc_6f2e06f5a0dd2c8d98ce75ab416660e7",
    "url":"https://modelcontextprotocol.io/specification/versioning",
    "claimIds":["claim-001"],
    "quote":"The **current** protocol version is [**2026-07-28**](https://modelcontextprotocol.io/specification/2026-07-28.md).",
    "matchType":"exact"
  },
  {
    "sourceRef":"wsrc_3af3257c452fc577322dd1fe372b693b",
    "url":"https://modelcontextprotocol.io/specification/latest/basic/transports",
    "claimIds":["claim-002"],
    "quote":"[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md): newline-delimited\n   messages over the standard streams of a client-launched subprocess.",
    "evidenceOrigin":"packet.research.sources"
  },
  {
    "sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83",
    "url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
    "claimIds":["claim-003","claim-004","claim-005"],
    "quote":"Each message is a single JSON-RPC request, notification, or response.\n* Messages are delimited by newlines, and **MUST NOT** contain embedded newlines.",
    "matchType":"exact"
  },
  {
    "sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83",
    "url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
    "claimIds":["claim-006"],
    "quote":"The server **MUST NOT** write anything to its `stdout` that is not a valid MCP\n  message.",
    "matchType":"exact"
  },
  {
    "sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83",
    "url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
    "claimIds":["claim-007"],
    "quote":"The server **MAY** write UTF-8 strings to `stderr` for any logging purposes\n  including informational, debug, and error messages.",
    "matchType":"exact"
  },
  {
    "sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83",
    "url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
    "claimIds":["claim-008","claim-009"],
    "quote":"The client **MAY** capture, forward, or ignore the server's `stderr` output and\n  **SHOULD NOT** assume `stderr` output indicates error conditions.",
    "matchType":"exact"
  },
  {
    "sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83",
    "url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md",
    "claimIds":["claim-010"],
    "quote":"The server reads JSON-RPC messages from `stdin` and writes JSON-RPC messages to\n  `stdout`.",
    "matchType":"exact"
  }
]</refs>