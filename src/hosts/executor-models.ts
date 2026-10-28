// New in agent-workflow (WP34 item 2): `executorModelsAction`, a read helper of the host API for
// the Pi profile picker (and any host that edits role profiles). For each executor it reports the
// models its probe lists (no model call: `pi --list-models`, `codex debug models`, Claude Code's
// aliases; WP31 `probeModelList`) and whether the probe declares that list exhaustive
// (`modelListComplete`, docs/sdk.md): a role model missing from a complete list is refused at
// launch, one missing from a partial list is only noted. Probes go through the shared per-process
// cache (`cachedExecutorProber`, 60 s), so opening the picker twice probes once. Never throws for
// one executor: an unknown, unavailable or failing executor is reported with its state.
import {
	cachedExecutorProber,
	type ExecutorReadinessProber,
	INSTALLED_DEFAULT_ORDER,
	probeIsUsable,
} from "../core/executor-default.js";
import { workflowExecutorRegistration } from "../core/executor-registry.js";
import { probeModelList } from "../core/role-profiles.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	result,
} from "./types.js";

export interface ExecutorModelsRequest {
	/** Executor ids (default: pi, claude, codex). */
	executors?: readonly string[];
	/** Probe seam (tests); default: the cached real probe. */
	prober?: ExecutorReadinessProber;
	/** Bound of each probe (default 30 s). */
	timeoutMs?: number;
}

export interface ExecutorModelList {
	id: string;
	/** Installed and not logged out. */
	usable: boolean;
	/** `ready`, `not-installed`, `logged-out`, `unavailable` or `probe-failed`. */
	state:
		| "ready"
		| "not-installed"
		| "logged-out"
		| "unavailable"
		| "probe-failed";
	/** Models the probe lists; null when it cannot tell. */
	models: string[] | null;
	/** The probe declares `models` exhaustive. */
	modelListComplete: boolean;
	/** One line for a picker: what the list means for a role model. */
	note: string;
	error?: string;
}

export interface ExecutorModelsData {
	executors: ExecutorModelList[];
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** What a model list means for a role model (shown next to the list). */
export function modelListNote(
	models: readonly string[] | null,
	complete: boolean,
): string {
	if (models === null)
		return "the probe lists no models: enter a model id the CLI accepts";
	if (complete)
		return `${models.length} models; the list is complete (modelListComplete): another id is refused at launch`;
	return `${models.length} models listed; the list is partial (modelListComplete: false): another id is only noted at launch, not refused`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`probe did not finish within ${timeoutMs} ms`)),
				timeoutMs,
			);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}

async function probeModels(
	id: string,
	request: ExecutorModelsRequest,
): Promise<ExecutorModelList> {
	const registration = workflowExecutorRegistration(id);
	if (registration?.descriptor === undefined) {
		const error =
			registration?.unavailableReason ?? `executor "${id}" is unknown`;
		return {
			id,
			usable: false,
			state: "unavailable",
			models: null,
			modelListComplete: false,
			note: `unavailable: ${error}`,
			error,
		};
	}
	try {
		const { probe } = await withTimeout(
			(request.prober ?? cachedExecutorProber)(registration.descriptor),
			request.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
		);
		const installed = probe.installed === true;
		const usable = probeIsUsable({ installed, auth: probe.auth });
		const models = probeModelList(
			probe as Parameters<typeof probeModelList>[0],
		);
		const complete = probe.modelListComplete === true;
		return {
			id,
			usable,
			state: !installed ? "not-installed" : usable ? "ready" : "logged-out",
			models,
			modelListComplete: complete,
			note: modelListNote(models, complete),
		};
	} catch (error) {
		const message = (
			error instanceof Error ? error.message : String(error)
		).slice(0, 500);
		return {
			id,
			usable: false,
			state: "probe-failed",
			models: null,
			modelListComplete: false,
			note: `probe failed: ${message}`,
			error: message,
		};
	}
}

/** The models each executor's probe lists (no model call). */
export async function executorModelsAction(
	ctx: HostApiContext,
	request: ExecutorModelsRequest = {},
): Promise<HostResult<ExecutorModelsData>> {
	assertActionAllowed(ctx, "profile");
	const ids = request.executors ?? INSTALLED_DEFAULT_ORDER;
	const executors = await Promise.all(
		ids.map((id) => probeModels(id, request)),
	);
	return result(
		"profile",
		"success",
		{ executors },
		executors
			.map(
				(entry) =>
					`${entry.id} (${entry.state}): ${entry.note}${entry.models?.length ? `\n  ${entry.models.join(", ")}` : ""}`,
			)
			.join("\n"),
	);
}
