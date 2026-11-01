// WP8: recorded Claude transcripts and the live-call log must stay scrubbed: no tokens, emails,
// account/org identifiers, absolute home paths, user names or host names.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
	new URL("../fixtures/executors/claude/", import.meta.url),
);

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

const PATTERNS = [
	["absolute macOS home path", /\/Users\/[A-Za-z0-9._-]+/u],
	["absolute Linux home path", /\/home\/[A-Za-z0-9._-]+\//u],
	["macOS per-user temp dir", /\/var\/folders\//u],
	[
		"email address",
		/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/u,
	],
	["Anthropic/OpenAI key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/u],
	[
		"OAuth access/refresh token",
		/\b(?:sk-ant-o[ar]t|oauth_token|refresh_token|access_token)\b/iu,
	],
	["bearer header", /Bearer\s+[A-Za-z0-9._-]{12,}/u],
	["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/u],
	[
		"account/org identifier field",
		/"(?:account_?uuid|organization_?uuid|orgId|org_id|accountId|emailAddress|organizationName|orgName)"\s*:\s*"(?!<)/iu,
	],
	["host name (.local)", /\b[A-Za-z0-9-]+\.local\b/u],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// The recording machine's user and host names (checked wherever the suite runs).
// Container/CI account names ("node" in the official Node image, "runner" on GitHub Actions) are
// ordinary words in recordings (".nvm/versions/node/…"), not a personal identity.
const GENERIC_ACCOUNTS = new Set([
	"node",
	"root",
	"runner",
	"user",
	"admin",
	"ubuntu",
	"debian",
	"docker",
	"builder",
	"vscode",
	"codespace",
	"app",
]);
const user = userInfo().username;
if (user.length >= 3 && !GENERIC_ACCOUNTS.has(user.toLowerCase()))
	PATTERNS.push(["local user name", new RegExp(`\\b${escape(user)}\\b`, "iu")]);
const host = hostname().replace(/\.local$/u, "");
if (host.length >= 3 && host !== "localhost")
	PATTERNS.push(["local host name", new RegExp(escape(host), "iu")]);

test("Claude fixtures contain no secrets, identities or absolute home paths", () => {
	const all = files(root).filter((path) =>
		/\.(jsonl|json|md|mjs)$/u.test(path),
	);
	assert.ok(all.length >= 15, `fixture files found: ${all.length}`);
	const hits = [];
	for (const path of all) {
		if (path.endsWith("fake-claude-mcp.mjs") || path.endsWith("harness.mjs"))
			continue;
		const text = readFileSync(path, "utf8");
		for (const [label, pattern] of PATTERNS)
			if (pattern.test(text)) hits.push(`${path.slice(root.length)}: ${label}`);
	}
	assert.deepEqual(hits, []);
});

test("the scrub patterns catch what they should", () => {
	const samples = {
		"absolute macOS home path": ["", "Users", "someone", ".claude"].join("/"),
		"email address": "person@example.com",
		"Anthropic/OpenAI key": "sk-ant-api03-abcdefghijklmnopqrstuv",
		"account/org identifier field": '"orgId":"123"',
		"host name (.local)": "my-mac.local",
	};
	for (const [label, sample] of Object.entries(samples)) {
		const pattern = PATTERNS.find(([name]) => name === label)[1];
		assert.ok(pattern.test(sample), label);
	}
	const redacted = PATTERNS.find(
		([name]) => name === "account/org identifier field",
	)[1];
	assert.ok(!redacted.test('"orgId":"<REDACTED>"'));
});
