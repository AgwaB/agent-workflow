// New in agent-workflow (WP5): how each executor's CLI surfaces the workflow_artifact MCP tool to
// the model. Since WP10 the mapping lives in `src/core/artifact-tool-names.ts` (the core prompt
// renderer uses it and core may import only its siblings); this module re-exports it unchanged.
export {
	ARTIFACT_TOOL_NAME_MAPPINGS,
	type ArtifactToolNameMapping,
	artifactToolNameMapping,
	artifactToolVisibleName,
	mcpPrefixedToolName,
} from "../core/artifact-tool-names.js";
