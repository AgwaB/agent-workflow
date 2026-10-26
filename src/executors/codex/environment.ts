/**
 * Codex environment probe (WP4d, owner decisions "Codex allow 규칙" and "Codex 전역 AGENTS.md").
 * Reads only policy/instruction files under `$CODEX_HOME` (default `~/.codex`): `rules/*.rules`
 * (counted, never recorded) and `AGENTS.md` (presence/emptiness only). Credential files such as
 * `auth.json` are never opened (D1).
 *
 * - `allow` rules let matching commands run without an approval request, outside the sandbox, so
 *   the readOnly guarantee drops to `emulated` with a warning (run, but warn; strict profiles refuse).
 * - A non-empty global `AGENTS.md` is loaded into every worker and cannot be switched off per run:
 *   `contextIsolation` is `emulated` with a warning; without it isolation is `native`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutorCapabilities } from "../../sdk/capabilities.js";

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
 * Count `decision = "allow"` keyword arguments in one `.rules` file. Comments and string contents
 * (e.g. a pattern that mentions `decision="allow"`) are not counted. Returns a count only.
 */
export function countCodexAllowRules(text: string): number {
	const tokens = tokenize(text);
	let count = 0;
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
			value.value === "allow"
		)
			count += 1;
	}
	return count;
}

export interface CodexEnvironmentFindings {
	readonly codexHome: string;
	readonly rulesPath: string;
	readonly rulesFiles: number;
	readonly allowRules: number;
	readonly agentsPath: string;
	readonly globalAgentsMd: "absent" | "empty" | "present";
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
			allowRules += countCodexAllowRules(readFileSync(file, "utf8"));
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
	return {
		codexHome,
		rulesPath,
		rulesFiles,
		allowRules,
		agentsPath,
		globalAgentsMd,
		problems,
	};
}

/** Probe capability rows for the findings (merged with `source: "probed"`). */
export function codexEnvironmentCapabilities(
	findings: CodexEnvironmentFindings,
): Partial<ExecutorCapabilities> {
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
			findings.globalAgentsMd === "present"
				? {
						level: "emulated",
						source: "probed",
						warning: `global ${findings.agentsPath} is loaded into every Codex worker`,
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
		...findings.problems,
	];
}
