// New in agent-workflow (WP5): visible tool-name mapping for WP6–WP8 adapters and prompt rendering.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ARTIFACT_TOOL_NAME_MAPPINGS,
	artifactToolNameMapping,
	artifactToolVisibleName,
	mcpPrefixedToolName,
} from "../../dist/mcp/artifact-server/index.js";

test("each executor surfaces workflow_artifact as mcp__workflow_artifact__workflow_artifact (unverified)", () => {
	for (const id of ["claude", "codex", "pi"]) {
		assert.equal(
			artifactToolVisibleName(id),
			"mcp__workflow_artifact__workflow_artifact",
		);
		const mapping = artifactToolNameMapping(id);
		assert.equal(mapping.executorId, id);
		assert.equal(
			mapping.verified,
			false,
			`${id} stays unverified until WP6–WP8`,
		);
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
