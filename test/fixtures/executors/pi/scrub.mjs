// Scrubber for recorded Pi transcripts (WP6). Every committed transcript goes through
// `scrubTranscriptLine` / `scrubText`; test/unit/executor-pi-fixtures.test.mjs greps the fixture
// tree for the patterns in `FORBIDDEN_PATTERNS` so nothing personal slips in later.
import { homedir, hostname, userInfo } from "node:os";

const HOME = homedir();
const USER = userInfo().username;
const HOST = hostname();

/** Patterns that must never appear in committed fixtures. */
export const FORBIDDEN_PATTERNS = [
	["absolute macOS home path", /\/Users\/[A-Za-z0-9._-]+/u],
	["absolute Linux home path", /\/home\/[A-Za-z0-9._-]+\//u],
	["macOS per-user temp dir", /\/var\/folders\//u],
	["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u],
	["API key (sk-…)", /\bsk-(?!<REDACTED>)[A-Za-z0-9_*-]{6,}/u],
	["Google API key", /\bAIza[0-9A-Za-z_-]{20,}/u],
	["bearer token", /\bBearer\s+[A-Za-z0-9._-]{12,}/u],
	["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/u],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/u],
	["OpenAI org/project id", /\b(?:org|proj)_[A-Za-z0-9]{16,}/u],
];

/** Patterns that depend on the recording machine (checked only when recording/scrubbing locally). */
export function machinePatterns() {
	// The user name is covered by the home path (and a short CI user name such as "runner" would
	// match ordinary words); the host name only when it is distinctive.
	return [
		["home directory", HOME],
		["host name", HOST],
	].filter(([, value]) => typeof value === "string" && value.length >= 6);
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function scrubText(text) {
	let out = text;
	out = out.replace(/\/private\/tmp\//gu, "/tmp/");
	out = out.replace(
		/\/tmp\/aw-live-pi-([a-z0-9-]+?)-[A-Za-z0-9]{6}(?=\/|"|$|\s)/gu,
		"<TMP>/aw-live-pi-$1",
	);
	out = out.replace(/\/tmp\/aw-faux-explore[^\s"]*/gu, "<TMP>/faux");
	out = out.replace(
		/\/(?:private\/)?var\/folders\/[^\s"/]+\/[^\s"/]+\/T\/?/gu,
		"<TMPDIR>/",
	);
	out = out.replace(new RegExp(escape(HOME), "gu"), "<HOME>");
	out = out.replace(/\/Users\/[A-Za-z0-9._-]+/gu, "<HOME>");
	out = out.replace(/\/home\/[A-Za-z0-9._-]+/gu, "<HOME>");
	if (HOST.length >= 3)
		out = out.replace(new RegExp(escape(HOST), "gu"), "<HOST>");
	if (USER.length >= 3)
		out = out.replace(new RegExp(`\\b${escape(USER)}\\b`, "gu"), "<USER>");
	out = out.replace(
		/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
		"<EMAIL>",
	);
	out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9_*-]{6,}/gu, "sk-<REDACTED>");
	out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}/gu, "<REDACTED_GOOGLE_KEY>");
	return out;
}

const SECTION_KEEP_CHARS = 160;

function walk(value, key) {
	if (typeof value === "string") return scrubText(value);
	if (Array.isArray(value)) return value.map((entry) => walk(entry));
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [childKey, child] of Object.entries(value)) {
			if (key === "sections" && typeof child === "string") {
				const text = scrubText(child);
				out[childKey] =
					text.length > SECTION_KEEP_CHARS &&
					!/…\[scrubbed: \d+ chars\]$/u.test(text)
						? `${text.slice(0, SECTION_KEEP_CHARS)}…[scrubbed: ${text.length - SECTION_KEEP_CHARS} chars]`
						: text;
			} else if (childKey === "thoughtSignature" && typeof child === "string")
				out[childKey] = "<SCRUBBED_SIGNATURE>";
			else out[childKey] = walk(child, childKey);
		}
		return out;
	}
	return value;
}

/** Scrub one raw Pi JSONL line (JSON-aware; long system-prompt sections are shortened). */
export function scrubTranscriptLine(line) {
	try {
		return JSON.stringify(walk(JSON.parse(line)));
	} catch {
		return scrubText(line);
	}
}

/** Problems (pattern names) found in `text`. */
export function findForbidden(text, { machine = true } = {}) {
	const found = [];
	for (const [name, pattern] of FORBIDDEN_PATTERNS)
		if (pattern.test(text)) found.push(name);
	if (machine)
		for (const [name, value] of machinePatterns())
			if (text.includes(value)) found.push(name);
	return found;
}
