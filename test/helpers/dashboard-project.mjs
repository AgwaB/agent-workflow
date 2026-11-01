// One teardown owns the ordering: settle starts/launches, close servers, stop the detached
// child while discovery still exists, drain fixture schedulers, then remove the project.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflowAction } from "../../dist/hosts/api.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import {
	ensureDashboard,
	readDashboardDiscovery,
} from "../../dist/hosts/dashboard/discovery.js";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
import {
	killTrackedProcess,
	processCommand,
	trackProcess,
} from "./process-cleanup.mjs";
import { drainWorkflowFixture } from "./workflow-fixture-lifecycle.mjs";

export async function dashboardProject(t, prefix) {
	// No await between creating the directory and registering its owner hook: a timeout
	// during asynchronous mkdtemp could otherwise finish the test before teardown exists.
	const cwd = mkdtempSync(join(tmpdir(), prefix));
	const pending = new Set(),
		servers = [],
		runs = new Set(),
		disposers = [];
	let closing = false;
	function own(action) {
		assert.equal(closing, false, "project is already tearing down");
		const promise = action();
		pending.add(promise);
		promise.finally(() => pending.delete(promise)).catch(() => {});
		return promise;
	}
	t.after(async () => {
		closing = true;
		const errors = [];
		const attempt = async (action) => {
			try {
				await action();
			} catch (error) {
				errors.push(error);
			}
		};
		// A node:test timeout does not cancel an async test body. Wait for acquisitions already
		// in flight, and reject new ones, so none can publish a server after directory removal.
		await Promise.allSettled([...pending]);
		for (const server of servers) await attempt(() => server.close());
		await attempt(async () => {
			const discovery = await readDashboardDiscovery(cwd, {
				probe: async () => true,
			});
			if (!discovery?.detached || discovery.pid === process.pid) return;
			// Never signal an unrelated process, even if a stale discovery pid has been reused.
			const command = processCommand(discovery.pid);
			if (!command?.includes("cli.mjs dashboard") || !command.includes(cwd))
				return;
			trackProcess(discovery.pid);
			try {
				let stderr = "";
				const code = await runAgentWorkflowCli(["dashboard", "--stop"], {
					cwd,
					env: { AGENT_WORKFLOW_ROLE: "supervisor" },
					stdout: () => {},
					stderr: (text) => {
						stderr += text;
					},
					isTTY: false,
				});
				assert.equal(code, 0, stderr);
			} finally {
				await killTrackedProcess(discovery.pid);
			}
		});
		for (const runId of runs)
			await attempt(() => drainWorkflowFixture(cwd, runId));
		for (const dispose of disposers) await attempt(dispose);
		await attempt(() =>
			rm(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			}),
		);
		if (errors.length)
			throw new AggregateError(errors, "dashboard project cleanup failed");
	});
	return {
		cwd,
		dispose: (callback) => disposers.push(callback),
		start: (options = {}) =>
			own(async () => {
				const server = await startDashboardServer({ cwd, ...options });
				servers.push(server);
				return server;
			}),
		ensure: (env) => own(() => ensureDashboard(cwd, env, { start: true })),
		launch: (context, request) =>
			own(async () => {
				const out = await runWorkflowAction(context, request);
				if (out.data?.runId) runs.add(out.data.runId);
				return out;
			}),
	};
}
