# Bundled workflows, skills and agents (WP10)

Source: `@agwab/pi-workflow` 0.16.4, commit `b83cc4f` (MIT, same author).

## Provenance

| Destination | Source (b83cc4f) | Header |
|---|---|---|
| `workflows/README.md` | `workflows/README.md` | none (listed here) |
| `workflows/{deep-research,deep-review,impact-review,spec-review}/spec.json`, `deep-research/tiered-verification.spec.json` | same paths | none: the spec schema rejects unknown top-level keys (no `$comment`) |
| `workflows/*/schemas/*.schema.json` | same paths | none (listed here; schemas are runtime inputs) |
| `workflows/*/helpers/*.mjs` | same paths | `// Ported from …` first line (after the shebang, if any) |
| `skills/workflow-guide/SKILL.md`, `skills/execution-router/SKILL.md` | same paths | none (YAML front matter; listed here) |
| `skills/workflow-guide/scaffolds/**` | same paths | `.mjs` files carry the header; JSON/Markdown are listed here |
| `agents/scout.md`, `agents/researcher.md` | same paths | none (front matter; shipped since WP0) |

The port commit copies every file byte-for-byte except the added `.mjs` header line.
