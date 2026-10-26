// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/store-lease-contention.test.mjs. MIT, same author. Changes: imports from dist/core (subagent-backend names from their WP4c modules); fixture copied to test/fixtures/core/lease-handoff/contention.mjs.
import test from "node:test";
import { runContention } from "../fixtures/core/lease-handoff/contention.mjs";

// Real child processes, default product lease budgets/heartbeats, no caller
// retries. The fixture also supports bounded longer evidence runs directly.
for (const mode of ["topology", "publication", "usage", "mixed"]) {
	test(`four-process ${mode} handoffs repeatedly settle with exact durable counts`, {
		timeout: 250_000,
	}, async () => {
		await runContention({ mode, iterations: 30, repeats: 2 });
	});
}
