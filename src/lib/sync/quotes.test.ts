import { describe, it, expect } from 'vitest';
import { buildRepeatUnits } from '$lib/sync/quotes';
import type { TimingIndex } from '$lib/types';

/** One line per entry, each a second long and contiguous. */
function index(texts: string[]): TimingIndex {
	const sentences = texts.map((text, i) => ({ id: i, start: i, end: i + 1, text }));
	return {
		sentences,
		starts: Float64Array.from(sentences.map((s) => s.start)),
		ends: Float64Array.from(sentences.map((s) => s.end))
	};
}

/** Compact view of the grouping: one `start-end` per unit. */
function spans(t: TimingIndex): string[] {
	return t.sentences.map((s, i) => `${t.starts[i]}-${t.ends[i]}`);
}

describe('buildRepeatUnits', () => {
	it('leaves unquoted lines alone', () => {
		const u = buildRepeatUnits(index(['あ', 'い', 'う']));
		expect(spans(u)).toEqual(['0-1', '1-2', '2-3']);
	});

	it('joins a quote that runs across lines', () => {
		const u = buildRepeatUnits(
			index(['地の文', '「覚えてないの？', 'また会おうって', '入ってるはずだけど」', '次の地の文'])
		);
		expect(spans(u)).toEqual(['0-1', '1-4', '4-5']);
		expect(u.sentences[1].id).toBe(1);
	});

	it('keeps a quote that opens and closes on one line as one unit', () => {
		const u = buildRepeatUnits(index(['「はい」', 'あと']));
		expect(spans(u)).toEqual(['0-1', '1-2']);
	});

	it('counts 『』 nested inside 「」 towards the same run', () => {
		const u = buildRepeatUnits(index(['「彼は『やめろ』と', '言った」', '地の文']));
		expect(spans(u)).toEqual(['0-2', '2-3']);
	});

	it('handles a line that closes one quote and opens the next', () => {
		const u = buildRepeatUnits(
			index(['「ひとつめ', 'まだ」そして「ふたつめ', 'おわり」', '地の文'])
		);
		expect(spans(u)).toEqual(['0-3', '3-4']);
	});

	it('does not let a stray closer push the depth below zero', () => {
		// The 」 has no opener; the 「 that follows must still open a run.
		const u = buildRepeatUnits(index(['壊れた」', '「本物の', 'せりふ」', '地の文']));
		expect(spans(u)).toEqual(['0-1', '1-3', '3-4']);
	});

	it('caps a quote that is never closed instead of swallowing the book', () => {
		const u = buildRepeatUnits(index(['「開いたまま', 'あ', 'い', 'う', 'え']), { maxLines: 3 });
		expect(spans(u)).toEqual(['0-3', '3-4', '4-5']);
	});

	it('returns the index untouched when grouping is off', () => {
		const src = index(['「ひとつめ', 'おわり」']);
		expect(buildRepeatUnits(src, { group: false })).toBe(src);
	});

	it('survives lines with no text', () => {
		const src: TimingIndex = {
			sentences: [
				{ id: 0, start: 0, end: 1 },
				{ id: 1, start: 1, end: 2 }
			],
			starts: Float64Array.from([0, 1]),
			ends: Float64Array.from([1, 2])
		};
		expect(spans(buildRepeatUnits(src))).toEqual(['0-1', '1-2']);
	});

	it('handles an empty index', () => {
		expect(buildRepeatUnits(index([])).sentences).toEqual([]);
	});
});
