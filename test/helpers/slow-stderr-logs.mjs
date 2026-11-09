import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/**
 * Slows every write to an executor's `*-stderr.log` file. An adapter must have its stderr log on disk before it
 * reports the terminal event, so a test that reads the log right after that event must pass however long the
 * write takes; the delay only makes a log that is still being written show up as a missing line.
 */
export function slowStderrLogs(t, delayMs = 100) {
	const original = fs.createWriteStream;
	fs.createWriteStream = function (path, options) {
		const stream = original.call(this, path, options);
		if (String(path).endsWith("-stderr.log")) {
			for (const method of ["_write", "_writev"]) {
				const write = stream[method]?.bind(stream);
				if (write)
					stream[method] = (...args) =>
						setTimeout(() => write(...args), delayMs);
			}
		}
		return stream;
	};
	syncBuiltinESMExports();
	t.after(() => {
		fs.createWriteStream = original;
		syncBuiltinESMExports();
	});
}
