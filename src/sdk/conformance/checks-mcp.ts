/**
 * MCP checks (R#9, prior-art §3 #8): injected stdio servers are reachable, secrets travel via env
 * (never argv), and the declared MCP output limit matches what the CLI actually delivers.
 */
import { randomBytes } from "node:crypto";
import { body, type ConformanceCheck, runScenario } from "./checks-core.js";
import type { CheckContext } from "./context.js";
import { createStubMcpServer, STUB_MCP_SERVER_NAME } from "./stub-mcp.js";

export const MCP_SECRET_ENV = "AW_CONFORMANCE_MCP_TOKEN";

/** Prompt marker the `mcp_tool` scenario echoes through the stub server's `echo` tool. */
export const MCP_NONCE_PATTERN = /conformance-nonce:([A-Za-z0-9-]+)/;

export function mcpToolPrompt(nonce: string): string {
	return `Call the "echo" tool of the MCP server "${STUB_MCP_SERVER_NAME}" with text "${nonce}" and reply with its result. conformance-nonce:${nonce}`;
}

const outputText = (output: unknown) =>
	output === undefined
		? undefined
		: typeof output === "string"
			? output
			: JSON.stringify(output);

async function mcpRun(ctx: CheckContext, padChars = 0) {
	const session = await ctx.open("mcp_tool");
	if (session.executor.capabilities().mcpInjection.level === "none")
		ctx.skip("mcpInjection declared none");
	const nonce = `n${randomBytes(4).toString("hex")}`;
	const secret = randomBytes(12).toString("hex");
	const server = await createStubMcpServer({
		dir: await ctx.dir("mcp"),
		padChars,
		env: { [MCP_SECRET_ENV]: secret },
	});
	const run = await runScenario(ctx, "mcp_tool", {
		session,
		request: { prompt: mcpToolPrompt(nonce), mcpServers: [server.spec] },
	});
	const violations: string[] = [];
	if (run.timedOut) violations.push("mcp_tool run did not terminate in time");
	if (run.error !== undefined) violations.push(`observe failed: ${run.error}`);
	const toolEvent = run.events.find(
		(event) =>
			event.type === "tool_call" &&
			event.status === "completed" &&
			outputText(event.output)?.includes(nonce) === true,
	);
	return { ...run, server, nonce, secret, toolEvent, violations };
}

export const MCP_CHECKS: readonly ConformanceCheck[] = [
	{
		id: "mcp.injection",
		tier: "offline",
		area: "mcp",
		title:
			"Injected stdio MCP server is started with its env and its tool result reaches the run",
		refs: ["plan §2.1", "R#9", "WP5"],
		scenarios: ["mcp_tool"],
		async run(ctx) {
			const run = await mcpRun(ctx);
			const log = await run.server.log();
			const starts = log.filter((entry) => entry.type === "start");
			if (starts.length === 0)
				run.violations.push("injected MCP server was never started");
			if (starts.some((entry) => !entry.envKeys.includes(MCP_SECRET_ENV)))
				run.violations.push(
					`MCP server started without its env ${MCP_SECRET_ENV}`,
				);
			const calls = await run.server.toolCalls();
			const echoed = calls.some(
				(call) =>
					call.name === "echo" &&
					JSON.stringify(call.arguments).includes(run.nonce),
			);
			if (!echoed)
				run.violations.push("MCP server received no echo call with the nonce");
			const telemetry = run.executor.capabilities().toolTelemetry.level;
			if (telemetry !== "none" && run.toolEvent === undefined)
				run.violations.push(
					"toolTelemetry declared but no completed tool_call carries the MCP result",
				);
			return body(run.violations, {
				starts: starts.length,
				calls: calls.length,
			});
		},
	},
	{
		id: "mcp.argv_no_secrets",
		tier: "offline",
		area: "mcp",
		title:
			"MCP env secrets never appear on any argv (CLI launch or MCP server)",
		refs: ["prior-art §3 #8", "prior-art §5"],
		scenarios: ["mcp_tool"],
		async run(ctx) {
			const run = await mcpRun(ctx);
			const argvs: (readonly string[])[] = [];
			for (const entry of await run.server.log())
				if (entry.type === "start") argvs.push(entry.argv);
			const launches = (await run.session.launches?.(run.req.attemptKey)) ?? [];
			for (const launch of launches) argvs.push(launch.argv);
			if (argvs.length === 0)
				ctx.skip("no argv evidence (no MCP start, no launch records)");
			argvs.forEach((argv, index) => {
				if (argv.some((arg) => arg.includes(run.secret)))
					run.violations.push(`argv #${index} contains the MCP env secret`);
			});
			return body(run.violations, {
				argvChecked: argvs.length,
				launches: launches.length,
			});
		},
	},
	{
		id: "mcp.delivery_bound",
		tier: "offline",
		area: "mcp",
		title:
			"Results above probe().mcpOutputLimitChars are not delivered beyond the declared limit",
		refs: ["R#9", "WP5"],
		scenarios: ["mcp_tool"],
		async run(ctx) {
			const session = await ctx.open("mcp_tool");
			const probe = await ctx.call(session.executor.probe(), "probe");
			const limit = probe.mcpOutputLimitChars;
			if (typeof limit !== "number" || limit <= 0)
				return ctx.skip(
					"probe reports no MCP output limit (artifact server must record deliveryUnverified)",
				);
			const served = limit * 2;
			const run = await mcpRun(ctx, served);
			const event = run.toolEvent;
			if (event?.type !== "tool_call")
				return ctx.skip(
					"no tool_call output to measure (toolTelemetry absent)",
				);
			const delivered = outputText(event.output)?.length ?? 0;
			if (delivered > limit)
				run.violations.push(
					`delivered ${delivered} chars > declared mcpOutputLimitChars ${limit}: the declared limit is wrong`,
				);
			return body(run.violations, { limit, served, delivered });
		},
	},
];
