/**
 * Minimal JSON-RPC 2.0 peer over newline-delimited JSON (ACP stdio transport, protocol v1
 * `transports.mdx`). Records are split on LF only: U+2028/U+2029 are valid inside JSON strings, so
 * a generic line reader (Node readline) must not be used. The peer answers requests from the agent
 * through `onRequest`; an unknown method gets JSON-RPC error -32601.
 */
import type { Readable, Writable } from "node:stream";

export interface RpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(error: RpcError) {
		super(error.message);
		this.name = "AcpRpcError";
		this.code = error.code;
		this.data = error.data;
	}
}

export const METHOD_NOT_FOUND = -32601;

export interface AcpPeerOptions {
	readonly input: Readable;
	readonly output: Writable;
	/** Every incoming record, verbatim (the adapter keeps a raw log). */
	readonly onLine?: (line: string) => void;
	/** Agent → client request. Throw an `AcpRpcError` to answer with an error. */
	readonly onRequest?: (method: string, params: unknown) => Promise<unknown>;
	readonly onNotification?: (method: string, params: unknown) => void;
	/** The agent's stdout ended or closed. */
	readonly onClose?: () => void;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class AcpPeer {
	private readonly options: AcpPeerOptions;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = "";
	private closed = false;
	parseErrors = 0;

	constructor(options: AcpPeerOptions) {
		this.options = options;
		options.input.setEncoding?.("utf8");
		options.input.on("data", (chunk: string | Buffer) =>
			this.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
		);
		const end = () => {
			if (this.buffer.trim() !== "") this.record(this.buffer);
			this.buffer = "";
			this.close(new Error("agent closed its output"));
		};
		options.input.on("end", end);
		options.input.on("close", end);
		options.input.on("error", end);
		options.output.on?.("error", () =>
			this.close(new Error("agent input closed")),
		);
	}

	private push(text: string): void {
		this.buffer += text;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim() !== "") this.record(line);
			index = this.buffer.indexOf("\n");
		}
	}

	private record(line: string): void {
		this.options.onLine?.(line);
		let message: Record<string, unknown>;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			)
				throw new Error("not an object");
			message = parsed as Record<string, unknown>;
		} catch {
			this.parseErrors += 1;
			return;
		}
		const hasId =
			typeof message.id === "number" || typeof message.id === "string";
		if (typeof message.method === "string") {
			if (hasId)
				void this.answer(
					message.id as number | string,
					message.method,
					message.params,
				);
			else this.options.onNotification?.(message.method, message.params);
			return;
		}
		if (!hasId) return;
		const pending = this.pending.get(message.id as number);
		if (pending === undefined) return;
		this.pending.delete(message.id as number);
		if (message.error !== undefined && message.error !== null) {
			const error = message.error as Partial<RpcError>;
			pending.reject(
				new AcpRpcError({
					code: typeof error.code === "number" ? error.code : -32000,
					message:
						typeof error.message === "string" ? error.message : "agent error",
					data: error.data,
				}),
			);
		} else pending.resolve(message.result);
	}

	private async answer(
		id: number | string,
		method: string,
		params: unknown,
	): Promise<void> {
		try {
			if (this.options.onRequest === undefined)
				throw new AcpRpcError({
					code: METHOD_NOT_FOUND,
					message: `method not found: ${method}`,
				});
			const result = await this.options.onRequest(method, params);
			this.write({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (error) {
			const rpc =
				error instanceof AcpRpcError
					? { code: error.code, message: error.message }
					: {
							code: -32603,
							message: error instanceof Error ? error.message : String(error),
						};
			this.write({ jsonrpc: "2.0", id, error: rpc });
		}
	}

	private write(message: unknown): boolean {
		if (this.closed) return false;
		try {
			this.options.output.write(`${JSON.stringify(message)}\n`);
			return true;
		} catch {
			return false;
		}
	}

	request(method: string, params: unknown): Promise<unknown> {
		if (this.closed)
			return Promise.reject(new Error(`agent closed before ${method}`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			if (!this.write({ jsonrpc: "2.0", id, method, params })) {
				this.pending.delete(id);
				reject(new Error(`cannot send ${method}`));
			}
		});
	}

	notify(method: string, params: unknown): boolean {
		return this.write({ jsonrpc: "2.0", method, params });
	}

	close(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
		this.options.onClose?.();
	}
}
