<control>
{"schema":"deep-research-verify-claim-v1","digest":"The cited specification explicitly prohibits non-MCP stdout output.","id":"claim-004","status":"verified","confidence":"high","verdictDigest":{"support":"The primary specification contains the claimed normative stdout prohibition verbatim.","sourceUrls":["https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"]},"evidence":[{"source":"Model Context Protocol specification — stdio","url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md","sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83","quote":"The server **MUST NOT** write anything to its `stdout` that is not a valid MCP\n  message.","matchType":"exact","relevance":"Direct normative support for the normalized stdout restriction."}],"caveats":["This verdict verifies the rewritten stdout claim, not the original newline-framing claim."],"correctionOrCounterclaim":""}
</control>
<analysis>
The independently requested exact-source read confirmed the supplied quotation. Plain-text logs, banners, or debugging output that are not valid MCP messages consequently cannot be written to stdout. The verdict applies to the normalized claim rather than its earlier framing formulation.
</analysis>
<refs>
[{"sourceRef":"wsrc_ff966eae34ec1ec6ab48a4f0cf055b83","url":"https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md"}]
</refs>