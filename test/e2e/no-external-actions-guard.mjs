// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/e2e/no-external-actions-guard.mjs. MIT, same author. Changes: env PI_WORKFLOW_E2E_*→AGENT_WORKFLOW_E2E_*; every stage-1 agent CLI (pi, codex, claude) is a blocked "agent-cli-executable" (was: pi only, "provider-executable"); the guard state symbol is agent-workflow's.
//
// Loaded into every Node process of `npm run e2e` (`NODE_OPTIONS=--import=<this file>`). It logs the
// process tree to AGENT_WORKFLOW_E2E_PROCESS_LOG and blocks, before they happen, every network
// connection and every child process that could install packages, act on a registry, fetch from the
// network or start a real agent CLI (and so a model call).
import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const enabled = process.env.AGENT_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS === "1";
const logPath = process.env.AGENT_WORKFLOW_E2E_PROCESS_LOG;
const stateKey = Symbol.for("agent-workflow.e2e-no-external-actions-guard");

export const AGENT_CLI_EXECUTABLES = ["pi", "codex", "claude"];

if (enabled && logPath && !globalThis[stateKey]) {
	globalThis[stateKey] = true;
	logEvent("process-start", {
		pid: process.pid,
		ppid: process.ppid,
		command: basename(process.execPath),
		argv: process.argv.slice(1, 8).map(boundedArgument),
	});
	installChildProcessGuard();
	installNetworkGuard();
}

function installChildProcessGuard() {
	for (const method of [
		"spawn",
		"spawnSync",
		"execFile",
		"execFileSync",
		"exec",
		"execSync",
	]) {
		const original = childProcess[method];
		const shell = method === "exec" || method === "execSync";
		const check = (command, args) => {
			const words = shell ? String(command).trim().split(/\s+/u) : [];
			const name = shell ? words[0] : command;
			const normalizedArgs = shell
				? words.slice(1)
				: Array.isArray(args)
					? args
					: [];
			const classification = classifyCommand(name, normalizedArgs);
			logEvent("child-process", {
				pid: process.pid,
				command: basename(String(name)),
				args: normalizedArgs.slice(0, 12).map(boundedArgument),
				classification,
			});
			if (classification !== "allowed") {
				logEvent("blocked-command", {
					pid: process.pid,
					command: basename(String(name)),
					classification,
				});
				throw new Error(`E2E external-action guard blocked ${classification}`);
			}
		};
		const guarded = function guardedChildProcess(command, args, ...rest) {
			check(command, args);
			return original.call(this, command, args, ...rest);
		};
		// exec/execFile carry a custom promisify ({stdout, stderr}); keep it, guarded.
		const custom = original[promisify.custom];
		if (typeof custom === "function")
			Object.defineProperty(guarded, promisify.custom, {
				value: function guardedPromisified(command, args, ...rest) {
					check(command, args);
					return custom.call(this, command, args, ...rest);
				},
			});
		childProcess[method] = guarded;
	}
	syncBuiltinESMExports();
}

export function classifyCommand(command, args) {
	const name = basename(String(command)).toLowerCase();
	if (["curl", "wget", "npx", "pnpx"].includes(name))
		return "network-or-package-executable";
	if (["pnpm", "yarn", "bun"].includes(name))
		return "alternate-package-manager";
	if (AGENT_CLI_EXECUTABLES.includes(name)) return "agent-cli-executable";
	if (name === "npm" || name === "npm-cli.js") return classifyNpm(args);
	if (
		(name === "node" || /^node(?:\.exe)?$/u.test(name)) &&
		/npm-cli\.js$/u.test(String(args[0] ?? ""))
	)
		return classifyNpm(args.slice(1));
	return "allowed";
}

export function classifyNpm(args) {
	const command = args.find(
		(argument) => typeof argument === "string" && !argument.startsWith("-"),
	);
	if (!command) return "allowed";
	if (
		[
			"install",
			"i",
			"ci",
			"add",
			"update",
			"uninstall",
			"remove",
			"rm",
			"link",
			"exec",
			"x",
		].includes(command)
	)
		return "package-install";
	if (
		[
			"access",
			"adduser",
			"deprecate",
			"dist-tag",
			"login",
			"logout",
			"org",
			"owner",
			"ping",
			"profile",
			"publish",
			"star",
			"stars",
			"team",
			"token",
			"unpublish",
			"view",
			"whoami",
		].includes(command)
	)
		return "registry-action";
	return "allowed";
}

function installNetworkGuard() {
	const block = (operation) => {
		logEvent("network-attempt", { pid: process.pid, operation });
		throw new Error(
			`E2E external-action guard blocked network operation ${operation}`,
		);
	};

	const originalSocketConnect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function guardedSocketConnect(..._args) {
		return block("net.Socket.connect");
	};
	Object.defineProperty(net.Socket.prototype.connect, "name", {
		value: originalSocketConnect.name,
	});
	net.createConnection = (..._args) => block("net.createConnection");
	net.connect = (..._args) => block("net.connect");
	tls.connect = (..._args) => block("tls.connect");
	http.request = (..._args) => block("http.request");
	http.get = (..._args) => block("http.get");
	https.request = (..._args) => block("https.request");
	https.get = (..._args) => block("https.get");
	dns.lookup = (..._args) => block("dns.lookup");
	dns.resolve = (..._args) => block("dns.resolve");
	dnsPromises.lookup = (..._args) => block("dns.promises.lookup");
	dnsPromises.resolve = (..._args) => block("dns.promises.resolve");
	globalThis.fetch = (..._args) => block("fetch");
	syncBuiltinESMExports();
}

function boundedArgument(value) {
	return String(value)
		.replace(/[\r\n]/gu, " ")
		.slice(0, 240);
}

function logEvent(type, details) {
	appendFileSync(
		logPath,
		`${JSON.stringify({ type, at: new Date().toISOString(), ...details })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}
