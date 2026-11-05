// 2026-11-05 (live, the Claude desktop app's Code tab): the app's own server (started in ~) is also
// offered to Code sessions; a model called it without cwd and the run went to home-runs. That
// connection declares `roots` and roots/list names the session's folder, so a call without cwd uses
// the client's single root; an explicit cwd may lie in a client root; several roots need a cwd.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const tools = await import("../../dist/mcp/host-server/tools.js");

let base;
before(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "aw-client-roots-")));
});
after(async () => {
	await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const call = ({ roots, capability = true, fail = false } = {}) => {
	const requests = [];
	return {
		requests,
		protocolVersion: "2025-11-25",
		clientCapabilities: capability ? { roots: {} } : {},
		signal: new AbortController().signal,
		sendRequest: async (method, params) => {
			requests.push([method, params]);
			if (fail) throw new Error("client error");
			return {
				roots: roots.map((dir) => ({
					uri:
						typeof dir === "string" && dir.startsWith("file:")
							? dir
							: pathToFileURL(dir).href,
					name: "r",
				})),
			};
		},
		sendNotification: () => undefined,
	};
};

test("a call without cwd takes the client's single root; none, failing or absent roots keep the server root", async () => {
	const serverRoot = join(base, "home");
	const project = join(base, "elsewhere", "research");
	await mkdir(serverRoot, { recursive: true });
	await mkdir(project, { recursive: true });
	const resolveDir = tools.resolveCallDirectory;
	const one = call({ roots: [project] });
	assert.equal(await resolveDir(serverRoot, undefined, one), project);
	assert.deepEqual(one.requests, [["roots/list", {}]]);
	assert.equal(
		await resolveDir(serverRoot, undefined, call({ roots: [] })),
		serverRoot,
	);
	assert.equal(
		await resolveDir(
			serverRoot,
			undefined,
			call({ roots: [join(base, "gone")] }),
		),
		serverRoot,
	);
	assert.equal(
		await resolveDir(
			serverRoot,
			undefined,
			call({ roots: ["https://example.com/x"] }),
		),
		serverRoot,
	);
	assert.equal(
		await resolveDir(
			serverRoot,
			undefined,
			call({ roots: [project], fail: true }),
		),
		serverRoot,
	);
	const none = call({ roots: [project], capability: false });
	assert.equal(await resolveDir(serverRoot, undefined, none), serverRoot);
	assert.deepEqual(none.requests, [], "no roots capability: never asked");
	assert.equal(await resolveDir(serverRoot, undefined, undefined), serverRoot);
});

test("an explicit cwd: inside the server root as before, or inside a client root; several roots need it", async () => {
	const serverRoot = join(base, "home2");
	const inside = join(serverRoot, "repo");
	const a = join(base, "roots", "a");
	const b = join(base, "roots", "b");
	for (const dir of [inside, join(a, "sub"), b])
		await mkdir(dir, { recursive: true });
	const resolveDir = tools.resolveCallDirectory;
	const plain = call({ roots: [a] });
	assert.equal(await resolveDir(serverRoot, inside, plain), inside);
	assert.deepEqual(
		plain.requests,
		[],
		"a cwd inside the server root needs no roots/list",
	);
	assert.equal(
		await resolveDir(serverRoot, join(a, "sub"), call({ roots: [a] })),
		join(a, "sub"),
	);
	await assert.rejects(
		resolveDir(serverRoot, join(a, "sub"), call({ roots: [b] })),
		/outside the server's project root/,
	);
	await assert.rejects(
		resolveDir(serverRoot, join(a, "sub"), undefined),
		/outside the server's project root/,
	);
	await assert.rejects(
		resolveDir(serverRoot, undefined, call({ roots: [a, b] })),
		/several roots .*pass cwd/,
	);
	assert.equal(await resolveDir(serverRoot, b, call({ roots: [a, b] })), b);
});

test("the server's tools use it: a status call without cwd reads the client root's project", async () => {
	const serverRoot = join(base, "home3");
	const project = join(base, "proj3");
	await mkdir(serverRoot, { recursive: true });
	await mkdir(project, { recursive: true });
	const seen = [];
	const api = new Proxy(
		{},
		{
			get(_, name) {
				if (name === "registerTestExecutorFromEnv")
					return async () => undefined;
				if (name === "statusAction")
					return async (ctx) => {
						seen.push(ctx.cwd);
						return {
							action: "status",
							ok: true,
							outcome: "success",
							text: "no runs",
							data: { runs: [] },
						};
					};
				return undefined;
			},
		},
	);
	const service = tools.createHostMcpService({
		root: serverRoot,
		host: "generic",
		env: {},
		api,
	});
	await service.call("workflow_status", {}, call({ roots: [project] }));
	await service.call(
		"workflow_status",
		{},
		call({ roots: [], capability: false }),
	);
	assert.deepEqual(seen, [project, serverRoot]);
});
