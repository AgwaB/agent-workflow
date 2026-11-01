// Opt-in preload for stress-pi-waits.mjs, never loaded by the normal unit suite. Preserve the
// fixture's project (attempts, events, worker logs, authority, supervisor lease and effect logs)
// before its after-hook removes it. The unit runner retains each isolated home with this evidence.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const rm = fs.promises.rm;
fs.promises.rm = async function captureProject(path, options) {
	if (
		typeof path === "string" &&
		basename(path).startsWith("aw-wp28-pi-waits-")
	) {
		const destination = join(process.env.HOME, "evidence", basename(path));
		await fs.promises.mkdir(join(process.env.HOME, "evidence"), {
			recursive: true,
		});
		await fs.promises.cp(path, destination, { recursive: true });
		console.error("captured project:", destination);
	}
	return rm(path, options);
};
syncBuiltinESMExports();
