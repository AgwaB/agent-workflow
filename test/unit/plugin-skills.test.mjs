// New in agent-workflow (WP14/WP15): the skills shipped in the Claude Code / Codex plugin. Every
// skill is present with valid front matter, the tool names they use exist on the host MCP server,
// the agent-workflow skill covers every tool and the 45 s wait cap, no Pi-only names survive the
// adaptation, and every `../../reference/…` path a skill names exists in the plugin.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as plugins from "../../tools/release/plugins.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pluginDir = join(root, plugins.PLUGIN_DIR);
const hostServer = await import("../../dist/mcp/host-server/index.js");
const hostApi = await import("../../dist/hosts/api.js");
const toolNames = hostServer.HOST_MCP_TOOLS.map((tool) => tool.name);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function skill(name) {
	return readFileSync(join(pluginDir, "skills", name, "SKILL.md"), "utf8");
}

function frontMatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(match, "front matter");
	const fields = {};
	for (const line of match[1].split("\n")) {
		const index = line.indexOf(":");
		if (index > 0)
			fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return fields;
}

test("the plugin ships the agent-workflow, workflow-guide and execution-router skills", () => {
	assert.deepEqual([...plugins.PLUGIN_SKILLS].sort(), [
		"agent-workflow",
		"execution-router",
		"workflow-guide",
	]);
	for (const name of plugins.PLUGIN_SKILLS) {
		const fields = frontMatter(skill(name));
		assert.equal(fields.name, name);
		assert.ok(fields.description.length > 40, name);
	}
	assert.equal(
		skill("agent-workflow"),
		readFileSync(join(root, "skills/agent-workflow/SKILL.md"), "utf8"),
	);
	assert.ok(
		existsSync(
			join(
				pluginDir,
				"skills/workflow-guide/scaffolds/fixed-inventory/initialize.mjs",
			),
		),
	);
});

test("skill tool names are the host MCP server's tools", () => {
	assert.deepEqual(toolNames.sort(), [
		"workflow_dynamic",
		"workflow_inspect",
		"workflow_list",
		"workflow_logs",
		"workflow_run",
		"workflow_status",
		"workflow_stop",
		"workflow_validate",
		"workflow_wait",
	]);
	// `workflow_artifact` is the worker-side artifact tool named in authoring guidance.
	const known = new Set([...toolNames, "workflow_artifact"]);
	for (const name of plugins.PLUGIN_SKILLS) {
		for (const [used] of skill(name).matchAll(/(?<![\w-])workflow_[a-z]+\b/g))
			assert.ok(known.has(used), `${name}: unknown tool ${used}`);
	}
	const main = skill("agent-workflow");
	for (const tool of toolNames)
		assert.match(main, new RegExp(`\`${tool}\``), tool);
	assert.match(
		main,
		new RegExp(`at most ${hostApi.HOST_WAIT_MAX_TIMEOUT_MS / 1000} s per call`),
	);
	assert.match(main, /stillRunning/);
	assert.match(main, /`free` is the default/);
	// Host-visible names (Claude Code plugin prefix, `mcp add` and Codex form).
	assert.match(
		main,
		new RegExp(
			`mcp__plugin_${plugins.PLUGIN_NAME}_${hostServer.HOST_MCP_SERVER_NAME}__<tool>`,
		),
	);
	assert.match(
		main,
		new RegExp(`mcp__${hostServer.HOST_MCP_SERVER_NAME}__<tool>`),
	);
	// WP18b (live 4b): Codex shows the server name with hyphens as underscores.
	assert.match(
		main,
		new RegExp(
			`mcp__${hostServer.HOST_MCP_SERVER_NAME.replaceAll("-", "_")}__<tool>`,
		),
	);
});

test("plugin skills carry no Pi-only names and the router stays recommendation-only", () => {
	for (const name of plugins.PLUGIN_SKILLS)
		assert.doesNotMatch(skill(name), plugins.PI_ONLY_SKILL_TEXT, name);
	const router = skill("execution-router");
	assert.match(router, /bounded read-only discovery/i);
	assert.match(router, /`workflow_list` tool/);
	assert.match(
		router,
		/Never invoke `workflow_run`, `workflow_dynamic`, `workflow_wait`, `workflow_stop`, `workflow_validate`/,
	);
	assert.match(router, /\*\*No execution performed\.\*\*/);
	const guide = skill("workflow-guide");
	assert.match(guide, /`workflow_validate` tool/);
	assert.match(
		guide,
		new RegExp(
			`npx -y --package=${plugins.PACKAGE_NAME}@${pkg.version.replaceAll(".", "\\.")} agent-workflow`,
		),
	);
});

test("every ../../reference path named by a plugin skill exists", () => {
	let count = 0;
	for (const name of plugins.PLUGIN_SKILLS) {
		const skillDir = join(pluginDir, "skills", name);
		for (const [, path] of skill(name).matchAll(/`(\.\.\/\.\.\/[^`\s]+)`/g)) {
			count += 1;
			assert.ok(existsSync(join(skillDir, path)), `${name}: ${path}`);
		}
	}
	assert.ok(count >= 6);
	for (const workflow of plugins.REFERENCE_WORKFLOWS)
		assert.equal(
			readFileSync(
				join(pluginDir, "reference/workflows", workflow, "spec.json"),
				"utf8",
			),
			readFileSync(join(root, "workflows", workflow, "spec.json"), "utf8"),
		);
});

test("the adaptation fails loudly when the source skill text changes", () => {
	assert.throws(
		() => plugins.adaptExecutionRouter("unrelated text"),
		/expected source text not found/,
	);
	assert.throws(
		() => plugins.adaptWorkflowGuide("# Workflow Guide\n\nnothing", "0.0.0"),
		/expected source text not found/,
	);
});
