// New in agent-workflow (WP5): path containment, debug-mode gating, secret hygiene and startup
// refusal of the workflow_artifact MCP server.
import assert from "node:assert/strict";
import {
	copyFile,
	link,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	artifactAccessConfigBytes,
	canonicalArtifactAccessJson,
} from "../../dist/core/artifact-access.js";
import {
	createRunFixture,
	resultText,
	runServerToExit,
	startServer,
} from "../fixtures/mcp/helpers.mjs";

const SECRET = "aw-secret-value-8c1f3e";

async function serve(t, fixtureOptions = {}) {
	const fixture = await createRunFixture(fixtureOptions);
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const outside = await mkdtemp(join(tmpdir(), "aw-mcp-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "secret.txt"), "OUTSIDE-THE-RUN-DIR\n");
	const server = startServer(["--config", fixture.configPath], {
		env: { AW_TEST_TOKEN: SECRET },
	});
	t.after(() => server.child.kill("SIGKILL"));
	await server.initialize();
	return { fixture, outside, server };
}

function assertBlocked(result, pattern) {
	assert.equal(result.isError, true);
	const text = resultText(result);
	assert.match(text, /artifact_read_failed/);
	if (pattern) assert.match(text, pattern);
	assert.doesNotMatch(text, /OUTSIDE-THE-RUN-DIR/);
}

test("source names cannot carry traversal, absolute paths or NUL bytes", async (t) => {
	const { server, fixture } = await serve(t);
	for (const source of [
		"../producer",
		"..",
		"/etc/passwd",
		"producer/../../x",
		"producer\u0000",
		"tasks/producer",
		"C:\\windows",
	])
		assertBlocked(
			await server.callTool({ action: "read", source, artifact: "analysis" }),
			/canonical workflow artifact source name/,
		);
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "../analysis",
		}),
	);
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "control",
			path: "../../etc/passwd",
		}),
	);
	await assert.rejects(readFile(fixture.ledgerPath), { code: "ENOENT" });
	await server.close();
	assert.doesNotMatch(server.stderr, new RegExp(SECRET));
	assert.doesNotMatch(server.lines.join("\n"), new RegExp(SECRET));
});

test("symlinked, hard-linked and symlinked-directory artifacts are refused", async (t) => {
	const { server, fixture, outside } = await serve(t);
	const producer = fixture.producerDir;
	await rm(join(producer, "analysis.md"));
	await symlink(join(outside, "secret.txt"), join(producer, "analysis.md"));
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
		}),
		/must not be a symlink/,
	);
	// Symlink to a file inside the run dir is refused as well.
	await rm(join(producer, "refs.json"));
	await symlink(join(producer, "control.json"), join(producer, "refs.json"));
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "refs",
		}),
		/must not be a symlink/,
	);
	// Hard link to a file outside the run dir.
	await rm(join(producer, "control.json"));
	await link(join(outside, "secret.txt"), join(producer, "control.json"));
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "control",
		}),
		/hard-linked/,
	);
	await server.close();
});

test("a symlinked directory inside the run dir cannot reach outside", async (t) => {
	const outside = await mkdtemp(join(tmpdir(), "aw-mcp-outside-dir-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "analysis.md"), "OUTSIDE-THE-RUN-DIR\n");
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const linkDir = join(fixture.runDir, "tasks", "linked");
	await symlink(outside, linkDir);
	const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
	manifest.sources[0].artifacts.analysis.path = join(linkDir, "analysis.md");
	await writeFile(fixture.manifestPath, JSON.stringify(manifest));
	const server = startServer(["--config", fixture.configPath]);
	t.after(() => server.child.kill("SIGKILL"));
	await server.initialize();
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
		}),
		/must stay inside the workflow run directory/,
	);
	await server.close();
});

test("a symlinked read ledger is refused and nothing is written through it", async (t) => {
	const { server, fixture, outside } = await serve(t);
	const target = join(outside, "ledger.jsonl");
	await writeFile(target, "");
	await symlink(target, fixture.ledgerPath);
	assertBlocked(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
		}),
		/read ledger must not be a symlink/,
	);
	assert.equal(await readFile(target, "utf8"), "");
	await server.close();
});

test("debug artifacts need human-debug in the config; the manifest policy cannot enable them", async (t) => {
	const task = await serve(t, { policy: { accessMode: "human-debug" } });
	const listed = JSON.parse(
		resultText(await task.server.callTool({ action: "list" })),
	);
	assert.deepEqual(listed.sources[0].artifacts, [
		"control",
		"analysis",
		"refs",
		"raw",
	]);
	assertBlocked(
		await task.server.callTool({
			action: "read",
			source: "producer",
			artifact: "prompt",
		}),
		/not available in workflow-task access mode/,
	);
	await task.server.close();

	const debug = await serve(t, { accessMode: "human-debug" });
	const read = await debug.server.callTool({
		action: "read",
		source: "producer",
		artifact: "prompt",
	});
	assert.equal(read.isError, false);
	assert.match(resultText(read), /Debug-only prompt artifact/);
	await debug.server.close();
});

async function refusal(t, mutate, pattern, args) {
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const configPath = (await mutate(fixture)) ?? fixture.configPath;
	const result = await runServerToExit(args ?? ["--config", configPath], {
		env: { AW_TEST_TOKEN: SECRET },
		input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
	});
	assert.notEqual(result.code, 0, `must refuse: ${pattern}`);
	assert.equal(result.stdout, "", "no protocol output from a refused start");
	assert.match(result.stderr, pattern);
	assert.doesNotMatch(result.stderr, new RegExp(SECRET));
	return result;
}

const rewriteConfig = (fixture, patch) =>
	writeFile(
		fixture.configPath,
		`${canonicalArtifactAccessJson({ ...fixture.config, ...patch })}\n`,
	);

test("invalid or missing config refuses to start", async (t) => {
	await refusal(t, () => undefined, /--config is required/, []);
	await refusal(t, () => undefined, /Unknown option/, [
		"--config",
		"x",
		"--bogus",
	]);
	await refusal(t, (f) => join(f.taskDir, "missing.json"), /config is missing/);
	await refusal(
		t,
		(f) => writeFile(f.configPath, "{nope"),
		/Invalid workflow artifact access config/,
	);
	await refusal(
		t,
		(f) => rewriteConfig(f, { version: 2 }),
		/Invalid workflow artifact access config/,
	);
	await refusal(
		t,
		(f) => rewriteConfig(f, { extra: true }),
		/Invalid workflow artifact access config/,
	);
	await refusal(
		t,
		(f) => rewriteConfig(f, { runDir: "relative/run" }),
		/Invalid workflow artifact access config/,
	);
	await refusal(
		t,
		(f) => rewriteConfig(f, { accessMode: "root" }),
		/Invalid workflow artifact access config/,
	);
	await refusal(
		t,
		(f) => rewriteConfig(f, { maxBytes: -1 }),
		/Invalid workflow artifact access config/,
	);
});

test("config/run mismatches and unsafe config paths refuse to start", async (t) => {
	// Config copied away from its manifest.
	await refusal(
		t,
		async (f) => {
			const elsewhere = join(f.runDir, "artifact-access.json");
			await copyFile(f.configPath, elsewhere);
			return elsewhere;
		},
		/not the task's artifact-access.json/,
	);
	// Manifest identity does not match the config.
	await refusal(
		t,
		async (f) => {
			const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
			manifest.runId = "other-run";
			await writeFile(f.manifestPath, JSON.stringify(manifest));
		},
		/do not match the config/,
	);
	// Manifest missing / a symlink.
	await refusal(t, (f) => rm(f.manifestPath), /source manifest is missing/);
	await refusal(
		t,
		async (f) => {
			const real = join(f.taskDir, "real-manifest.json");
			await copyFile(f.manifestPath, real);
			await rm(f.manifestPath);
			await symlink(real, f.manifestPath);
		},
		/source manifest must not be a symlink/,
	);
	// Config file is a symlink.
	await refusal(
		t,
		async (f) => {
			const real = join(f.taskDir, "real-config.json");
			await copyFile(f.configPath, real);
			await rm(f.configPath);
			await symlink(real, f.configPath);
		},
		/config must not be a symlink/,
	);
	// Ledger or manifest outside the run dir.
	await refusal(
		t,
		(f) => rewriteConfig(f, { ledgerPath: join(tmpdir(), "elsewhere.jsonl") }),
		/ledgerPath must be inside the workflow run directory/,
	);
	// A runDir that does not contain the task.
	await refusal(
		t,
		async (f) => {
			await rewriteConfig(f, { runDir: join(f.cwd, "missing-run") });
		},
		/must be inside the workflow run directory/,
	);
	// Manifest entry pointing outside the run dir.
	await refusal(
		t,
		async (f) => {
			const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
			manifest.sources[0].artifacts.analysis.path = "/etc/passwd";
			await writeFile(f.manifestPath, JSON.stringify(manifest));
		},
		/must be inside the workflow run directory/,
	);
	// NUL bytes in config paths (argv itself cannot carry NUL).
	await refusal(
		t,
		(f) =>
			rewriteConfig(f, { ledgerPath: join(f.taskDir, "led\u0000ger.jsonl") }),
		/ledgerPath must not contain NUL bytes/,
	);
});

test("the canonical config written by core is what the server accepts", async (t) => {
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	assert.equal(
		await readFile(fixture.configPath, "utf8"),
		artifactAccessConfigBytes(fixture.config),
	);
	await mkdir(join(fixture.runDir, "unrelated"), { recursive: true });
	const server = startServer(["--config", fixture.configPath]);
	t.after(() => server.child.kill("SIGKILL"));
	await server.initialize();
	await server.close();
	assert.equal(server.stderr, "");
});
