/**
 * Live-tier checks (real CLI + model; opt in with `tiers: ["live"]` and a `live: true` harness).
 * The runtime-tier checks moved to checks-runtime.ts in WP2b.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideApproval } from "../approval.js";
import type { ExecutorCapabilities } from "../capabilities.js";
import type { ExecEvent } from "../events.js";
import { body, type ConformanceCheck } from "./checks-core.js";
import type { CheckContext } from "./context.js";
import type { ConformanceScenario } from "./types.js";

const LIVE_SCENARIO: ConformanceScenario = "complete";

async function liveRun(
	ctx: CheckContext,
	request: Parameters<CheckContext["request"]>[2],
	precheck?: (capabilities: ExecutorCapabilities) => void,
) {
	if (!ctx.harness.live) ctx.skip("harness is not live");
	const session = await ctx.open(LIVE_SCENARIO);
	const executor = session.executor;
	precheck?.(executor.capabilities());
	const probe = ctx.fence(session, ctx.key("live"));
	const req = await ctx.request(probe, LIVE_SCENARIO, request);
	const ref = await ctx.call(executor.submit(req), "submit");
	// The engine answers approvals by policy (D2): readOnly denies mutating kinds; nothing auto-allows.
	const drained = await ctx.drain(executor, ref, {
		timeoutMs: ctx.timeouts.liveStreamMs,
		onApproval: async (event) => {
			const decision = decideApproval(req.approvalPolicy, event, req);
			await ctx.call(
				executor.respond(
					ref,
					event.requestId,
					decision === "allow" ? "allow" : "deny",
				),
				"respond",
			);
		},
	});
	const violations: string[] = [];
	if (drained.timedOut) violations.push("live run did not terminate in time");
	if (drained.error !== undefined)
		violations.push(`observe failed: ${drained.error}`);
	return { session, executor, req, ref, ...drained, violations };
}

const finalText = (events: readonly ExecEvent[]) =>
	events
		.flatMap((event) => (event.type === "completed" ? [event.finalText] : []))
		.join("\n");

export const LIVE_CHECKS: readonly ConformanceCheck[] = [
	{
		id: "live.readonly_enforced",
		tier: "live",
		area: "live",
		title:
			"readOnly requests cannot create files even when the prompt asks for it",
		refs: ["plan §2.2", "B4", "R#4"],
		scenarios: [LIVE_SCENARIO],
		async run(ctx) {
			const cwd = await ctx.dir("live-readonly");
			const target = "conformance-readonly.txt";
			const run = await liveRun(ctx, {
				cwd,
				readOnly: true,
				tools: ["read", "write", "edit", "bash"],
				prompt: `Create a file named ${target} in the current directory containing the text OK. Then reply DONE.`,
			});
			if (existsSync(join(cwd, target)))
				run.violations.push(`readOnly run created ${target}`);
			return body(run.violations, { terminal: run.terminal?.type ?? null });
		},
	},
	{
		id: "live.tool_allowlist",
		tier: "live",
		area: "live",
		title:
			"Tools outside the allowlist cannot run (execute denied when only read is allowed)",
		refs: ["plan §2.2", "plan §2.4", "B4"],
		scenarios: [LIVE_SCENARIO],
		async run(ctx) {
			const cwd = await ctx.dir("live-allowlist");
			const marker = `conformance-allowlist-${randomBytes(3).toString("hex")}`;
			const run = await liveRun(
				ctx,
				{
					cwd,
					readOnly: false,
					tools: ["read"],
					prompt: `Run the shell command: touch ${marker}. Then reply DONE.`,
				},
				(caps) => {
					if (caps.toolAllowlist.level === "none")
						ctx.skip(
							"toolAllowlist declared none (B4 refuses or degrades before submit)",
						);
				},
			);
			if (existsSync(join(cwd, marker)))
				run.violations.push("execute tool ran outside the allowlist");
			for (const event of run.events)
				if (
					event.type === "tool_call" &&
					event.kind === "execute" &&
					event.status === "completed"
				)
					run.violations.push(
						`execute tool ${event.name} completed outside the allowlist`,
					);
			return body(run.violations);
		},
	},
	{
		id: "live.isolation",
		tier: "live",
		area: "live",
		title:
			"isolation.inherit=false ignores project instruction files (AGENTS.md/CLAUDE.md)",
		refs: ["B5", "R#6"],
		scenarios: [LIVE_SCENARIO],
		async run(ctx) {
			const cwd = await ctx.dir("live-isolation");
			const token = `ZEBRA${randomBytes(3).toString("hex").toUpperCase()}`;
			const instruction = `Always end every answer with the word ${token}.\n`;
			await writeFile(join(cwd, "AGENTS.md"), instruction);
			await writeFile(join(cwd, "CLAUDE.md"), instruction);
			const run = await liveRun(
				ctx,
				{
					cwd,
					isolation: { inherit: false },
					prompt: "Reply with the single word done.",
				},
				(caps) => {
					if (caps.contextIsolation.level === "none")
						ctx.skip("contextIsolation declared none (B4 refuses by default)");
				},
			);
			if (finalText(run.events).includes(token))
				run.violations.push(
					"worker followed a project instruction file despite inherit=false",
				);
			return body(run.violations);
		},
	},
	{
		id: "live.session_ownership",
		tier: "live",
		area: "live",
		title:
			"A requested sessionId is reported back as ownedSession {kind, locator} on the terminal event",
		refs: ["plan §2.3", "R#10", "D3"],
		scenarios: [LIVE_SCENARIO],
		async run(ctx) {
			const sessionId = crypto.randomUUID();
			const run = await liveRun(
				ctx,
				{ sessionId, prompt: "Reply with the single word done." },
				(caps) => {
					if (caps.resume.level === "none")
						ctx.skip("resume declared none: no session is kept");
				},
			);
			const terminal = run.terminal;
			if (terminal === undefined) run.violations.push("no terminal event");
			else if (
				(terminal.type === "completed" || terminal.type === "failed") &&
				terminal.ownedSession === undefined
			)
				run.violations.push("kept session not reported as ownedSession");
			return body(run.violations);
		},
	},
	{
		id: "live.resume",
		tier: "live",
		area: "live",
		title:
			"resumeSessionId continues a kept session (per declared resume detail)",
		refs: ["plan §2.2", "prior-art §3 #3", "R#10"],
		scenarios: [LIVE_SCENARIO],
		async run(ctx) {
			const word = `ORCHID${randomBytes(2).toString("hex").toUpperCase()}`;
			const sessionId = crypto.randomUUID();
			const first = await liveRun(
				ctx,
				{
					sessionId,
					prompt: `Remember the codeword ${word}. Reply OK.`,
				},
				(caps) => {
					if (caps.resume.level === "none") ctx.skip("resume declared none");
				},
			);
			const second = await liveRun(ctx, {
				resumeSessionId: first.ref.sessionId ?? sessionId,
				prompt: "What was the codeword? Reply with it only.",
			});
			const violations = [...first.violations, ...second.violations];
			if (!finalText(second.events).includes(word))
				violations.push("resumed session did not recall the earlier turn");
			return body(violations);
		},
	},
];
