// New in agent-workflow (WP5): visible tool-name mapping for WP6–WP8 adapters and prompt rendering. WP10: rows are verified (live WP6–WP8 evidence).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ARTIFACT_TOOL_NAME_MAPPINGS,
	artifactToolNameMapping,
	artifactToolVisibleName,
	mcpPrefixedToolName,
} from "../../dist/mcp/artifact-server/index.js";

test("each executor surfaces workflow_artifact as mcp__workflow_artifact__workflow_artifact (verified live)", () => {
	for (const id of ["claude", "codex", "pi"]) {
		assert.equal(
			artifactToolVisibleName(id),
			"mcp__workflow_artifact__workflow_artifact",
		);
		const mapping = artifactToolNameMapping(id);
		assert.equal(mapping.executorId, id);
		// WP10: verified by the WP6–WP8 live runs (Pi #4, Codex #2, Claude #10). Was: false.
		assert.equal(mapping.verified, true, `${id} was verified live in WP6–WP8`);
		assert.match(mapping.evidence, /live/);
	}
	assert.deepEqual(Object.keys(ARTIFACT_TOOL_NAME_MAPPINGS).sort(), [
		"claude",
		"codex",
		"pi",
	]);
	assert.equal(artifactToolNameMapping("toString"), undefined);
	assert.equal(
		artifactToolVisibleName("unknown-cli"),
		"mcp__workflow_artifact__workflow_artifact",
	);
	assert.equal(
		mcpPrefixedToolName("dev-radius", "get.thing"),
		"mcp__dev_radius__get_thing",
	);
});
