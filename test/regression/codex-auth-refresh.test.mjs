// test-tier: integration
// Codex token refresh through a private worker home (2026-11-10; part of `npm run test:regression`, local only).
// Isolated Codex workers run in a private CODEX_HOME whose auth.json is a symlink to the user's; that is only safe
// while Codex writes refreshed tokens in place, so the user's file gets them. This runs the installed codex binary
// (or AGENT_WORKFLOW_CODEX_PATH) against a throwaway login and local fake servers: three workers start with an
// expired access token, the OAuth server rotates refresh tokens and answers a reused one with
// `refresh_token_reused`, as the real one does. No real login is read or written and no model is called.
// A Codex release that replaced auth.json instead (temp file + rename) would leave the user's file with the spent
// refresh token and fail this test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import { createExecutor } from "../../dist/executors/codex/index.js";
import { waitUntil } from "../helpers/wait-until.mjs";

// test/run-unit.mjs puts a blocking `codex` shim first on PATH; this test needs the real binary (it only ever sees a
// throwaway login and local servers), so it looks past the runner's shim directory.
function realCodex() {
	if (process.env.AGENT_WORKFLOW_CODEX_PATH)
		return process.env.AGENT_WORKFLOW_CODEX_PATH;
	const shimDir = process.env.HOME ? join(process.env.HOME, "bin") : undefined;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir || dir === shimDir) continue;
		const candidate = join(dir, "codex");
		if (existsSync(candidate)) return candidate;
	}
	return "codex";
}
const CODEX = realCodex();
const version = spawnSync(CODEX, ["--version"], { encoding: "utf8" });
const skip =
	version.status === 0 ? false : `no codex binary (${CODEX}) to run against`;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) =>
	`${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig`;

function fakeServers({ newAccess, idToken }) {
	const log = { accepted: [], reused: 0, bearers: [] };
	const spent = new Set();
	let issued = 0;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		if (req.url.startsWith("/oauth/token")) {
			const { refresh_token: token } = JSON.parse(body || "{}");
			if (spent.has(token)) {
				log.reused++;
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: "refresh_token_reused" } }));
				return;
			}
			spent.add(token);
			log.accepted.push(token);
			issued++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id_token: idToken,
					access_token: newAccess,
					refresh_token: `refresh-new-${issued}`,
				}),
			);
			return;
		}
		if (req.method === "POST" && req.url.includes("/responses")) {
			log.bearers.push(req.headers.authorization?.slice("Bearer ".length));
			const events = [
				{ type: "response.created", response: { id: "resp-1" } },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						role: "assistant",
						id: "msg-1",
						content: [{ type: "output_text", text: "refresh check ok" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						usage: {
							input_tokens: 1,
							input_tokens_details: null,
							output_tokens: 1,
							output_tokens_details: null,
							total_tokens: 2,
						},
					},
				},
			];
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				events
					.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
					.join(""),
			);
			return;
		}
		// Plugin, model-list, analytics and account calls: not needed for a turn.
		res.writeHead(404);
		res.end();
	});
	return { server, log };
}

function privateHomes(stateDir) {
	const attempts = join(stateDir, "attempts");
	if (!existsSync(attempts)) return [];
	return readdirSync(attempts)
		.map((name) => join(attempts, name, "home"))
		.filter((path) => existsSync(path));
}

test("codex refresh in private worker homes reaches the user's auth.json (3 workers, rotating tokens)", {
	skip,
	timeout: 180_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "aw-codex-refresh-"));
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		email: "user@example.com",
		"https://api.openai.com/auth": {
			chatgpt_plan_type: "pro",
			chatgpt_account_id: "acct_fake",
			chatgpt_user_id: "user_fake",
		},
	};
	const oldAccess = jwt({ ...claims, iat: now - 864_000, exp: now - 3600 });
	const newAccess = jwt({ ...claims, iat: now, exp: now + 864_000 });
	const idToken = jwt({ ...claims, iat: now, exp: now + 864_000 });
	const { server, log } = fakeServers({ newAccess, idToken });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const origin = `http://127.0.0.1:${server.address().port}`;
		const userHome = join(root, "user-codex-home");
		mkdirSync(userHome);
		writeFileSync(
			join(userHome, "config.toml"),
			[
				'model_provider = "fake"',
				'model = "fake-model"',
				`chatgpt_base_url = "${origin}/backend-api/"`,
				"",
				"[model_providers.fake]",
				'name = "fake"',
				`base_url = "${origin}/v1"`,
				'wire_api = "responses"',
				"requires_openai_auth = true",
				"",
			].join("\n"),
		);
		const authPath = join(userHome, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				OPENAI_API_KEY: null,
				auth_mode: "chatgpt",
				tokens: {
					id_token: idToken,
					access_token: oldAccess,
					refresh_token: "refresh-old",
					account_id: "acct_fake",
				},
				last_refresh: new Date(Date.now() - 9 * 86_400_000).toISOString(),
			}),
			{ mode: 0o600 },
		);
		writeFileSync(join(userHome, "auth.lock"), "");
		const project = join(root, "project");
		mkdirSync(project);
		const stateDir = join(root, ".state");
		const executor = createExecutor({ stateDir, codexPath: CODEX });
		const env = {
			CODEX_HOME: userHome,
			CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${origin}/oauth/token`,
			OPENAI_API_KEY: undefined,
			CODEX_API_KEY: undefined,
		};
		const runOne = async (index) => {
			const attemptKey = `refresh-${index}-${Date.now()}`;
			const gate = createAuthorityGate({ attemptKey });
			const ref = await executor.submit({
				attemptKey,
				authority: gate.authority,
				cwd: project,
				prompt: "Reply with: refresh check ok",
				model: "fake-model",
				effort: "low",
				tools: ["read"],
				readOnly: true,
				mcpServers: [],
				deadlineMs: Date.now() + 120_000,
				env,
				isolation: { inherit: false },
				approvalPolicy: defaultApprovalPolicy(),
				artifactsDir: join(root, `artifacts-${index}`),
			});
			const events = [];
			for await (const event of executor.observe(ref)) events.push(event);
			return events.at(-1);
		};
		const terminals = await Promise.all([0, 1, 2].map(runOne));
		const detail = JSON.stringify({ version: version.stdout.trim(), log });
		for (const terminal of terminals)
			assert.equal(terminal?.type, "completed", JSON.stringify(terminal));

		// The spent refresh token was accepted once; the user's file holds what that refresh issued, as a regular
		// owner-only file (not replaced by a link or a copy elsewhere).
		assert.deepEqual(log.accepted.slice(0, 1), ["refresh-old"], detail);
		const after = JSON.parse(readFileSync(authPath, "utf8"));
		assert.equal(after.tokens.access_token, newAccess, detail);
		assert.equal(
			after.tokens.refresh_token,
			`refresh-new-${log.accepted.length}`,
			detail,
		);
		assert.ok(lstatSync(authPath).isFile());
		assert.equal(lstatSync(authPath).mode & 0o777, 0o600);
		// Every model request carried the refreshed access token.
		assert.equal(log.bearers.length, 3, detail);
		assert.ok(
			log.bearers.every((bearer) => bearer === newAccess),
			detail,
		);
		// Private homes end with their attempts; nothing was kept aside as a replaced login.
		await waitUntil(
			() => privateHomes(stateDir),
			"the private CODEX_HOMEs to be removed",
			{ accepts: (homes) => homes.length === 0, timeoutMs: 15_000 },
		);
		assert.equal(existsSync(join(stateDir, "replaced-auth")), false);
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
