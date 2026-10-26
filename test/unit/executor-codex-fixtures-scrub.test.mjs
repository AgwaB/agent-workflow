// WP7: committed codex fixtures carry no secrets or personal data — no tokens, emails, account or
// installation ids, hostnames, absolute home or live temp paths.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
	new URL("../fixtures/executors/codex", import.meta.url),
);

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

const FORBIDDEN = [
	["macOS home path", /\/Users\/[A-Za-z0-9._-]+/u],
	["Linux home path", /\/home\/[A-Za-z0-9._-]+\//u],
	["live temp path", /\/(?:private\/)?tmp\/aw-live-codex-[A-Za-z0-9]/u],
	[
		"email address",
		/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/u,
	],
	["hostname", /\b[A-Za-z0-9-]+\.local\b/u],
	["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u],
	["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/u],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/u],
	["bearer header", /Bearer [A-Za-z0-9._-]{12,}/u],
	["OpenAI request id", /\breq_[A-Za-z0-9]{12,}/u],
	[
		"account id field",
		/"(?:chatgptAccountId|accountId|installationId|userId)":"(?!<REDACTED>)[^"]+"/u,
	],
	["plan / credit balance", /"(?:planType|balance)":"(?!<REDACTED>)[^"]+"/u],
	["account notification", /"method":"(?:account\/|remoteControl\/)/u],
	[
		"access/refresh token field",
		/"(?:access_token|refresh_token|id_token|authToken)":"[^"]+"/u,
	],
];

test("codex fixtures contain no secrets, personal data or local paths", () => {
	const all = files(root);
	assert.ok(
		all.some((path) => path.endsWith(".jsonl")),
		"recorded transcripts present",
	);
	const hits = [];
	for (const path of all) {
		const text = readFileSync(path, "utf8");
		for (const [label, pattern] of FORBIDDEN) {
			const match = pattern.exec(text);
			if (match !== null)
				hits.push(
					`${relative(root, path)}: ${label} (${match[0].slice(0, 40)})`,
				);
		}
	}
	assert.deepEqual(hits, []);
});

test("the scrubber removes every forbidden pattern from a dirty sample", async () => {
	const { scrubText } = await import("../fixtures/executors/codex/scrub.mjs");
	const dirty = JSON.stringify({
		// Built from parts so this file does not trip the repository's home-path check.
		a: ["", "Users", "someone", ".codex", "AGENTS.md"].join("/"),
		b: "mail me@example.com",
		c: "serverName tobys-MacBook-Pro.local",
		d: "request id: req_c324f913b9fc4b5fa879763570fe33f7",
		e: "/private/tmp/aw-live-codex-smoke-uGQ25l/work/a.txt",
		installationId: "eff3bd27-fb60-44e2-83cf-530336098b34",
		planType: "pro",
		token: "sk-proj-abcdefghijklmnopqrstuvwx",
	});
	const clean = scrubText(dirty, {});
	for (const [label, pattern] of FORBIDDEN)
		assert.doesNotMatch(clean, pattern, label);
});
