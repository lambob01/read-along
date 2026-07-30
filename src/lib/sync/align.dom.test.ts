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

	it('is not dragged forward by a table of contents', () => {
		// The contents lists chapter titles, the narrator reads those titles aloud,
		// so every entry matches perfectly — minutes ahead of where the reading
		// actually is. The cursor never rewinds, so believing one entry strands the
		// whole first chapter. This is what left 氷菓's opening letter unsynced:
		// 1 of its 30 sentences timed, its words plainly there in the subtitle.
		const doc = makeDoc('', [
			'<p>一　ベナレスからの手紙</p><p>二　伝統ある古典部の再生</p>',
			'<p>一　ベナレスからの手紙</p><p>前略、奉太郎。息災ですか。</p><p>古典部に入りなさい。</p>',
			'<p>二　伝統ある古典部の再生</p><p>高校生活といえば薔薇色である。</p>'
		]);
		const filler = Array.from(
			{ length: 40 },
			(_, i) => [`これは埋草の文${i}である。`, 20 + i * 2, 22 + i * 2] as [string, number, number]
		);
		const cues = makeCues([
			['一　ベナレスからの手紙', 0, 4],
			['前略、奉太郎。息災ですか。', 4, 8],
			['古典部に入りなさい。', 8, 12],
			...filler,
			['二　伝統ある古典部の再生', 300, 304],
			['高校生活といえば薔薇色である。', 304, 308]
		]);

		const index = alignEpubToCues(doc, cues);
		const byChapter = (order: number) => index.sentences.filter((s) => s.chapterOrder === order);

		// The contents entry for a chapter that has not been reached yet must not
		// be believed just because its words occur later.
		expect(byChapter(0)[1].timed).toBe(false);
		// The prose it would have skipped past stays aligned. The chapter's own
		// heading is not asserted: the contents entry above it legitimately
		// consumed the one cue that spoke those words, and losing a duplicated
		// heading costs nothing.
		expect(
			byChapter(1)
				.slice(1)
				.every((s) => s.timed)
		).toBe(true);
		expect(byChapter(1)[1].start).toBe(4);
		// And the real heading, reached in order, still times normally.
		expect(byChapter(2).every((s) => s.timed)).toBe(true);
		expect(byChapter(2)[0].start).toBe(300);
	});

	it('still steps over an insertion the book does not contain', () => {
		// The corroboration rule must not cost the wide window its purpose: a theme
		// song or announcement in the recording is skipped, because the text after
		// the landing point carries straight on.
		const doc = makeDoc('<p>最初の文である。次の文である。最後の文である。</p>');
		const jingle = Array.from(
			{ length: 40 },
			(_, i) => [`主題歌の歌詞その${i}。`, 2 + i * 2, 4 + i * 2] as [string, number, number]
		);
		const cues = makeCues([
			['最初の文である。', 0, 2],
			...jingle,
			['次の文である。', 300, 302],
			['最後の文である。', 302, 304]
		]);

		const index = alignEpubToCues(doc, cues);

		expect(index.sentences.every((s) => s.timed)).toBe(true);
		expect(index.sentences[1].start).toBe(300);
	});

	it('does not chase a sentence tail across the book', () => {
		// The second half of this sentence is missing from the subtitle, but the
		// same words recur much later — novels repeat lines. Searching thousands of
		// characters ahead for the tail finds that recurrence, and the sentence
		// then claims everything from 0:00 to 15:00. `finalize` demotes every
		// sentence that legitimately falls inside the range it has claimed, so one
		// bad jump takes a chapter of the book with it.
		const doc = makeDoc(
			'<p>青豆は肯いた、そして彼女は静かに部屋を出て行った。</p><p>次の文である。その次の文である。</p>'
		);
		const filler = Array.from(
			{ length: 30 },
			(_, i) => [`これは埋草の文${i}である。`, 10 + i * 2, 12 + i * 2] as [string, number, number]
		);
		const cues = makeCues([
			['青豆は肯いた、', 0, 2],
			['次の文である。', 2, 4],
			['その次の文である。', 4, 6],
			...filler,
			['そして彼女は静かに部屋を出て行った。', 900, 904]
		]);

		const index = alignEpubToCues(doc, cues);
		const byText = (t: string) => index.sentences.find((s) => s.text.startsWith(t))!;

		const overreach = byText('青豆は肯いた');
		expect(overreach.timed && overreach.end > 100).toBe(false);
		// The sentences whose cues it would have swallowed stay timed.
		expect(byText('次の文である').timed).toBe(true);
		expect(byText('次の文である').start).toBe(2);
		expect(byText('その次の文である').timed).toBe(true);
	});

	it('rewinds the cursor when a sentence fails to match', () => {
		// This sentence anchors on a phrase that recurs late in the book, matches
		// a third of itself there and is rightly left untimed — but the cursor it
		// moved on the way is kept, and it never rewinds. Everything between is
		// then unreachable: text plainly present in the subtitle, never highlighted.
		const doc = makeDoc(
			'<p>犬が吠えた声が遠くに聞こえたような気がしたが、彼女はもう振り返らなかった。</p>' +
				'<p>次の文である。その次の文である。</p>'
		);
		const filler = Array.from(
			{ length: 30 },
			(_, i) => [`これは埋草の文${i}である。`, 10 + i * 2, 12 + i * 2] as [string, number, number]
		);
		const cues = makeCues([
			['次の文である。', 2, 4],
			['その次の文である。', 4, 6],
			...filler,
			['犬が吠えた声が遠くに聞こえた', 900, 904]
		]);

		const index = alignEpubToCues(doc, cues);
		const byText = (t: string) => index.sentences.find((s) => s.text.startsWith(t))!;

		expect(byText('犬が吠えた').timed).toBe(false);
		expect(byText('次の文である').timed).toBe(true);
		expect(byText('次の文である').start).toBe(2);
		expect(byText('その次の文である').timed).toBe(true);
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
