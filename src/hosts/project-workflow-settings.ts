import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, posix, resolve } from "node:path";
import {
	validateProjectWorkflowSettingsIntent,
	validateProjectWorkflowSettingsSlots,
	type ProjectWorkflowSettingsCapture,
	type ProjectWorkflowSettingsEditableSlot,
	type ProjectWorkflowSettingsIdentity,
	type ProjectWorkflowSettingsIntent,
	type ProjectWorkflowSettingsTarget,
} from "../core/project-workflow-settings.js";
import {
	readPrivateFileText,
	writePrivateFileAtomic,
	writePrivateFileNoReplace,
} from "../core/secure-atomic-write.js";
import { ensureStateBase, stateBase } from "../core/state-location.js";
import { projectWorkflowSettingsKey } from "../core/workflow-specs.js";
import { withStoreLock } from "./store-lock.js";

export const PROJECT_WORKFLOW_SETTINGS_SCHEMA =
	"agent-workflow-project-workflow-settings-v1";
export const PROJECT_WORKFLOW_SETTINGS_ABSENT = "absent";
export const PROJECT_WORKFLOW_SETTINGS_LIMITS = Object.freeze({
	entries: 512,
	bytes: 1_048_576,
});

export class ProjectWorkflowSettingsConflict extends Error {
	readonly code = "PROJECT_WORKFLOW_SETTINGS_CONFLICT";
	constructor(message: string) {
		super(message);
		this.name = "ProjectWorkflowSettingsConflict";
	}
}

export interface ProjectWorkflowSettingsEntry {
	identity: ProjectWorkflowSettingsIdentity;
	revision: string;
	definitionFingerprint: string;
	intent: ProjectWorkflowSettingsIntent;
}
export interface ProjectWorkflowSettingsStore {
	schema: typeof PROJECT_WORKFLOW_SETTINGS_SCHEMA;
	storeEpoch: string;
	workflows: Record<string, ProjectWorkflowSettingsEntry>;
}
export interface ProjectWorkflowSettingsExpected {
	storeEpoch: string;
	revision: string;
	definitionFingerprint: string;
	resolutionToken: string;
}
export interface ProjectWorkflowSettingsRead
	extends ProjectWorkflowSettingsCapture {
	resolutionToken: string;
	present: boolean;
	savedDefinitionFingerprint?: string;
}
export interface ProjectWorkflowSettingsOptions {
	env?: NodeJS.ProcessEnv;
}
export interface ProjectWorkflowSettingsSaveOptions
	extends ProjectWorkflowSettingsOptions {
	/** Re-resolve the original server selection, not a request-supplied replacement path. Runs under the lock. */
	resolveTarget: (intent: ProjectWorkflowSettingsIntent) => Promise<{
		target: ProjectWorkflowSettingsTarget;
		editableSlots: readonly ProjectWorkflowSettingsEditableSlot[];
	}>;
	/** Optional additional executor/model/capability validation; failure preserves the store. */
	validateIntent?: (
		intent: ProjectWorkflowSettingsIntent,
		target: ProjectWorkflowSettingsTarget,
	) => void | Promise<void>;
}

export function projectWorkflowSettingsPath(
	cwd: string,
	options: ProjectWorkflowSettingsOptions = {},
): string {
	return join(
		stateBase(cwd, options.env),
		"workflow-settings",
		"v1",
		"settings.json",
	);
}

function digest(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid project workflow settings object");
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some((key) => !allowed.includes(key)))
		throw new Error("Unknown project workflow settings field");
	return result;
}
function nonempty(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim())
		throw new Error("Invalid project workflow settings string");
}
function pathText(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
		throw new Error("Invalid settings identity path");
}
function generation(value: unknown): asserts value is string {
	nonempty(value);
	if (value === PROJECT_WORKFLOW_SETTINGS_ABSENT)
		throw new Error("Reserved settings generation");
}
function hash(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw new Error("Invalid settings digest or key");
}
function identity(value: unknown): ProjectWorkflowSettingsIdentity {
	const item = object(value, ["scope", "relativeSpec", "physicalSpecPath"]);
	if (item.scope === "external") {
		if (Object.hasOwn(item, "relativeSpec"))
			throw new Error("Invalid external settings identity");
		pathText(item.physicalSpecPath);
		if (
			!isAbsolute(item.physicalSpecPath) ||
			resolve(item.physicalSpecPath) !== item.physicalSpecPath
		)
			throw new Error("Invalid external settings path");
		return { scope: "external", physicalSpecPath: item.physicalSpecPath };
	}
	if (
		!["project-shared", "project-private", "user", "package"].includes(
			item.scope as string,
		) ||
		Object.hasOwn(item, "physicalSpecPath")
	)
		throw new Error("Invalid settings scope");
	pathText(item.relativeSpec);
	if (
		posix.isAbsolute(item.relativeSpec) ||
		posix.normalize(item.relativeSpec) !== item.relativeSpec ||
		item.relativeSpec === "." ||
		item.relativeSpec === ".." ||
		item.relativeSpec.startsWith("../")
	)
		throw new Error("Invalid relative settings path");
	return {
		scope: item.scope as Exclude<
			ProjectWorkflowSettingsIdentity["scope"],
			"external"
		>,
		relativeSpec: item.relativeSpec,
	};
}
function validateTarget(target: ProjectWorkflowSettingsTarget): void {
	if (
		projectWorkflowSettingsKey(identity(target.identity)) !== target.key ||
		!isAbsolute(target.specPath)
	)
		throw new Error("Invalid server settings target");
	hash(target.key);
	hash(target.definitionFingerprint);
	hash(target.resolutionToken);
}
function parse(raw: string): ProjectWorkflowSettingsStore {
	if (Buffer.byteLength(raw) > PROJECT_WORKFLOW_SETTINGS_LIMITS.bytes)
		throw new Error("Project workflow settings exceeds size limit");
	const value = object(JSON.parse(raw), ["schema", "storeEpoch", "workflows"]);
	if (value.schema !== PROJECT_WORKFLOW_SETTINGS_SCHEMA)
		throw new Error("Unsupported project workflow settings schema");
	generation(value.storeEpoch);
	if (
		!value.workflows ||
		typeof value.workflows !== "object" ||
		Array.isArray(value.workflows)
	)
		throw new Error("Invalid settings workflows");
	const entries = Object.entries(value.workflows);
	if (entries.length > PROJECT_WORKFLOW_SETTINGS_LIMITS.entries)
		throw new Error("Project workflow settings exceeds entry limit");
	const workflows = Object.fromEntries(
		entries.map(([key, rawEntry]) => {
			hash(key);
			const entry = object(rawEntry, [
				"identity",
				"revision",
				"definitionFingerprint",
				"intent",
			]);
			const locator = identity(entry.identity);
			if (projectWorkflowSettingsKey(locator) !== key)
				throw new Error("Settings identity/key mismatch");
			generation(entry.revision);
			hash(entry.definitionFingerprint);
			return [
				key,
				{
					identity: locator,
					revision: entry.revision,
					definitionFingerprint: entry.definitionFingerprint,
					intent: validateProjectWorkflowSettingsIntent(entry.intent),
				},
			];
		}),
	);
	return {
		schema: PROJECT_WORKFLOW_SETTINGS_SCHEMA,
		storeEpoch: value.storeEpoch,
		workflows,
	};
}
async function rawRead(
	file: string,
	limit: number = PROJECT_WORKFLOW_SETTINGS_LIMITS.bytes,
): Promise<string | undefined> {
	try {
		return await readPrivateFileText(file, limit, {
			ownerOnly: true,
			preserveBOM: true,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function load(
	file: string,
): Promise<{ store: ProjectWorkflowSettingsStore; rawDigest: string }> {
	const raw = await rawRead(file);
	return raw === undefined
		? {
				store: {
					schema: PROJECT_WORKFLOW_SETTINGS_SCHEMA,
					storeEpoch: PROJECT_WORKFLOW_SETTINGS_ABSENT,
					workflows: {},
				},
				rawDigest: PROJECT_WORKFLOW_SETTINGS_ABSENT,
			}
		: { store: parse(raw), rawDigest: digest(raw) };
}
async function publish(
	file: string,
	store: ProjectWorkflowSettingsStore,
): Promise<void> {
	const raw = `${JSON.stringify(store, null, 2)}\n`;
	// Validate the exact serialized representation, including both save limits.
	parse(raw);
	await writePrivateFileAtomic(file, raw);
}
function checkEntry(
	store: ProjectWorkflowSettingsStore,
	key: string,
	expected: { storeEpoch: string; revision: string },
): void {
	if (
		store.storeEpoch !== expected.storeEpoch ||
		(store.workflows[key]?.revision ?? PROJECT_WORKFLOW_SETTINGS_ABSENT) !==
			expected.revision
	)
		throw new ProjectWorkflowSettingsConflict(
			"Project settings changed; reload before saving",
		);
}
function snapshot(
	store: ProjectWorkflowSettingsStore,
	target: ProjectWorkflowSettingsTarget,
): ProjectWorkflowSettingsRead {
	const entry = store.workflows[target.key];
	return {
		identity: target.identity,
		key: target.key,
		storeEpoch: store.storeEpoch,
		revision: entry?.revision ?? PROJECT_WORKFLOW_SETTINGS_ABSENT,
		definitionFingerprint: target.definitionFingerprint,
		resolutionToken: target.resolutionToken,
		intent: entry?.intent ?? {},
		present: entry !== undefined,
		...(entry
			? { savedDefinitionFingerprint: entry.definitionFingerprint }
			: {}),
	};
}

/** Reads never acquire a lock or create a directory. */
export async function readProjectWorkflowSettings(
	cwd: string,
	target: ProjectWorkflowSettingsTarget,
	options: ProjectWorkflowSettingsOptions = {},
): Promise<ProjectWorkflowSettingsRead> {
	validateTarget(target);
	return snapshot(
		(await load(projectWorkflowSettingsPath(cwd, options))).store,
		target,
	);
}

/** Includes empty and undiscovered entries. Keys select entries, never filesystem paths. */
export async function listProjectWorkflowSettings(
	cwd: string,
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{
	storeEpoch: string;
	rawDigest: string;
	workflows: Record<string, ProjectWorkflowSettingsEntry>;
}> {
	const { store, rawDigest } = await load(
		projectWorkflowSettingsPath(cwd, options),
	);
	return {
		storeEpoch: store.storeEpoch,
		rawDigest,
		workflows: store.workflows,
	};
}
export async function readProjectWorkflowSettingsEntry(
	cwd: string,
	key: string,
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{
	storeEpoch: string;
	revision: string;
	entry?: ProjectWorkflowSettingsEntry;
}> {
	hash(key);
	const { store } = await load(projectWorkflowSettingsPath(cwd, options));
	const entry = store.workflows[key];
	return {
		storeEpoch: store.storeEpoch,
		revision: entry?.revision ?? PROJECT_WORKFLOW_SETTINGS_ABSENT,
		...(entry ? { entry } : {}),
	};
}

export async function saveProjectWorkflowSettings(
	cwd: string,
	target: ProjectWorkflowSettingsTarget,
	expected: ProjectWorkflowSettingsExpected,
	value: unknown,
	options: ProjectWorkflowSettingsSaveOptions,
): Promise<ProjectWorkflowSettingsRead> {
	validateTarget(target);
	const intent = validateProjectWorkflowSettingsIntent(value);
	for (const block of [intent.defaults, ...Object.values(intent.slots ?? {})])
		if (block) Object.freeze(block);
	if (intent.slots) Object.freeze(intent.slots);
	Object.freeze(intent);
	const file = projectWorkflowSettingsPath(cwd, options);
	await ensureStateBase(cwd, options.env);
	return withStoreLock(file, async () => {
		const { store } = await load(file);
		checkEntry(store, target.key, expected);
		const current = await options.resolveTarget(intent);
		validateTarget(current.target);
		if (
			current.target.key !== target.key ||
			current.target.definitionFingerprint !== expected.definitionFingerprint ||
			current.target.resolutionToken !== expected.resolutionToken
		)
			throw new ProjectWorkflowSettingsConflict(
				"Workflow definition or alias resolution changed; reload before saving",
			);
		validateProjectWorkflowSettingsSlots(intent, current.editableSlots);
		await options.validateIntent?.(intent, current.target);
		if (store.storeEpoch === PROJECT_WORKFLOW_SETTINGS_ABSENT)
			store.storeEpoch = randomUUID();
		store.workflows[target.key] = {
			identity: current.target.identity,
			revision: randomUUID(),
			definitionFingerprint: current.target.definitionFingerprint,
			intent,
		};
		await publish(file, store);
		return snapshot(store, current.target);
	});
}

/** Delete one complete binding by exact stored key, without discovery or semantic repair. */
export async function clearProjectWorkflowSettingsBinding(
	cwd: string,
	key: string,
	expected: { storeEpoch: string; revision: string },
	selection: { kind: "defaults" } | { kind: "slot"; slot: string },
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{ storeEpoch: string; revision: string }> {
	hash(key);
	const selected = { ...selection };
	object(selected, selected.kind === "defaults" ? ["kind"] : ["kind", "slot"]);
	if (selected.kind !== "defaults" && selected.kind !== "slot")
		throw new Error("Invalid binding selection");
	if (selected.kind === "slot") nonempty(selected.slot);
	const file = projectWorkflowSettingsPath(cwd, options);
	await ensureStateBase(cwd, options.env);
	return withStoreLock(file, async () => {
		const { store } = await load(file);
		checkEntry(store, key, expected);
		const entry = store.workflows[key];
		if (!entry) throw new Error("Settings entry does not exist");
		if (selected.kind === "defaults") {
			if (!Object.hasOwn(entry.intent, "defaults"))
				throw new Error("Defaults binding does not exist");
			delete entry.intent.defaults;
		} else {
			if (!Object.hasOwn(entry.intent.slots ?? {}, selected.slot))
				throw new Error("Slot binding does not exist");
			delete entry.intent.slots![selected.slot];
		}
		entry.revision = randomUUID();
		await publish(file, store);
		return { storeEpoch: store.storeEpoch, revision: entry.revision };
	});
}

/** Reset retains an empty entry; purge rotates the epoch, invalidating absent drafts too. */
export async function clearProjectWorkflowSettingsEntry(
	cwd: string,
	key: string,
	expected: { storeEpoch: string; revision: string },
	mode: "reset" | "purge" = "reset",
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{ storeEpoch: string; revision: string }> {
	hash(key);
	if (mode !== "reset" && mode !== "purge")
		throw new Error("Invalid settings clear mode");
	const file = projectWorkflowSettingsPath(cwd, options);
	await ensureStateBase(cwd, options.env);
	return withStoreLock(file, async () => {
		const { store } = await load(file);
		checkEntry(store, key, expected);
		const entry = store.workflows[key];
		if (!entry) throw new Error("Settings entry does not exist");
		if (mode === "purge") {
			delete store.workflows[key];
			store.storeEpoch = randomUUID();
		} else
			store.workflows[key] = { ...entry, revision: randomUUID(), intent: {} };
		await publish(file, store);
		return {
			storeEpoch: store.storeEpoch,
			revision:
				store.workflows[key]?.revision ?? PROJECT_WORKFLOW_SETTINGS_ABSENT,
		};
	});
}

/** Whole-store clear additionally compares the raw snapshot, so concurrent ordinary saves cannot be lost. */
export async function clearProjectWorkflowSettings(
	cwd: string,
	expected: { storeEpoch: string; rawDigest: string },
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{ storeEpoch: string }> {
	const file = projectWorkflowSettingsPath(cwd, options);
	await ensureStateBase(cwd, options.env);
	return withStoreLock(file, async () => {
		const loaded = await load(file);
		if (
			loaded.store.storeEpoch !== expected.storeEpoch ||
			loaded.rawDigest !== expected.rawDigest
		)
			throw new ProjectWorkflowSettingsConflict(
				"Project settings changed; reload before clearing",
			);
		const store: ProjectWorkflowSettingsStore = {
			schema: PROJECT_WORKFLOW_SETTINGS_SCHEMA,
			storeEpoch: randomUUID(),
			workflows: {},
		};
		await publish(file, store);
		return { storeEpoch: store.storeEpoch };
	});
}

/** Explicit recovery inspection only. Unsafe/unreadable/over-16MiB files remain an error. */
export async function inspectProjectWorkflowSettingsRecovery(
	cwd: string,
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{ rawDigest: string; bytes: number; malformed: boolean }> {
	const raw = await rawRead(
		projectWorkflowSettingsPath(cwd, options),
		16_777_216,
	);
	if (raw === undefined) throw new Error("No settings store to recover");
	let malformed = false;
	try {
		parse(raw);
	} catch {
		malformed = true;
	}
	return { rawDigest: digest(raw), bytes: Buffer.byteLength(raw), malformed };
}

/** Explicit destructive action: preserve and verify a private backup before replacing malformed data. */
export async function recoverProjectWorkflowSettings(
	cwd: string,
	expectedRawDigest: string,
	options: ProjectWorkflowSettingsOptions = {},
): Promise<{ storeEpoch: string; backupPath: string }> {
	hash(expectedRawDigest);
	const file = projectWorkflowSettingsPath(cwd, options);
	await ensureStateBase(cwd, options.env);
	return withStoreLock(file, async () => {
		const raw = await rawRead(file, 16_777_216);
		if (raw === undefined || digest(raw) !== expectedRawDigest)
			throw new ProjectWorkflowSettingsConflict(
				"Raw project settings changed; inspect again before recovery",
			);
		let malformed = false;
		try {
			parse(raw);
		} catch {
			malformed = true;
		}
		if (!malformed)
			throw new Error("Settings store is valid; use explicit clear instead");
		const backupPath = `${file}.recovery-${randomUUID()}.bak`;
		await writePrivateFileNoReplace(backupPath, raw);
		if (
			digest(
				await readPrivateFileText(backupPath, 16_777_216, {
					ownerOnly: true,
					preserveBOM: true,
				}),
			) !== expectedRawDigest
		)
			throw new Error("Settings recovery backup verification failed");
		// Recheck after backup: an external edit must not be overwritten by recovery.
		const latest = await rawRead(file, 16_777_216);
		if (latest === undefined || digest(latest) !== expectedRawDigest)
			throw new ProjectWorkflowSettingsConflict(
				"Raw project settings changed during backup",
			);
		const store: ProjectWorkflowSettingsStore = {
			schema: PROJECT_WORKFLOW_SETTINGS_SCHEMA,
			storeEpoch: randomUUID(),
			workflows: {},
		};
		await publish(file, store);
		return { storeEpoch: store.storeEpoch, backupPath };
	});
}
