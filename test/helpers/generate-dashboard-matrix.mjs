// Manual fixture refresh, not a test: npm run build && node test/helpers/generate-dashboard-matrix.mjs [absolute-capture-dir] [comma-separated-shapes]
// Only test-matrix is selected. Every run/server lives in a temporary project and is stopped/removed.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { hostApiDashboardSource } from "../../dist/hosts/dashboard/source.js";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
import { createBrowser, findChrome } from "./dashboard-browser.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url)),
	out = join(repo, "test/fixtures/dashboard/matrix");
const reports = process.argv[2];
const selected = process.argv[3]?.split(",");
await mkdir(out, { recursive: true });
if (reports) await mkdir(reports, { recursive: true });
const root = await mkdtemp("/tmp/aw-uimatrix-");
const env = {
	...process.env,
	AGENT_WORKFLOW_HOME: join(root, "home"),
	AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
	AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: fileURLToPath(
		new URL("./dashboard-matrix-executor.mjs", import.meta.url),
	),
	AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
	AGENT_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS: "0",
	AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS: "8",
};
const cli = (cwd, args) => {
	const result = spawnSync(
		"node",
		[join(repo, "src/hosts/cli/cli.mjs"), ...args],
		{ cwd, env, encoding: "utf8", timeout: 30000 },
	);
	if (result.status !== 0) throw new Error(result.stdout + result.stderr);
	return result.stdout;
};
const single = (id, extra = {}) => ({
	id,
	type: "single",
	prompt: "MATRIX-WORK",
	...extra,
});
const shapes = [
	["single", [single("very-long-" + "very-long-stage-title-".repeat(7))]],
	[
		"linear",
		[
			single("collect"),
			single("review", { after: ["collect"] }),
			single("verify", { after: ["review"] }),
			single("report", { after: ["verify"] }),
		],
	],
	[
		"parallel",
		[
			single("plan"),
			...["alpha", "beta", "gamma"].map((id) =>
				single(id, { after: ["plan"] }),
			),
			single("join", { after: ["alpha", "beta", "gamma"] }),
		],
	],
	...[3, 18, 60].map((n) => [
		`foreach-${n}`,
		[
			single("plan", { prompt: `MATRIX-ITEMS=${n}` }),
			{
				id: "check-claims",
				type: "foreach",
				after: ["plan"],
				from: { source: "plan", path: "$.items" },
				each: { itemIdentityPath: "$.id", prompt: "MATRIX-CHECK ${item}" },
			},
			single("report", { after: ["check-claims"] }),
		],
	]),
	[
		"mixed",
		[
			single("plan", { prompt: "MATRIX-ITEMS=3" }),
			{
				id: "check-claims",
				type: "foreach",
				after: ["plan"],
				from: { source: "plan", path: "$.items" },
				each: {
					itemIdentityPath: "$.id",
					prompt: "MATRIX-MIXED MATRIX-FAIL ${item}",
				},
			},
		],
	],
	[
		"dynamic",
		[
			single("prep"),
			{
				id: "adaptive",
				type: "dynamic",
				after: ["prep"],
				dynamic: {
					uses: "./controller.mjs",
					permissions: {
						approval: "auto",
						allowDynamicRoles: true,
						allowDynamicTools: true,
					},
				},
			},
			single("report", { after: ["adaptive"] }),
		],
	],
	[
		"approval",
		[
			single("prep"),
			{
				id: "adaptive",
				type: "dynamic",
				after: ["prep"],
				dynamic: {
					uses: "./controller.mjs",
					permissions: {
						approval: "ask",
						allowDynamicRoles: true,
						allowDynamicTools: true,
					},
				},
			},
		],
	],
	[
		"loop",
		[
			{
				id: "iterate",
				type: "loop",
				maxRounds: 2,
				until: { stage: "check", path: "$.status", equals: "verified" },
				stages: [single("work"), single("check")],
			},
			single("report", { after: ["iterate"] }),
		],
	],
	[
		"support",
		[
			single("prep"),
			{ id: "normalize", after: ["prep"], support: { uses: "./support.mjs" } },
			single("report", { after: ["normalize"] }),
		],
	],
	[
		"stop-resume",
		[
			single("prep"),
			single("slow", { after: ["prep"], prompt: "MATRIX-SLOW" }),
			single("report", { after: ["slow"] }),
		],
	],
	["needs-decision", [single("crash", { prompt: "MATRIX-CRASH" })]],
	["failed", [single("failure", { prompt: "MATRIX-FAIL" })]],
];
const manifest = [];
const active = [];
let browser;
let server;
function sanitize(run, name, state) {
	const old = run.runId,
		id = `workflow_matrix_${name.replaceAll("-", "_")}_${state.replaceAll("-", "_")}`;
	const base =
		Date.parse("2026-10-29T08:09:55.000Z") - Date.parse(run.updatedAt);
	const visit = (value) =>
		typeof value === "string"
			? /^\d{4}-\d\d-\d\dT/.test(value)
				? new Date(Date.parse(value) + base).toISOString()
				: value
						.replaceAll(old, id)
						.replaceAll(root, "/tmp/dashboard-matrix")
						.replaceAll(repo, "/repo/agent-workflow")
			: Array.isArray(value)
				? value.map(visit)
				: value && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value).map(([k, v]) => [k, visit(v)]),
						)
					: value;
	return { ...visit(run), runId: id };
}
try {
	for (const [name, stages] of shapes.filter(
		([name]) => !selected || selected.includes(name),
	)) {
		const cwd = join(root, name);
		await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
		await writeFile(
			join(cwd, ".agent-workflow/agents/reader.md"),
			"---\nname: reader\ndescription: local fixture\ntools: read\n---\nRead and report.\n",
		);
		await writeFile(
			join(cwd, "wf.json"),
			JSON.stringify({
				schemaVersion: 1,
				name:
					name === "single"
						? "검증 — " + "Long dashboard workflow name ".repeat(10)
						: `matrix-${name}`,
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: { stages },
			}),
		);
		await writeFile(
			join(cwd, "controller.mjs"),
			`export default async function(ctx) { await ctx.parallel([()=>ctx.agent({id:'one',agent:'reader',tools:['read'],prompt:'MATRIX-WORK'}),()=>ctx.agent({id:'two',agent:'reader',tools:['read'],prompt:'MATRIX-WORK'})]); return {control:{schema:'dynamic-controller-result-v1',digest:'Generated agents finished'},analysis:'done',refs:[]}; }`,
		);
		await writeFile(
			join(cwd, "support.mjs"),
			`export default async function() { await new Promise(r=>setTimeout(r,1200));return {control:{schema:'stage-control-v1',digest:'Support normalized evidence'},analysis:'done',refs:[]}; }`,
		);
		let runId;
		try {
			runId = /(workflow_[a-z0-9_]+)/.exec(
				cli(cwd, [
					"run",
					"wf.json",
					"검증 UI matrix — local test only",
					"--executor",
					"test-matrix",
					"--detach",
				]),
			)?.[1];
			if (!runId) throw Error("No run id");
		} catch (e) {
			console.log(name, "LAUNCH ERROR", e.message);
			manifest.push({ name, error: e.message });
			continue;
		}
		active.push({ cwd, runId });
		const source = hostApiDashboardSource({ cwd, host: "cli", env });
		const save = async (run, state) => {
			const file = `${name}-${state}.json`;
			await writeFile(
				join(out, file),
				JSON.stringify(sanitize(run, name, state), null, "\t") + "\n",
			);
			manifest.push({
				name,
				state,
				file,
				status: run.status,
				tasks: run.tasks.length,
			});
			console.log(name, state, run.status, run.tasks.length);
			if (name === "single") {
				const variant = sanitize(run, "long-text", state);
				variant.name = "UnbrokenWorkflowName".repeat(14);
				if (state === "finished")
					variant.summary = "UnbrokenSummaryEvidence".repeat(30);
				if (state === "running")
					variant.tasks[0].activity = {
						kind: "read",
						label: "아주긴활동이름".repeat(22) + "UnbrokenPath".repeat(25),
						at: variant.updatedAt,
					};
				const derived = `long-text-${state}.json`;
				await writeFile(
					join(out, derived),
					JSON.stringify(variant, null, "\t") + "\n",
				);
				manifest.push({
					name: "long-text",
					state,
					file: derived,
					derivedFrom: file,
				});
			}
		};
		let saved = false,
			retrySaved = false,
			stopped = false,
			resumed = false,
			resumedSaved = false,
			done = false;
		const deadline = Date.now() + 180000;
		if (reports && name === "foreach-18") {
			server = await startDashboardServer({ cwd, env, source, readonly: true });
			browser = await createBrowser(await findChrome());
			await browser.open(`${server.url}&run=${runId}&stage=check-claims`);
			await mkdir(join(reports, "live-8fps"), { recursive: true });
		}
		let frame = 0;
		const times = [];
		let latest,
			polling = false;
		while (Date.now() < deadline) {
			const t0 = Date.now();
			const run = browser
				? (latest ?? (await source.run(runId)))
				: await source.run(runId);
			if (browser && !polling) {
				polling = true;
				source
					.run(runId)
					.then((value) => {
						latest = value;
					})
					.finally(() => {
						polling = false;
					});
			}
			if (!run) {
				await delay(100);
				continue;
			}
			const items = run.tasks.filter(
				(t) => t.kind === "foreach" && !t.placeholder,
			);
			const ready = /foreach|mixed/.test(name)
				? items.some((t) => t.status === "running")
				: name === "parallel"
					? run.tasks.some(
							(t) =>
								["alpha", "beta", "gamma"].includes(t.stageId) &&
								t.status === "running",
						)
					: name === "dynamic"
						? run.tasks.some((t) => t.generated && t.status === "running")
						: name === "support"
							? run.tasks.some(
									(t) => t.kind === "support" && t.status === "running",
								)
							: run.tasks.some((t) => t.status === "running");
			if (!saved && ready) {
				await save(run, "running");
				saved = true;
			}
			if (
				name === "mixed" &&
				!retrySaved &&
				run.tasks.some((t) => t.retry && t.status !== "completed")
			) {
				await save(run, "retry");
				retrySaved = true;
			}
			if (
				name === "stop-resume" &&
				!stopped &&
				run.tasks.some((t) => t.stageId === "slow" && t.status === "running")
			) {
				cli(cwd, ["stop", runId]);
				stopped = true;
			}
			if (stopped && !resumed && run.status === "interrupted") {
				await save(run, "stopped");
				cli(cwd, ["resume", runId, "--detach"]);
				resumed = true;
			}
			if (resumed && !resumedSaved && run.status === "running") {
				await save(run, "resumed");
				resumedSaved = true;
			}
			if (browser) {
				times.push(Date.now());
				const shot = await browser.send("Page.captureScreenshot", {
					format: "jpeg",
					quality: 65,
				});
				await writeFile(
					join(
						reports,
						"live-8fps",
						`f${String(frame++).padStart(4, "0")}.jpg`,
					),
					Buffer.from(shot.data, "base64"),
				);
			}
			if (
				["completed", "failed", "blocked"].includes(run.status) ||
				(run.status === "interrupted" && name !== "stop-resume")
			) {
				await save(run, run.status === "completed" ? "finished" : run.status);
				done = true;
				break;
			}
			await delay(Math.max(0, (browser ? 70 : 200) - (Date.now() - t0)));
		}
		if (browser) {
			await writeFile(
				join(reports, "live-8fps", "timing.json"),
				JSON.stringify(times),
			);
			console.log(
				"frames",
				frame,
				"fps",
				((times.length - 1) * 1000) / (times.at(-1) - times[0]),
				"errors",
				browser.errors,
			);
			await browser.close();
			browser = undefined;
			await server.close();
			server = undefined;
		}
		if (!done) {
			console.log(name, "TIMEOUT");
			manifest.push({ name, error: "Timed out" });
		}
	}
} finally {
	await browser?.close();
	await server?.close();
	for (const { cwd, runId } of active)
		try {
			cli(cwd, ["stop", runId]);
		} catch {}
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 200,
	});
	await writeFile(
		join(out, "manifest.json"),
		JSON.stringify(manifest, null, "\t") + "\n",
	);
	if (manifest.some((entry) => entry.error)) process.exitCode = 1;
}
