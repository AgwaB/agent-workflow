/**
 * Executor rediscovery (stage-1 plan §2.1 [R#15], design §9.2, owner decision B1).
 * A detached supervisor or a resumed run cannot receive adapter objects; it receives an
 * `ExecutorDescriptor` (data) stored in the run record and reloads the adapter from `module`.
 * Missing modules, id mismatches and incompatible versions are refused — never substituted.
 *
 * The descriptor is persisted as is (the runtime writes it to `worker.json` and `executor.json`,
 * and run records may copy it), so `config` must never carry a secret. Credentials go through
 * `SubmitRequest.env` (or `McpServerSpec.env`), which the runtime keeps off disk (WP2c, D1).
 * `validateExecutorDescriptor` refuses config values that look like tokens (WP2b,
 * `findSecretLikeConfigValues`).
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assertWorkflowExecutor,
	EXECUTOR_CONTRACT_VERSION,
	isContractCompatible,
	isVersionCompatible,
	type WorkflowExecutor,
} from "./contract.js";
import { SdkError } from "./errors.js";
import { isJsonValue, isPlainObject, type JsonValue } from "./json.js";

export interface ExecutorDescriptor {
	readonly id: string;
	/** Adapter version at submit time; reload requires a compatible version. */
	readonly version: string;
	readonly contractVersion: string;
	/** Package specifier (`@agwab/agent-workflow/executors/codex`), absolute path, or `file:` URL. */
	readonly module: string;
	/**
	 * JSON-only adapter configuration. Persisted in plain text (`worker.json`, `executor.json`, run
	 * records), so it must not contain secrets: API keys, tokens and passwords go through
	 * `SubmitRequest.env`, which is never written to disk. Values that look like tokens (`sk-…`,
	 * `ghp_…`, `xox…-`, AWS/Google keys, private keys, JWTs, or a long hex/base64 value under a
	 * key-like name such as `apiKey`/`token`/`secret`/`password`) are refused by
	 * `validateExecutorDescriptor` with `DESCRIPTOR_INVALID`.
	 */
	readonly config: JsonValue;
}

/** What an adapter module exports so `loadExecutor` can rebuild it in a new process. */
export interface ExecutorModule {
	createExecutor(
		config: JsonValue,
	): WorkflowExecutor | Promise<WorkflowExecutor>;
}

/** Token shapes that are secrets whatever key they sit under. */
const SECRET_VALUE_PATTERNS: readonly (readonly [string, RegExp])[] = [
	[
		"OpenAI/Anthropic-style key (sk-…)",
		/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/u,
	],
	["GitHub token (gh?_…)", /\bgh[pousr]_[A-Za-z0-9]{20,}/u],
	["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}/u],
	["GitLab token (glpat-…)", /\bglpat-[A-Za-z0-9_-]{16,}/u],
	["Slack token (xox?-…)", /\bxox[abposr]-[A-Za-z0-9-]{10,}/u],
	["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}/u],
	["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
	["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
];

/** Key names under which a long opaque value is treated as a credential. */
const SECRET_KEY_NAME =
	/(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|auth[_-]?key|client[_-]?secret)/iu;

function opaqueSecretShape(value: string): string | undefined {
	if (/^[0-9a-f]{32,}$/iu.test(value)) return "long hex value";
	if (
		/^[A-Za-z0-9+/_-]{24,}={0,2}$/u.test(value) &&
		!value.startsWith("/") &&
		/[0-9]/u.test(value) &&
		/[a-z]/u.test(value) &&
		/[A-Z]/u.test(value)
	)
		return "long base64 value";
	return undefined;
}

/**
 * Paths (`config.a.b[0]`) of config values that look like secrets, with the reason. Never returns
 * the values themselves. Used by `validateExecutorDescriptor` (WP2b): descriptor config is
 * persisted, secrets belong in `SubmitRequest.env`.
 */
export function findSecretLikeConfigValues(config: unknown): string[] {
	const findings: string[] = [];
	const visit = (value: unknown, path: string, key: string | undefined) => {
		if (typeof value === "string") {
			const shape = SECRET_VALUE_PATTERNS.find(([, pattern]) =>
				pattern.test(value),
			);
			if (shape !== undefined) {
				findings.push(`${path} looks like a secret (${shape[0]})`);
				return;
			}
			const opaque =
				key !== undefined && SECRET_KEY_NAME.test(key)
					? opaqueSecretShape(value)
					: undefined;
			if (opaque !== undefined)
				findings.push(`${path} looks like a secret (${opaque} under "${key}")`);
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
			return;
		}
		if (value !== null && typeof value === "object")
			for (const [childKey, child] of Object.entries(value))
				visit(child, `${path}.${childKey}`, childKey);
	};
	visit(config, "config", undefined);
	return findings;
}

export function validateExecutorDescriptor(value: unknown): string[] {
	if (!isPlainObject(value)) return ["descriptor must be an object"];
	const problems: string[] = [];
	if (typeof value.id !== "string" || value.id === "")
		problems.push("id must be a non-empty string");
	if (
		typeof value.version !== "string" ||
		!isVersionCompatible(value.version, value.version)
	)
		problems.push("version must be semver");
	if (typeof value.contractVersion !== "string")
		problems.push("contractVersion must be a string");
	if (typeof value.module !== "string" || value.module === "")
		problems.push("module must be a non-empty string");
	else if (value.module.startsWith("."))
		problems.push(
			"module must not be relative (absolute path, file: URL or package specifier)",
		);
	if (!("config" in value) || !isJsonValue(value.config))
		problems.push("config must be JSON-serializable");
	else
		for (const finding of findSecretLikeConfigValues(value.config))
			problems.push(
				`${finding}; descriptor config is persisted (worker.json, executor.json), pass secrets through SubmitRequest.env`,
			);
	return problems;
}

export function assertExecutorDescriptor(
	value: unknown,
): asserts value is ExecutorDescriptor {
	const problems = validateExecutorDescriptor(value);
	if (problems.length > 0)
		throw new SdkError(
			"DESCRIPTOR_INVALID",
			`invalid executor descriptor: ${problems.join("; ")}`,
		);
}

/** Build a descriptor for a live executor (stored in the run record at dispatch time). */
export function describeExecutor(
	executor: WorkflowExecutor,
	module: string,
	config: JsonValue = null,
): ExecutorDescriptor {
	const descriptor: ExecutorDescriptor = {
		id: executor.id,
		version: executor.version,
		contractVersion: executor.contractVersion,
		module,
		config,
	};
	assertExecutorDescriptor(descriptor);
	return descriptor;
}

/** In-process registry (`registerExecutor`, B1). Checked before importing `module`. */
export interface ExecutorRegistry {
	register(module: string, executorModule: ExecutorModule): void;
	get(module: string): ExecutorModule | undefined;
}

export function createExecutorRegistry(): ExecutorRegistry {
	const modules = new Map<string, ExecutorModule>();
	return {
		register(module, executorModule) {
			if (typeof executorModule?.createExecutor !== "function")
				throw new SdkError(
					"DESCRIPTOR_INVALID",
					`executor module ${module} must export createExecutor(config)`,
				);
			modules.set(module, executorModule);
		},
		get: (module) => modules.get(module),
	};
}

function importSpecifier(module: string): string {
	return isAbsolute(module) ? pathToFileURL(module).href : module;
}

async function importExecutorModule(module: string): Promise<ExecutorModule> {
	let loaded: unknown;
	try {
		loaded = await import(importSpecifier(module));
	} catch (error) {
		throw new SdkError(
			"DESCRIPTOR_MODULE_NOT_FOUND",
			`cannot load executor module ${module}`,
			{ subject: module, cause: error },
		);
	}
	const record = loaded as Record<string, unknown> | null;
	const candidate =
		typeof record?.createExecutor === "function"
			? record
			: (record?.default as Record<string, unknown> | undefined);
	if (typeof candidate?.createExecutor !== "function")
		throw new SdkError(
			"DESCRIPTOR_INVALID",
			`executor module ${module} does not export createExecutor(config)`,
			{ subject: module },
		);
	const createExecutor =
		candidate.createExecutor as ExecutorModule["createExecutor"];
	// The returned executor is structurally validated by assertWorkflowExecutor in loadExecutor.
	return { createExecutor: (config) => createExecutor.call(candidate, config) };
}

/**
 * Reload an executor from a stored descriptor. Refuses (never substitutes) when the module is
 * missing, the id differs, the adapter version is incompatible, or the contract version is not
 * supported by this SDK.
 */
export async function loadExecutor(
	descriptor: ExecutorDescriptor,
	options: { registry?: ExecutorRegistry } = {},
): Promise<WorkflowExecutor> {
	assertExecutorDescriptor(descriptor);
	if (!isContractCompatible(descriptor.contractVersion))
		throw new SdkError(
			"CONTRACT_VERSION_MISMATCH",
			`descriptor contract ${descriptor.contractVersion} is not compatible with SDK contract ${EXECUTOR_CONTRACT_VERSION}`,
			{ subject: descriptor.id },
		);
	const executorModule =
		options.registry?.get(descriptor.module) ??
		(await importExecutorModule(descriptor.module));
	const executor = await executorModule.createExecutor(descriptor.config);
	assertWorkflowExecutor(executor);
	if (executor.id !== descriptor.id)
		throw new SdkError(
			"DESCRIPTOR_ID_MISMATCH",
			`module ${descriptor.module} built executor ${executor.id}, expected ${descriptor.id}`,
			{
				subject: descriptor.id,
			},
		);
	if (!isVersionCompatible(descriptor.version, executor.version))
		throw new SdkError(
			"DESCRIPTOR_VERSION_MISMATCH",
			`executor ${executor.id}@${executor.version} is not compatible with recorded ${descriptor.version}`,
			{ subject: descriptor.id },
		);
	return executor;
}
