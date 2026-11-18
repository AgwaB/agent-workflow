import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createCodexExecutor } from "../../dist/executors/codex/index.js";
import { AppServerConnection } from "../../dist/executors/codex/rpc.js";
import {
	AttemptStore,
	ThreadOwnershipStore,
} from "../../dist/executors/codex/state.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";

async function setup(t) {
	const dir = await mkdtemp(join(tmpdir(), "aw-codex-fail-closed-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const userHome = join(dir, "user");
	await mkdir(userHome);
	await writeFile(join(userHome, "auth.json"), "{}");
	const stateDir = join(dir, "state");
	return {
		dir,
		userHome,
		stateDir,
		executor: createCodexExecutor({ stateDir }),
	};
}

function request(dir, userHome, attemptKey, authority, overrides = {}) {
	return {
		attemptKey,
		authority,
		cwd: dir,
		prompt: "hi",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: { CODEX_HOME: userHome },
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		...overrides,
	};
}

function mockLaunch(t, implementation) {
	const mock = t.mock.method(childProcess, "spawn", implementation);
	syncBuiltinESMExports();
	t.after(() => {
		mock.mock.restore();
		syncBuiltinESMExports();
	});
	return mock;
}

// agent-workflow 2026-11-10 (regression audit G2): failed private-home preparation fell back to the user's home — 7b45c4f
test("submit refuses failed private-home preparation without launching", async (t) => {
	const { dir, userHome, stateDir, executor } = await setup(t);
	const attemptKey = "prepare-refused";
	const logDir = new AttemptStore(stateDir).logDir(attemptKey);
	const target = join(dir, "linked-attempt");
	await mkdir(target);
	await mkdir(join(stateDir, "attempts"), { recursive: true });
	await symlink(target, logDir);
	const launch = mockLaunch(t, () => {
		throw new Error("unexpected app-server launch");
	});
	const gate = createAuthorityGate({ attemptKey });
	await assert.rejects(
		executor.submit(request(dir, userHome, attemptKey, gate.authority)),
		(error) =>
			error.code === "CAPABILITY_MISSING" &&
			/cannot prepare a private CODEX_HOME.*not a plain directory/.test(
				error.message,
			),
	);
	assert.equal(launch.mock.callCount(), 0);
});

// agent-workflow 2026-11-10 (regression audit G3): isolated-resume refusal consumed execution authority — 58e5160
test("isolated resume refuses before consuming authority or recording a launch", async (t) => {
	const { dir, userHome, executor } = await setup(t);
	const attemptKey = "isolated-resume";
	const trace = [];
	const gate = createAuthorityGate({
		attemptKey,
		onTrace: (entry) => trace.push(entry),
	});
	const consume = t.mock.method(gate.authority, "consume");
	const launch = mockLaunch(t, () => {
		throw new Error("unexpected app-server launch");
	});
	await assert.rejects(
		executor.submit(
			request(dir, userHome, attemptKey, gate.authority, {
				resumeSessionId: "foreign-thread",
			}),
		),
		{ code: "CAPABILITY_MISSING" },
	);
	assert.equal(
		consume.mock.callCount(),
		0,
		"refusal must not consume authority",
	);
	assert.equal(gate.state(), "pending");
	assert.deepEqual(trace, []);
	assert.equal(launch.mock.callCount(), 0);
	assert.deepEqual(await executor.reconcile(attemptKey), { absent: true });
});

// agent-workflow 2026-11-10 (regression audit G4): unconfirmed deletion-server exit discarded thread ownership — 1e58acb
test("deletion fails and retains ownership when SIGKILL has no exit acknowledgement", async (t) => {
	const { stateDir, executor } = await setup(t);
	const session = { kind: "codex-thread", locator: "owned-thread" };
	const threads = new ThreadOwnershipStore(stateDir);
	threads.record(session.locator, "kept-attempt");
	const ended = Promise.withResolvers();
	const killed = Promise.withResolvers();
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		kill: t.mock.fn(() => {
			killed.resolve();
			return true;
		}),
	});
	mockLaunch(t, () => child);
	const methods = [];
	t.mock.method(AppServerConnection.prototype, "request", async (method) => {
		methods.push(method);
		return {};
	});
	// Neither EOF nor SIGKILL acknowledges an exit.
	t.mock.method(AppServerConnection.prototype, "end", () => {
		child.stdin.end();
		ended.resolve();
	});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const deleting = executor.deleteOwnedSession(session);
	await ended.promise;
	t.mock.timers.tick(3_000);
	await killed.promise;
	t.mock.timers.tick(3_000);
	assert.equal(await deleting, "failed", "unconfirmed exit must fail deletion");
	assert.deepEqual(methods, ["initialize", "thread/delete"]);
	assert.deepEqual(
		child.kill.mock.calls.map((call) => call.arguments),
		[["SIGKILL"]],
	);
	assert.equal(
		new ThreadOwnershipStore(stateDir).owns(session.locator),
		true,
		"ownership must survive an unconfirmed exit",
	);
});
