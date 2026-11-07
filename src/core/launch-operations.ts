import { throwIfWorkflowStopRequested } from "./workflow-stop.js";

export const WORKER_LAUNCH_ACK_TIMEOUT_MS = 30_000;
export const WORKER_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
export const WORKER_INTERRUPT_TIMEOUT_MS = 10_000;
export function abortSignalError(signal: AbortSignal): Error {
	const reason = (signal as AbortSignal & { reason?: unknown }).reason;
	if (reason instanceof Error) return reason;
	return new Error(
		reason === undefined
			? "Lost supervisor lease"
			: `Lost supervisor lease: ${String(reason)}`,
	);
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortSignalError(signal);
}

export async function throwIfLaunchStopped(
	cwd: string,
	runId: string,
	leaseSignal?: AbortSignal,
	workflowStopSignal?: AbortSignal,
): Promise<void> {
	throwIfAborted(leaseSignal);
	throwIfAborted(workflowStopSignal);
	await throwIfWorkflowStopRequested(cwd, runId);
	throwIfAborted(leaseSignal);
	throwIfAborted(workflowStopSignal);
}

export function combineAbortSignals(
	left?: AbortSignal,
	right?: AbortSignal,
): AbortSignal | undefined {
	if (!left) return right;
	if (!right) return left;
	return AbortSignal.any([left, right]);
}

export class WorkerOperationTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerOperationTimeoutError";
	}
}

export async function awaitWorkerOperation<T>(
	operation: () => Promise<T>,
	options: {
		operation: string;
		context: string;
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<T> {
	throwIfAborted(options.signal);
	const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
	return new Promise<T>((resolveOperation, rejectOperation) => {
		let settled = false;
		let abortListener: (() => void) | undefined;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (options.signal && abortListener) {
				options.signal.removeEventListener("abort", abortListener);
			}
			callback();
		};
		const timer = setTimeout(() => {
			finish(() =>
				rejectOperation(
					new WorkerOperationTimeoutError(
						`worker ${options.operation} timed out after ${timeoutMs}ms (${options.context})`,
					),
				),
			);
		}, timeoutMs);
		if (options.signal) {
			abortListener = () => {
				finish(() => rejectOperation(abortSignalError(options.signal!)));
			};
			options.signal.addEventListener("abort", abortListener, { once: true });
		}
		Promise.resolve()
			.then(() => {
				// Cancellation can win after this waiter is created but before its
				// operation microtask starts. Never dispatch work after that outcome.
				throwIfAborted(options.signal);
				return operation();
			})
			.then(
				(value) => finish(() => resolveOperation(value)),
				(error: unknown) => finish(() => rejectOperation(error)),
			);
	});
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
