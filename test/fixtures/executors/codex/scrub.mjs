// Scrubs a raw adapter transcript (`codex-app-server.jsonl`) into a committable fixture:
// no tokens, emails, account/installation ids, hostnames, absolute home or temp paths. Drops
// stderr (OTel noise naming local endpoints) and every `account/*` / `remoteControl/*`
// notification. Usage: node scrub.mjs <raw.jsonl> <out.jsonl> [--cwd <dir>] [--state <dir>]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const DROP_METHODS = /^(?:account\/|remoteControl\/|mcpServer\/oauth)/u;

export function scrubText(text, { cwd, state } = {}) {
	let out = text;
	const replaceAll = (from, to) => {
		if (from) out = out.split(from).join(to);
	};
	for (const dir of [cwd, state].filter(Boolean)) {
		replaceAll(`/private${dir}`, dir);
	}
	replaceAll(state, "<STATE>");
	replaceAll(cwd, "<CWD>");
	replaceAll(homedir(), "<HOME>");
	return out
		.replace(/\/Users\/[A-Za-z0-9._-]+/gu, "<HOME>")
		.replace(/\/(?:private\/)?tmp\/aw-live-codex-[A-Za-z0-9._-]+/gu, "<TMP>")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<EMAIL>")
		.replace(/\b[A-Za-z0-9-]+\.local\b/gu, "<HOST>")
		.replace(/\(Mac OS [^)]*\)(?: [A-Za-z0-9_.-]+\/[0-9.]+)?/gu, "(<OS>)")
		.replace(/\breq_[A-Za-z0-9]+/gu, "<REQUEST_ID>")
		.replace(/cf-ray: [A-Za-z0-9-]+/gu, "cf-ray: <CF_RAY>")
		.replace(
			/"(installationId|chatgptAccountId|accountId|userId|planType|balance)":"[^"]*"/gu,
			'"$1":"<REDACTED>"',
		)
		.replace(/\b(sk|sess|rt|at)-[A-Za-z0-9_-]{16,}/gu, "<TOKEN>")
		.replace(
			/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
			"<JWT>",
		);
}

export function scrubEntries(entries, options) {
	return entries
		.filter((entry) => entry.dir !== "stderr")
		.filter(
			(entry) =>
				!(
					typeof entry.msg?.method === "string" &&
					DROP_METHODS.test(entry.msg.method)
				),
		)
		.map(({ dir, msg }) =>
			JSON.parse(scrubText(JSON.stringify({ dir, msg }), options)),
		);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [input, output, ...rest] = process.argv.slice(2);
	const flag = (name) => {
		const at = rest.indexOf(name);
		return at >= 0 ? rest[at + 1] : undefined;
	};
	const entries = readFileSync(input, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
	const scrubbed = scrubEntries(entries, {
		cwd: flag("--cwd"),
		state: flag("--state"),
	});
	writeFileSync(
		output,
		`${scrubbed.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}
