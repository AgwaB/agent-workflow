// test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, watchFile, unwatchFile } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const host = new URL("../../dist/hosts/api.js", import.meta.url);
const store = new URL("../../dist/core/store.js", import.meta.url);
const entry = new URL("../../dist/hosts/cli/index.js", import.meta.url);
const executorHook = new URL(
	"../../dist/hosts/test-executor.js",
	import.meta.url,
);
const executor = fileURLToPath(
	new URL("../helpers/host-test-executor.mjs", import.meta.url),
);

async function readWhen(t, path, predicate = Boolean) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const check = () =>
		readFile(path, "utf8").then(
			(text) => {
				if (predicate(text)) resolve(text);
			},
			(error) => {
				if (error.code !== "ENOENT") reject(error);
			},
		);
	watchFile(path, { interval: 30 }, check);
	const abort = () => reject(t.signal.reason);
	t.signal.addEventListener("abort", abort, { once: true });
	try {
		void check();
		return await promise;
	} finally {
		unwatchFile(path, check);
		t.signal.removeEventListener("abort", abort);
	}
}

const model = (id, extra = {}) => ({
	id,
	type: "single",
	prompt: "Collect facts.",
	...extra,
});
const support = { id: "slow", support: { uses: "./helpers/barrier.mjs" } };

async function fixture(t, { stages = [support], layout = "plain" } = {}) {
	const root = await mkdtemp(join(tmpdir(), "aw-detached-support-"));
	const cwd = layout === "plain" ? root : join(root, "nested");
	const project = layout === "cli-subdirectory" ? root : cwd;
	if (layout !== "plain") {
		await mkdir(cwd);
		await mkdir(join(root, ".git"));
	}
	const started = join(project, "started");
	const released = join(project, "released");
	await mkdir(join(project, "helpers"));
	// Leave the host-selected nested directory without a project marker.
	const agents = join(
		layout === "host-nested"
			? join(cwd, "user-state")
			: join(project, ".agent-workflow"),
		"agents",
	);
	await mkdir(agents, { recursive: true });
	await writeFile(
		join(agents, "reader.md"),
		"---\nname: reader\ndescription: Reads\ntools: read, edit\n---\nRead and report.\n",
	);
	await writeFile(
		join(project, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "detach-fixture",
			defaults: { agent: "reader", tools: ["read"] },
			artifactGraph: { stages },
		}),
	);
	await writeFile(
		join(project, "helpers/barrier.mjs"),
		`
import { existsSync, watch, writeFileSync } from "node:fs";
export default async () => {
	if (process.env.AW_FAIL_SUPPORT === "1") throw new Error("fail before the barrier");
	const released = ${JSON.stringify(released)};
	await new Promise((done, fail) => {
		const check = () => { if (existsSync(released)) { watcher.close(); done(); } };
		const watcher = watch(${JSON.stringify(project)}, check);
		watcher.on("error", fail);
		writeFileSync(${JSON.stringify(started)}, String(process.pid), { flag: "wx" });
		check();
	});
	return { ok: true };
};
`,
	);
	const release = () => writeFile(released, "");
	t.after(release);
	function launch(argv, extraEnv = {}) {
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
import { runAgentWorkflowCli } from ${JSON.stringify(entry.href)};
process.on("message", () => {});
if (process.env.AW_STATUS_CLOCK_OFFSET) {
	const now = Date.now;
	Date.now = () => now() + Number(process.env.AW_STATUS_CLOCK_OFFSET);
}
if (process.env.AW_PUBLICATION_HOOK) {
	const { setRunLeaseTestHooksForTests } = await import(${JSON.stringify(store.href)});
	const { existsSync, mkdirSync } = await import("node:fs");
	const { basename, dirname, join } = await import("node:path");
	setRunLeaseTestHooksForTests({
		async onBeforeReleaseLockRename({ lockFile }) {
			const runFile = join(dirname(lockFile), "run.json");
			if (basename(lockFile) !== "supervisor.lock" || !existsSync(runFile)) return;
			if (process.env.AW_PUBLICATION_HOOK === "break-log") {
				mkdirSync(join(dirname(lockFile), "supervise.log"), { recursive: true });
				return;
			}
			process.send({ lockFile });
			await new Promise(() => {});
		},
	});
}
let stdout = "", stderr = "";
let code;
if (process.env.AW_DIRECT_HOST === "1") {
	const { runWorkflowAction } = await import(${JSON.stringify(host.href)});
	const { registerTestExecutorFromEnv } = await import(${JSON.stringify(executorHook.href)});
	await registerTestExecutorFromEnv(process.env);
	const env = { ...process.env };
	if (env.AW_HOST_HOME) env.AGENT_WORKFLOW_HOME = env.AW_HOST_HOME;
	const result = await runWorkflowAction({ cwd: process.cwd(), host: "generic", env }, {
		workflow: "spec.json", task: "probe", executor: "test-fixture", detach: true,
	});
	code = result.ok ? 0 : 1;
	stdout = JSON.stringify(result);
	stderr = result.text;
} else {
	code = await runAgentWorkflowCli(process.argv.slice(1), {
		cwd: process.cwd(), env: process.env, stdout: (s) => stdout += s,
		stderr: (s) => stderr += s, isTTY: false,
	});
}
process.send({ code, stdout, stderr });
`,
				"--",
				...argv,
			],
			{
				cwd,
				env: {
					...process.env,
					...(layout === "host-nested"
						? { AGENT_WORKFLOW_HOME: "user-state" }
						: {}),
					AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: executor,
					AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
					AW_HOST_TEST_EFFECT_LOG: join(project, "effects.jsonl"),
					...extraEnv,
				},
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			},
		);
		const exit = once(child, "exit");
		const message = once(child, "message").then(([response]) => response);
		const result = Promise.race([
			message,
			exit.then((state) => {
				assert.fail(
					`launcher exited before responding: ${JSON.stringify(state)}`,
				);
			}),
		]);
		void result.catch(() => undefined);
		const kill = async () => {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			return exit;
		};
		t.after(kill);
		return { pid: child.pid, kill, result };
	}
	return {
		launch,
		release,
		helperStarted: () => existsSync(started),
		helperPid: async () => Number(await readWhen(t, started)),
		runArgs: [
			"run",
			"spec.json",
			"probe",
			"--executor",
			"test-fixture",
			"--json",
		],
	};
}

function supervisorLog(t, path) {
	return readWhen(t, path, (text) =>
		/(\bdone:|^Error:|not found|unknown run)/im.test(text),
	);
}

for (const command of ["run", "resume", "blocked run"]) {
	test(`${command} --detach: only the supervisor runs the held support stage`, async (t) => {
		const blocked = command === "blocked run";
		const f = await fixture(
			t,
			blocked
				? {
						stages: [
							model("approval", {
								approvalMode: "on-request",
								tools: ["read", "edit"],
							}),
							{ ...support, after: [] },
						],
					}
				: {},
		);
		let args = f.runArgs;
		if (command === "resume") {
			const first = await f.launch(args, { AW_FAIL_SUPPORT: "1" }).result;
			assert.equal(first.code, 1, first.stderr);
			const data = JSON.parse(first.stdout).data;
			assert.equal(data.status, "failed");
			args = ["resume", data.runId, "--json"];
		}
		const launcher = f.launch([...args, "--detach"]);
		const first = await Promise.race([f.helperPid(), launcher.result]);
		if (first === launcher.pid) {
			assert.ok(blocked, "detached helper ran in the launcher");
			await f.release(); // On main, show the missing supervisor after the launcher returns.
		}
		const { stdout, stderr } =
			typeof first === "number" ? await launcher.result : first;
		const { data } = JSON.parse(stdout);
		assert.ok(data?.detached, stdout + stderr);
		const helperPid =
			typeof first === "number"
				? first
				: await Promise.race([
						f.helperPid(),
						supervisorLog(t, data.detached.logPath).then((log) =>
							assert.fail(`supervisor exited before helper dispatch:\n${log}`),
						),
					]);
		assert.notEqual(
			helperPid,
			launcher.pid,
			"detached helper ran in the launcher",
		);
		assert.equal(data.status, blocked ? "blocked" : "running");
		assert.equal(data.taskSummary.pending, 1);
		assert.equal(data.detached.pid, helperPid);
		assert.deepEqual(await launcher.kill(), [null, "SIGKILL"]);
		await f.release();
		const { logPath } = data.detached;
		assert.ok(
			(await supervisorLog(t, logPath)).includes(
				`done: ${data.runId} ${blocked ? "blocked" : "completed"}`,
			),
		);
		if (blocked) {
			const run = JSON.parse(
				await readFile(join(dirname(logPath), "run.json"), "utf8"),
			);
			assert.deepEqual(
				run.tasks.map(({ specId, status, statusDetail }) => [
					specId,
					status,
					statusDetail,
				]),
				[
					["approval.main", "blocked", "pending_approval"],
					["slow.main", "completed", "support_completed"],
				],
			);
		}
	});
}

test("foreground run still executes and waits for the support stage in the launcher", async (t) => {
	const f = await fixture(t);
	const child = f.launch(f.runArgs);
	assert.equal(await f.helperPid(), child.pid);
	await f.release();
	const { code, stdout, stderr } = await child.result;
	assert.equal(code, 0, stderr);
	assert.equal(JSON.parse(stdout).data.status, "completed");
});

for (const command of ["run", "run with loop", "resume"]) {
	test(`${command}: wait recovers a publication whose launcher dies before spawn`, async (t) => {
		const f = await fixture(
			t,
			command === "run with loop"
				? {
						stages: [
							support,
							{
								id: "cycle",
								after: ["slow"],
								type: "loop",
								maxRounds: 2,
								until: { stage: "check", path: "$.digest", exists: true },
								stages: [
									model("work", { readOnly: true }),
									model("check", { readOnly: true }),
								],
							},
						],
					}
				: {},
		);
		let args = f.runArgs;
		if (command === "resume") {
			const first = JSON.parse(
				(await f.launch(args, { AW_FAIL_SUPPORT: "1" }).result).stdout,
			).data;
			assert.equal(first.status, "failed");
			args = ["resume", first.runId];
		}
		const launcher = f.launch([...args, "--detach"], {
			AW_PUBLICATION_HOOK: "pause",
		});
		const { lockFile, stdout, stderr } = await launcher.result;
		assert.ok(
			lockFile,
			`expected the publication barrier, not a command result: ${stdout ?? ""}${stderr ?? ""}`,
		);
		const dir = dirname(lockFile);
		const runId = basename(dir);
		assert.deepEqual(await launcher.kill(), [null, "SIGKILL"]);
		await assert.rejects(readFile(join(dir, "supervise.log")), {
			code: "ENOENT",
		});
		// Advance only this dead lease past the ordinary reclaim grace.
		await utimes(lockFile, new Date(0), new Date(0));
		assert.equal(f.helperStarted(), false);
		// Status only diagnoses a missing driver after the launch grace, before the
		// separate driver-lost cutoff. Advance the observer's clock, not the record.
		const status = await f.launch(["status", runId], {
			AW_STATUS_CLOCK_OFFSET: "60000",
		}).result;
		assert.match(status.stdout, /no live driver/);
		const waiter = f.launch(["wait", runId, "--json"]);
		assert.equal(await f.helperPid(), waiter.pid);
		await f.release();
		const result = await waiter.result;
		assert.equal(result.code, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).data.status, "completed");
	});
}

test("a spawn failure reports a wait hint for the published run", async (t) => {
	const f = await fixture(t, {
		stages: [model("collect", { readOnly: true })],
	});
	const { code, stdout } = await f.launch([...f.runArgs, "--detach"], {
		AW_PUBLICATION_HOOK: "break-log",
	}).result;
	assert.equal(code, 1);
	const { data } = JSON.parse(stdout);
	assert.match(data.detachError, /Could not start detached supervisor/);
	assert.match(data.detachError, new RegExp(`Wait.*wait ${data.runId}`));
	assert.equal(data.detached, undefined);
	const waited = await f.launch(["wait", data.runId, "--json"]).result;
	assert.equal(waited.code, 0, waited.stderr);
});

for (const [name, layout, env] of [
	[
		"CLI from a subdirectory with a relative home",
		"cli-subdirectory",
		{ AGENT_WORKFLOW_HOME: "state-home" },
	],
	["host-selected nested project", "host-nested", { AW_DIRECT_HOST: "1" }],
	[
		"host environment with a different state home",
		"plain",
		{ AW_DIRECT_HOST: "1", AW_HOST_HOME: "other-state-home" },
	],
]) {
	test(`${name}: supervisor reads the same run store`, async (t) => {
		const f = await fixture(t, {
			layout,
			stages: [model("collect", { readOnly: true })],
		});
		const { code, stdout, stderr } = await f.launch(
			[...f.runArgs, "--detach"],
			env,
		).result;
		assert.equal(code, 0, stderr);
		const { data } = JSON.parse(stdout);
		assert.ok(data.detached, stdout);
		const log = await supervisorLog(t, data.detached.logPath);
		assert.match(log, new RegExp(`done: ${data.runId} completed`));
	});
}
