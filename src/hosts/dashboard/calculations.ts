import { randomUUID } from "node:crypto";

interface Reply {
	status: number;
	value: unknown;
}
interface Calculation {
	at: number;
	reply?: Reply;
}
/** Dashboard-only asynchronous reads. No launch/save authority, persisted state or stale success. */
export class DashboardCalculations {
	private readonly jobs = new Map<string, Calculation>();
	constructor(private readonly now: () => number) {}
	private prune() {
		for (const [id, job] of this.jobs)
			if (job.reply && this.now() - job.at > 60_000) this.jobs.delete(id);
	}
	private pending(calculationId: string) {
		return {
			status: 202,
			value: {
				pending: true,
				calculationId,
				poll: `/api/calculations/${calculationId}`,
				retryAfterMs: 150,
			},
		};
	}
	start(
		action: () => Promise<unknown>,
		status: (error: unknown) => number = (error) =>
			(error as { status?: number })?.status ?? 500,
	) {
		this.prune();
		if (this.jobs.size >= 8) {
			const completed = [...this.jobs].find(([, job]) => job.reply);
			if (completed) this.jobs.delete(completed[0]);
		}
		if (this.jobs.size >= 8)
			throw Object.assign(new Error("calculation queue is full; try again"), {
				status: 429,
			});
		const id = randomUUID();
		const job: Calculation = { at: this.now() };
		this.jobs.set(id, job);
		void Promise.resolve()
			.then(action)
			.then(
				(value) => {
					job.reply = { status: 200, value };
					job.at = this.now();
				},
				(error) => {
					job.reply = {
						status: status(error),
						value: {
							error: error instanceof Error ? error.message : String(error),
						},
					};
					job.at = this.now();
				},
			);
		return this.pending(id);
	}
	read(id: string) {
		this.prune();
		const job = this.jobs.get(id);
		if (!job)
			return {
				status: 404,
				value: { error: "Calculation expired; retry the preview." },
			};
		return job.reply ?? this.pending(id);
	}
}
