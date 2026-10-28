// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/workflow-sensitive-query.ts. MIT, same author. Changes: WP19 (stage-2 review #7) `redactSensitiveWorkflowText` also redacts quoted structured credentials (JSON/header fields such as `"Authorization":"Basic …"`, `"refresh_token":"…"`, also inside escaped JSON), `Proxy-Authorization`/`x-api-key` header lines, and Linux (`/home/<user>`) and Windows (`C:\\Users\\<user>`) home paths besides macOS.
// WP19 round 2: escape-aware structured values (N4); prose such as `Exit code: 1` or `Authorization: missing …` is kept, credential header values and tokens are not (N6).
// WP19 round 3 (R1): a value under a credential header (`Authorization`, `x-api-key`, `Cookie`, `*-token`, …) is always redacted, whatever its length or alphabet; the only prose exception is an obvious statement after `Authorization:` (`missing …`, `not required …`).
const SENSITIVE_QUERY_TOKENS = new Set([
	"access",
	"auth",
	"code",
	"credential",
	"key",
	"password",
	"secret",
	"session",
	"signature",
	"sig",
	"sid",
	"jwt",
	"token",
]);

const SENSITIVE_QUERY_COMPOUNDS = new Set([
	"apikey",
	"authkey",
	"apisecret",
	"apitoken",
	"authtoken",
	"accesstoken",
	"accesskey",
	"clientsecret",
	"authorization",
	"jwttoken",
	"secretkey",
	"sessionid",
	"sessiontoken",
	"x-amz-credential",
]);

const MAX_SENSITIVE_KEY_DECODE_DEPTH = 8;
const MAX_SENSITIVE_FRAGMENT_DECODE_DEPTH = 8;
const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/iu;

/**
 * Decode a key only while every percent escape is well formed.  A bounded,
 * fail-closed loop prevents both recursive encoding bypasses and pathological
 * input from turning the shared policy into an unbounded decoder.
 */
function fullyDecodeSensitiveKey(key: string): string | undefined {
	let decoded = key.trim();
	if (!decoded) return undefined;
	if (!decoded.includes("%")) return decoded;
	for (let depth = 0; depth < MAX_SENSITIVE_KEY_DECODE_DEPTH; depth += 1) {
		if (!decoded.includes("%")) return decoded;
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return undefined;
			decoded = next;
		} catch {
			return undefined;
		}
	}
	// Do not classify a key whose encoding depth exceeds the policy bound or
	// whose decoder left a malformed/residual escape behind.
	return decoded.includes("%") ? undefined : decoded;
}

/**
 * Return true for a credential-bearing decoded query key. Malformed or
 * over-depth percent encoding is also sensitive: the decoder cannot establish
 * that the name is benign, so callers must block/redact it rather than treat
 * it as a false negative.
 */
export function isSensitiveWorkflowQueryKey(key: string): boolean {
	const trimmed = key.trim();
	if (!trimmed) return false;
	const decoded = fullyDecodeSensitiveKey(trimmed);
	if (!decoded) return true;
	const camelSeparated = decoded.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	const lower = camelSeparated.toLowerCase();
	if (SENSITIVE_QUERY_COMPOUNDS.has(lower)) return true;
	const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
	return tokens.some(
		(token) =>
			SENSITIVE_QUERY_TOKENS.has(token) || SENSITIVE_QUERY_COMPOUNDS.has(token),
	);
}

/** Redact URLs and credential-bearing assignments in provider text. */
export function redactSensitiveWorkflowText(value: string): string {
	const withUrls = value.replace(/https?:\/\/[^\s)\]}>"']+/gi, (match) => {
		const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
		const core = trailing ? match.slice(0, -trailing.length) : match;
		try {
			const url = new URL(core);
			for (const key of [...url.searchParams.keys()]) {
				if (!isSensitiveWorkflowQueryKey(key)) continue;
				if (hasUnsafeSensitiveWorkflowQueryKeyEncoding(key)) {
					url.searchParams.delete(key);
					url.searchParams.append("REDACTED", "REDACTED");
				} else {
					url.searchParams.set(key, "REDACTED");
				}
			}
			url.hash = redactSensitiveWorkflowFragment(url.hash);
			url.username = "";
			url.password = "";
			return `${url.href}${trailing}`;
		} catch {
			return match;
		}
	});
	// Providers also commonly emit a redirect fragment without retaining the
	// surrounding URL. Cover that representation too, including encoded `=`;
	// ordinary anchors are returned unchanged by the fragment helper.
	const withFragments = withUrls.replace(
		/(^|[\s("'=:)])#([^\s)\]}>"]+)/gu,
		(_whole, prefix, fragment) =>
			`${prefix}${redactSensitiveWorkflowFragment(`#${fragment}`)}`,
	);
	// WP19: a value never starts with a backslash, so the escaped-JSON form (`\"key\":\"v\"`,
	// handled by redactStructuredCredentials first) is not split at its escape.
	const assignment =
		/(["']?)([^\s"'=:,;{}]+)\1\s*([=:])(\s*)(["']?)([^\s"'&,;}\\][^\s"'&,;}]*)\5/gu;
	const redactedAssignments = redactStructuredCredentials(
		withFragments,
	).replace(
		assignment,
		(whole, quote, key, delimiter, space, valueQuote, assigned) => {
			if (!isSensitiveWorkflowQueryKey(String(key))) return whole;
			// WP19 round 2 (N6): `Label: value` with a space is how prose and reports read
			// (`Exit code: 1`, `HTTP status code: 403`). There only a credential key (password,
			// token, secret, …) or a token-shaped value is redacted; credential header names go to
			// the header rule below.
			if (delimiter === ":" && space) {
				// WP19 round 3 (R1): an unquoted credential header name: the header rule below
				// redacts its whole value.
				if (!quote && isCredentialHeaderName(String(key))) return whole;
				if (
					!isStructuredSecretKey(String(key)) &&
					!looksLikeSecretToken(String(assigned))
				)
					return whole;
			}
			return `${quote}${key}${quote}${delimiter}${space}${valueQuote}REDACTED${valueQuote}`;
		},
	);
	return redactedAssignments
		.replace(CREDENTIAL_HEADER_LINE, (whole, name, headerValue) =>
			credentialHeaderValue(String(name), String(headerValue))
				? `${name}: REDACTED`
				: whole,
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer REDACTED")
		.replace(/\/Users\/[^\s:'")]+/g, "/Users/REDACTED")
		.replace(/\/home\/[^\s:'")]+/g, "/home/REDACTED")
		.replace(
			/\b([A-Za-z]):((?:\\){1,2})Users\2[^\s:'")]+/g,
			"$1:$2Users$2REDACTED",
		);
}

/**
 * WP19: field names whose quoted value is a credential even when it contains whitespace
 * (`Basic <b64>`, `Bearer <jwt>`, cookie lists). Compared lowercase without separators.
 */
const STRUCTURED_SECRET_KEYS = new Set([
	"authorization",
	"proxyauthorization",
	"cookie",
	"setcookie",
	"xapikey",
	"apikey",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authtoken",
	"sessiontoken",
	"bearertoken",
	"secret",
	"clientsecret",
	"secretkey",
	"privatekey",
	"password",
	"passwd",
	"passphrase",
	"credentials",
]);

/**
 * WP19 round 3 (R1): a credential header line under an unequivocal credential header
 * (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`, `api-key`,
 * `*-token`). Its value is redacted through the end of the line whatever its length or alphabet.
 * A `*-token` name starts at a word start (keeps the scan linear on long hyphenated text).
 */
const CREDENTIAL_HEADER_LINE =
	/((?:proxy-)?authorization|set-cookie|cookie|x-api-key|api-key|(?<![A-Za-z0-9-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-token)\s*:\s*([^\n\r]+)/gi;

/** A key the header rule (CREDENTIAL_HEADER_LINE) handles as a whole line. */
function isCredentialHeaderName(key: string): boolean {
	return /^(?:(?:proxy-)?authorization|set-cookie|cookie|x-api-key|api-key|[a-z0-9]+(?:-[a-z0-9]+)*-token)$/iu.test(
		key,
	);
}

/**
 * WP19 round 3 (R1): the only prose kept after a credential header: `Authorization:` (or
 * `Proxy-Authorization:`) followed by an obvious statement about the header, e.g. `missing on the
 * delete endpoint` or `not required for /health`. The first word must be one of these, and no
 * later word may look like a token. Anything else is redacted.
 */
const AUTHORIZATION_PROSE_LEAD = new Set([
	"missing",
	"not",
	"none",
	"no",
	"absent",
	"required",
	"optional",
	"omitted",
	"unset",
	"empty",
	"disabled",
	"unchecked",
	"unverified",
	"ignored",
	"bypassed",
]);

function authorizationProse(name: string, value: string): boolean {
	if (!/authorization$/iu.test(name)) return false;
	const words = value.split(/\s+/u).filter(Boolean);
	const lead = (words[0] ?? "").toLowerCase().replace(/[.,;:!]+$/u, "");
	if (!AUTHORIZATION_PROSE_LEAD.has(lead)) return false;
	return words.every(
		(word) =>
			/^[A-Za-z][A-Za-z'-]*[.,;:!?)]*$|^\/[A-Za-z0-9/_-]*[.,;:!?)]*$|^\(?[A-Za-z]+$/u.test(
				word,
			) && !looksLikeSecretToken(word),
	);
}

/**
 * WP19 round 2 (N6): a single word that looks like a credential (API key, token, session id) and
 * not like prose or a status number: at least 8 characters with a digit or a token character
 * (`+/=_.~`), or at least 24 characters.
 */
function looksLikeSecretToken(word: string): boolean {
	const value = word.replace(/^["'`<(]+|["'`>).,;:!?]+$/gu, "");
	if (value.length >= 24 && /^\S+$/u.test(value)) return true;
	return value.length >= 8 && /[0-9+/=_.~]/u.test(value);
}

/**
 * WP19 round 3 (R1): a credential header line's value is always a credential, whatever its length
 * or alphabet, unless it is already redacted or it is narrow `Authorization:` prose (see
 * authorizationProse). When unsure, redact.
 */
function credentialHeaderValue(name: string, value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "REDACTED") return false;
	return !authorizationProse(name, trimmed);
}

function isStructuredSecretKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		STRUCTURED_SECRET_KEYS.has(normalized) ||
		/(token|secret|password|apikey)$/.test(normalized)
	);
}

/**
 * WP19: `"key": "value"` (and `'key': 'value'`, and the backslash-escaped form inside a JSON string,
 * e.g. an event line carrying a request) with a secret-looking key: the whole quoted value goes,
 * whitespace included. The generic assignment rule above stops at the first space, so
 * `{"Authorization":"Basic dXNlcjpw..."}` used to pass through.
 *
 * WP19 round 2 (N4): the value's end is found by an escape-aware scanner, not a regex, so an
 * escaped quote inside the value (`"sid=\"secret\"; path=/"`, a password containing `\"`) is part
 * of the value, at every nesting level of escaped JSON.
 */
function redactStructuredCredentials(value: string): string {
	const key = /(\\*)(["'])([A-Za-z0-9_.-]{1,64})\1\2(\s*:\s*)(\\*)(["'])/gu;
	let out = "";
	let copied = 0;
	let match: RegExpExecArray | null;
	while ((match = key.exec(value)) !== null) {
		const [whole, , , name, , valueEscape = "", valueQuote = '"'] = match;
		if (!isStructuredSecretKey(String(name))) {
			// Rescan from after the key: its value may hold nested escaped JSON with secret keys.
			key.lastIndex = match.index + 1;
			continue;
		}
		const contentStart = match.index + whole.length;
		const end = quotedValueEnd(
			value,
			contentStart,
			valueEscape.length,
			valueQuote,
		);
		out += `${value.slice(copied, contentStart)}REDACTED`;
		if (end.closed) {
			out += `${valueEscape}${valueQuote}`;
			copied = end.index + valueEscape.length + 1;
		} else copied = end.index;
		key.lastIndex = copied;
	}
	return copied === 0 ? value : out + value.slice(copied);
}

/**
 * WP19 round 2 (N4): where a quoted value that starts at `start` ends. The value's delimiters are
 * `quote` preceded by `escapes` backslashes (0 for plain JSON, 1 inside one level of escaped JSON,
 * 3 inside two, …). In the raw text a run of backslashes before a quote is a number of escaped
 * backslashes (2·(escapes+1) raw characters each) followed by either the closing delimiter
 * (`escapes` more) or an escaped quote inside the value (2·escapes+1 more). Returns the index of
 * the closing delimiter's first backslash (or quote), or the end of the line when the value is
 * not closed there (the rest of the line is treated as the value: fail closed).
 */
function quotedValueEnd(
	text: string,
	start: number,
	escapes: number,
	quote: string,
): { index: number; closed: boolean } {
	const unit = 2 * (escapes + 1);
	let index = start;
	while (index < text.length) {
		const char = text[index];
		if (char === "\n" || char === "\r") return { index, closed: false };
		if (char !== "\\" && char !== quote) {
			index += 1;
			continue;
		}
		let run = 0;
		while (text[index + run] === "\\") run += 1;
		if (text[index + run] !== quote) {
			index += Math.max(run, 1);
			continue;
		}
		const rest = run % unit;
		if (rest === escapes)
			// The closing delimiter starts after the escaped backslashes.
			return { index: index + run - escapes, closed: true };
		if (rest < escapes)
			// A quote of an enclosing level: the value cannot run past it.
			return { index: index + run - rest, closed: false };
		// An escaped quote inside the value (or malformed escaping): keep scanning.
		index += run + 1;
	}
	return { index, closed: false };
}

/**
 * Fragments are not exposed through URL.searchParams. Decode their structural
 * separators in a bounded loop before parsing them as query-like data. This
 * catches a credential assignment hidden inside a benign value, for example
 * `foo=bar%26access_token%3Dsecret`, without changing ordinary anchors or
 * benign values that do not contain a sensitive assignment.
 */
export function redactSensitiveWorkflowFragment(hash: string): string {
	if (!hash) return "";
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw) return "";

	// URLSearchParams is deliberately permissive about malformed escapes. Do
	// this validation first so a malformed fragment cannot be retained as an
	// apparently benign value while a later decoder sees a different shape.
	if (hasMalformedPercentEncoding(raw)) return "#REDACTED=REDACTED";

	const decoded = boundedDecodeFragmentStructure(raw);
	if (decoded === undefined) return "#REDACTED=REDACTED";
	try {
		const params = new URLSearchParams(decoded);
		let changed = false;
		for (const key of [...params.keys()]) {
			if (!isSensitiveWorkflowQueryKey(key)) continue;
			const decodedKey = fullyDecodeSensitiveKey(key);
			if (
				hasUnsafeSensitiveWorkflowQueryKeyEncoding(key) ||
				(decodedKey !== undefined && /[&=]/u.test(decodedKey))
			) {
				params.delete(key);
				params.append("REDACTED", "REDACTED");
			} else {
				params.set(key, "REDACTED");
			}
			changed = true;
		}
		return changed ? `#${params.toString()}` : hash;
	} catch {
		// Do not retain a fragment if parsing unexpectedly fails after the
		// bounded decoder accepted it.
		return "#REDACTED=REDACTED";
	}
}

/**
 * Decode enough layers to expose nested `&`/`=` separators, but never recurse
 * without a bound. A residual valid escape at the bound is unsafe because the
 * hidden structure has not been established. Literal percent characters that
 * result from a valid `%25` value do not force another decode layer unless the
 * layer still contains a valid escape.
 */
function boundedDecodeFragmentStructure(raw: string): string | undefined {
	let decoded = raw;
	for (let depth = 0; depth < MAX_SENSITIVE_FRAGMENT_DECODE_DEPTH; depth += 1) {
		if (!decoded.includes("%")) return decoded;
		if (hasMalformedPercentEncoding(decoded)) {
			// A residual malformed escape is only meaningful as a failure once the
			// fragment has query-like structure; plain anchors remain byte-stable.
			return /[&=]/u.test(decoded) ? undefined : raw;
		}
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return decoded;
			decoded = next;
		} catch {
			return undefined;
		}
		if (!PERCENT_ESCAPE_PATTERN.test(decoded)) return decoded;
	}
	// If another valid escape remains, it may still conceal a structural
	// separator. Do not guess at its meaning after the policy bound.
	return PERCENT_ESCAPE_PATTERN.test(decoded) ? undefined : decoded;
}

function hasMalformedPercentEncoding(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "%") continue;
		if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) return true;
		index += 2;
	}
	return false;
}

export function hasSensitiveWorkflowQueryKey(url: URL): boolean {
	for (const key of url.searchParams.keys()) {
		if (isSensitiveWorkflowQueryKey(key)) return true;
	}
	return false;
}

/** True when a sensitive key could not be safely decoded to a stable name. */
export function hasUnsafeSensitiveWorkflowQueryKeyEncoding(
	key: string,
): boolean {
	const trimmed = key.trim();
	return Boolean(
		trimmed && trimmed.includes("%") && !fullyDecodeSensitiveKey(trimmed),
	);
}
