# Task

Read NOTES.md and report its first heading.

# Workflow Stage

stage=first-heading
type=single

# Instructions

Use the read tool once to read the file named in the runtime task (a path relative to the current working directory). Do not modify files and do not read any other file. Report the text of the first Markdown heading in that file. Respond with exactly three sections and no prose outside them: <control>{"schema":"stage-control-v1","digest":"First heading: <heading text>"}</control> then <analysis>one short sentence</analysis> then <refs>["<the file path>"]</refs>.

# Workflow Output Protocol

Return your final answer exactly as these three sections, in this order, with no prose outside the tags:

<control>{...}</control>

<analysis>...</analysis>

<refs>[]</refs>

The <control> section must be valid JSON object data for the workflow control plane.

The control object must include a non-empty string `schema` and a concise non-empty string `digest`.

Use schema `stage-control-v1` unless the workflow asks for a more specific control schema.

Put detailed prose, reasoning, and evidence discussion in <analysis> only.

Put structured evidence pointers in <refs> as a JSON array; use [] if none.

# Workflow Artifact Inputs

Use workflow_artifact to list/read upstream workflow artifacts. Inline controlProjection fields are authoritative for the projected data they contain; use artifact reads for declared requiredReads, missing fields, or debug detail.

Projected reads must include a JSON path when using maxItems or maxChars, for example {"action":"read","source":"plan","artifact":"control","path":"$.factSlots","maxItems":8,"maxChars":2000}. For a whole artifact read, omit maxItems/maxChars.

No hard requiredReads are declared for this stage.

Available sources:

[]