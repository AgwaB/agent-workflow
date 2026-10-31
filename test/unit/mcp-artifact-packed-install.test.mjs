// New in agent-workflow (WP5 acceptance): the packed tarball ships the artifact MCP server, and the
// server starts from an installed copy via the core launch spec (pattern from
// runtime-packed-install.test.mjs).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { callMcpTool } from "../../dist/sdk/conformance/index.js";
import { createRunFixture, root } from "../fixtures/mcp/helpers.mjs";

const execFileAsync = promisify(execFile);
const NETWORK_FAILURE =
	/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTCACHED|network|offline/iu;
const npmEnv = {
	...process.env,
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
	npm_config_loglevel: "error",
};
const npm = (args, cwd) =>
	execFileAsync("npm", args, {
		cwd,
		env: npmEnv,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});

test("@modelcontextprotocol/sdk is a devDependency only", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(pkg.dependencies ?? {}, {});
	assert.ok(pkg.devDependencies["@modelcontextprotocol/sdk"]);
	assert.equal(pkg.peerDependencies?.["@modelcontextprotocol/sdk"], undefined);
});

test("packed tarball contains the server and it starts from the install", async (t) => {
	assert.ok(
		existsSync(join(root, "dist", "mcp", "artifact-server", "server.js")),
		"run `npm run build` first",
	);
	const work = await mkdtemp(join(tmpdir(), "aw-mcp-packed-"));
	t.after(() =>
		rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	let packed;
	try {
		// --ignore-scripts: dist is already built; prepack would rebuild under parallel tests.
		const { stdout } = await npm(
			["pack", "--ignore-scripts", "--json", "--pack-destination", work],
			root,
		);
		[packed] = JSON.parse(stdout);
	} catch (error) {
		if (error?.code === "ENOENT") return t.skip("npm is not on PATH");
		throw error;
	}
	const files = new Set(packed.files.map((file) => file.path));
	for (const path of [
		"dist/mcp/artifact-server/server.js",
		"dist/mcp/artifact-server/service.js",
		"dist/mcp/artifact-server/stdio.js",
		"dist/mcp/visible-names.js",
		"dist/core/artifact-access.js",
		"dist/core/workflow-artifact-tool.js",
	])
		assert.ok(files.has(path), `tarball must contain ${path}`);
	assert.ok(
		![...files].some((path) => path.includes("@modelcontextprotocol")),
		"the MCP SDK must not ship",
	);

	const project = join(work, "project");
	await mkdir(project);
	await writeFile(
		join(project, "package.json"),
		`${JSON.stringify({ name: "aw-mcp-packed-probe", private: true, type: "module" })}\n`,
	);
	try {
		await npm(
			[
				"install",
				"--offline",
				"--ignore-scripts",
				"--no-package-lock",
				join(work, packed.filename),
			],
			project,
		);
	} catch (error) {
		const detail = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
		if (NETWORK_FAILURE.test(detail))
			return t.skip(`offline: ${detail.trim().split("\n")[0]}`);
		throw error;
	}
	const installed = await realpath(
		join(project, "node_modules", "@agwab", "agent-workflow"),
	);
	assert.equal(
		existsSync(join(project, "node_modules", "@modelcontextprotocol")),
		false,
	);

	const fixture = await createRunFixture();
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const access = await import(
		pathToFileURL(join(installed, "dist", "core", "artifact-access.js")).href
	);
	const spec = access.artifactMcpServerSpec(fixture.config);
	assert.equal(
		spec.args[0],
		join(installed, "dist", "mcp", "artifact-server", "server.js"),
	);
	const result = await callMcpTool(
		spec,
		"workflow_artifact",
		{ action: "read", source: "producer", artifact: "analysis" },
		{ cwd: project, timeoutMs: 15_000 },
	);
	assert.equal(result.isError, false);
	assert.deepEqual(result.tools, ["workflow_artifact"]);
	assert.equal(result.serverInfo.name, "agent-workflow-artifact");
	assert.equal(result.serverInfo.version, packed.version);
	assert.match(result.text, /Line three of the analysis/);
});
