import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardProject } from "./dashboard-project.mjs";
import { registerWorkflowExecutor } from "../../dist/core/executor-registry.js";
import { resetExecutorProbeCacheForTests } from "../../dist/core/executor-default.js";
import { stateBase } from "../../dist/core/state-location.js";
import { dashboardCsrf } from "../../dist/hosts/dashboard/security.js";

export async function managementProject(t, options = {}) {
	const project = await dashboardProject(t, "aw-dashboard-management-");
	const { cwd } = project;
	const env = {
		...process.env,
		AGENT_WORKFLOW_ROLE: "supervisor",
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
	};
	const probeLog = join(cwd, "probes.log");
	const effects = join(cwd, "effects.jsonl");
	resetExecutorProbeCacheForTests();
	for (const id of ["pi", "claude", "codex", "antigravity", "management-fake"])
		project.dispose(
			registerWorkflowExecutor({
				id,
				version: "0.1.0",
				contractVersion: "0.1.0",
				module: fileURLToPath(
					new URL("./dashboard-management-probe.mjs", import.meta.url),
				),
				config: {
					id,
					effectLog: effects,
					probeLog,
					probe: { installed: true, cliVersion: "1.2.3", auth: "ok" },
				},
			}),
		);
	project.dispose(() => resetExecutorProbeCacheForTests());
	await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
	await mkdir(join(cwd, ".agent-workflow/workflows"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: Reads facts\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, ".agent-workflow/workflows/manage.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "manage",
			description: "Management fixture",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "read", type: "single", prompt: "Read facts." }],
			},
		}),
	);
	let now = Date.now();
	const server = await project.start({ env, now: () => now, ...options });
	const origin = new URL(server.url).origin;
	const base = `/api/projects/${server.projectId}`;
	async function http(
		path,
		{ method = "GET", body = {}, headers = {}, guarded = true } = {},
	) {
		const response = await fetch(`${origin}${path}`, {
			method,
			headers: {
				...(method !== "GET" && guarded
					? {
							"Content-Type": "application/json",
							Origin: origin,
							"Sec-Fetch-Site": "same-origin",
							"X-AW-CSRF": dashboardCsrf(server.token),
						}
					: {}),
				...headers,
			},
			...(method === "GET" ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, data: await response.json() };
	}
	return {
		...project,
		server,
		cwd,
		env,
		ctx: { cwd, env, host: "cli" },
		base,
		origin,
		http,
		effects,
		probeLog,
		advance: (ms) => {
			now += ms;
		},
		probeCount: async () =>
			existsSync(probeLog)
				? (await readFile(probeLog, "utf8")).trim().split("\n").length
				: 0,
	};
}
export async function persistManagementRun(
	cwd,
	id,
	status = "completed",
	extras = {},
) {
	const at = "2026-01-01T00:00:00.000Z";
	const dir = join(stateBase(cwd), ".agent-workflow/workflows", id);
	await mkdir(dir, { recursive: true });
	const run = {
		schemaVersion: 1,
		runId: id,
		name: "Management history",
		type: "artifact-graph",
		cwd,
		status,
		createdAt: at,
		updatedAt: at,
		specPath: "fixture.json",
		backend: { type: "local", mode: "headless" },
		tasks: [
			{
				taskId: "task-1",
				specId: "read.main",
				stageId: "read",
				displayName: "Read",
				kind: "single",
				agent: "reader",
				roles: [],
				status,
				statusDetail: status,
				backendTaskId: "",
				runtime: { approvalMode: "never" },
				agentFile: "",
				agentDescription: "reader",
				cwd,
				worktree: {
					enabled: false,
					path: null,
					branch: null,
					baseCwd: null,
					warning: null,
				},
				files: {
					output: "",
					stderr: "",
					systemPrompt: "",
					taskPrompt: "",
					result: "",
				},
			},
		],
		...extras,
	};
	await writeFile(join(dir, "run.json"), JSON.stringify(run));
	return { run, dir };
}
