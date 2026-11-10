import { writeSync } from "node:fs";

// Shared by the scripted agent and the signal-ordering regression. Hooks hold the response/stderr
// boundary over IPC; without hooks this is the fixture's original synchronous write-and-exit path.
export async function finishLateAuthentication(
	id,
	{ afterResponse, onStop } = {},
) {
	// A client may stop us as soon as it reads stdout. Only our own exit may end this scenario.
	process.on("SIGTERM", () => onStop?.());
	writeSync(1, `${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
	if (afterResponse) await afterResponse();
	writeSync(2, "Signed in: https://example.invalid/done\n");
	process.exit(0);
}
