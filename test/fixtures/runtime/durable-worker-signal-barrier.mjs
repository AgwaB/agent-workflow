// Preload for the lifecycle test. Hold the payload read (after the worker installs its
// SIGTERM handlers) until a real SIGTERM has been delivered, before the startup delay.
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const readFile = fs.readFile;
fs.readFile = async (path, ...args) => {
	if (path === process.argv[2]) {
		const guard = setTimeout(() => process.exit(2), 20_000);
		try {
			const signal = once(process, "SIGTERM");
			await fs.writeFile(`${path}.awaiting-sigterm`, "");
			await signal;
		} finally {
			clearTimeout(guard);
		}
	}
	return readFile(path, ...args);
};
syncBuiltinESMExports();
