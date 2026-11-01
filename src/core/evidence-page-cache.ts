// agent-workflow 2026-11-01: content-addressed cache of pages fetched for evidence checks.
// Like kimi-code's image originals (SHA-256 file names, one total cap): bodies are stored once per
// content hash under `.agent-workflow/evidence-cache/`, URL entries point at them, runs record only
// the hash. The total size is capped (default 1 GiB); the oldest bodies are evicted first.
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export interface CachedPage {
	readonly url: string;
	readonly finalUrl: string;
	readonly status: number;
	readonly contentType: string;
	readonly bodySha256: string;
	readonly bytes: number;
	readonly fetchedAt: string;
	readonly redirects: readonly string[];
}

export interface EvidencePageCacheOptions {
	readonly maxTotalBytes?: number;
	/** Entries older than this are fetched again (default 24 h). */
	readonly maxAgeMs?: number;
	readonly now?: () => number;
}

export function evidenceCacheDir(cwd: string): string {
	return join(cwd, ".agent-workflow", "evidence-cache");
}

const sha256 = (data: string | Buffer): string =>
	createHash("sha256").update(data).digest("hex");

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, data);
	await rename(temp, path);
}

export class EvidencePageCache {
	readonly #dir: string;
	readonly #maxTotalBytes: number;
	readonly #maxAgeMs: number;
	readonly #now: () => number;

	constructor(dir: string, options: EvidencePageCacheOptions = {}) {
		this.#dir = dir;
		this.#maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
		this.#maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
		this.#now = options.now ?? Date.now;
	}

	#entryPath(url: string): string {
		return join(this.#dir, "urls", `${sha256(url)}.json`);
	}

	#bodyPath(hash: string): string {
		return join(this.#dir, "bodies", hash);
	}

	async get(
		url: string,
	): Promise<{ page: CachedPage; body: Buffer } | undefined> {
		try {
			const page = JSON.parse(
				await readFile(this.#entryPath(url), "utf8"),
			) as CachedPage;
			if (
				page.url !== url ||
				!/^[0-9a-f]{64}$/.test(page.bodySha256) ||
				this.#now() - Date.parse(page.fetchedAt) > this.#maxAgeMs
			)
				return undefined;
			const body = await readFile(this.#bodyPath(page.bodySha256));
			if (sha256(body) !== page.bodySha256) return undefined;
			return { page, body };
		} catch {
			return undefined;
		}
	}

	async put(
		page: Omit<CachedPage, "bodySha256" | "bytes" | "fetchedAt">,
		body: Buffer,
	): Promise<CachedPage> {
		const entry: CachedPage = {
			...page,
			bodySha256: sha256(body),
			bytes: body.length,
			fetchedAt: new Date(this.#now()).toISOString(),
		};
		await mkdir(join(this.#dir, "bodies"), { recursive: true });
		await mkdir(join(this.#dir, "urls"), { recursive: true });
		const bodyPath = this.#bodyPath(entry.bodySha256);
		const exists = await stat(bodyPath).then(
			() => true,
			() => false,
		);
		if (exists) {
			const now = new Date(this.#now());
			await utimes(bodyPath, now, now).catch(() => undefined);
		} else await writeAtomic(bodyPath, body);
		await writeAtomic(this.#entryPath(page.url), JSON.stringify(entry));
		await this.#evict();
		return entry;
	}

	async #evict(): Promise<void> {
		const dir = join(this.#dir, "bodies");
		const files = await Promise.all(
			(await readdir(dir))
				.filter((name) => /^[0-9a-f]{64}$/.test(name))
				.map(async (name) => {
					const info = await stat(join(dir, name)).catch(() => undefined);
					return info
						? { name, size: info.size, mtime: info.mtimeMs }
						: undefined;
				}),
		);
		const bodies = files.filter((file) => file !== undefined);
		let total = bodies.reduce((sum, file) => sum + file.size, 0);
		if (total <= this.#maxTotalBytes) return;
		bodies.sort((a, b) => a.mtime - b.mtime);
		for (const file of bodies) {
			if (total <= this.#maxTotalBytes) break;
			await rm(join(dir, file.name), { force: true });
			total -= file.size;
		}
	}
}
