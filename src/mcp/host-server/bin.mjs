#!/usr/bin/env node
// `agent-workflow-mcp` bin (WP13): a thin launcher of the compiled host MCP server
// (dist/mcp/host-server/server.js). Usage: agent-workflow-mcp --host <claude-code|codex|generic>.
// No Pi imports. stdout is MCP protocol only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = new URL(
	"../../../dist/mcp/host-server/server.js",
	import.meta.url,
);
if (!existsSync(fileURLToPath(entry))) {
	process.stderr.write(
		`agent-workflow-mcp: the build is missing at ${fileURLToPath(entry)}. Run \`npm run build\` in a source checkout, or install the packed package.\n`,
	);
	process.exit(1);
}
await import(entry.href);
