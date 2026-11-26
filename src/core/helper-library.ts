// Read tested bundle-local helper sources shipped alongside the compiled engine.
import { readFileSync } from "node:fs";

/** The bytes of one helper file. */
export function readHelperFile(file: string): string {
	return readFileSync(
		new URL(`./helper-library/${file}`, import.meta.url),
		"utf8",
	);
}
