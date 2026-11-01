// Local-only executor for generate-dashboard-matrix.mjs, loaded through the guarded CLI test hook.
// Emits SDK events and creates one retry marker in its disposable project; never calls a provider.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeExecutor } from "../../dist/sdk/testing/index.js";
export const testExecutorDescriptor = {
	id: "test-matrix",
	version: "0.1.0",
	contractVersion: "0.1.0",
	module: fileURLToPath(import.meta.url),
	config: null,
};
const control = (value) =>
	`<control>\n${JSON.stringify({ schema: "stage-control-v1", digest: "검증 결과 — evidence checked", status: "verified", ...value })}\n</control>\n<analysis>Local matrix fixture; no provider call.</analysis>\n<refs>[]</refs>`;
export function createExecutor() {
	const inners = new Map();
	const probe = createFakeExecutor({ id: "test-matrix" });
	function inner(req) {
		if (inners.has(req.attemptKey)) return inners.get(req.attemptKey);
		const prompt = req.prompt;
		const n = Number(/MATRIX-ITEMS=(\d+)/.exec(prompt)?.[1] ?? 0);
		const item = /"id"\s*:\s*"(c\d+)"/.exec(prompt)?.[1];
		let failure =
			/MATRIX-FAIL/.test(prompt) &&
			(!/MATRIX-MIXED/.test(prompt) || item === "c2");
		let transient = false;
		if (/MATRIX-MIXED/.test(prompt) && item === "c3") {
			const marker = join(req.cwd, ".matrix-retried");
			if (!existsSync(marker)) {
				writeFileSync(marker, "1");
				transient = true;
			}
		}
		const text = control(
			n
				? {
						items: Array.from({ length: n }, (_, i) => ({
							id: `c${i + 1}`,
							title: `검증 항목 ${i + 1} — ${"Very long evidence title with no truncation of meaning ".repeat(i === 0 ? 7 : 1)}`,
						})),
					}
				: {},
		);
		const script = [
			{ type: "started", sessionId: null },
			{
				type: "tool_call",
				name: "Read",
				kind: "read",
				status: "running",
				callId: "matrix-read",
				input: {
					file_path: `/tmp/matrix/${"아주 긴 활동 이름 evidence source ".repeat(12)}.md`,
				},
			},
			{
				type: "tool_call",
				name: "Bash",
				kind: "execute",
				status: "running",
				callId: "matrix-exec",
				input: { command: `rg -n '${"검증할 증거 ".repeat(24)}' sources.txt` },
			},
			...(failure || transient
				? [
						{
							type: "failed",
							class: transient ? "transient" : "auth",
							raw: null,
							message: transient
								? "Temporary connection failure; retry this item"
								: "Selected matrix item failed",
						},
					]
				: [
						{ type: "message_delta", text },
						{
							type: "usage",
							input: 10,
							output: 5,
							cached: null,
							cost: null,
							source: "unknown",
						},
						{ type: "completed", finalText: text },
					]),
		];
		const result = createFakeExecutor({
			id: "test-matrix",
			version: "0.1.0",
			script,
			stepDelayMs: /MATRIX-SLOW/.test(prompt) ? 1400 : 350,
			faults: { crashAfterConsume: /MATRIX-CRASH/.test(prompt) },
		});
		inners.set(req.attemptKey, result);
		return result;
	}
	return {
		id: "test-matrix",
		version: "0.1.0",
		contractVersion: "0.1.0",
		probe: () => probe.probe(),
		capabilities: () => probe.capabilities(),
		submit: (req) => inner(req).submit(req),
		observe: (ref) => inners.get(ref.attemptKey).observe(ref),
		cancel: (ref, scope) =>
			inners.get(ref.attemptKey)?.cancel(ref, scope) ?? "no_active",
		reconcile: (key) =>
			inners.get(key)?.reconcile(key) ?? {
				unknown: true,
				reason: "test attempt absent",
			},
		respond: (ref, id, decision) =>
			inners.get(ref.attemptKey).respond(ref, id, decision),
		deleteOwnedSession: async () => "deleted",
	};
}
