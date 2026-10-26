// Test fixture (WP2a-2): an executor module that a durable worker can reload from its
// descriptor in a fresh process (`loadExecutor`). It wraps the SDK fake executor and appends
// every authority decision, effect, cancel and reconcile to an effect log file, so a parent
// test observes effects that happened in another process.
//
// Config (descriptor.config, JSON):
//   effectLog   absolute path of the JSONL effect log (required)
//   mode        "normal" | "hang-after-effect" | "skip-consume" | "crash-after-consume"
//   id, version executor id/version this module builds (default "fixture" / "0.1.0")
//   script      FakeStep[] (default: started, delta, usage(cost null), completed)
//   stepDelayMs delay between script steps
//   sessionBound  capability flag (default false)
//   reconcile   "log" (default: from the effect log) | "found" (report found for logged effects)
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeExecutor } from "@agwab/agent-workflow/sdk/testing";

export const FIXTURE_MODULE = fileURLToPath(import.meta.url);

export const FIXTURE_SCRIPT = [
	{ type: "started", sessionId: "fixture-session" },
	{ type: "message_delta", text: "fixture " },
	{
		type: "usage",
		input: 10,
		output: 5,
		cached: null,
		cost: null,
		source: "unknown",
	},
	{ type: "message_delta", text: "output" },
	{
		type: "usage",
		input: 2,
		output: 3,
		cached: null,
		cost: null,
		source: "unknown",
	},
	{ type: "completed", finalText: "fixture final answer" },
];

/** Descriptor for this module (what a run record stores). */
export function fixtureDescriptor(config, overrides = {}) {
	return {
		id: config.id ?? "fixture",
		version: config.version ?? "0.1.0",
		contractVersion: "0.1.0",
		module: FIXTURE_MODULE,
		config,
		...overrides,
	};
}

export function readEffectLog(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

function log(path, entry) {
	appendFileSync(
		path,
		`${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`,
	);
}

export function createExecutor(config) {
	const effectLog = config?.effectLog;
	if (typeof effectLog !== "string") throw new Error("fixture needs effectLog");
	const mode = config.mode ?? "normal";
	const script = config.script ?? FIXTURE_SCRIPT;
	const inner = createFakeExecutor({
		id: config.id ?? "fixture",
		version: config.version ?? "0.1.0",
		script,
		...(config.stepDelayMs === undefined
			? {}
			: { stepDelayMs: config.stepDelayMs }),
		faults: {
			skipConsume: mode === "skip-consume",
			crashAfterConsume: mode === "crash-after-consume",
		},
	});
	const released = new Set();
	const caps = {
		...inner.capabilities(),
		sessionBound: config.sessionBound === true,
	};
	return {
		id: inner.id,
		version: inner.version,
		contractVersion: inner.contractVersion,
		probe: () => inner.probe(),
		capabilities: () => caps,
		async submit(req) {
			const attemptKey = req.attemptKey;
			log(effectLog, {
				type: "submit",
				attemptKey,
				cwd: req.cwd,
				prompt: req.prompt,
				artifactsDir: req.artifactsDir ?? null,
				envKeys: Object.keys(req.env ?? {}),
			});
			const authority = {
				attemptKey: req.authority.attemptKey,
				async consume() {
					try {
						const decision = await req.authority.consume();
						if (decision.kind === "released") released.add(attemptKey);
						log(effectLog, {
							type: "consume",
							attemptKey,
							outcome: decision.kind,
							bindingSchema: req.authority.binding?.()?.schema ?? null,
							...(decision.kind === "revoked"
								? { reason: decision.reason }
								: {}),
						});
						return decision;
					} catch (error) {
						log(effectLog, {
							type: "consume",
							attemptKey,
							outcome: "rejected",
							code: error?.code ?? null,
							message: String(error?.message ?? error),
						});
						throw error;
					}
				},
			};
			const before = inner.effectCount(attemptKey);
			let ref;
			try {
				ref = await inner.submit({ ...req, authority });
			} finally {
				if (inner.effectCount(attemptKey) > before)
					log(effectLog, {
						type: "effect",
						attemptKey,
						authorized: released.has(attemptKey),
					});
			}
			log(effectLog, { type: "ref", attemptKey, ref });
			// Keep the event loop alive: the test kills this process while it "runs".
			if (mode === "hang-after-effect")
				await new Promise(() => setInterval(() => {}, 1000));
			return ref;
		},
		async *observe(ref) {
			if (inner.store.attempts.get(ref.attemptKey)?.run !== undefined) {
				yield* inner.observe(ref);
				return;
			}
			// Another process launched it: replay the script (adoption by reconcile).
			log(effectLog, { type: "adopt-observe", attemptKey: ref.attemptKey });
			for (const step of script) yield step;
		},
		async cancel(ref, scope) {
			const result = await inner.cancel(ref, scope);
			log(effectLog, {
				type: "cancel",
				attemptKey: ref.attemptKey,
				scope,
				result,
			});
			return result;
		},
		async reconcile(attemptKey) {
			let result;
			if (inner.store.attempts.has(attemptKey))
				result = await inner.reconcile(attemptKey);
			else {
				const entries = readEffectLog(effectLog).filter(
					(entry) => entry.attemptKey === attemptKey,
				);
				const effect = entries.find((entry) => entry.type === "effect");
				const refEntry = entries.find((entry) => entry.type === "ref");
				const consumed = entries.some(
					(entry) => entry.type === "consume" && entry.outcome === "released",
				);
				if (effect !== undefined && config.reconcile === "found")
					result = {
						found: refEntry?.ref ?? {
							executorId: inner.id,
							attemptKey,
							handle: `fixture-adopted-${attemptKey}`,
						},
					};
				else if (effect !== undefined || consumed)
					result = {
						unknown: true,
						reason: "effect logged by a process that is gone",
					};
				else result = { absent: true };
			}
			log(effectLog, { type: "reconcile", attemptKey, result });
			return result;
		},
		respond: (ref, requestId, decision) =>
			inner.respond(ref, requestId, decision),
	};
}
