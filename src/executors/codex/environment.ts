/**
 * Codex environment probe (WP4d, owner decisions "Codex allow 규칙" and "Codex 전역 AGENTS.md").
 * Reads only policy/instruction files under `$CODEX_HOME` (default `~/.codex`): `rules/*.rules`
 * (counted, never recorded), `AGENTS.md` (presence/emptiness only), and system requirements
 * (free-mode restrictions only). Credential files such as
 * `auth.json` are never opened (D1).
 *
 * - `allow` rules let matching commands run without an approval request, outside the sandbox, so
 *   the readOnly guarantee drops to `emulated` with a warning (run, but warn; strict profiles refuse).
 * - A non-empty global `AGENTS.md` is loaded into every worker and cannot be switched off per run:
 *   `contextIsolation` is `emulated` with a warning. Policy that survives isolation also warns.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutorCapabilities } from "../../sdk/capabilities.js";
import { type CodexWorkerHomeDecision, decideCodexWorkerHome } from "./home.js";

export function codexHomeDir(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const configured = env.CODEX_HOME;
	return configured !== undefined && configured !== ""
		? resolve(configured)
		: join(homedir(), ".codex");
}

type Token =
	| { readonly kind: "ident"; readonly value: string }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "punct"; readonly value: string };

/** Minimal Starlark tokenizer: identifiers, string literals (incl. triple/prefixed), punctuation. */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const readString = (quote: string): string => {
		const triple = text.startsWith(quote.repeat(3), i);
		const close = triple ? quote.repeat(3) : quote;
		i += close.length;
		let value = "";
		while (i < text.length) {
			if (text.startsWith(close, i)) {
				i += close.length;
				return value;
			}
			const ch = text[i] as string;
			if (!triple && ch === "\n") return value; // unterminated: stop at line end
			if (ch === "\\" && i + 1 < text.length) {
				value += text[i + 1];
				i += 2;
				continue;
			}
			value += ch;
			i += 1;
		}
		return value;
	};
	while (i < text.length) {
		const ch = text[i] as string;
		if (/\s/u.test(ch)) {
			i += 1;
		} else if (ch === "#") {
			while (i < text.length && text[i] !== "\n") i += 1;
		} else if (ch === '"' || ch === "'") {
			tokens.push({ kind: "string", value: readString(ch) });
		} else if (/[A-Za-z_]/u.test(ch)) {
			let end = i + 1;
			while (end < text.length && /[A-Za-z0-9_]/u.test(text[end] as string))
				end += 1;
			const word = text.slice(i, end);
			i = end;
			const next = text[i];
			if (/^[rRbB]{1,2}$/u.test(word) && (next === '"' || next === "'")) {
				tokens.push({ kind: "string", value: readString(next) });
			} else tokens.push({ kind: "ident", value: word });
		} else {
			tokens.push({ kind: "punct", value: ch });
			i += 1;
		}
	}
	return tokens;
}

/**
 * Count allow/forbidden/prompt decision arguments in one `.rules` file. Comments and string
 * contents (e.g. a pattern that mentions `decision="allow"`) are not counted. Counts only.
 */
export function countCodexRules(text: string): {
	allow: number;
	forbidden: number;
	prompt: number;
} {
	const tokens = tokenize(text);
	const counts = { allow: 0, forbidden: 0, prompt: 0 };
	for (let index = 0; index + 2 < tokens.length; index += 1) {
		const name = tokens[index];
		const equals = tokens[index + 1];
		const value = tokens[index + 2];
		if (
			name?.kind === "ident" &&
			name.value === "decision" &&
			equals?.kind === "punct" &&
			equals.value === "=" &&
			value?.kind === "string" &&
			["allow", "forbidden", "prompt"].includes(value.value)
		)
			counts[value.value as keyof typeof counts] += 1;
	}
	return counts;
}

/** Backward-compatible allow-only count. */
export function countCodexAllowRules(text: string): number {
	return countCodexRules(text).allow;
}

/** System requirements path; override for hermetic probes/tests, never credentials. */
export function codexRequirementsPath(
	env: Readonly<Record<string, string | undefined>>,
): string {
	return (
		env.AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH ??
		(process.platform === "win32"
			? join(
					env.ProgramData ?? "C:\\ProgramData",
					"OpenAI",
					"Codex",
					"requirements.toml",
				)
			: "/etc/codex/requirements.toml")
	);
}

/** Narrow root-array reader, not a TOML evaluator. Unsupported syntax is warned about. */
function requiredModes(text: string): {
	sandbox: boolean;
	approval: boolean;
	unsupported: boolean;
} {
	const tokens = tokenize(text);
	let sandbox = false;
	let approval = false;
	let unsupported = false;
	let depth = 0;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (depth === 0 && token?.value === "[" && tokens[i - 1]?.value !== "=")
			break; // table: no more root keys
		if (
			depth === 0 &&
			(token?.kind === "ident" || token?.kind === "string") &&
			["allowed_sandbox_modes", "allowed_approval_policies"].includes(
				token.value,
			)
		) {
			if (tokens[i + 1]?.value !== "=" || tokens[i + 2]?.value !== "[") {
				unsupported = true;
				continue;
			}
			const values: string[] = [];
			let j = i + 3;
			let expectValue = true;
			for (; j < tokens.length && tokens[j]?.value !== "]"; j += 1) {
				const value = tokens[j];
				if (expectValue && value?.kind === "string") {
					values.push(value.value);
					expectValue = false;
				} else if (!expectValue && value?.value === ",") expectValue = true;
				else unsupported = true;
			}
			if (tokens[j]?.value !== "]") unsupported = true;
			if (token.value === "allowed_sandbox_modes")
				sandbox = !values.includes("danger-full-access");
			else approval = !values.includes("never");
			i = j;
			continue;
		}
		if (token?.value === "[" || token?.value === "{") depth += 1;
		if (token?.value === "]" || token?.value === "}") depth -= 1;
	}
	return { sandbox, approval, unsupported };
}

export interface CodexEnvironmentFindings {
	readonly codexHome: string;
	readonly rulesPath: string;
	readonly rulesFiles: number;
	readonly allowRules: number;
	readonly forbiddenRules: number;
	readonly promptRules: number;
	readonly requirementsPath: string;
	readonly disallowedFreeModes: readonly ("danger-full-access" | "never")[];
	readonly agentsPath: string;
	readonly globalAgentsMd: "absent" | "empty" | "present";
	/** C1: whether isolated workers get a private CODEX_HOME (no global AGENTS.md). */
	readonly workerHome: CodexWorkerHomeDecision;
	/** Unreadable files etc. (paths only). */
	readonly problems: readonly string[];
}

export function inspectCodexEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
): CodexEnvironmentFindings {
	const codexHome = codexHomeDir(env);
	const rulesPath = join(codexHome, "rules");
	const agentsPath = join(codexHome, "AGENTS.md");
	const problems: string[] = [];
	let rulesFiles = 0;
	let allowRules = 0;
	let forbiddenRules = 0;
	let promptRules = 0;
	let names: string[] = [];
	try {
		names = readdirSync(rulesPath).filter((name) => name.endsWith(".rules"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			problems.push(`cannot list ${rulesPath}`);
	}
	for (const name of names.sort()) {
		const file = join(rulesPath, name);
		try {
			if (!statSync(file).isFile()) continue;
			const counts = countCodexRules(readFileSync(file, "utf8"));
			allowRules += counts.allow;
			forbiddenRules += counts.forbidden;
			promptRules += counts.prompt;
			rulesFiles += 1;
		} catch {
			problems.push(`cannot read ${file}`);
		}
	}
	let globalAgentsMd: CodexEnvironmentFindings["globalAgentsMd"] = "absent";
	try {
		if (statSync(agentsPath).isFile())
			globalAgentsMd =
				readFileSync(agentsPath, "utf8").trim() === "" ? "empty" : "present";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			problems.push(`cannot read ${agentsPath}`);
	}
	const requirementsPath = codexRequirementsPath(env);
	const disallowedFreeModes: ("danger-full-access" | "never")[] = [];
	try {
		const modes = requiredModes(readFileSync(requirementsPath, "utf8"));
		if (modes.unsupported)
			problems.push(
				`cannot fully inspect ${requirementsPath}; ask your administrator to verify allowed_sandbox_modes and allowed_approval_policies before running`,
			);
		else {
			if (modes.sandbox) disallowedFreeModes.push("danger-full-access");
			if (modes.approval) disallowedFreeModes.push("never");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			problems.push(
				`cannot read ${requirementsPath}; ask your administrator to verify managed requirements before running`,
			);
	}
	return {
		codexHome,
		rulesPath,
		rulesFiles,
		allowRules,
		forbiddenRules,
		promptRules,
		requirementsPath,
		disallowedFreeModes,
		agentsPath,
		globalAgentsMd,
		workerHome: decideCodexWorkerHome({ userHome: codexHome, env }),
		problems,
	};
}

/** Probe capability rows for the findings (merged with `source: "probed"`). */
export function codexEnvironmentCapabilities(
	findings: CodexEnvironmentFindings,
): Partial<ExecutorCapabilities> {
	const isolationWarnings = [
		...(findings.globalAgentsMd === "present" && !findings.workerHome.relocate
			? [
					`global ${findings.agentsPath} is loaded into every Codex worker (private worker home not used: ${findings.workerHome.reason})`,
				]
			: []),
		...codexPolicyWarnings(findings),
	];
	return {
		...(findings.allowRules > 0
			? {
					readOnly: {
						level: "emulated",
						source: "probed",
						warning: `${findings.allowRules} allow rule${findings.allowRules === 1 ? "" : "s"} in ${findings.rulesPath} let matching commands run without approval`,
					},
				}
			: {}),
		contextIsolation:
			isolationWarnings.length > 0
				? {
						level: "emulated",
						source: "probed",
						warning: isolationWarnings.join("; "),
					}
				: { level: "native", source: "probed" },
	};
}

/** Probe notes for the findings (counts and paths only, never rule patterns or file contents). */
export function codexEnvironmentNotes(
	findings: CodexEnvironmentFindings,
): string[] {
	return [
		`exec-policy rules: ${findings.allowRules} allow rule${findings.allowRules === 1 ? "" : "s"} in ${findings.rulesFiles} file${findings.rulesFiles === 1 ? "" : "s"} under ${findings.rulesPath}`,
		`global instructions: ${findings.agentsPath} ${findings.globalAgentsMd}`,
		findings.workerHome.relocate
			? `worker home: private CODEX_HOME per attempt or kept session (auth.json, its auth.lock, config.toml and rules linked from ${findings.codexHome}; global AGENTS.md not loaded)`
			: `worker home: ${findings.codexHome} shared (${findings.workerHome.reason})`,
		...codexPolicyWarnings(findings),
	];
}

/** Counts/paths only: rules and managed requirements survive worker context isolation. */
export function codexPolicyWarnings(
	findings: CodexEnvironmentFindings,
): string[] {
	return [
		...(findings.forbiddenRules > 0
			? [
					`${findings.forbiddenRules} forbidden exec-policy rule(s) in ${findings.rulesPath} will deny matching commands even in free mode; review the rules with your administrator or use a compatible executor`,
				]
			: []),
		...(findings.promptRules > 0
			? [
					`${findings.promptRules} prompt exec-policy rule(s) in ${findings.rulesPath} will deny matching commands in free mode (approvalPolicy=never), not ask; review the rules with your administrator or use a compatible executor`,
				]
			: []),
		...(findings.disallowedFreeModes.length > 0
			? [
					`managed requirements ${findings.requirementsPath} disallow ${findings.disallowedFreeModes.join(" and ")}; free-mode startup will fail before a model turn if Codex rejects or changes the requested permissions; ask your administrator to permit danger-full-access and never or use a compatible executor/profile`,
				]
			: []),
		...findings.problems,
	];
}
