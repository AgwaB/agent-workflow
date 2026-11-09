// Loaded into every unit-tier test process by `test/run-unit.mjs --tier=unit` (2026-11-10). A unit test must not
// start a process that runs alongside it (a worker, a CLI, an agent stub) or open a server: those make the result
// depend on timing and load. Such a call fails at once with the fix. Short helpers that run to completion (git, the
// macOS process-identity helper, pdftotext) and spawning a binary that does not exist are allowed.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename } from "node:path";
import { promisify } from "node:util";

const LONG_LIVED = new Set([
	basename(process.execPath),
	"node",
	"codex",
	"claude",
	"pi",
	"agy",
	"agy_acp_server",
	"stub-cli",
	"codex-stub",
	"fake-gemini",
]);
const fix =
	"a unit-tier test started it; add `// test-tier: integration` as the file's first line (see test/run-unit.mjs)";

function refuse(what) {
	throw new Error(`unit tier: ${what} — ${fix}`);
}

function guarded(name, original) {
	const check = (command) => {
		const program = basename(String(command));
		if (name === "fork" || LONG_LIVED.has(program))
			refuse(`${name}(${program})`);
	};
	const wrapper = function (command, ...rest) {
		check(command);
		return original.call(this, command, ...rest);
	};
	const custom = original[promisify.custom];
	if (custom)
		wrapper[promisify.custom] = function (command, ...rest) {
			check(command);
			return custom.call(this, command, ...rest);
		};
	return wrapper;
}

for (const name of ["spawn", "fork", "execFile", "exec"])
	childProcess[name] = guarded(name, childProcess[name]);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
	refuse("a server opened a port");
	return listen.apply(this, args);
};
syncBuiltinESMExports();
