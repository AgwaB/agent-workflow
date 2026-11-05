// The active-workflows widget lists only runs tracked by this Pi session.
// The TUI foreground loader cancels waits without stopping runs; cancelling auto
// comparison aborts its request and starts nothing. Load BorderedLoader lazily from Pi;
// RPC, print, and JSON modes run without a loader.
import type { WorkflowRunRecord } from "../../core/types.js";
import type { PiExtensionContext } from "./pi-types.js";
import { loadPiRuntimeModule } from "./pi-runtime.js";

export const AW_ACTIVE_WIDGET_KEY = "agent-workflow-active";
const ACTIVE_WORKFLOW_LIMIT = 5;

type ActiveRun = Pick<
	WorkflowRunRecord,
	"runId" | "name" | "createdAt" | "taskSummary" | "status"
>;

function truncateLabel(value: string, maxCodePoints: number): string {
	const points = Array.from(value);
	if (points.length <= maxCodePoints) return value;
	return `${points.slice(0, Math.max(1, maxCodePoints - 1)).join("")}…`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/** Visible progress includes completed and running tasks. */
function visibleProgress(run: ActiveRun): number {
	return (run.taskSummary.completed ?? 0) + (run.taskSummary.running ?? 0);
}

/** The widget lines for this session's active runs (newest first); [] when none. */
export function formatActiveWorkflowLines(
	runs: ActiveRun[],
	nowMs = Date.now(),
): string[] {
	if (runs.length === 0) return [];
	const visible = runs.slice(0, ACTIVE_WORKFLOW_LIMIT);
	const lines = [
		"Active workflows",
		...visible.map((run) => {
			const createdAtMs = Date.parse(run.createdAt ?? "");
			const elapsed = Number.isFinite(createdAtMs)
				? ` · ${formatElapsed(nowMs - createdAtMs)}`
				: "";
			return `● ${truncateLabel(run.name ?? run.runId, 28)} ${visibleProgress(run)}/${run.taskSummary.total} ${run.status}${elapsed}`;
		}),
	];
	if (runs.length > visible.length)
		lines.push(`… and ${runs.length - visible.length} more`);
	return lines;
}

/** Set (lines) or clear (undefined) the widget; UI rendering never affects a run. */
export function setActiveWorkflowWidget(
	ctx: PiExtensionContext,
	lines: string[] | undefined,
): void {
	const set = ctx.ui.setWidget;
	if (typeof set !== "function") return;
	try {
		set.call(ctx.ui, AW_ACTIVE_WIDGET_KEY, lines, {
			placement: "belowEditor",
		});
	} catch {
		// Optional UI.
	}
}

/** A cancellable loader component (Pi's `BorderedLoader`: `signal` aborts on Escape). */
export interface ForegroundLoader {
	readonly signal: AbortSignal;
	onAbort?: (() => void) | undefined;
}

export type ForegroundLoaderFactory = (
	tui: unknown,
	theme: unknown,
	label: string,
) => ForegroundLoader;

export const FOREGROUND_CANCELLED: unique symbol = Symbol(
	"agent-workflow-foreground-cancelled",
);

/** Pi's `BorderedLoader` (Pi 1.1 exports it); undefined when it cannot be loaded. */
export async function piBorderedLoaderFactory(): Promise<
	ForegroundLoaderFactory | undefined
> {
	try {
		const pi = (await loadPiRuntimeModule()) as {
			BorderedLoader?: new (
				tui: unknown,
				theme: unknown,
				message: string,
			) => ForegroundLoader;
		};
		const Loader = pi.BorderedLoader;
		if (typeof Loader !== "function") return undefined;
		return (tui, theme, label) => new Loader(tui, theme, label);
	} catch {
		return undefined;
	}
}

type Outcome<T> =
	| { kind: "completed"; value: T }
	| { kind: "cancelled" }
	| { kind: "failed"; error: unknown };

/**
 * Run `operation` behind a cancellable loader while it blocks the session (TUI only). Escape
 * aborts the operation's signal and resolves FOREGROUND_CANCELLED at once; the operation must
 * treat the signal as "stop waiting" only. Without a TUI (RPC, print, JSON) or without the loader
 * the operation runs as is.
 */
export async function withForegroundLoader<T>(
	ctx: PiExtensionContext,
	label: string,
	operation: (signal: AbortSignal | undefined) => Promise<T>,
	/** Loader provider (tests); default: Pi's BorderedLoader. */
	loaderFactory: () => Promise<
		ForegroundLoaderFactory | undefined
	> = piBorderedLoaderFactory,
): Promise<T | typeof FOREGROUND_CANCELLED> {
	const custom = ctx.ui.custom;
	if (!ctx.hasUI || ctx.mode !== "tui" || typeof custom !== "function")
		return operation(undefined);
	const create = await loaderFactory().catch(() => undefined);
	if (!create) return operation(undefined);
	const outcome = await custom.call(
		ctx.ui,
		(
			tui: unknown,
			theme: unknown,
			_keybindings: unknown,
			done: (value: Outcome<T>) => void,
		) => {
			const loader = create(tui, theme, label);
			let settled = false;
			const finish = (value: Outcome<T>) => {
				if (settled) return;
				settled = true;
				done(value);
			};
			loader.onAbort = () => finish({ kind: "cancelled" });
			Promise.resolve()
				.then(() => operation(loader.signal))
				.then(
					(value) =>
						finish(
							loader.signal.aborted
								? { kind: "cancelled" }
								: { kind: "completed", value },
						),
					(error: unknown) =>
						finish(
							loader.signal.aborted
								? { kind: "cancelled" }
								: { kind: "failed", error },
						),
				);
			return loader;
		},
	);
	const result = outcome as Outcome<T> | undefined;
	if (!result || result.kind === "cancelled") return FOREGROUND_CANCELLED;
	if (result.kind === "failed") throw result.error;
	return result.value;
}
