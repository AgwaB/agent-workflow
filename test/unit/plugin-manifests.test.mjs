// New in agent-workflow (WP14/WP15): the committed Claude Code / Codex plugin
// (`plugins/agent-workflow/`) and the repo marketplaces. Checks that they equal the generator
// output (tools/release/plugins.mjs), JSON shape and required fields, version sync with
// package.json, the exact npx pin, the per-host `--host` value, the absence of manifests that would
// register the server a second time or with the wrong working directory, and that both
// marketplaces resolve to the plugin directory. docs/plugins.md.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as plugins from "../../tools/release/plugins.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const hostServer = await import("../../dist/mcp/host-server/index.js");
const hostApi = await import("../../dist/hosts/api.js");

function readJson(path) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

const pluginDir = join(root, plugins.PLUGIN_DIR);
const claude = readJson(`${plugins.PLUGIN_DIR}/.claude-plugin/plugin.json`);
const codex = readJson(`${plugins.PLUGIN_DIR}/.codex-plugin/plugin.json`);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

test("committed plugin and marketplaces equal the generator output", async () => {
	assert.deepEqual(await plugins.checkCommitted(root), []);
});

test("both manifests name the plugin and carry the package version", () => {
	assert.equal(plugins.PLUGIN_NAME, "agent-workflow");
	for (const manifest of [claude, codex]) {
		assert.equal(manifest.name, plugins.PLUGIN_NAME);
		assert.match(manifest.name, KEBAB);
		assert.equal(manifest.version, pkg.version);
		assert.equal(typeof manifest.description, "string");
		assert.ok(manifest.description.length > 20);
		assert.equal(manifest.license, pkg.license);
		assert.equal(typeof manifest.author?.name, "string");
	}
	assert.equal(
		claude.$schema,
		"https://anthropic.com/claude-code/plugin.schema.json",
	);
	assert.equal(codex.skills, "./skills/");
	assert.equal(codex.interface.displayName, "agent-workflow");
});

test("each host registers the agent-workflow server through the pinned npx package with its own --host", () => {
	const expected = {
		"claude-code": claude.mcpServers,
		codex: codex.mcpServers,
	};
	for (const [host, servers] of Object.entries(expected)) {
		assert.deepEqual(Object.keys(servers), [hostServer.HOST_MCP_SERVER_NAME]);
		const server = servers[hostServer.HOST_MCP_SERVER_NAME];
		assert.ok(hostServer.HOST_MCP_HOSTS.includes(host));
		assert.equal(server.command, "npx");
		assert.deepEqual(server.args, [
			"-y",
			`--package=${pkg.name}@${pkg.version}`,
			"agent-workflow-mcp",
			"--host",
			host,
		]);
		// The pin is an exact version, never a range or tag.
		assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
		// `agent-workflow-mcp` is a bin of the package.
		assert.equal(pkg.bin["agent-workflow-mcp"], "src/mcp/host-server/bin.mjs");
		// The server starts in the session's working directory (its project root): no cwd.
		assert.equal(server.cwd, undefined);
	}
	assert.deepEqual(
		plugins.npxLaunch(pkg.version, "codex"),
		(({ command, args }) => ({ command, args }))(
			codex.mcpServers["agent-workflow"],
		),
	);
});

test("Codex timeouts leave room for the 45 s wait cap and the first npx download", () => {
	const server = codex.mcpServers["agent-workflow"];
	assert.ok(server.tool_timeout_sec * 1000 > hostApi.HOST_WAIT_MAX_TIMEOUT_MS);
	assert.ok(server.tool_timeout_sec >= 60);
	assert.ok(server.startup_timeout_sec >= 60);
	// Claude Code has no startup field; its per-server `timeout` (ms) stays unset (default).
	assert.equal(claude.mcpServers["agent-workflow"].timeout, undefined);
});

test("no second server registration and no portable manifest that would start the server in the plugin root", () => {
	// Claude Code loads `.mcp.json` from a plugin root in addition to plugin.json `mcpServers`.
	assert.equal(existsSync(join(pluginDir, ".mcp.json")), false);
	// Codex prefers a root Agent Plugins plugin.json/mcp.json over .codex-plugin/ and starts its
	// stdio servers in the plugin root, not the project (docs/plugins.md).
	assert.equal(existsSync(join(pluginDir, "plugin.json")), false);
	assert.equal(existsSync(join(pluginDir, "mcp.json")), false);
	// Claude Code would load these directories as plugin components.
	for (const dir of ["agents", "commands", "hooks", "workflows"])
		assert.equal(existsSync(join(pluginDir, dir)), false, dir);
	// The repo root is not itself a plugin.
	assert.equal(existsSync(join(root, ".claude-plugin/plugin.json")), false);
	assert.equal(existsSync(join(root, ".codex-plugin/plugin.json")), false);
	assert.equal(existsSync(join(root, "plugin.json")), false);
});

test("the Claude Code marketplace resolves to the plugin directory", () => {
	const market = readJson(plugins.CLAUDE_MARKETPLACE_FILE);
	assert.equal(market.name, plugins.MARKETPLACE_NAME);
	assert.match(market.name, KEBAB);
	assert.equal(typeof market.owner?.name, "string");
	assert.equal(market.plugins.length, 1);
	const [entry] = market.plugins;
	assert.equal(entry.name, plugins.PLUGIN_NAME);
	assert.match(entry.source, /^\.\//);
	const target = resolve(root, entry.source);
	assert.equal(target, pluginDir);
	assert.ok(statSync(target).isDirectory());
	assert.equal(
		JSON.parse(readFileSync(join(target, ".claude-plugin/plugin.json"), "utf8"))
			.name,
		entry.name,
	);
});

test("the Codex marketplace resolves to the plugin directory", () => {
	const market = readJson(plugins.CODEX_MARKETPLACE_FILE);
	assert.equal(market.name, plugins.MARKETPLACE_NAME);
	assert.equal(market.interface.displayName, "agent-workflow");
	assert.equal(market.plugins.length, 1);
	const [entry] = market.plugins;
	assert.equal(entry.name, plugins.PLUGIN_NAME);
	assert.equal(entry.source.source, "local");
	assert.match(entry.source.path, /^\.\//);
	// Codex resolves source.path against the marketplace root (the repo root), not .agents/plugins/.
	assert.equal(resolve(root, entry.source.path), pluginDir);
	assert.deepEqual(entry.policy, {
		installation: "AVAILABLE",
		authentication: "ON_INSTALL",
	});
	assert.equal(typeof entry.category, "string");
	assert.equal(
		JSON.parse(
			readFileSync(join(pluginDir, ".codex-plugin/plugin.json"), "utf8"),
		).name,
		entry.name,
	);
});

test("install docs pin the package version", () => {
	let count = 0;
	for (const path of [
		"README.md",
		"docs/plugins.md",
		`${plugins.PLUGIN_DIR}/README.md`,
	]) {
		const text = readFileSync(join(root, path), "utf8");
		for (const [, version] of text.matchAll(
			/--package=@agwab\/agent-workflow@([^\s`]+)/g,
		)) {
			count += 1;
			if (version !== "<package") assert.equal(version, pkg.version, path);
		}
	}
	assert.ok(count >= 5);
});

test("the plugin is not part of the npm package", () => {
	// WP33: `plugins/pi` (the aw- Pi package skills, package.json `pi.skills`) is published; the
	// Claude Code/Codex plugin and the marketplaces are not.
	for (const path of pkg.files.filter((entry) => entry !== "plugins/pi"))
		assert.ok(
			!["plugins", ".claude-plugin", ".agents"].some(
				(prefix) => path === prefix || path.startsWith(`${prefix}/`),
			),
			path,
		);
});
