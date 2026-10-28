// Reads codex app-server account/rateLimits/read (no model call). Prints a scrubbed one-line JSON.
import { spawn } from "node:child_process";
const label = process.argv[2] ?? "gate";
const env = { ...process.env };
delete env.OPENAI_API_KEY;
const child = spawn("codex", ["app-server"], {
	stdio: ["pipe", "pipe", "pipe"],
	env,
	cwd: "/tmp",
});
let buf = "";
const pending = new Map();
let id = 0;
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		try {
			const m = JSON.parse(line);
			if (m.id !== undefined && pending.has(m.id)) {
				pending.get(m.id)(m);
				pending.delete(m.id);
			}
		} catch {}
	}
});
function req(method, params) {
	const n = ++id;
	child.stdin.write(
		JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n",
	);
	return new Promise((r) => pending.set(n, r));
}
const timer = setTimeout(() => {
	console.log(JSON.stringify({ label, error: "timeout" }));
	child.kill();
	process.exit(2);
}, 30000);
await req("initialize", {
	clientInfo: { name: "aw-live5-gate", version: "0" },
});
child.stdin.write(
	JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n",
);
const r = await req("account/rateLimits/read", {});
clearTimeout(timer);
const rl = r.result?.rateLimits ?? r.result ?? {};
const out = {
	label,
	at: new Date().toISOString(),
	ordinaryUsageAllowed:
		rl.ordinaryUsageAllowed ?? r.result?.ordinaryUsageAllowed,
	rateLimitReachedType: rl.rateLimitReachedType ?? null,
	primaryUsedPercent: rl.primary?.usedPercent,
	primaryWindowMins: rl.primary?.windowDurationMins,
	primaryResetsAt: rl.primary?.resetsAt
		? new Date(rl.primary.resetsAt * 1000).toISOString()
		: undefined,
	spendControlReached: rl.spendControl?.reached ?? rl.spendControlReached,
	error: r.error?.message,
};
console.log(JSON.stringify(out));
child.kill();
process.exit(0);
