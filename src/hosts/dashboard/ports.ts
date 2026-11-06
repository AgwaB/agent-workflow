import type { Server } from "node:net";

/** Settle both listeners on each attempt, including a failed bind before a retry. */
export function listenDashboardPort(
	server: Server,
	port: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			server.off("listening", onListening);
			server.off("error", onError);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		try {
			server.listen(port, "127.0.0.1");
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

/** Ordered bind candidates; zero asks the OS for an ephemeral port. No I/O. */
export function dashboardPortCandidates(options: {
	explicit?: number;
	customHome: boolean;
	lastPort?: number;
}): number[] {
	if (options.explicit !== undefined) return [options.explicit];
	if (options.customHome) return options.lastPort ? [options.lastPort, 0] : [0];
	return [...Array.from({ length: 10 }, (_, index) => 7417 + index), 0];
}

/** The binder is injected so fallback ordering can be exercised without touching default ports. */
export async function bindDashboardPort(
	candidates: readonly number[],
	listen: (port: number) => Promise<void>,
): Promise<void> {
	if (!candidates.length) throw new Error("dashboard port policy is empty");
	for (const [index, candidate] of candidates.entries()) {
		try {
			await listen(candidate);
			return;
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
				index === candidates.length - 1
			)
				throw error;
		}
	}
}
