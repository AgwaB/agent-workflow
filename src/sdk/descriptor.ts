/**
 * Executor rediscovery (stage-1 plan §2.1 [R#15], design §9.2, owner decision B1).
 * A detached supervisor or a resumed run cannot receive adapter objects; it receives an
 * `ExecutorDescriptor` (data) stored in the run record and reloads the adapter from `module`.
 * Missing modules, id mismatches and incompatible versions are refused — never substituted.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWorkflowExecutor, EXECUTOR_CONTRACT_VERSION, isContractCompatible, isVersionCompatible, type WorkflowExecutor } from "./contract.js";
import { SdkError } from "./errors.js";
import { isJsonValue, isPlainObject, type JsonValue } from "./json.js";

export interface ExecutorDescriptor {
	readonly id: string;
	/** Adapter version at submit time; reload requires a compatible version. */
	readonly version: string;
	readonly contractVersion: string;
	/** Package specifier (`@agwab/agent-workflow/executors/codex`), absolute path, or `file:` URL. */
	readonly module: string;
	/** JSON-only adapter configuration (no secrets: they would be persisted in run records). */
	readonly config: JsonValue;
}

/** What an adapter module exports so `loadExecutor` can rebuild it in a new process. */
export interface ExecutorModule {
	createExecutor(config: JsonValue): WorkflowExecutor | Promise<WorkflowExecutor>;
}

export function validateExecutorDescriptor(value: unknown): string[] {
	if (!isPlainObject(value)) return ["descriptor must be an object"];
	const problems: string[] = [];
	if (typeof value.id !== "string" || value.id === "") problems.push("id must be a non-empty string");
	if (typeof value.version !== "string" || !isVersionCompatible(value.version, value.version)) problems.push("version must be semver");
	if (typeof value.contractVersion !== "string") problems.push("contractVersion must be a string");
	if (typeof value.module !== "string" || value.module === "") problems.push("module must be a non-empty string");
	else if (value.module.startsWith(".")) problems.push("module must not be relative (absolute path, file: URL or package specifier)");
	if (!("config" in value) || !isJsonValue(value.config)) problems.push("config must be JSON-serializable");
	return problems;
}

export function assertExecutorDescriptor(value: unknown): asserts value is ExecutorDescriptor {
	const problems = validateExecutorDescriptor(value);
	if (problems.length > 0) throw new SdkError("DESCRIPTOR_INVALID", `invalid executor descriptor: ${problems.join("; ")}`);
}

/** Build a descriptor for a live executor (stored in the run record at dispatch time). */
export function describeExecutor(executor: WorkflowExecutor, module: string, config: JsonValue = null): ExecutorDescriptor {
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
				throw new SdkError("DESCRIPTOR_INVALID", `executor module ${module} must export createExecutor(config)`);
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
		throw new SdkError("DESCRIPTOR_MODULE_NOT_FOUND", `cannot load executor module ${module}`, { subject: module, cause: error });
	}
	const record = loaded as Record<string, unknown> | null;
	const candidate = typeof record?.createExecutor === "function" ? record : (record?.default as Record<string, unknown> | undefined);
	if (typeof candidate?.createExecutor !== "function")
		throw new SdkError("DESCRIPTOR_INVALID", `executor module ${module} does not export createExecutor(config)`, { subject: module });
	const createExecutor = candidate.createExecutor as ExecutorModule["createExecutor"];
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
	const executorModule = options.registry?.get(descriptor.module) ?? (await importExecutorModule(descriptor.module));
	const executor = await executorModule.createExecutor(descriptor.config);
	assertWorkflowExecutor(executor);
	if (executor.id !== descriptor.id)
		throw new SdkError("DESCRIPTOR_ID_MISMATCH", `module ${descriptor.module} built executor ${executor.id}, expected ${descriptor.id}`, {
			subject: descriptor.id,
		});
	if (!isVersionCompatible(descriptor.version, executor.version))
		throw new SdkError(
			"DESCRIPTOR_VERSION_MISMATCH",
			`executor ${executor.id}@${executor.version} is not compatible with recorded ${descriptor.version}`,
			{ subject: descriptor.id },
		);
	return executor;
}
