// 2026-11-10: the report refuses a reader translation that drops a number of its source (render-executive), and the
// original then shows — in recorded runs 20 fields in 7 of 26 runs, mostly a date dropped from an RFC fact. A shown
// key finding or lead the audit left untranslated while the report is in another script is listed too (81 of 109
// English leads in recorded Korean reports). The retranslate stage translates each once; with none, this lists no
// batch and retranslate starts no worker.
import { refusedReaderTranslations } from "./render-executive.mjs";
import { findSource, stringOf } from "./source-access.mjs";

const MAX_ITEMS = 40;
// 2026-11-10 (live check): one malformed entry fails the whole control, and a retry with the preview repeated it, so
// a batch of 24 lost every item; batches of at most 12 lose at most 12.
const BATCH_SIZE = 12;

export default async function translationCheck({ sources }) {
	const refused = refusedReaderTranslations(sources).slice(0, MAX_ITEMS);
	const items = refused.map(({ key, source, translated, dropped }) => ({
		key,
		source,
		...(translated === null
			? {}
			: { refusedTranslation: translated, droppedNumbers: dropped }),
	}));
	const sample = stringOf(findSource(sources, "final-audit")?.synthesis?.bottomLine);
	return {
		schema: "deep-research-translation-check-v1",
		digest:
			items.length === 0
				? "No reader translation is missing or drops a number of its source."
				: `${items.length} reader text(s) untranslated or dropping a number of their source get one translation.`,
		batches: Array.from(
			{ length: Math.ceil(items.length / BATCH_SIZE) },
			(_, index) => ({
				id: `refused-translations-${index + 1}`,
				reportLanguageSample: (sample ?? "").slice(0, 200),
				items: items.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
			}),
		),
	};
}
