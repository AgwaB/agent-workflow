// 2026-11-10: the report refuses a reader translation that drops a number of its source (render-executive), and the
// original then shows — in recorded runs 22 fields in 8 of 12 runs, mostly a date dropped from an RFC fact. This
// stage lists those fields so the retranslate stage can try each once more; with none, it lists no batch and
// retranslate starts no worker.
import { refusedReaderTranslations } from "./render-executive.mjs";

const MAX_ITEMS = 24;

export default async function translationCheck({ sources }) {
	const refused = refusedReaderTranslations(sources).slice(0, MAX_ITEMS);
	const items = refused.map(({ key, source, translated, dropped }) => ({
		key,
		source,
		refusedTranslation: translated,
		droppedNumbers: dropped,
	}));
	return {
		schema: "deep-research-translation-check-v1",
		digest:
			items.length === 0
				? "No reader translation drops a number of its source."
				: `${items.length} reader translation(s) drop a number of their source and get one retranslation.`,
		batches: items.length === 0 ? [] : [{ id: "refused-translations", items }],
	};
}
