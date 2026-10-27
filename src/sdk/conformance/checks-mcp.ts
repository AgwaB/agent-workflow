/**
 * MCP checks (R#9, prior-art §3 #8): injected stdio servers are reachable, secrets travel via env
 * (never argv), the declared MCP output limit matches what the CLI actually delivers, and (WP5b) a
 * page of the size the workflow_artifact server uses for that limit arrives whole.
 */
import { randomBytes } from "node:crypto";
import { artifactServerOutputLimit } from "../mcp-delivery.js";
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
		// A caller-injected server's tools may mutate: adapters refuse it on readOnly requests
		// (WP12d-2 review #6), so the injection checks run on a mutation-capable request.
		request: {
			prompt: mcpToolPrompt(nonce),
			mcpServers: [server.spec],
			readOnly: false,
		},
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
			// A CLI may wrap a cut result in its own notice (probe().mcpOutputNoticeChars).
			const notice = probe.mcpOutputNoticeChars ?? 0;
			if (delivered > limit + notice)
				run.violations.push(
					`delivered ${delivered} chars > declared mcpOutputLimitChars ${limit}${notice > 0 ? ` + mcpOutputNoticeChars ${notice}` : ""}: the declared limit is wrong`,
				);
			return body(run.violations, {
				limit,
				...(notice > 0 ? { notice } : {}),
				served,
				delivered,
			});
		},
	},
	{
		id: "mcp.paged_read",
		tier: "offline",
		area: "mcp",
		title:
			"A result of the artifact server's page size for probe() limits is delivered whole (paged reads deliver a large artifact completely)",
		refs: ["R#9", "WP5b"],
		scenarios: ["mcp_tool"],
		async run(ctx) {
			const session = await ctx.open("mcp_tool");
			const probe = await ctx.call(session.executor.probe(), "probe");
			// The core launches the workflow_artifact server with exactly this limit; every page it
			// serves (header + page + footer) fits it in UTF-16 chars and UTF-8 bytes, and pages tile
			// [0, totalChars). So if a response of this size arrives whole, every page does, and the
			// worker can read any artifact completely by paging. An ASCII response is the worst case
			// (chars = bytes = the limit).
			const pageLimit = artifactServerOutputLimit(probe);
			if (pageLimit === null)
				return ctx.skip(
					"probe reports no MCP output limit (the artifact server keeps its 8192-char default)",
				);
			const run = await mcpRun(ctx, pageLimit);
			const event = run.toolEvent;
			if (event?.type !== "tool_call")
				return ctx.skip(
					"no tool_call output to measure (toolTelemetry absent)",
				);
			const output = outputText(event.output) ?? "";
			// The stub's echo result: the nonce, a space and "x" padding up to `pageLimit` chars.
			const page = `${run.nonce} ${"x".repeat(pageLimit - run.nonce.length - 1)}`;
			const eventLimit = ctx.harness.toolOutputEventLimitChars;
			if (
				!output.includes(page) &&
				eventLimit !== undefined &&
				eventLimit < pageLimit &&
				output.startsWith(page.slice(0, eventLimit))
			)
				return ctx.skip(
					`the adapter's normalized tool_call.output keeps at most ${eventLimit} chars (< page size ${pageLimit}); the event view cannot prove page delivery — verify live`,
				);
			if (!output.includes(page))
				run.violations.push(
					`a ${pageLimit}-char result (the artifact server page size for mcpOutputLimitChars ${probe.mcpOutputLimitChars}) did not arrive whole (${output.length} chars delivered): paged artifact reads would be cut`,
				);
			return body(run.violations, {
				limit: probe.mcpOutputLimitChars ?? null,
				pageLimit,
				delivered: output.length,
			});
		},
	},
];
