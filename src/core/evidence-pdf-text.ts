// agent-workflow 2026-11-01: PDF text through the system `pdftotext` (poppler), like qwen-code's
// utils/pdf.ts: no bundled PDF dependency; when the tool is missing the quote is reported as
// unchecked with that reason instead of failing.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PdfTextResult =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly reason: "pdf-tool-missing" | "pdf-extract-failed";
			readonly detail: string;
	  };

export function isPdf(contentType: string, body: Buffer): boolean {
	return (
		/^application\/(?:x-)?pdf\b/i.test(contentType) ||
		body.subarray(0, 5).toString("latin1") === "%PDF-"
	);
}

export async function pdfToText(
	body: Buffer,
	options: { signal?: AbortSignal; timeoutMs?: number; command?: string } = {},
): Promise<PdfTextResult> {
	const dir = await mkdtemp(join(tmpdir(), "aw-evidence-pdf-"));
	try {
		const file = join(dir, "page.pdf");
		await writeFile(file, body);
		return await new Promise<PdfTextResult>((resolve) => {
			execFile(
				options.command ?? "pdftotext",
				["-q", "-enc", "UTF-8", file, "-"],
				{
					timeout: options.timeoutMs ?? 30_000,
					maxBuffer: 32 * 1024 * 1024,
					encoding: "utf8",
					...(options.signal ? { signal: options.signal } : {}),
				},
				(error, stdout) => {
					if (!error) return resolve({ ok: true, text: stdout });
					const code = (error as NodeJS.ErrnoException).code;
					resolve(
						code === "ENOENT"
							? {
									ok: false,
									reason: "pdf-tool-missing",
									detail:
										"pdftotext is not installed (install poppler, e.g. `brew install poppler` or `apt-get install poppler-utils`)",
								}
							: {
									ok: false,
									reason: "pdf-extract-failed",
									detail: error.message.slice(0, 200),
								},
					);
				},
			);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** PDF text plus a copy with line-break hyphenation joined ("recog-\nnition" → "recognition"). */
export function pdfTextViews(text: string): string[] {
	const joined = text.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2");
	return joined === text ? [text] : [text, joined];
}
