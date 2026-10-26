The current official versioning page identifies version 2026-07-28. Its stdio binding supplies direct, exact evidence for both required slots.

Preserve the distinction between obligation and permission: stdout MUST contain only valid MCP messages; stderr MAY carry UTF-8 logging text, including non-error diagnostics. The specification does not require servers to log, nor does it restrict stderr to errors. Its companion client rule explicitly permits ignoring stderr and says clients SHOULD NOT assume it indicates error conditions.

Plain-text stdout logs violate the valid-message restriction; that example is an inference from the explicit normative prohibition, not separately quoted specification wording.
