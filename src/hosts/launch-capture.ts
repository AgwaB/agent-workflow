// New in agent-workflow (WP33 item 4, parity row 35): host-neutral launch capture. pi-workflow
// recorded launch provenance (`launch-command.txt` + `run.launch` v1/v2) only for its own Pi slash
// commands and tools; the host API now records it for every host: the CLI, the Pi host and the host
// MCP server. `source` is the host (`cli`, `pi`, `mcp:<host>`), `entry` how it was asked (a command
// line or a tool call), and the command text is human readable: the host's own command line
// (`agent-workflow run …`, `/aw run …`) or `<tool> <JSON arguments>`, synthesized from the request
// when a host passes none. Before it is written the text is redacted (the host redactor: tokens,
// keys, credential headers) and the user's home directory becomes `~`.
import { homedir } from "node:os";

import type {
	WorkflowHostId,
	WorkflowRunHostAutoSelectionMetadata,
	WorkflowRunLaunchCaptureHostV1,
	WorkflowRunLaunchCaptureHostV2,
	WorkflowRunLaunchHostSource,
} from "../core/types.js";
import { hostTextRedactor } from "./redaction.js";

/** How a host was asked to launch (the host passes it; absent → synthesized from the request). */
export type LaunchOrigin =
	/** The host's command line as typed, e.g. `agent-workflow run …` or `/aw run …`. */
	| { kind: "command"; text: string }
	/** A tool call: its name and arguments (rendered as `<name> <JSON>`). */
	| { kind: "tool"; name: string; arguments: Record<string, unknown> };

/** `cli` for the CLI (and callers without a host), `pi`, else `mcp:<host>` (host MCP server). */
export function launchHostSource(
	host: WorkflowHostId | undefined,
): WorkflowRunLaunchHostSource {
	if (host === undefined || host === "cli") return "cli";
	if (host === "pi") return "pi";
	return `mcp:${host}`;
}

const SAFE_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/u;

/** POSIX-shell-like quoting, for display only. */
function quoteArg(value: string): string {
	if (value !== "" && SAFE_ARG.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface CaptureRequest {
	workflow?: string;
	task: string;
	executor?: string;
	profile?: string;
	permissionMode?: string;
	allowUnverifiedCapabilities?: string[];
	model?: string;
	effort?: string;
	detach?: boolean;
	forceNew?: boolean;
	inputOverrides?: Record<string, unknown>;
}

/** The equivalent `agent-workflow` command line of a request (hosts that pass no origin). */
export function synthesizedLaunchCommand(
	action: "run" | "dynamic",
	request: CaptureRequest,
): string {
	const args = ["agent-workflow", action];
	if (action === "run" && request.workflow) args.push(request.workflow);
	args.push(request.task);
	if (request.executor) args.push("--executor", request.executor);
	if (request.profile) args.push("--profile", request.profile);
	if (request.permissionMode)
		args.push("--permission-mode", request.permissionMode);
	if (request.allowUnverifiedCapabilities?.length)
		args.push(
			"--allow-unverified",
			request.allowUnverifiedCapabilities.join(","),
		);
	if (request.model) args.push("--model", request.model);
	if (request.effort) args.push("--effort", request.effort);
	for (const [key, value] of Object.entries(request.inputOverrides ?? {}))
		args.push(
			"--input",
			`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
		);
	if (request.detach) args.push("--detach");
	if (request.forceNew) args.push("--force-new");
	return args.map(quoteArg).join(" ");
}

/** `argv` (without the node/bin prefix) as a display command line: `agent-workflow …`. */
export function cliLaunchCommand(argv: readonly string[]): string {
	return ["agent-workflow", ...argv].map(quoteArg).join(" ");
}

function homeDirectories(env: NodeJS.ProcessEnv): string[] {
	const homes = new Set<string>();
	for (const value of [env.HOME, env.USERPROFILE, safeHomedir()])
		if (typeof value === "string" && value.length > 1)
			homes.add(value.replace(/[\\/]+$/u, ""));
	// Longest first, so a nested home is replaced before its parent.
	return [...homes].sort((left, right) => right.length - left.length);
}

function safeHomedir(): string | undefined {
	try {
		return homedir();
	} catch {
		return undefined;
	}
}

/** Redact credentials and show the home directory as `~` (WP33: launch-command.txt). */
export function redactLaunchCommand(
	text: string,
	env: NodeJS.ProcessEnv,
): string {
	let out = text;
	for (const home of homeDirectories(env)) out = out.split(home).join("~");
	return hostTextRedactor(env)(out);
}

/**
 * The engine's launch capture of one host API launch (schema `agent-workflow-run-launch-v1`).
 * WP32: a confirmed `auto` launch passes its selection facts and gets `agent-workflow-run-launch-v2`
 * (entry `command auto` or the tool, routing mode `auto-confirmed`, `selection`).
 */
export function hostLaunchCapture(
	host: WorkflowHostId | undefined,
	env: NodeJS.ProcessEnv,
	action: "run" | "dynamic",
	request: CaptureRequest,
	origin: LaunchOrigin | undefined,
	autoSelection?: WorkflowRunHostAutoSelectionMetadata,
): WorkflowRunLaunchCaptureHostV1 | WorkflowRunLaunchCaptureHostV2 {
	if (autoSelection) {
		const text =
			origin?.kind === "command"
				? origin.text
				: origin?.kind === "tool"
					? `${origin.name} ${JSON.stringify(origin.arguments)}`
					: ["agent-workflow", "auto", request.task].map(quoteArg).join(" ");
		return {
			schema: "agent-workflow-run-launch-v2",
			source: launchHostSource(host),
			entry:
				origin?.kind === "tool"
					? { kind: "tool", name: origin.name }
					: { kind: "command", action: "auto" },
			requestKind: action === "run" ? "named-workflow" : "direct-dynamic",
			routingMode: "auto-confirmed",
			profile: action === "run" ? { kind: "base" } : { kind: "not-applicable" },
			task: { characters: 0, lines: 0 },
			selection: autoSelection,
			command: { state: "captured", text: redactLaunchCommand(text, env) },
		};
	}
	const text =
		origin?.kind === "command"
			? origin.text
			: origin?.kind === "tool"
				? `${origin.name} ${JSON.stringify(origin.arguments)}`
				: synthesizedLaunchCommand(action, request);
	return {
		schema: "agent-workflow-run-launch-v1",
		source: launchHostSource(host),
		entry:
			origin?.kind === "tool"
				? { kind: "tool", name: origin.name }
				: { kind: "command", action },
		requestKind: action === "run" ? "named-workflow" : "direct-dynamic",
		routingMode: "off",
		// Normalized by the engine (the applied profile, the task size).
		profile: action === "run" ? { kind: "base" } : { kind: "not-applicable" },
		task: { characters: 0, lines: 0 },
		command: { state: "captured", text: redactLaunchCommand(text, env) },
	};
}
