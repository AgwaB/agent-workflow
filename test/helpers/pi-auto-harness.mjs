// New in agent-workflow (WP38b): a shared harness for the ported pi-workflow `/workflow auto` tests
// that now run against WP32 `/aw auto` (host API `autoAction`) in a fake Pi session. The built-in
// executor ids are shadowed by the workflow executor fixture (no agent CLI, no model call): its
// `autoRecommend` answers the classifier call (`autoClassifier: true` in the effect log), every
// other submit is a workflow task. `classify` replaces the classifier answer (for example no-fit).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fakeCtx, fakePi } from "./pi-host-fake.mjs";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "./workflow-executor-fixture.mjs";

export const READY = { installed: true, cliVersion: "1.0.0", auth: "ok" };

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const ext = await import("../../dist/hosts/pi/extension.js");

export { api, core, store };

/** A named workflow (one single stage on the fixture executor) with routing hints. */
export function autoSpec(name, useWhen, description = `${name} reviews code`) {
	return {
		schemaVersion: 1,
		name,
		description,
		routing: { useWhen: [useWhen], outputs: ["A review report."] },
		defaults: { agent: "reader", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
		},
	};
}

/** A project with the `reader` agent and the given named workflows ([name, useWhen] pairs). */
export async function autoProject(cwd, home, workflows) {
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	for (const [name, useWhen] of workflows) {
		await mkdir(join(cwd, "workflows", name), { recursive: true });
		await writeFile(
			join(cwd, "workflows", name, "spec.json"),
			`${JSON.stringify(autoSpec(name, useWhen))}\n`,
		);
	}
	return {
		...process.env,
		HOME: home,
		AGENT_WORKFLOW_HOME: join(cwd, "aw-home"),
	};
}

/**
 * Shadow `pi`, `claude` and `codex` with fixtures sharing one effect log; returns the undo list
 * and the log path. `recommend`: the label the classifier recommends (true: the first startable).
 */
export function shadowExecutors(
	logPath,
	{ recommend = true, stepDelayMs, autoStatus } = {},
) {
	return ["pi", "claude", "codex"].map((id) =>
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: logPath,
				autoRecommend: recommend,
				...(autoStatus ? { autoStatus } : {}),
				...(stepDelayMs === undefined ? {} : { stepDelayMs }),
				probe: READY,
				// The direct-dynamic workflow requests the CLI web tools (as the real adapters).
				capabilities: {
					webTools: {
						level: "native",
						source: "probed",
						detail: "search+fetch",
						safetyPolicy: "cli",
					},
				},
			}),
		),
	);
}

/** Submits of the classifier call and of workflow tasks in the fixture effect log. */
export function submits(logPath) {
	const entries = readFixtureLog(logPath);
	const all = entries.filter((entry) => entry.type === "submit");
	return {
		classifier: all.filter((entry) => entry.autoClassifier === true),
		workflow: all.filter((entry) => entry.autoClassifier !== true),
		cancels: entries.filter((entry) => entry.type === "cancel"),
	};
}

/**
 * A fake Pi session with the agent-workflow extension. `confirm(title, message, session)` and
 * `select(options, title)` script the dialogs (defaults: yes, first option).
 */
export function piAutoSession(cwd, env, options = {}) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({
		env,
		feedbackPollMs: 50,
		...(options.foregroundLoader
			? { foregroundLoader: options.foregroundLoader }
			: {}),
	})(pi);
	const ctx = fakeCtx(cwd, {
		...options.ctx,
		select: options.select ?? ((choices) => choices[0]),
	});
	const confirms = [];
	const session = {
		pi,
		ctx,
		confirms,
		command: (args) => pi.commands.get("aw").handler(args, ctx),
		async shutdown() {
			for (const handler of pi.handlers.get("session_shutdown") ?? [])
				await handler({ reason: "quit" }, undefined);
		},
	};
	ctx.ui.confirm = async (title, message) => {
		confirms.push({ title, message });
		return options.confirm
			? await options.confirm(title, message, session)
			: true;
	};
	return session;
}

/** A fake Pi BorderedLoader factory: `cancel()` is the user pressing Escape. */
export function fakeLoaders() {
	const created = [];
	const factory = async () => (_tui, _theme, label) => {
		const controller = new AbortController();
		const loader = {
			label,
			get signal() {
				return controller.signal;
			},
			onAbort: undefined,
			cancel() {
				controller.abort();
				loader.onAbort?.();
			},
		};
		created.push(loader);
		return loader;
	};
	return { created, factory };
}

/** Runs created in the project (the rebuilt index counts run directories). */
export async function runCount(cwd) {
	const index = await store.readFreshIndex(cwd);
	return Object.keys(index?.runs ?? {}).length;
}

/** Run ids in creation order. */
export async function runIds(cwd) {
	const index = await store.readFreshIndex(cwd);
	return [...(index?.runs ?? [])]
		.sort((left, right) =>
			String(left.createdAt).localeCompare(String(right.createdAt)),
		)
		.map((run) => run.runId);
}

/** Wait until the run is no longer running. */
export async function settle(cwd, env, runId) {
	let waited;
	do waited = await api.waitAction({ cwd, env }, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

export function readLog(path) {
	return readFixtureLog(path);
}
