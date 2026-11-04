// Argument handling shared by the terminal CLI (`agent-workflow <command>`) and the Pi `/aw` command
// (refactor 2026-11-04: both had their own copy of each request builder). A command line becomes the
// same host API request on both; only the usage prefix and the CLI's `--json` flag differ
// (CommandSyntax). Host-specific flows (waiting, dialogs, the Pi board and profile picker, the
// dashboard) stay in each dispatcher.
import { parseRoleAssignmentText } from "../core/role-profiles.js";
import {
	HostUsageError,
	type LogsRequest,
	parseCapabilityList,
	parsePermissionMode,
	parseThinkingLevel,
	type ProfileRequest,
	type WorkflowPreferenceRequest,
} from "./api.js";

export interface OptionSpec {
	/** Boolean flags. */
	flags?: readonly string[];
	/** Options taking one value. */
	values?: readonly string[];
	/** Options taking one value that may be given more than once (WP12a: `--input`). */
	repeatable?: readonly string[];
	/** Option aliases → canonical name. */
	aliases?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
	positionals: string[];
	flags: Set<string>;
	values: Map<string, string>;
	lists: Map<string, string[]>;
}

/** How a host writes its commands: usage prefix and flags every command accepts. */
export interface CommandSyntax {
	/** Put before a usage text: "" (CLI) or "/aw " (Pi). */
	usagePrefix: string;
	/** Flags every command accepts (CLI: `--json`). */
	commonFlags: readonly string[];
}

export const CLI_SYNTAX: CommandSyntax = {
	usagePrefix: "",
	commonFlags: ["--json"],
};

/** Strict argv parser: `--name value`, `--name=value`, `--` ends options, duplicates rejected. */
export function parseCommandArgs(
	argv: readonly string[],
	spec: OptionSpec,
): ParsedArgs {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const positionals: string[] = [];
	const known = new Set([
		...(spec.flags ?? []),
		...(spec.values ?? []),
		...(spec.repeatable ?? []),
	]);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--") || arg === "--") {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		let name = eq < 0 ? arg : arg.slice(0, eq);
		name = spec.aliases?.[name] ?? name;
		if (!known.has(name))
			throw new HostUsageError(`Unknown option ${arg.split("=")[0]}`);
		if (spec.flags?.includes(name)) {
			if (eq >= 0) throw new HostUsageError(`${name} takes no value`);
			if (flags.has(name)) throw new HostUsageError(`Duplicate option ${name}`);
			flags.add(name);
			continue;
		}
		const value = eq >= 0 ? arg.slice(eq + 1) : argv[++index];
		if (
			value === undefined ||
			value === "" ||
			(eq < 0 && value.startsWith("--"))
		)
			throw new HostUsageError(`${name} requires a value`);
		if (spec.repeatable?.includes(name)) {
			lists.set(name, [...(lists.get(name) ?? []), value]);
			continue;
		}
		if (values.has(name)) throw new HostUsageError(`Duplicate option ${name}`);
		values.set(name, value);
	}
	return { positionals, flags, values, lists };
}

export function intValue(
	raw: string | undefined,
	option: string,
): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
		throw new HostUsageError(`${option} requires a non-negative integer`);
	return Number(raw);
}

export function usageError(
	syntax: CommandSyntax,
	usage: string,
): HostUsageError {
	return new HostUsageError(`Usage: ${syntax.usagePrefix}${usage}`);
}

/** Exactly `count` positionals, else the command's usage. */
export function onlyPositionals(
	parsed: ParsedArgs,
	count: number,
	usage: string,
	syntax: CommandSyntax,
): string[] {
	if (parsed.positionals.length !== count) throw usageError(syntax, usage);
	return parsed.positionals;
}

/** `spec` plus the flags every command of this host accepts. */
function withCommonFlags(syntax: CommandSyntax, spec: OptionSpec): OptionSpec {
	return syntax.commonFlags.length === 0
		? spec
		: { ...spec, flags: [...syntax.commonFlags, ...(spec.flags ?? [])] };
}

function parse(
	argv: readonly string[],
	syntax: CommandSyntax,
	spec: OptionSpec = {},
): ParsedArgs {
	return parseCommandArgs(argv, withCommonFlags(syntax, spec));
}

/** `list [--query <text>] [--offset N] [--limit N]` */
export function listRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): { query?: string; offset?: number; limit?: number } {
	const parsed = parse(argv, syntax, {
		values: ["--query", "--offset", "--limit"],
	});
	onlyPositionals(
		parsed,
		0,
		"list [--query <text>] [--offset N] [--limit N]",
		syntax,
	);
	const offset = intValue(parsed.values.get("--offset"), "--offset");
	const limit = intValue(parsed.values.get("--limit"), "--limit");
	return {
		...(parsed.values.has("--query")
			? { query: parsed.values.get("--query")! }
			: {}),
		...(offset === undefined ? {} : { offset }),
		...(limit === undefined ? {} : { limit }),
	};
}

/** `validate|roles <workflow-name-or-path>` */
export function workflowRefRequest(
	command: string,
	argv: readonly string[],
	syntax: CommandSyntax,
): { workflow: string } {
	const [workflow] = onlyPositionals(
		parse(argv, syntax),
		1,
		`${command} <workflow-name-or-path>`,
		syntax,
	);
	return { workflow: workflow! };
}

/** `agents` (no arguments) */
export function agentsRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): void {
	onlyPositionals(parse(argv, syntax), 0, "agents", syntax);
}

/** `status [<run-id-or-prefix>]` */
export function statusRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): { runId?: string } {
	const { positionals } = parse(argv, syntax);
	if (positionals.length > 1)
		throw usageError(syntax, "status [<run-id-or-prefix>]");
	return positionals[0] ? { runId: positionals[0] } : {};
}

/** `show <run-id-or-workflow> [--raw]` */
export function showRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): { ref: string; raw?: true } {
	const parsed = parse(argv, syntax, { flags: ["--raw"] });
	const [ref] = onlyPositionals(
		parsed,
		1,
		"show <run-id-or-workflow> [--raw]",
		syntax,
	);
	return { ref: ref!, ...(parsed.flags.has("--raw") ? { raw: true } : {}) };
}

/** `inspect <run-id-or-prefix> [--failures] [--results]` */
export function inspectRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): { runId: string; failures: boolean; results: boolean } {
	const parsed = parse(argv, syntax, { flags: ["--failures", "--results"] });
	const [runId] = onlyPositionals(
		parsed,
		1,
		"inspect <run-id-or-prefix>",
		syntax,
	);
	return {
		runId: runId!,
		failures: parsed.flags.has("--failures"),
		results: parsed.flags.has("--results"),
	};
}

/** `logs` options shared by the CLI and `/aw logs`. */
export function logsRequest(
	runId: string,
	values: ReadonlyMap<string, string>,
): LogsRequest {
	const lines = intValue(values.get("--lines"), "--lines");
	const stream = values.get("--stream");
	return {
		runId,
		...(values.has("--task") ? { task: values.get("--task")! } : {}),
		...(lines === undefined ? {} : { lines }),
		...(stream === undefined
			? {}
			: { stream: stream as NonNullable<LogsRequest["stream"]> }),
	};
}

/** `logs <run-id-or-prefix> [--task <id>] [--lines N] [--stream …]` */
export function logsCommandRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): LogsRequest {
	const parsed = parse(argv, syntax, {
		values: ["--task", "--lines", "--stream"],
	});
	const [runId] = onlyPositionals(
		parsed,
		1,
		"logs <run-id-or-prefix> [--task <id>] [--lines N] [--stream output|stderr|events|all]",
		syntax,
	);
	return logsRequest(runId!, parsed.values);
}

/** `stop <run-id-or-prefix>` */
export function stopRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): { runId: string } {
	const [runId] = onlyPositionals(
		parse(argv, syntax),
		1,
		"stop <run-id-or-prefix>",
		syntax,
	);
	return { runId: runId! };
}

/** WP31: `--role` values → a role map (each `<role>=<executor>[:<model>[:<effort>]]`). */
export function parseRoleFlags(
	values: readonly string[] | undefined,
): Record<string, unknown> | undefined {
	if (values === undefined || values.length === 0) return undefined;
	const roles: Record<string, unknown> = {};
	for (const value of values) {
		let parsed: ReturnType<typeof parseRoleAssignmentText>;
		try {
			parsed = parseRoleAssignmentText(value, "--role");
		} catch (error) {
			throw new HostUsageError(
				error instanceof Error ? error.message : String(error),
			);
		}
		if (Object.hasOwn(roles, parsed[0]))
			throw new HostUsageError(`--role ${parsed[0]} is given twice`);
		roles[parsed[0]] = parsed[1];
	}
	return roles;
}

export const WORKFLOW_PREFERENCE_USAGE =
	"profile workflow list | show <workflow> | set <workflow> [--profile <name>] [--role <role>=<executor>[:<model>[:<effort>]]]... [--unset profile,roles,roles.<role>] | clear <workflow>";

/** WP31: `profile workflow …` → a per-workflow preference request (CLI wording on both hosts). */
export function workflowPreferenceRequest(
	argv: readonly string[],
): WorkflowPreferenceRequest {
	const syntax = CLI_SYNTAX;
	const [op = "list", ...rest] = argv;
	if (op === "list") {
		onlyPositionals(parse(rest, syntax), 0, WORKFLOW_PREFERENCE_USAGE, syntax);
		return { op: "list" };
	}
	if (op === "show" || op === "clear") {
		const [workflow] = onlyPositionals(
			parse(rest, syntax),
			1,
			WORKFLOW_PREFERENCE_USAGE,
			syntax,
		);
		return { op, workflow: workflow! };
	}
	if (op === "set") {
		const parsed = parse(rest, syntax, {
			values: ["--profile", "--unset"],
			repeatable: ["--role"],
		});
		const [workflow] = onlyPositionals(
			parsed,
			1,
			WORKFLOW_PREFERENCE_USAGE,
			syntax,
		);
		const roles = parseRoleFlags(parsed.lists.get("--role"));
		const unset = parsed.values
			.get("--unset")
			?.split(",")
			.map((field) => field.trim())
			.filter(Boolean);
		return {
			op: "set",
			workflow: workflow!,
			...(parsed.values.has("--profile")
				? { profile: parsed.values.get("--profile")! }
				: {}),
			...(roles ? { roles } : {}),
			...(unset ? { unset } : {}),
		};
	}
	throw usageError(syntax, WORKFLOW_PREFERENCE_USAGE);
}

/** `profile list|show|set|presets|delete|default …` (`profile workflow …`: workflowPreferenceRequest). */
export function profileRequest(
	argv: readonly string[],
	syntax: CommandSyntax,
): ProfileRequest {
	const [op = "list", ...rest] = argv;
	if (op === "list") {
		onlyPositionals(parse(rest, syntax), 0, "profile list", syntax);
		return { op: "list" };
	}
	if (op === "show") {
		const { positionals } = parse(rest, syntax);
		if (positionals.length > 1)
			throw usageError(syntax, "profile show [<name>]");
		return positionals[0]
			? { op: "show", name: positionals[0] }
			: { op: "show" };
	}
	if (op === "set") {
		const parsed = parse(rest, syntax, {
			flags: ["--default"],
			values: [
				"--executor",
				"--model",
				"--effort",
				"--permission-mode",
				"--strict-capabilities",
				"--unset",
				"--preset",
			],
			repeatable: ["--role"],
			aliases: { "--thinking": "--effort" },
		});
		const [name] = onlyPositionals(
			parsed,
			1,
			"profile set <name> [options]",
			syntax,
		);
		const v = parsed.values;
		const values: Record<string, unknown> = {};
		if (v.has("--executor")) values.executor = v.get("--executor");
		if (v.has("--model")) values.model = v.get("--model");
		if (v.has("--effort"))
			values.effort = parseThinkingLevel(v.get("--effort")!);
		if (v.has("--permission-mode"))
			values.permissionMode = parsePermissionMode(v.get("--permission-mode")!);
		if (v.has("--strict-capabilities"))
			values.strictCapabilities = parseCapabilityList(
				v.get("--strict-capabilities")!,
				"--strict-capabilities",
			);
		// WP31: `--role <role>=<executor>[:<model>[:<effort>]]` (repeatable) and `--preset <id>`.
		const roles = parseRoleFlags(parsed.lists.get("--role"));
		if (roles) values.roles = roles;
		const unset = v
			.get("--unset")
			?.split(",")
			.map((field) => field.trim())
			.filter(Boolean);
		return {
			op: "set",
			name: name!,
			values,
			...(unset ? { unset } : {}),
			...(parsed.flags.has("--default") ? { makeDefault: true } : {}),
			...(v.has("--preset") ? { preset: v.get("--preset")! } : {}),
		};
	}
	if (op === "presets") {
		onlyPositionals(parse(rest, syntax), 0, "profile presets", syntax);
		return { op: "presets" };
	}
	if (op === "delete")
		return {
			op: "delete",
			name: onlyPositionals(
				parse(rest, syntax),
				1,
				"profile delete <name>",
				syntax,
			)[0]!,
		};
	if (op === "default") {
		const parsed = parse(rest, syntax, { flags: ["--clear"] });
		if (parsed.flags.has("--clear")) {
			onlyPositionals(parsed, 0, "profile default <name> | --clear", syntax);
			return { op: "default", name: null };
		}
		return {
			op: "default",
			name: onlyPositionals(
				parsed,
				1,
				"profile default <name> | --clear",
				syntax,
			)[0]!,
		};
	}
	throw new HostUsageError(
		`Unknown profile operation "${op}". Usage: ${syntax.usagePrefix}profile list|show|set|delete|default|presets|workflow`,
	);
}
