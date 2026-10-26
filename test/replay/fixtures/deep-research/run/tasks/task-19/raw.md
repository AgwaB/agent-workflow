<control>
{"schema":"deep-research-verify-claim-v1","digest":"Server stdout prohibition verified directly.","id":"claim-006","status":"verified","confidence":"high","verdictDigest":{"support":"The cited primary specification states the server stdout prohibition explicitly with MUST NOT.","sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"]},"evidence":[{"source":"Model Context Protocol specification — stdio","url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md","sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83","quote":"The server **MUST NOT** write anything to its `stdout` that is not a valid MCP\n  message.","matchType":"exact","relevance":"Directly establishes the claimed server stdout restriction."}],"caveats":[],"correctionOrCounterclaim":""}
</control>
<analysis>
An exact-match read confirmed the supplied evidence quote. The claim preserves both the server-specific scope and the normative MUST NOT language without extending it into a broader logging requirement. This verifies the cited specification text, not whether that version is currently the latest release.
</analysis>
<refs>
[{"sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83","url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"}]
</refs>