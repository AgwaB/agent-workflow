// The synthetic executor behind `agent-workflow rehearse`: no model, no CLI, no network. It answers every
// model-backed task with a control generated from the stage's control schema (src/core/schema-sample.ts),
// a placeholder analysis and refs, and — through the real `workflow_artifact` tool — performs the reads the
// stage requires, exactly as a compliant worker would, so the read ledger the engine checks is the real one.
//
// It is an ordinary SDK executor module: the rehearsal registers a descriptor for it under a private id for
// the duration of one rehearsal (src/core/rehearsal.ts) and removes it afterwards, so it is never selectable
// for a real run. Everything it observes goes to a JSONL effect log the rehearsal turns into the report.
//
// Config (descriptor.config, JSON):
//   effectLog   absolute JSONL path (required)
//   projectCwd  the project the rehearsal runs in (run records live under its temporary state root)
//   items       item count of unbounded arrays (default 2)
//   loop        "pass" (until holds on round 1) | "exhaust" (until never holds)
//   foreach     [{source, path, identityPath?}]: foreach stages and the array they fan out over; the stage
//               named `source` gets items at `path`, each with a unique identity at `identityPath`
import { appendFileSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakeExecutor } from "../sdk/testing/index.js";
import type { ExecEvent } from "../sdk/events.js";
import type { SubmitRequest, WorkflowExecutor } from "../sdk/contract.js";
import type { JsonValue } from "../sdk/json.js";
import { fakeCapabilities } from "../sdk/testing/index.js";
import { level } from "../sdk/capabilities.js";
import {
	type JsonSchema,
	type JsonSchemaObject,
	validateJsonSchema,
} from "./json-schema.js";
import {
	alternativeValues,
	deleteAtPath,
	getAtPath,
	parseSamplePath,
	type SampleValue,
	sampleFromSchema,
	schemaAtPath,
	setAtPath,
} from "./schema-sample.js";
import { workflowRunDir } from "./store.js";
import type {
	ArtifactGraphRequiredRead,
	LoopUntilCondition,
	LoopUntilLeaf,
	RequiredWorkflowArtifactReadPolicy,
	WorkflowTaskRunRecord,
} from "./types.js";
import {
	handleWorkflowArtifactToolCall,
	loadWorkflowSourceManifest,
	type WorkflowArtifactToolConfig,
} from "./workflow-artifact-tool.js";

export const REHEARSAL_EXECUTOR_VERSION = "0.1.0";

export interface RehearsalExecutorConfig {
	effectLog: string;
	projectCwd: string;
	items: number;
	loop: "pass" | "exhaust";
	foreach: RehearsalForeachHint[];
}

/** A foreach stage's fan-out edge: where in `source`'s control its items are and how they are identified. */
export interface RehearsalForeachHint {
	source: string;
	path: string;
	identityPath?: string;
}

export function foreachHintToJson(hint: RehearsalForeachHint): JsonValue {
	const out: Record<string, JsonValue> = {
		source: hint.source,
		path: hint.path,
	};
	if (hint.identityPath !== undefined) out.identityPath = hint.identityPath;
	return out;
}

function foreachHintFromJson(value: JsonValue): RehearsalForeachHint[] {
	if (!isRecord(value)) return [];
	const { source, path, identityPath } = value;
	if (typeof source !== "string" || typeof path !== "string") return [];
	return [
		{
			source,
			path,
			...(typeof identityPath === "string" ? { identityPath } : {}),
		},
	];
}

/** One line of the effect log the rehearsal report is built from. */
export type RehearsalEffect =
	| {
			type: "submit";
			taskId: string;
			specId: string;
			sources: Array<{ source: string; status: string | null }>;
	  }
	| {
			type: "read";
			taskId: string;
			specId: string;
			source: string;
			artifact: string;
			path: string | null;
			ok: boolean;
			message?: string;
	  }
	| {
			type: "control-invalid";
			taskId: string;
			specId: string;
			issues: string[];
	  }
	| { type: "loop-forced"; taskId: string; specId: string; note: string };

function record(path: string, entry: RehearsalEffect): void {
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function readRehearsalEffects(path: string): RehearsalEffect[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RehearsalEffect);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(config: JsonValue): RehearsalExecutorConfig {
	if (!isRecord(config))
		throw new Error("rehearsal executor needs a config object");
	const { effectLog, projectCwd, items, loop, foreach } = config;
	if (typeof effectLog !== "string" || typeof projectCwd !== "string")
		throw new Error("rehearsal executor needs effectLog and projectCwd");
	return {
		effectLog,
		projectCwd,
		items: typeof items === "number" ? items : 2,
		loop: loop === "exhaust" ? "exhaust" : "pass",
		foreach: Array.isArray(foreach) ? foreach.flatMap(foreachHintFromJson) : [],
	};
}

interface CompiledLoopStage {
	id: string;
	maxRounds: number | null;
	until: LoopUntilCondition;
	progressPath?: string;
}

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readJson(path: string): Promise<unknown> {
	return parseJson(await readFile(path, "utf8"), path);
}

function schemaObject(
	schema: JsonSchema | undefined,
): JsonSchemaObject | undefined {
	return typeof schema === "object" ? schema : undefined;
}

function leavesOf(condition: LoopUntilCondition): LoopUntilLeaf[] {
	const candidate = condition as {
		all?: LoopUntilCondition[];
		any?: LoopUntilCondition[];
	};
	if (Array.isArray(candidate.all)) return candidate.all.flatMap(leavesOf);
	if (Array.isArray(candidate.any)) return candidate.any.flatMap(leavesOf);
	return [condition as LoopUntilLeaf];
}

/** A value for the leaf's path that makes the leaf true (`holds`) or false. */
function leafValue(
	leaf: LoopUntilLeaf,
	holds: boolean,
	schema: JsonSchema | undefined,
	key: string,
): { set: SampleValue } | { remove: true } | undefined {
	if (Object.hasOwn(leaf, "exists"))
		return (leaf.exists === true) === holds
			? { set: pickValue(schema, key, undefined) }
			: { remove: true };
	if (Object.hasOwn(leaf, "equals"))
		return holds
			? { set: leaf.equals as SampleValue }
			: { set: pickValue(schema, key, leaf.equals) };
	if (Object.hasOwn(leaf, "notEquals"))
		return holds
			? { set: pickValue(schema, key, leaf.notEquals) }
			: { set: leaf.notEquals as SampleValue };
	if (Object.hasOwn(leaf, "lengthEquals")) {
		const wanted = leaf.lengthEquals ?? 0;
		const length = holds ? wanted : wanted + 1;
		const items = schemaObject(schema)?.items;
		const item = Array.isArray(items) ? undefined : items;
		return {
			set: Array.from({ length }, (_, index) =>
				pickValue(item, `${key}-${index + 1}`, undefined),
			),
		};
	}
	return undefined;
}

function pickValue(
	schema: JsonSchema | undefined,
	key: string,
	avoid: unknown,
): SampleValue {
	return (
		alternativeValues(schema, key, avoid as SampleValue)[0] ?? `${key}-other`
	);
}

interface ForcedLoop {
	control: SampleValue;
	note: string | undefined;
}

/** Apply the rehearsal's loop policy to the control of a loop child that the `until` condition reads. */
function forceLoop(
	control: SampleValue,
	schema: JsonSchema | undefined,
	loop: CompiledLoopStage,
	childStageId: string,
	round: number,
	policy: "pass" | "exhaust",
): ForcedLoop {
	const leaves = leavesOf(loop.until).filter(
		(leaf) => (leaf.stage ?? leaf.source) === childStageId,
	);
	if (leaves.length === 0) return { control, note: undefined };
	// An unlimited loop has no exhaustion to rehearse: it must end by `until`.
	const exhaust = policy === "exhaust" && loop.maxRounds !== null;
	// pass: every leaf holds. exhaust: no leaf holds, which keeps `all` and `any` false alike.
	const notes: string[] = [];
	for (const leaf of leaves) {
		const tokens = parseSamplePath(leaf.path);
		if (tokens === undefined) continue;
		const sub = schema === undefined ? undefined : schemaAtPath(schema, tokens);
		const change = leafValue(
			leaf,
			!exhaust,
			sub,
			tokens.at(-1)?.toString() ?? "value",
		);
		if (change === undefined) continue;
		if ("remove" in change) deleteAtPath(control, tokens);
		else setAtPath(control, tokens, change.set);
		notes.push(`${leaf.path} ${exhaust ? "does not hold" : "holds"}`);
	}
	if (exhaust) {
		// A bounded loop also stops when its progress metric stops falling; make it fall each round so the
		// rehearsal reaches the exhausted end state when the schema leaves room for it.
		const progress = parseSamplePath(loop.progressPath ?? "$.blockingFailures");
		const remaining = Math.max(0, (loop.maxRounds ?? 0) - round + 1);
		const sub =
			progress === undefined || schema === undefined
				? undefined
				: schemaObject(schemaAtPath(schema, progress));
		if (progress !== undefined && sub?.type === "array") {
			const item = Array.isArray(sub.items) ? undefined : sub.items;
			const max = typeof sub.maxItems === "number" ? sub.maxItems : Infinity;
			const min = typeof sub.minItems === "number" ? sub.minItems : 0;
			const length = Math.max(min, Math.min(remaining, max));
			setAtPath(
				control,
				progress,
				Array.from({ length }, (_, position) =>
					pickValue(item, `failure-${position + 1}`, undefined),
				),
			);
		} else if (
			progress !== undefined &&
			(sub?.type === "number" || sub?.type === "integer")
		) {
			const max = typeof sub.maximum === "number" ? sub.maximum : Infinity;
			const min = typeof sub.minimum === "number" ? sub.minimum : -Infinity;
			setAtPath(control, progress, Math.max(min, Math.min(remaining, max)));
		}
	}
	return {
		control,
		note: `loop ${loop.id} round ${round}: ${notes.join(", ")}`,
	};
}

interface TaskContext {
	task: WorkflowTaskRunRecord;
	runDir: string;
	taskId: string;
}

async function loadTask(
	req: SubmitRequest,
	config: RehearsalExecutorConfig,
): Promise<TaskContext | undefined> {
	const [, runId, taskId] = req.attemptKey.split(":");
	if (runId === undefined || taskId === undefined) return undefined;
	const runDir = workflowRunDir(config.projectCwd, runId);
	const run = (await readJson(join(runDir, "run.json"))) as {
		tasks: WorkflowTaskRunRecord[];
	};
	const task = run.tasks.find((candidate) => candidate.taskId === taskId);
	return task === undefined ? undefined : { task, runDir, taskId };
}

const SAFE_IDENTITY = /^[a-z0-9][a-z0-9_-]*$/u;

/**
 * Give the items a foreach stage fans out over what the engine needs of them: the array exists and every item
 * has a unique, task-id-safe identity at the stage's `itemIdentityPath`. A control schema often leaves an
 * item's shape open (`{"type": "object"}`), so the schema alone cannot say where the identity is.
 */
function applyForeachHints(
	control: SampleValue,
	hints: readonly RehearsalForeachHint[],
	stageName: string,
	items: number,
): void {
	for (const hint of hints) {
		if (hint.source !== stageName && !stageName.endsWith(`.${hint.source}`))
			continue;
		const path = parseSamplePath(hint.path);
		const identity =
			hint.identityPath === undefined
				? undefined
				: parseSamplePath(hint.identityPath);
		if (path === undefined) continue;
		let list = getAtPath(control, path);
		if (!Array.isArray(list)) {
			if (
				!setAtPath(
					control,
					path,
					Array.from({ length: items }, () => ({})),
				)
			)
				continue;
			list = getAtPath(control, path);
		}
		if (!Array.isArray(list) || identity === undefined) continue;
		const used = new Set<string>();
		list.forEach((item, index) => {
			if (!isRecord(item)) return;
			const current = getAtPath(item, identity);
			let value =
				typeof current === "string" && current.toLowerCase() !== ""
					? current.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-")
					: `item-${index + 1}`;
			if (!SAFE_IDENTITY.test(value) || used.has(value))
				value = `item-${index + 1}`;
			used.add(value);
			setAtPath(item, identity, value);
		});
	}
}

function envelope(
	control: SampleValue,
	specId: string,
	schema: JsonSchema | undefined,
	maxDigestChars: number | undefined,
): SampleValue {
	const out: Record<string, SampleValue> = isRecord(control)
		? (control as Record<string, SampleValue>)
		: {};
	const property = (name: string): JsonSchema | undefined =>
		schemaObject(schema)?.properties?.[name];
	const fixed = (name: string): boolean => {
		const sub = schemaObject(property(name));
		return (
			sub !== undefined &&
			(Object.hasOwn(sub, "const") || Array.isArray(sub.enum))
		);
	};
	const stage = specId.replace(/\.[^.]*$/u, "") || specId;
	const accepts = (name: string, value: string): boolean => {
		const sub = property(name);
		return sub === undefined || validateJsonSchema(value, sub).valid;
	};
	if (!fixed("schema")) {
		const value = `${stage}-control-v1`;
		if (accepts("schema", value)) out.schema = value;
		else if (typeof out.schema !== "string" || out.schema === "")
			out.schema = "control";
	}
	if (!fixed("digest")) {
		let value = `rehearsal: ${specId}`;
		const limit = maxDigestChars ?? 200;
		if (value.length > limit) value = value.slice(0, limit);
		if (accepts("digest", value)) out.digest = value;
		else if (typeof out.digest !== "string" || out.digest.trim() === "")
			out.digest = value;
	}
	return out;
}

function renderOutput(
	control: SampleValue,
	specId: string,
	refs: string[],
): string {
	return [
		"<control>",
		JSON.stringify(control),
		"</control>",
		"<analysis>",
		`Rehearsal analysis for ${specId}: synthetic output, no model was called.`,
		"</analysis>",
		"<refs>",
		JSON.stringify(refs),
		"</refs>",
	].join("\n");
}

async function syntheticOutput(
	config: RehearsalExecutorConfig,
	context: TaskContext | undefined,
): Promise<string> {
	if (context === undefined)
		return renderOutput(envelope({}, "task", undefined, undefined), "task", []);
	const { task, runDir, taskId } = context;
	const specId = task.specId;
	const output = task.artifactGraph?.output;
	let schema: JsonSchema | undefined;
	if (output?.controlSchemaPath !== undefined)
		schema = (await readJson(output.controlSchemaPath)) as JsonSchema;
	let control: SampleValue =
		schema === undefined
			? {}
			: sampleFromSchema(schema, { arrayItems: config.items }).value;

	if (task.loopChild !== undefined) {
		const compiled = (await readJson(join(runDir, "compiled.json"))) as {
			stages: Array<CompiledLoopStage & { type?: string }>;
		};
		const loop = compiled.stages.find(
			(stage) => stage.type === "loop" && stage.id === task.loopChild?.loopId,
		);
		const childStageId = new RegExp(
			`(?:^|\\.)${task.loopChild.loopId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.r\\d+\\.(.+)$`,
			"u",
		).exec(specId)?.[1];
		if (loop !== undefined && childStageId !== undefined) {
			const forced = forceLoop(
				control,
				schema,
				loop,
				childStageId,
				task.loopChild.round,
				config.loop,
			);
			control = forced.control;
			if (forced.note !== undefined)
				record(config.effectLog, {
					type: "loop-forced",
					taskId,
					specId,
					note: forced.note,
				});
		}
	}

	applyForeachHints(
		control,
		config.foreach,
		specId.replace(/\.[^.]*$/u, "") || specId,
		config.items,
	);
	control = envelope(control, specId, schema, output?.maxDigestChars);
	if (schema !== undefined) {
		const check = validateJsonSchema(control, schema);
		if (!check.valid)
			record(config.effectLog, {
				type: "control-invalid",
				taskId,
				specId,
				issues: check.issues.map((issue) => `${issue.path}: ${issue.message}`),
			});
	}
	const refsCount = Math.max(0, output?.refsMinItems ?? 0);
	return renderOutput(
		control,
		specId,
		Array.from(
			{ length: refsCount },
			(_, index) => `rehearsal:${specId}:${index + 1}`,
		),
	);
}

interface PlannedRead {
	source: string;
	artifact: string;
	path?: string;
	maxChars?: number;
	maxItems?: number;
}

/**
 * The reads the engine will require of this task, `count` times each, as a compliant model would make them
 * (the same expansion the engine-replay harness uses).
 */
export function plannedRequiredReads(
	requiredReads: readonly ArtifactGraphRequiredRead[],
	policy: readonly RequiredWorkflowArtifactReadPolicy[] = [],
): PlannedRead[] {
	const reads: PlannedRead[] = [];
	for (const read of requiredReads) {
		if (typeof read === "string") {
			const match = /^([A-Za-z0-9_.-]+)\.(control|analysis|refs|raw)$/u.exec(
				read,
			);
			if (match) reads.push({ source: match[1]!, artifact: match[2]! });
			continue;
		}
		const { count = 1, ...spec } = read;
		for (let index = 0; index < count; index += 1) reads.push({ ...spec });
	}
	// A policy entry usually repeats a required read (the compiler derives one from the other); read it
	// only when no required read covers it, because a `count: 1` read made twice does not satisfy.
	const key = (read: PlannedRead): string =>
		JSON.stringify([
			read.source,
			read.artifact,
			read.path ?? null,
			read.maxChars ?? null,
			read.maxItems ?? null,
		]);
	const covered = new Set(reads.map(key));
	for (const entry of policy) {
		const { source, artifact, path, maxChars, maxItems } = entry;
		const read: PlannedRead = {
			source,
			artifact,
			...(path === undefined ? {} : { path }),
			...(maxChars === undefined ? {} : { maxChars }),
			...(maxItems === undefined ? {} : { maxItems }),
		};
		if (covered.has(key(read))) continue;
		covered.add(key(read));
		reads.push(read);
	}
	return reads;
}

async function performReads(
	req: SubmitRequest,
	config: RehearsalExecutorConfig,
	context: TaskContext | undefined,
): Promise<void> {
	if (context === undefined) return;
	const { task, taskId } = context;
	const server = (req.mcpServers ?? []).find(
		(entry) => entry.name === "workflow_artifact",
	);
	// No artifact tool means the worker received no sources at all.
	if (server === undefined) {
		record(config.effectLog, {
			type: "submit",
			taskId,
			specId: task.specId,
			sources: [],
		});
		return;
	}
	const configPath = server.args[server.args.indexOf("--config") + 1]!;
	const { version: _version, ...access } = parseJson(
		readFileSync(configPath, "utf8"),
		configPath,
	) as { version: number } & WorkflowArtifactToolConfig;
	let sources: Array<{ source: string; status: string | null }> = [];
	try {
		const manifest = await loadWorkflowSourceManifest(access.manifestPath, {
			runDir: access.runDir,
		});
		sources = manifest.sources.map((entry) => ({
			source: entry.source,
			status: entry.status ?? null,
		}));
	} catch {
		sources = [];
	}
	record(config.effectLog, {
		type: "submit",
		taskId,
		specId: task.specId,
		sources,
	});
	const reads = plannedRequiredReads(
		task.artifactGraph?.requiredReads ?? [],
		task.artifactGraph?.requiredReadPolicy ?? [],
	);
	for (const read of reads) {
		const base = {
			type: "read" as const,
			taskId,
			specId: task.specId,
			source: read.source,
			artifact: read.artifact,
			path: read.path ?? null,
		};
		try {
			await handleWorkflowArtifactToolCall(
				{
					action: "read",
					source: read.source,
					artifact: read.artifact,
					...(read.path === undefined ? {} : { path: read.path }),
					...(read.maxChars === undefined ? {} : { maxChars: read.maxChars }),
					...(read.maxItems === undefined ? {} : { maxItems: read.maxItems }),
				},
				access,
			);
			record(config.effectLog, { ...base, ok: true });
		} catch (error) {
			record(config.effectLog, {
				...base,
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export function rehearsalCapabilities(): ReturnType<typeof fakeCapabilities> {
	return fakeCapabilities({
		webTools: {
			...level("native"),
			detail: "search+fetch",
			safetyPolicy: "engine",
		},
	});
}

export function createExecutor(rawConfig: JsonValue): WorkflowExecutor {
	const config = parseConfig(rawConfig);
	const id = (rawConfig as { id?: string }).id ?? "aw-rehearsal";
	const inners = new Map<string, ReturnType<typeof createFakeExecutor>>();
	const probe = createFakeExecutor({
		id,
		capabilities: rehearsalCapabilities(),
	});
	return {
		id,
		version: REHEARSAL_EXECUTOR_VERSION,
		contractVersion: probe.contractVersion,
		probe: () => probe.probe(),
		capabilities: () => probe.capabilities(),
		async submit(req) {
			const context = await loadTask(req, config);
			let inner = inners.get(req.attemptKey);
			if (inner === undefined) {
				const finalText = await syntheticOutput(config, context);
				const script: ExecEvent[] = [
					{ type: "started", sessionId: null },
					{ type: "message_delta", text: finalText },
					{
						type: "usage",
						input: 0,
						output: 0,
						cached: null,
						cost: null,
						source: "unknown",
					},
					{ type: "completed", finalText },
				];
				inner = createFakeExecutor({
					id,
					version: REHEARSAL_EXECUTOR_VERSION,
					capabilities: rehearsalCapabilities(),
					script,
				});
				inners.set(req.attemptKey, inner);
			}
			const authority = {
				attemptKey: req.authority.attemptKey,
				async consume() {
					const decision = await req.authority.consume();
					if (decision.kind === "released")
						await performReads(req, config, context);
					return decision;
				},
			};
			return inner.submit({ ...req, authority });
		},
		observe: (ref) => inners.get(ref.attemptKey)!.observe(ref),
		async cancel(ref, scope) {
			const inner = inners.get(ref.attemptKey);
			return inner === undefined ? "no_active" : inner.cancel(ref, scope);
		},
		async reconcile(attemptKey) {
			const inner = inners.get(attemptKey);
			return inner === undefined
				? { unknown: true, reason: "attempt unknown to this process" }
				: inner.reconcile(attemptKey);
		},
		respond: (ref, requestId, decision) =>
			inners.get(ref.attemptKey)!.respond(ref, requestId, decision),
	};
}
