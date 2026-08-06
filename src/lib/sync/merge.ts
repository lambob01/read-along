import type { RawCue, Sentence, Paragraph, MergeOptions } from '$lib/types';
import { isNonSpeech } from './sanitize';

/**
 * Punctuation that ends a sentence. The merge only ever breaks on the text it
 * has already merged (line 39): a cue that happens to end in punctuation is
 * the end of the *current* utterance, so it is merged in and the break fires
 * against the combined text. Breaking on the *next* cue's punctuation instead
 * leaves a fragment behind — the opening of the sentence becomes its own
 * sentence.
 *
 * Covers the Japanese terminators as well as the Latin ones. Without 。 every
 * line of a Japanese transcript looked unterminated, so consecutive cues were
 * merged until an audio gap broke them up — a whole paragraph would light up
 * as one "sentence", and mining it wrote that whole run into the card.
 *
 * The closing brackets stand alone deliberately: Japanese convention omits the
 * full stop before them, so 「そうか」 ends a sentence with no 。 to match.
 */
const SENTENCE_END_RE = /[.!?\u3002\uFF0E\uFF01\uFF1F\u2026\u00BB"」』]$/;
const DIALOGUE_START_RE = /^[-—]/;

export function mergeCues(cues: RawCue[], opts: MergeOptions = {}): Paragraph[] {
	const { gapThreshold = 1.2, showNonSpeech = false } = opts;

	const filtered = showNonSpeech ? cues : cues.filter((c) => !isNonSpeech(c.text));

	if (filtered.length === 0) return [];

	const sentences: Sentence[] = [];
	let sentenceId = 0;
	let cueIdx = 0;

	while (cueIdx < filtered.length) {
		let current = filtered[cueIdx];
		let mergedText = current.text;
		let mergedStart = current.start;
		let mergedEnd = current.end;
		const mergedCueIds = [current.index];

		while (cueIdx + 1 < filtered.length) {
			const nextCue = filtered[cueIdx + 1];
			if (SENTENCE_END_RE.test(mergedText.trimEnd())) break;
			// A run that started with a non-speech cue stays on its own: the
			// point of showNonSpeech is seeing [music] lines separately, and
			// the nextCue guard below keeps speech from absorbing them.
			if (isNonSpeech(mergedText.trim())) break;
			if (isNonSpeech(nextCue.text)) break;
			const gap = nextCue.start - mergedEnd;
			if (gap > gapThreshold) break;
			mergedText += ' ' + nextCue.text;
			mergedEnd = nextCue.end;
			mergedCueIds.push(nextCue.index);
			cueIdx++;
		}

		sentences.push({
			id: sentenceId++,
			start: mergedStart,
			end: mergedEnd,
			text: mergedText.trim(),
			cueIds: mergedCueIds
		});

		cueIdx++;
	}

	const paragraphs: Paragraph[] = [];
	let paraId = 0;
	let currentParaSentences: Sentence[] = [];

	for (let i = 0; i < sentences.length; i++) {
		const sent = sentences[i];
		const isFirst = currentParaSentences.length === 0;

		if (!isFirst) {
			const prev = currentParaSentences[currentParaSentences.length - 1];
			const gap = sent.start - prev.end;

			if (gap > gapThreshold || DIALOGUE_START_RE.test(sent.text)) {
				paragraphs.push({
					id: paraId++,
					sentences: currentParaSentences
				});
				currentParaSentences = [];
			}
		}

		currentParaSentences.push(sent);
	}

	if (currentParaSentences.length > 0) {
		paragraphs.push({
			id: paraId,
			sentences: currentParaSentences
		});
	}

	return paragraphs;
}
