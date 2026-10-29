// Secret-value scan for the files npm would publish (used by release-check.mjs, WP12c).
//
// It flags secret VALUES — token-shaped strings, private-key blocks, JWTs and long high-entropy
// values assigned to key-like names — and never identifier names or documentation mentions such as
// `ANTHROPIC_API_KEY`, `PI_RUN_SECRETS_ENV` or "the private key block". Findings name the file,
// line and rule, never the matched value.
//
// `secretScanSelfTest()` plants real-looking secrets (assembled at run time, so this file holds no
// token-shaped literal) and benign mentions; release-check refuses to run with a scanner that
// misses a planted secret or flags a benign mention.

/** Local machine paths and desktop artifacts that must never ship (unchanged from WP0). */
// `navigator.clipboard` is the Web Clipboard API the dashboard's Copy button uses, not a desktop
// artifact name; every other `clipboard` mention is still refused.
export const LOCAL_PATH_PATTERN =
	/\/Users\/toby|\/var\/folders|Desktop|(?<!navigator\.)clipboard|Screenshot/;

/** Token shapes that are secrets wherever they appear. */
const TOKEN_RULES = [
	{
		rule: "OpenAI/Anthropic-style key (sk-…)",
		pattern:
			/(?<![A-Za-z0-9_-])sk-(?:ant-(?:api|admin)\d{2}-|proj-|svcacct-|admin-|live-)?[A-Za-z0-9_-]{20,}/gu,
		// Real keys mix letters and digits; kebab-case words (`sk-some-long-name`) are not keys.
		accept: (match) => /\d/u.test(match) && /[A-Za-z]{2}/u.test(match.slice(3)),
	},
	{
		rule: "GitHub token (gh?_…)",
		pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}/gu,
	},
	{
		rule: "GitHub fine-grained token",
		pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{40,}/gu,
	},
	{
		rule: "GitLab token (glpat-…)",
		pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/gu,
	},
	{
		rule: "Slack token (xox?-…)",
		pattern: /(?<![A-Za-z0-9_-])xox[abposr]-\d{6,}-[A-Za-z0-9-]{10,}/gu,
	},
	{
		rule: "Slack app token (xapp-…)",
		pattern: /(?<![A-Za-z0-9_-])xapp-\d-[A-Z0-9]{8,}-\d{6,}-[a-f0-9]{20,}/gu,
	},
	{
		rule: "npm token (npm_…)",
		pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/gu,
	},
	{
		rule: "AWS access key id",
		pattern:
			/(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}(?![A-Z0-9])/gu,
		// Documentation placeholders (`AKIAXXXXXXXXXXXXXXXX`) are not keys.
		accept: (match) => !/^.{4}(?:X+|0+)$/u.test(match),
	},
	{
		rule: "Google API key",
		pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/gu,
	},
	{
		rule: "Google OAuth client secret",
		pattern: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])/gu,
	},
	{
		rule: "Stripe live key",
		pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{24,}/gu,
	},
	{
		// The armor line followed by key material (a real newline or an escaped `\n` in JSON/JS
		// strings); a bare header in prose or a regex source is not a key.
		rule: "private key block",
		pattern:
			/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\r?\n|\\(?:r\\)?n)(?:[A-Za-z0-9-]+: [^\n]*(?:\r?\n|\\(?:r\\)?n))*[A-Za-z0-9+/=]{40,}/gu,
	},
	{
		rule: "JWT",
		pattern:
			/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/gu,
		// The header must decode to a JSON object with `alg` (or `typ`).
		accept: (match) => {
			try {
				const header = JSON.parse(
					Buffer.from(match.split(".")[0], "base64url").toString("utf8"),
				);
				return (
					header !== null &&
					typeof header === "object" &&
					("alg" in header || "typ" in header)
				);
			} catch {
				return false;
			}
		},
	},
];

/** Key names under which a long high-entropy value is treated as a credential. */
const SECRET_KEY_NAME =
	/(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|auth[_-]?(?:token|key)|^_?auth$|client[_-]?secret|session[_-]?key|signing[_-]?key)/iu;

// `name = "value"`, `name: 'value'`, `"name": "value"`, `NAME=value` (env/.npmrc), `Bearer value`.
const ASSIGNMENT =
	/(?<name>[A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?:=|:|=>)\s*(?<quote>["'`]?)(?<value>[A-Za-z0-9+/=_.~-]{20,})\k<quote>/gu;
const BEARER = /\bBearer\s+(?<value>[A-Za-z0-9+/=_.~-]{20,})/gu;

function shannonEntropy(value) {
	const counts = new Map();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/** A long opaque value: mixed character classes and high entropy, not an identifier or path. */
export function isHighEntropySecretValue(value) {
	if (value.length < 20) return false;
	if (!/\d/u.test(value) || !/[A-Za-z]/u.test(value)) return false;
	// Absolute and relative paths are locations, not credentials.
	if (/^\.{0,2}\//u.test(value)) return false;
	// UUID-shaped values (legacy npm `_authToken`, API tokens) under a key-like name.
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
			value,
		)
	)
		return true;
	// Identifiers, constants and dotted names (`AGENT_WORKFLOW_X_1`, `foo.bar.baz2`, kebab ids).
	if (/^[A-Z0-9_]+$/u.test(value) && value.includes("_")) return false;
	if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/u.test(value) && !/\d{4,}/u.test(value))
		return false;
	if (/^(?:x+|0+|\*+|\.+)$/iu.test(value)) return false;
	const classes =
		Number(/[a-z]/u.test(value)) +
		Number(/[A-Z]/u.test(value)) +
		Number(/\d/u.test(value));
	const hex = /^[0-9a-f]+$/iu.test(value);
	if (!hex && classes < 3) return false;
	return shannonEntropy(value) >= (hex ? 3.0 : 3.5);
}

function unquotedAssignmentLine(text, match) {
	const lineStart = text.lastIndexOf("\n", match.index) + 1;
	const prefix = text.slice(lineStart, match.index);
	if (!/^\s*(?:export\s+)?$/u.test(prefix) && !/^\s*\/\/\S*:$/u.test(prefix))
		return false;
	const end = match.index + match[0].length;
	const rest = text.slice(
		end,
		text.indexOf("\n", end) === -1 ? undefined : text.indexOf("\n", end),
	);
	return /^\s*(?:#.*)?\r?$/u.test(rest);
}

function lineOf(text, index) {
	let line = 1;
	for (
		let i = text.indexOf("\n");
		i !== -1 && i < index;
		i = text.indexOf("\n", i + 1)
	)
		line += 1;
	return line;
}

/**
 * Secret values in `text`: `{rule, line}` per finding (the value is never returned). `text` is any
 * packed file content (source, compiled JS, declarations, Markdown, JSON).
 */
export function findSecretValues(text) {
	const findings = [];
	const seen = new Set();
	const add = (rule, index) => {
		const line = lineOf(text, index);
		const key = `${rule}\0${line}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({ rule, line });
	};
	for (const { rule, pattern, accept } of TOKEN_RULES) {
		for (const match of text.matchAll(pattern))
			if (!accept || accept(match[0])) add(rule, match.index);
	}
	for (const match of text.matchAll(ASSIGNMENT)) {
		const { name, quote, value } = match.groups;
		if (!SECRET_KEY_NAME.test(name)) continue;
		// An unquoted value counts only in env/ini/.npmrc lines (`NAME=value` at the line start or
		// after `//host/:`, nothing after the value); in code it is an expression such as
		// `record.launchAuthoritySha256`.
		if (quote === "" && !unquotedAssignmentLine(text, match)) continue;
		if (isHighEntropySecretValue(value))
			add(`high-entropy value assigned to "${name}"`, match.index);
	}
	for (const match of text.matchAll(BEARER))
		if (isHighEntropySecretValue(match.groups.value))
			add("bearer credential", match.index);
	return findings.sort((a, b) => a.line - b.line);
}

/** Deterministic pseudo-random characters, so planted secrets are not literals in this file. */
function chars(seed, length, alphabet) {
	let state = seed >>> 0;
	let out = "";
	for (let i = 0; i < length; i += 1) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out += alphabet[state % alphabet.length];
	}
	return out;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HEX = "0123456789abcdef";
const B64 = `${ALNUM}+/`;

/** Planted real-looking secrets (each must be found) and benign mentions (none may be found). */
export function secretScanSelfTestCases() {
	const jwtPart = (value) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const jwt = [
		jwtPart({ alg: "HS256", typ: "JWT" }),
		jwtPart({ sub: "1234567890", name: "release", iat: 1700000000 }),
		chars(7, 43, `${ALNUM}-_`),
	].join(".");
	const keyBody = Array.from({ length: 4 }, (_, i) =>
		chars(30 + i, 64, B64),
	).join("\n");
	const pem = (label) =>
		`-----BEGIN ${label}PRIVATE KEY-----\n${keyBody}\n-----END ${label}PRIVATE KEY-----`;
	const planted = [
		["sk- key", `const key = "${"sk"}-${chars(1, 48, ALNUM)}";`],
		[
			"sk-ant key",
			`ANTHROPIC_API_KEY=${"sk"}-ant-api03-${chars(2, 90, `${ALNUM}-_`)}`,
		],
		[
			"sk-proj key",
			`OPENAI_API_KEY: ${"sk"}-proj-${chars(3, 60, `${ALNUM}-_`)}`,
		],
		["GitHub classic token", `token ${"gh"}p_${chars(4, 36, ALNUM)}`],
		[
			"GitHub fine-grained token",
			`${"github"}_pat_${chars(5, 22, ALNUM)}_${chars(6, 59, ALNUM)}`,
		],
		["GitLab token", `${"glpat"}-${chars(8, 20, `${ALNUM}-_`)}`],
		[
			"Slack bot token",
			`${"xo"}xb-${chars(9, 12, "0123456789")}-${chars(10, 13, "0123456789")}-${chars(11, 24, ALNUM)}`,
		],
		[
			"npm token",
			`//registry.npmjs.org/:_authToken=${"npm"}_${chars(12, 36, ALNUM)}`,
		],
		[
			"AWS access key id",
			`aws_access_key_id = ${"AK"}IA${chars(13, 16, UPPER_DIGITS)}`,
		],
		["AWS secret access key", `aws_secret_access_key = ${chars(14, 40, B64)}`],
		["Google API key", `key=${"AI"}za${chars(15, 35, `${ALNUM}-_`)}`],
		[
			"Google OAuth client secret",
			`"client_secret": "${"GOC"}SPX-${chars(16, 28, `${ALNUM}-_`)}"`,
		],
		["Stripe live key", `${"sk"}_live_${chars(17, 32, ALNUM)}`],
		["RSA private key", pem("RSA ")],
		["PKCS#8 private key in JSON", JSON.stringify({ private_key: pem("") })],
		["OpenSSH private key", pem("OPENSSH ")],
		["JWT", `Authorization: ${jwt}`],
		[
			"bearer header",
			`curl -H "Authorization: Bearer ${chars(18, 40, `${ALNUM}._-`)}"`,
		],
		[
			"hex secret under a key name",
			`const webhookSecret = "${chars(19, 64, HEX)}";`,
		],
		["base64 secret in JSON", `{"apiToken": "${chars(20, 44, B64)}="}`],
		[
			"legacy npm auth token (uuid)",
			`_authToken=${chars(21, 8, HEX)}-${chars(22, 4, HEX)}-4${chars(23, 3, HEX)}-a${chars(24, 3, HEX)}-${chars(25, 12, HEX)}`,
		],
		["password env assignment", `DB_PASSWORD=${chars(26, 24, ALNUM)}`],
	];
	const benign = [
		[
			"env var names in docs",
			"Executor CLIs keep their own variables (`CODEX_HOME`, `ANTHROPIC_API_KEY`, …).",
		],
		[
			"API key billing prose",
			"A set `ANTHROPIC_API_KEY` switches the CLI to API-key billing.",
		],
		[
			"secret constant name",
			'export const PI_RUN_SECRETS_ENV = "AGENT_WORKFLOW_PI_RUN_SECRETS_JSON";',
		],
		[
			"mcp secret env name",
			'export const MCP_SECRET_ENV = "AW_CONFORMANCE_MCP_TOKEN";',
		],
		[
			"identifier usage",
			"env[PI_RUN_SECRETS_ENV] = JSON.stringify({ secret, token: tokenValue });",
		],
		[
			"private key regex source",
			'["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],',
		],
		[
			"private key prose",
			"A descriptor config must not hold a -----BEGIN PRIVATE KEY----- block.",
		],
		[
			"JWT regex source",
			'["JWT", /\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/u],',
		],
		["sk- regex source", "/\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/u"],
		["sk- kebab name", "the sk-learn-compatible-pipeline-adapter option"],
		[
			"token shape prose",
			"`sk-…`, `ghp_…`, `xox…-`, AWS/Google keys, private keys, JWTs",
		],
		["password word", "PASSWORD and SECRET are never written to disk."],
		["AWS doc placeholder", "aws_access_key_id = AKIAXXXXXXXXXXXXXXXX"],
		[
			"session id key",
			'const sessionId = "agent-workflow.workflow_123.task-1";',
		],
		[
			"token budget",
			"maxTokenBudget: 320000, tokenCount: 1234567890123456789012",
		],
		["auth state enum", 'auth: "ok" | "missing" | "expired" | "unknown"'],
		[
			"env placeholder",
			"NPM_TOKEN=${{ secrets.NPM_TOKEN }} and token=$NPM_TOKEN",
		],
		["sha256 digest field", 'stateSha256: "<sha256>", digest: "sha256:abc"'],
		[
			"camelCase secret identifier value",
			'const secretKeyName = "clientSecretFromEnvironment";',
		],
		[
			"long path value",
			'tokenFile: "/var/lib/agent-workflow/run-index/locators.json"',
		],
	];
	return { planted, benign };
}

/** Problems with the scanner itself: a missed planted secret or a flagged benign mention. */
export function secretScanSelfTest() {
	const { planted, benign } = secretScanSelfTestCases();
	const problems = [];
	for (const [name, text] of planted)
		if (findSecretValues(text).length === 0)
			problems.push(`missed planted secret: ${name}`);
	for (const [name, text] of benign) {
		const findings = findSecretValues(text);
		if (findings.length > 0)
			problems.push(
				`flagged benign text: ${name} (${findings.map((f) => f.rule).join(", ")})`,
			);
	}
	return problems;
}
