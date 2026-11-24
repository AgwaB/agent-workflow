import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The workflow-guide skill is read whole by the agent that authors a workflow, so its size is bounded
// (2026-11-24: 49,308 -> 43,843 bytes by the skill audit). Anything that must not be lost belongs in
// docs/usage.md or in a tool that enforces it; do not raise the bound to fit a new paragraph.

const MAX_BYTES = 44_000;
const skill = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"skills",
	"workflow-guide",
	"SKILL.md",
);

test(`skills/workflow-guide/SKILL.md is at most ${MAX_BYTES} bytes`, async () => {
	const { size } = await stat(skill);
	assert.ok(
		size <= MAX_BYTES,
		`SKILL.md is ${size} bytes, ${size - MAX_BYTES} over the ${MAX_BYTES} limit: move detail to docs/usage.md or to a tool check`,
	);
});
