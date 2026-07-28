import { describe, it, expect } from 'vitest';
import { alignEpubToCues } from '$lib/sync/align';
import { collectBlocks, blockPlainText, resolvePath } from '$lib/epub/text';
import type { EpubDoc, RawCue } from '$lib/types';

/** Builds a single-chapter EpubDoc from a body HTML fragment. */
function makeDoc(bodyHtml: string, chapters?: string[]): EpubDoc {
	const sources = chapters ?? [bodyHtml];
	return {
		title: 'Test Book',
		author: 'Test Author',
		language: 'ja',
		chapters: sources.map((html, i) => {
			const doc = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
			return {
				id: `ch${i}`,
				order: i,
				href: `ch${i}.xhtml`,
				title: `Chapter ${i + 1}`,
				body: doc.body as HTMLElement
			};
		})
	};
}

/** Builds cues from [text, start, end] tuples. */
function makeCues(rows: [string, number, number][]): RawCue[] {
	return rows.map(([text, start, end], i) => ({ index: i, start, end, text }));
}

describe('epub/text', () => {
	it('excludes furigana from prose text but keeps the ruby base', () => {
		const doc = makeDoc('<p>今日<ruby>漢字<rt>かんじ</rt></ruby>です。</p>');
		const p = doc.chapters[0].body.querySelector('p')!;
		expect(blockPlainText(p)).toBe('今日漢字です。');
	});

	it('collects block elements in reading order', () => {
		const doc = makeDoc('<h1>見出し</h1><p>本文一。</p><div><p>本文二。</p></div>');
		const blocks = collectBlocks(doc.chapters[0].body);
		expect(blocks.map((b) => b.el.tagName.toLowerCase())).toEqual(['h1', 'p', 'p']);
	});

	it('skips empty blocks', () => {
		const doc = makeDoc('<p>本文。</p><p>   </p><p></p>');
		expect(collectBlocks(doc.chapters[0].body).length).toBe(1);
	});

	it('resolves a node path back to its element', () => {
		const doc = makeDoc('<div><p>一。</p><p>二。</p></div>');
		const body = doc.chapters[0].body;
		const blocks = collectBlocks(body);
		for (const b of blocks) {
			expect(resolvePath(body, b.path)).toBe(b.el);
		}
	});
});

describe('alignEpubToCues', () => {
	it('times sentences when subtitle text matches the epub exactly', () => {
		const doc = makeDoc('<p>朝が来た。鳥が鳴いた。</p>');
		const cues = makeCues([
			['朝が来た。', 0, 2],
			['鳥が鳴いた。', 2, 4]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences.length).toBe(2);
		expect(index.sentences.every((s) => s.timed)).toBe(true);
		expect(index.stats.coverage).toBe(1);
		expect(index.sentences[0].start).toBeCloseTo(0, 5);
		expect(index.sentences[1].end).toBeCloseTo(4, 5);
	});

	it('aligns despite furigana present only in the epub', () => {
		const doc = makeDoc('<p><ruby>朝<rt>あさ</rt></ruby>が来た。</p>');
		const cues = makeCues([['朝が来た。', 0, 2]]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences[0].timed).toBe(true);
		expect(index.stats.coverage).toBe(1);
	});

	it('aligns despite punctuation and width differences', () => {
		const doc = makeDoc('<p>「ＡＢＣ」と言った。</p>');
		const cues = makeCues([['ABC と言った', 0, 3]]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences[0].timed).toBe(true);
	});

	it('marks unaligned front matter as untimed', () => {
		const doc = makeDoc('<p>著作権表示のページ。</p><p>朝が来た。</p>');
		const cues = makeCues([['朝が来た。', 10, 12]]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences[0].timed).toBe(false);
		expect(index.sentences[1].timed).toBe(true);
		// Untimed sentences are excluded from the timing arrays entirely.
		expect(index.timed.length).toBe(1);
		expect(index.starts.length).toBe(1);
	});

	it('recovers alignment after an inserted cue', () => {
		const doc = makeDoc('<p>最初の文である。次の文である。最後の文である。</p>');
		const cues = makeCues([
			['最初の文である。', 0, 2],
			['ここは主題歌の歌詞。', 2, 4],
			['次の文である。', 4, 6],
			['最後の文である。', 6, 8]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences.length).toBe(3);
		expect(index.sentences.every((s) => s.timed)).toBe(true);
		expect(index.sentences[2].start).toBeGreaterThan(index.sentences[1].start);
	});

	it('handles one cue spanning several epub sentences', () => {
		const doc = makeDoc('<p>短い文。もう一つ。</p>');
		const cues = makeCues([['短い文。もう一つ。', 0, 4]]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences.every((s) => s.timed)).toBe(true);
		expect(index.sentences[0].end).toBeLessThanOrEqual(index.sentences[1].start + 1e-9);
	});

	it('handles a sentence spanning several cues', () => {
		const doc = makeDoc('<p>これは長い一つの文である。</p>');
		const cues = makeCues([
			['これは長い', 0, 1],
			['一つの文である。', 1, 3]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences.length).toBe(1);
		expect(index.sentences[0].start).toBeCloseTo(0, 5);
		expect(index.sentences[0].end).toBeCloseTo(3, 5);
	});

	it('spans multiple chapters in spine order', () => {
		const doc = makeDoc('', ['<p>第一章の文。</p>', '<p>第二章の文。</p>']);
		const cues = makeCues([
			['第一章の文。', 0, 2],
			['第二章の文。', 2, 4]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences[0].chapterOrder).toBe(0);
		expect(index.sentences[1].chapterOrder).toBe(1);
		expect(index.sentences.every((s) => s.timed)).toBe(true);
	});

	it('reports zero coverage when nothing matches', () => {
		const doc = makeDoc('<p>全く違う内容である。</p>');
		const cues = makeCues([['無関係な音声の書き起こし。', 0, 2]]);

		const index = alignEpubToCues(doc, cues);

		expect(index.stats.coverage).toBe(0);
		expect(index.starts.length).toBe(0);
	});

	it('tolerates an empty cue list', () => {
		const doc = makeDoc('<p>本文である。</p>');
		const index = alignEpubToCues(doc, []);

		expect(index.sentences.length).toBe(1);
		expect(index.sentences[0].timed).toBe(false);
		expect(index.stats.coverage).toBe(0);
	});
});

describe('alignment index invariants', () => {
	/** The ticker's binary search requires sorted, non-overlapping ranges. */
	function assertMonotonic(starts: Float64Array, ends: Float64Array) {
		for (let i = 0; i < starts.length; i++) {
			expect(ends[i]).toBeGreaterThan(starts[i]);
			if (i > 0) {
				expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
				expect(starts[i]).toBeGreaterThanOrEqual(ends[i - 1] - 1e-9);
			}
		}
	}

	it('emits sorted, non-overlapping, positive-width ranges', () => {
		const doc = makeDoc('<h1>見出し</h1><p>一つ目の文。二つ目の文。</p><p>三つ目の文。</p>');
		const cues = makeCues([
			['一つ目の文。', 0, 2],
			['二つ目の文。', 2, 4],
			['三つ目の文。', 4, 6]
		]);

		const index = alignEpubToCues(doc, cues);
		assertMonotonic(index.starts, index.ends);
	});

	it('keeps arrays parallel to the timed sentence list', () => {
		const doc = makeDoc('<p>一。二。三。</p>');
		const cues = makeCues([
			['一。', 0, 1],
			['二。', 1, 2],
			['三。', 2, 3]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.starts.length).toBe(index.timed.length);
		expect(index.ends.length).toBe(index.timed.length);
		for (let i = 0; i < index.timed.length; i++) {
			expect(index.starts[i]).toBe(index.timed[i].start);
			expect(index.ends[i]).toBe(index.timed[i].end);
		}
	});

	it('demotes rather than emits overlapping ranges from out-of-order cues', () => {
		const doc = makeDoc('<p>先の文。後の文。</p>');
		// Deliberately inverted timings, as a damaged subtitle file might carry.
		const cues = makeCues([
			['先の文。', 10, 12],
			['後の文。', 1, 3]
		]);

		const index = alignEpubToCues(doc, cues);
		assertMonotonic(index.starts, index.ends);
	});

	it('records stream extents on blocks', () => {
		const doc = makeDoc('<p>一つ目。</p><p>二つ目。</p>');
		const cues = makeCues([
			['一つ目。', 0, 1],
			['二つ目。', 1, 2]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.blocks.length).toBe(2);
		expect(index.blocks[0].streamEnd).toBeGreaterThan(index.blocks[0].streamStart);
		expect(index.blocks[1].streamStart).toBeGreaterThanOrEqual(index.blocks[0].streamEnd);
	});
});
