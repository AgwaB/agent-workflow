/**
 * Read-only shell commands (owner decision 2026-11-02: do not over-tighten read-only stages).
 *
 * Some agents (Google Antigravity) have no list/grep/find tool and run `ls`/`rg` through their
 * shell tool, which reports every command as kind `execute`. A readOnly stage denies `execute`, so
 * such a worker could not search the repository at all. A command that passes this check is
 * treated as a search instead.
 *
 * Ported from gajae-code's read-only bash profile (`packages/coding-agent/src/tools/
 * bash-allowed-prefixes.ts`, f536b10):
 * - the command is split into plain words;
 * - shell control operators, command substitution, `$`, unquoted glob/brace characters, a
 *   word-initial `~`, backslashes and newlines are refused;
 * - the first word must be an inspection command;
 * - options that write, run another program or never end are refused per command.
 *
 * gjc runs the command itself after rewriting it. An ACP client only answers a permission request
 * and the agent runs the exact string, so the string must already be in that plain form; nothing
 * is rewritten here.
 */

/** Inspection commands a readOnly stage may run (gjc's set plus find, cat, head, tail, git reads). */
export const READ_ONLY_SHELL_COMMANDS: readonly string[] = [
	"cat",
	"du",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"ls",
	"pwd",
	"rg",
	"stat",
	"tail",
	"tree",
	"wc",
];

/** git subcommands that only read (gjc's read-only agents' `bashAllowedPrefixes`). */
export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = [
	"blame",
	"diff",
	"log",
	"ls-files",
	"rev-parse",
	"show",
	"status",
];

export interface ReadOnlyShellCheck {
	readonly ok: boolean;
	/** Why the command is not read-only (absent when ok). */
	readonly reason?: string;
}

const CONTROL = new Set([";", "|", "&", "<", ">", "(", ")"]);
const UNQUOTED_EXPANSION = new Set(["$", "*", "?", "[", "]", "{", "}"]);

function parseWords(command: string): { words: string[]; reason?: string } {
	const words: string[] = [];
	let current = "";
	let started = false;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i] as string;
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "$" || char === "`" || char === "\\")
				return { words, reason: `'${char}' inside double quotes` };
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\n" || char === "\r")
			return { words, reason: "more than one command" };
		if (char === "`") return { words, reason: "command substitution" };
		if (CONTROL.has(char)) return { words, reason: `shell operator '${char}'` };
		if (UNQUOTED_EXPANSION.has(char))
			return { words, reason: `shell expansion '${char}'` };
		if (char === "\\") return { words, reason: "backslash escape" };
		if (char === "~" && !started)
			return { words, reason: "home expansion '~'" };
		if (/\s/u.test(char)) {
			if (started) words.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (quote !== null) return { words, reason: "unterminated quote" };
	if (started) words.push(current);
	return { words };
}

/** Option words before `--`. */
function options(words: readonly string[]): string[] {
	const out: string[] = [];
	for (const word of words.slice(1)) {
		if (word === "--") break;
		out.push(word);
	}
	return out;
}

const long = (word: string, name: string) =>
	word === name || word.startsWith(`${name}=`);
const shortCluster = (word: string, flag: string) =>
	word.startsWith("-") &&
	!word.startsWith("--") &&
	word.slice(1).includes(flag);

const FIND_ACTIONS_THAT_WRITE_OR_RUN = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
]);

function optionProblem(words: readonly string[]): string | undefined {
	const [command, ...rest] = words;
	const opts = options(words);
	switch (command) {
		case "rg":
			for (const option of opts) {
				if (long(option, "--pre") || long(option, "--pre-glob"))
					return "rg preprocessors run another program";
				if (long(option, "--hostname-bin"))
					return "rg --hostname-bin runs another program";
				if (long(option, "--search-zip") || shortCluster(option, "z"))
					return "rg -z runs decompression programs";
			}
			return undefined;
		case "tree":
			for (const option of opts)
				if (long(option, "--output") || shortCluster(option, "o"))
					return "tree -o writes a file";
			return undefined;
		case "file":
			for (const option of opts)
				if (long(option, "--compile") || shortCluster(option, "C"))
					return "file -C writes a compiled magic file";
			return undefined;
		case "find":
			for (const word of rest)
				if (FIND_ACTIONS_THAT_WRITE_OR_RUN.has(word))
					return `find ${word} writes or runs a program`;
			return undefined;
		case "tail":
			for (const option of opts)
				if (
					long(option, "--follow") ||
					shortCluster(option, "f") ||
					shortCluster(option, "F")
				)
					return "tail -f does not end";
			return undefined;
		case "git": {
			const sub = rest[0];
			if (sub === undefined || !READ_ONLY_GIT_SUBCOMMANDS.includes(sub))
				return `git ${sub ?? "(no subcommand)"} is not a read-only git command (allowed: ${READ_ONLY_GIT_SUBCOMMANDS.join(", ")}; no global options)`;
			for (const word of rest.slice(1))
				if (
					long(word, "--output") ||
					long(word, "--ext-diff") ||
					long(word, "--textconv") ||
					long(word, "--exec")
				)
					return `git ${word} writes a file or runs a program`;
			return undefined;
		}
		default:
			return undefined;
	}
}

/** Whether `command` is one plain read-only inspection command (see the module comment). */
export function checkReadOnlyShellCommand(command: string): ReadOnlyShellCheck {
	const parsed = parseWords(command.trim());
	if (parsed.reason !== undefined)
		return { ok: false, reason: `not a plain command: ${parsed.reason}` };
	const head = parsed.words[0];
	if (head === undefined) return { ok: false, reason: "empty command" };
	if (!READ_ONLY_SHELL_COMMANDS.includes(head))
		return {
			ok: false,
			reason: `${head} is not a read-only inspection command (allowed: ${READ_ONLY_SHELL_COMMANDS.join(", ")})`,
		};
	const problem = optionProblem(parsed.words);
	return problem === undefined ? { ok: true } : { ok: false, reason: problem };
}

export function isReadOnlyShellCommand(command: string): boolean {
	return checkReadOnlyShellCommand(command).ok;
}
