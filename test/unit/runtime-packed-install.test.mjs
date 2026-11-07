// The packed runtime imports without Pi packages, spawns shipped workers, preserves
// the Darwin helper executable bit, and runs the fixture executor end to end.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PI_SCOPE = ["@earendil", "works"].join("-");
const HELPER = "runtime/native/darwin-process-identity";
const NETWORK_FAILURE =
	/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTCACHED|network|offline/iu;

const npmEnv = {
	...process.env,
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
	npm_config_loglevel: "error",
};

async function npm(args, cwd) {
	return await execFileAsync("npm", args, {
		cwd,
		env: npmEnv,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			...options,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			resolveRun({ code, signal, stdout, stderr }),
		);
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}

test("package keeps zero runtime dependencies and no bundled Pi packages", () => {
	assert.deepEqual(
		pkg.dependencies ?? {},
		{},
		"runtime must have zero dependencies",
	);
	for (const key of ["bundleDependencies", "bundledDependencies"])
		assert.equal(pkg[key], undefined, `${key} must not be used`);
	for (const name of Object.keys(pkg.peerDependencies ?? {})) {
		if (!name.startsWith(`${PI_SCOPE}/`)) continue;
		assert.equal(
			pkg.peerDependenciesMeta?.[name]?.optional,
			true,
			`${name} must stay an optional peer`,
		);
	}
});

test("packed tarball installs Pi-free and runs the runtime from dist", async (t) => {
	if (!existsSync(join(root, "dist", "runtime", "index.js")))
		assert.fail("dist/runtime is missing; run `npm run build` first");
	const work = await mkdtemp(join(tmpdir(), "aw-packed-install-"));
	try {
		// --ignore-scripts: dist is already built by test:unit; prepack would
		// rebuild (rm -rf dist) under the other test files running in parallel.
		let packed;
		try {
			const { stdout } = await npm(
				["pack", "--ignore-scripts", "--json", "--pack-destination", work],
				root,
			);
			[packed] = JSON.parse(stdout);
		} catch (error) {
			if (error?.code === "ENOENT") {
				t.skip("npm is not on PATH; packed install not exercised");
				return;
			}
			throw error;
		}
		const files = new Map(packed.files.map((file) => [file.path, file]));
		for (const path of [
			"dist/runtime/index.js",
			"dist/runtime/workers/process-gate.js",
			"dist/runtime/workers/durable-worker-binding.js",
			"dist/runtime/workers/durable-worker.js",
			"dist/runtime/workers/terminal-finalizer.js",
			"dist/runtime/native/darwin-process-identity.manifest.json",
		])
			assert.ok(files.has(path), `tarball must contain ${path}`);
		assert.deepEqual(
			[...files.keys()].filter((path) => path.startsWith("src/")).sort(),
			Object.values(pkg.bin).sort(),
			"only bin launchers ship under src; native source stays in the source checkout",
		);
		const helper = files.get(`dist/${HELPER}`);
		assert.ok(helper, `tarball must contain dist/${HELPER}`);
		assert.equal(
			helper.mode & 0o755,
			0o755,
			`dist/${HELPER} must be executable in the tarball (mode ${helper.mode.toString(8)})`,
		);

		const project = join(work, "project");
		await mkdir(project);
		await writeFile(
			join(project, "package.json"),
			`${JSON.stringify({ name: "aw-packed-probe", private: true, type: "module" }, null, 2)}\n`,
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
			if (NETWORK_FAILURE.test(detail)) {
				t.skip(
					`offline: npm could not install the tarball (${detail.trim().split("\n")[0]})`,
				);
				return;
			}
			throw error;
		}
		const installed = join(project, "node_modules", "@agwab", "agent-workflow");
		assert.equal(
			existsSync(join(project, "node_modules", PI_SCOPE)),
			false,
			"no Pi package may be installed",
		);
		const topLevel = (await readdir(join(project, "node_modules"))).filter(
			(name) => !name.startsWith("."),
		);
		assert.deepEqual(topLevel, ["@agwab"], "the tarball pulls no dependencies");
		assert.equal(
			(await stat(join(installed, "dist", HELPER))).mode & 0o111,
			0o111,
			"installed helper keeps its exec bit",
		);

		const probe = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const runtime = await import("@agwab/agent-workflow/runtime");
// The first runs of a freshly installed native helper can exceed its 2 s timeout under load
// (macOS first-execution scan), answering \"unknown\"; retry before judging the install.
let identity = await runtime.inspectProcessIdentity(process.pid);
for (let i = 0; i < 6 && identity.state !== \"alive\"; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  identity = await runtime.inspectProcessIdentity(process.pid);
}
console.log(JSON.stringify({
  module: runtime.MODULE,
  runsDir: runtime.DEFAULT_RUNS_DIR,
  validate: runtime.validateResolveInput({ task: "t" }, "codex").ok,
  identity: identity.state,
  identityReason: identity.reason ?? null,
  gate: runtime.runtimeWorkerPath("process-gate"),
  binding: runtime.runtimeWorkerPath("durable-worker-binding"),
}));`,
			],
			{ cwd: project },
		);
		assert.equal(probe.code, 0, probe.stderr);
		const report = JSON.parse(probe.stdout);
		assert.equal(report.module, "src/runtime");
		assert.equal(report.runsDir, ".agent-workflow/runs");
		assert.equal(report.validate, true);
		assert.ok(report.gate.startsWith(await realpath(installed)), report.gate);
		if (process.platform === "darwin" || process.platform === "linux")
			assert.equal(
				report.identity,
				"alive",
				`process identity works from the install (${report.identityReason ?? "no reason"})`,
			);

		// process-gate: documented usage error (125) without a payload ...
		const usage = await run(process.execPath, [report.gate], { cwd: project });
		assert.deepEqual([usage.code, usage.signal], [125, null], usage.stderr);
		// ... and a clean pass-through run with one.
		const gated = await run(process.execPath, [report.gate], {
			cwd: project,
			input: `${JSON.stringify({
				argv: [process.execPath, "-e", "console.log('gated')"],
				cwd: project,
				env: {},
			})}\n`,
		});
		assert.deepEqual([gated.code, gated.signal], [0, null], gated.stderr);
		assert.equal(gated.stdout, "gated\n");

		// durable-worker-binding is a library module: running it has no effect,
		// importing it from the installed copy yields the guard API.
		const binding = await run(process.execPath, [report.binding], {
			cwd: project,
		});
		assert.deepEqual([binding.code, binding.signal], [0, null], binding.stderr);
		assert.equal(binding.stdout, "");
		const guard = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const m = await import(${JSON.stringify(new URL(`file://${report.binding}`).href)});
try { m.prepareDurableWorkerBinding({ payload: {} }); } catch (error) {
  console.log(JSON.stringify({ guard: m.isDurableWorkerGuardError(error), kind: error.failureKind }));
}`,
			],
			{ cwd: project },
		);
		assert.equal(guard.code, 0, guard.stderr);
		assert.deepEqual(JSON.parse(guard.stdout), {
			guard: true,
			kind: "guard_failure",
		});

		// WP2a-2: the installed durable worker reloads an executor from its descriptor in a
		// fresh process (the fake executor fixture, resolved against the installed SDK).
		const fixture = join(project, "fake-executor-module.mjs");
		await copyFile(
			join(root, "test", "fixtures", "runtime", "fake-executor-module.mjs"),
			fixture,
		);
		const durable = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const runtime = await import("@agwab/agent-workflow/runtime");
const { fixtureDescriptor, readEffectLog } = await import(${JSON.stringify(new URL(`file://${fixture}`).href)});
const effectLog = ${JSON.stringify(join(project, "effects.jsonl"))};
const run = await runtime.runWorker({ cwd: process.cwd(), executor: fixtureDescriptor({ effectLog }), task: "packed", async: true });
const waited = await runtime.waitForWorker({ cwd: process.cwd(), runId: run.runId, attemptId: run.attemptId, timeoutMs: 20000, pollIntervalMs: 50 });
// WP2b: the detached finalizer still publishes after the registry turns terminal; the fixture is
// removed right after this script, so wait for its run event (it raced rm with ENOTEMPTY).
for (let i = 0; i < 400 && !(await runtime.readRunEvents({ cwd: process.cwd(), runId: run.runId }, Infinity)).some((event) => event.type === "run." + waited.snapshot?.status); i += 1) await new Promise((r) => setTimeout(r, 50));
console.log(JSON.stringify({
  status: waited.snapshot?.status,
  failureKind: waited.snapshot?.failureKind,
  worker: runtime.runtimeWorkerPath("durable-worker"),
  effects: readEffectLog(effectLog).filter((entry) => entry.type === "effect").map((entry) => ({ authorized: entry.authorized, other: entry.pid !== process.pid })),
}));`,
			],
			{ cwd: project },
		);
		assert.equal(durable.code, 0, durable.stderr);
		const durableReport = JSON.parse(durable.stdout);
		assert.equal(durableReport.status, "completed", durable.stdout);
		assert.equal(durableReport.failureKind, null);
		assert.ok(
			durableReport.worker.startsWith(await realpath(installed)),
			durableReport.worker,
		);
		assert.deepEqual(durableReport.effects, [
			{ authorized: true, other: true },
		]);
	} finally {
		await rm(work, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
