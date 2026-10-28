// Live bundle 5 (WP39), C2: on a real terminal `agent-workflow auto` answered "y" to
// "Send this task to claude to compare workflows? [y/N]" and printed "Not sent: you did not agree".
// The CLI's terminal prompt closed its readline interface before resolving the answer; `close`
// fires synchronously and resolved "" first, so every typed y/N (auto consent, the degradation
// confirmation, dynamic-controller approval, `approve`) was read as no answer. The unit tests of
// those flows script `io.prompt`, so they never ran the real readline prompt. Here the real
// readline prompt reads from a stream. No model or agent-CLI calls.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

const cli = await import("../../dist/hosts/cli/index.js");

function streams() {
	const input = new PassThrough();
	const output = new PassThrough();
	let shown = "";
	output.on("data", (chunk) => {
		shown += chunk.toString();
	});
	return { input, output, shown: () => shown };
}

test("readline prompt resolves the typed answer (y), not the close event's empty answer", async () => {
	const io = streams();
	const answer = cli.readlinePrompt(io.input, io.output)("Proceed? [y/N] ");
	io.input.write("y\n");
	assert.equal(await answer, "y");
	assert.match(io.shown(), /Proceed\? \[y\/N\] /);
});

test("readline prompt: two questions in a row on the same input (consent, then the choice)", async () => {
	const io = streams();
	const ask = cli.readlinePrompt(io.input, io.output);
	const first = ask("Send this task? [y/N] ");
	io.input.write("yes\n");
	assert.equal(await first, "yes");
	const second = ask("Start which workflow? [1-3, Enter = 1, n = cancel] ");
	io.input.write("2\n");
	assert.equal(await second, "2");
});

test("readline prompt: end of input and an abort resolve the empty answer", async () => {
	const ended = streams();
	const atEnd = cli.readlinePrompt(ended.input, ended.output)("Run? [y/n] ");
	ended.input.end();
	assert.equal(await atEnd, "");

	const aborted = streams();
	const controller = new AbortController();
	const pending = cli.readlinePrompt(aborted.input, aborted.output)(
		"Run? [y/n] ",
		{ signal: controller.signal },
	);
	controller.abort();
	assert.equal(await pending, "");
});

test("the CLI's process io uses the readline prompt", () => {
	assert.equal(typeof cli.processCliIo().prompt, "function");
});
