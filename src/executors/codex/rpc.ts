/**
 * Minimal newline-delimited JSON-RPC 2.0 client for `codex app-server` over stdio (WP7).
 * Protocol discovered from codex-cli 0.159.2 (`codex app-server generate-ts`) and live traffic;
 * the message shapes follow openai/codex-plugin-cc `app-server.mjs` (Apache-2.0), no code copied.
 * The server omits `"jsonrpc": "2.0"` on its messages and accepts requests without it.
 * Lines are split on "\n" only: node:readline also splits on U+2028/U+2029, which JSON strings
 * may contain unescaped (seen live in web_search results).
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcId = number | string;

export interface RpcMessage {
	readonly id?: RpcId;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code?: number; readonly message?: string };
}

export class RpcError extends Error {
	readonly code: number | undefined;
	readonly method: string;
	constructor(method: string, error: RpcMessage["error"]) {
		super(error?.message ?? `codex app-server ${method} failed`);
		this.name = "RpcError";
		this.code = error?.code;
		this.method = method;
	}
}

export interface RpcHandlers {
	/** Server notification (no id). */
	onNotification(method: string, params: unknown, line: string): void;
	/** Server → client request (approval, elicitation, …). Answer later with `respond`. */
	onServerRequest(id: RpcId, method: string, params: unknown): void;
	/** Every line in either direction, for the raw transcript. */
	onLine?(direction: "in" | "out", message: RpcMessage): void;
	onClose(error: Error | null): void;
}

export class AppServerConnection {
	private nextId = 1;
	private readonly pending = new Map<
		RpcId,
		{
			method: string;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	private closed = false;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly handlers: RpcHandlers,
	) {
		child.stdin.on("error", () => {
			// Late writes after exit must not crash the adapter.
		});
		let buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				newline = buffer.indexOf("\n");
			}
		});
		child.stdout.on("end", () => {
			if (buffer.trim() !== "") this.handleLine(buffer);
			buffer = "";
		});
		child.once("close", (code, signal) => {
			this.close(
				code === 0
					? null
					: new Error(
							`codex app-server exited (${signal === null ? `exit ${code}` : `signal ${signal}`})`,
						),
			);
		});
		child.once("error", (error) => this.close(error));
	}

	get isClosed(): boolean {
		return this.closed;
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		if (this.closed)
			return Promise.reject(
				new Error(`codex app-server is closed (request ${method})`),
			);
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				method,
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.send({ id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		this.send(params === undefined ? { method } : { method, params });
	}

	respond(id: RpcId, result: unknown): void {
		this.send({ id, result });
	}

	respondError(id: RpcId, code: number, message: string): void {
		this.send({ id, error: { code, message } });
	}

	/** Close stdin (the server exits on EOF). */
	end(): void {
		if (!this.child.stdin.destroyed) this.child.stdin.end();
	}

	private send(message: RpcMessage): void {
		if (this.closed || this.child.stdin.destroyed) return;
		this.handlers.onLine?.("out", message);
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		if (line.trim() === "") return;
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch {
			this.handlers.onLine?.("in", { method: "<unparsable>", params: line });
			return;
		}
		this.handlers.onLine?.("in", message);
		if (message.id !== undefined && typeof message.method === "string") {
			this.handlers.onServerRequest(message.id, message.method, message.params);
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			if (pending === undefined) return;
			this.pending.delete(message.id);
			if (message.error !== undefined && message.error !== null)
				pending.reject(new RpcError(pending.method, message.error));
			else pending.resolve(message.result ?? {});
			return;
		}
		if (typeof message.method === "string")
			this.handlers.onNotification(message.method, message.params, line);
	}

	private close(error: Error | null): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values())
			pending.reject(
				error ??
					new Error(
						`codex app-server closed before ${pending.method} returned`,
					),
			);
		this.pending.clear();
		this.handlers.onClose(error);
	}
}
