// New in agent-workflow (WP14/WP15): `node tools/release/plugins.mjs dev <outDir>` writes a local
// marketplace root whose plugin runs this checkout's host MCP server. Checks the dev manifests
// (absolute Node + bin path, per-host `--host`), that the rest of the plugin equals the committed
// one, the empty-directory/--force rule, the CLI usage errors, and that the Codex dev command
// really starts the server in a project directory and lists the tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { spawnHostServer } from "../helpers/mcp-host-client.mjs";
import * as plugins from "../../tools/release/plugins.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(root, "tools/release/plugins.mjs");
const hostServer = await import("../../dist/mcp/host-server/index.js");
const bin = join(root, "src/mcp/host-server/bin.mjs");

let temp;
before(async () => {
	temp = await realpath(await mkdtemp(join(tmpdir(), "aw-plugin-dev-")));
});
after(async () => {
	await rm(temp, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

test("dev output: manifests launch the checkout's server per host; everything else equals the committed plugin", async () => {
	const out = join(temp, "market");
	const result = spawnSync(process.execPath, [generator, "dev", out], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /claude --plugin-dir /);
	const pluginDir = join(out, plugins.PLUGIN_DIR);
	const claude = await readJson(join(pluginDir, ".claude-plugin/plugin.json"));
	const codex = await readJson(join(pluginDir, ".codex-plugin/plugin.json"));
	for (const [manifest, host] of [
		[claude, "claude-code"],
		[codex, "codex"],
	]) {
		const server = manifest.mcpServers[hostServer.HOST_MCP_SERVER_NAME];
		assert.equal(server.command, process.execPath);
		assert.ok(isAbsolute(server.args[0]));
		assert.equal(server.args[0], bin);
		assert.ok(existsSync(server.args[0]));
		assert.deepEqual(server.args.slice(1), ["--host", host]);
	}
	assert.equal(codex.mcpServers["agent-workflow"].tool_timeout_sec, 120);
	// WP36: the dev completion hook runs the checkout's CLI.
	const hook = claude.hooks.UserPromptSubmit[0].hooks[0];
	assert.ok(
		hook.command.includes(
			`${process.execPath} ${join(root, "src/hosts/cli/cli.mjs")} notify-check --host claude-code`,
		),
		hook.command,
	);
	assert.equal(codex.hooks, undefined);

	const committed = join(root, plugins.PLUGIN_DIR);
	for (const path of [
		"README.md",
		"skills/agent-workflow/SKILL.md",
		"skills/workflow-guide/SKILL.md",
		"skills/execution-router/SKILL.md",
		"skills/workflow-guide/scaffolds/README.md",
		"reference/docs/usage.md",
	])
		assert.equal(
			readFileSync(join(pluginDir, path), "utf8"),
			readFileSync(join(committed, path), "utf8"),
			path,
		);
	for (const path of [
		plugins.CLAUDE_MARKETPLACE_FILE,
		plugins.CODEX_MARKETPLACE_FILE,
	])
		assert.equal(
			readFileSync(join(out, path), "utf8"),
			readFileSync(join(root, path), "utf8"),
			path,
		);
	// Apart from the launch command, the dev manifests equal the committed ones.
	const strip = (manifest) => {
		const copy = structuredClone(manifest);
		for (const server of Object.values(copy.mcpServers)) {
			delete server.command;
			delete server.args;
		}
		delete copy.hooks;
		return copy;
	};
	assert.deepEqual(
		strip(claude),
		strip(await readJson(join(committed, ".claude-plugin/plugin.json"))),
	);
	assert.deepEqual(
		strip(codex),
		strip(await readJson(join(committed, ".codex-plugin/plugin.json"))),
	);
});

test("dev refuses a non-empty directory unless --force, and --force replaces the plugin", async () => {
	const out = join(temp, "busy");
	await mkdir(out, { recursive: true });
	await writeFile(join(out, "keep.txt"), "user file\n");
	const refused = spawnSync(process.execPath, [generator, "dev", out], {
		encoding: "utf8",
	});
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /is not empty \(pass --force/);
	assert.equal(existsSync(join(out, plugins.PLUGIN_DIR)), false);

	await mkdir(join(out, plugins.PLUGIN_DIR, "stale"), { recursive: true });
	await writeFile(join(out, plugins.PLUGIN_DIR, "stale/old.md"), "old\n");
	const forced = spawnSync(
		process.execPath,
		[generator, "dev", out, "--force"],
		{ encoding: "utf8" },
	);
	assert.equal(forced.status, 0, forced.stderr);
	assert.equal(existsSync(join(out, plugins.PLUGIN_DIR, "stale")), false);
	assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "user file\n");
	assert.ok(
		existsSync(join(out, plugins.PLUGIN_DIR, ".codex-plugin/plugin.json")),
	);
});

test("generator CLI usage errors", () => {
	for (const args of [[], ["dev"], ["dev", "a", "b"], ["nope"]]) {
		const result = spawnSync(process.execPath, [generator, ...args], {
			encoding: "utf8",
		});
		assert.equal(result.status, 2, args.join(" "));
		assert.match(result.stderr, /usage: node tools\/release\/plugins\.mjs/);
	}
});

test("the Codex dev command starts the server in the project directory and lists every tool", async () => {
	const out = join(temp, "serve");
	await plugins.buildDev(out);
	const codex = await readJson(
		join(out, plugins.PLUGIN_DIR, ".codex-plugin/plugin.json"),
	);
	const { command, args } = codex.mcpServers["agent-workflow"];
	assert.equal(command, process.execPath);
	const project = join(temp, "project");
	await mkdir(project, { recursive: true });
	const server = spawnHostServer({
		cwd: project,
		command: args[0],
		args: args.slice(1),
		env: { AGENT_WORKFLOW_HOME: join(temp, "home") },
	});
	try {
		const init = await server.initialize();
		assert.equal(init.result.serverInfo.name, hostServer.HOST_MCP_SERVER_NAME);
		const listed = await server.request("tools/list", {});
		assert.deepEqual(
			listed.result.tools.map((tool) => tool.name).sort(),
			hostServer.HOST_MCP_TOOLS.map((tool) => tool.name).sort(),
		);
		const status = await server.call("workflow_status", {});
		assert.notEqual(status.isError, true, JSON.stringify(status));
		const closed = await server.close();
		assert.equal(closed.code, 0, server.stderr());
	} finally {
		server.kill();
	}
});
