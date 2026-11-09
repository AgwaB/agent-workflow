// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP11a acceptance): the packed tarball installs into a project with no Pi
// packages and its `agent-workflow` bin works: --help, list, validate of a bundled workflow, and a
// foreground run plus a detached run + wait of a one-stage workflow against a test executor
// registered through the guarded hook (AGENT_WORKFLOW_TEST_EXECUTOR_MODULE +
// AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only). The test executor wraps the installed SDK fake
// executor: no model or agent-CLI calls. Skips with a reason only when npm is unavailable or the
// offline install cannot run.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const PI_SCOPE = ["@earendil", "works"].join("-");
const NETWORK_FAILURE =
	/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTCACHED|network|offline/iu;
const npmEnv = {
	...process.env,
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
	npm_config_loglevel: "error",
};

const TEST_EXECUTOR_MODULE = `import { fileURLToPath } from "node:url";
import { createFakeExecutor } from "@agwab/agent-workflow/sdk/testing";

export const testExecutorDescriptor = {
	id: "test-packed",
	version: "0.1.0",
	contractVersion: "0.1.0",
	module: fileURLToPath(import.meta.url),
	config: null,
};

const finalText = [
	"<control>",
	JSON.stringify({ schema: "stage-control-v1", digest: "packed done" }),
	"</control>",
	"<analysis>",
	"packed analysis",
	"</analysis>",
	"<refs>",
	"[]",
	"</refs>",
].join("\\n");

export function createExecutor() {
	return createFakeExecutor({
		id: "test-packed",
		version: "0.1.0",
		script: [
			{ type: "started", sessionId: null },
			{ type: "message_delta", text: finalText },
			{ type: "usage", input: 1, output: 1, cached: null, cost: null, source: "unknown" },
			{ type: "completed", finalText },
		],
	});
}
`;

function run(command, args, options = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
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
		child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
	});
}

test("packed install: agent-workflow bin runs Pi-free (help, list, validate, run, run --detach + wait)", async (t) => {
	if (!existsSync(join(root, "dist", "hosts", "cli", "index.js")))
		assert.fail("dist/hosts/cli is missing; run `npm run build` first");
	const work = await mkdtemp(join(tmpdir(), "aw-cli-packed-"));
	try {
		let packed;
		try {
			const { stdout } = await execFileAsync(
				"npm",
				["pack", "--ignore-scripts", "--json", "--pack-destination", work],
				{
					cwd: root,
					env: npmEnv,
					encoding: "utf8",
					maxBuffer: 32 * 1024 * 1024,
				},
			);
			[packed] = JSON.parse(stdout);
		} catch (error) {
			if (error?.code === "ENOENT") {
				t.skip("npm is not on PATH; packed install not exercised");
				return;
			}
			throw error;
		}
		const files = new Set(packed.files.map((file) => file.path));
		for (const path of [
			"src/hosts/cli/cli.mjs",
			"dist/hosts/cli/index.js",
			"dist/hosts/api.js",
			"dist/hosts/api.d.ts",
		])
			assert.ok(files.has(path), `tarball must contain ${path}`);

		const project = join(work, "project");
		await mkdir(join(project, ".agent-workflow", "agents"), {
			recursive: true,
		});
		await writeFile(
			join(project, "package.json"),
			`${JSON.stringify({ name: "aw-cli-packed-probe", private: true, type: "module" }, null, 2)}\n`,
		);
		try {
			await execFileAsync(
				"npm",
				[
					"install",
					"--offline",
					"--ignore-scripts",
					"--no-package-lock",
					join(work, packed.filename),
				],
				{
					cwd: project,
					env: npmEnv,
					encoding: "utf8",
					maxBuffer: 32 * 1024 * 1024,
				},
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
		assert.equal(
			existsSync(join(project, "node_modules", PI_SCOPE)),
			false,
			"no Pi package may be installed",
		);
		const topLevel = (await readdir(join(project, "node_modules"))).filter(
			(name) => !name.startsWith("."),
		);
		assert.deepEqual(topLevel, ["@agwab"], "the tarball pulls no dependencies");
		const bin = join(project, "node_modules", ".bin", "agent-workflow");
		assert.ok(existsSync(bin), "npm links the agent-workflow bin");

		const env = {
			...process.env,
			AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
		};
		const aw = (args, extra = {}) =>
			run(bin, args, { cwd: project, env: { ...env, ...extra } });

		const help = await aw(["--help"]);
		assert.equal(help.code, 0, help.stderr);
		assert.match(help.stdout, /Usage: agent-workflow <command>/);
		const list = await aw(["list", "--json"]);
		assert.equal(list.code, 0, list.stderr);
		const rows = JSON.parse(list.stdout).data.workflows;
		const review = rows.find((row) => row.name === "deep-review");
		assert.ok(review, "bundled deep-review is listed");
		assert.match(
			review.specPath,
			/node_modules\/@agwab\/agent-workflow\/workflows\/deep-review\/spec\.json$/,
		);
		const validate = await aw(["validate", "deep-review"]);
		assert.equal(validate.code, 0, validate.stderr);
		assert.match(validate.stdout, /^Workflow spec valid: deep-review/);

		await writeFile(
			join(project, ".agent-workflow", "agents", "reader.md"),
			"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
		);
		await writeFile(
			join(project, "wf.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				name: "packed-one-stage",
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
				},
			})}\n`,
		);
		const executorModule = join(project, "test-executor.mjs");
		await writeFile(executorModule, TEST_EXECUTOR_MODULE);
		const hook = {
			AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: executorModule,
			AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
		};

		const foreground = await aw(
			["run", "wf.json", "packed", "task", "--executor", "test-packed"],
			hook,
		);
		if (foreground.code !== 0) {
			// Name the failed task's reason (the launch text only says "failed").
			const runId = /Run: (\S+)/u.exec(foreground.stdout)?.[1];
			let detail = "";
			if (runId) {
				const inspected = await aw(["inspect", runId, "--json"]);
				try {
					const tasks = JSON.parse(inspected.stdout).data.run.tasks;
					detail = JSON.stringify(
						tasks.map((task) => ({
							specId: task.specId,
							status: task.status,
							statusDetail: task.statusDetail,
							lastMessage: task.lastMessage,
							error: task.error,
							stderr: task.files?.stderr
								? readFileSync(
										join(stateDir(project), task.files.stderr),
										"utf8",
									).slice(-2000)
								: undefined,
						})),
						null,
						1,
					);
				} catch {
					detail = inspected.stdout.slice(0, 4000);
				}
			}
			assert.fail(
				`${foreground.stdout}${foreground.stderr}\n--- failed tasks ---\n${detail}`,
			);
		}
		assert.match(
			foreground.stdout,
			/Capability check \(test-packed@0\.1\.0, 1 stage, permission mode: free\): accepted/,
		);
		assert.match(foreground.stdout, /packed analysis/);

		const detached = await aw(
			[
				"run",
				"wf.json",
				"packed detached",
				"--executor",
				"test-packed",
				"--detach",
				"--json",
			],
			hook,
		);
		assert.equal(detached.code, 0, detached.stdout + detached.stderr);
		const launched = JSON.parse(detached.stdout).data;
		assert.equal(launched.status, "running");
		const waited = await aw(["wait", launched.runId, "--json"]);
		assert.equal(waited.code, 0, waited.stdout + waited.stderr);
		const result = JSON.parse(waited.stdout);
		assert.equal(result.outcome, "completed");
		assert.equal(result.data.terminal, true);
		const deadline = Date.now() + 20_000;
		while (
			!(
				existsSync(launched.detached.logPath) &&
				readFileSync(launched.detached.logPath, "utf8").includes(
					`done: ${launched.runId}`,
				)
			)
		) {
			assert.ok(Date.now() < deadline, "detached supervisor finishes");
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
		}
	} finally {
		await rm(work, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	}
});
