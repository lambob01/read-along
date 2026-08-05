import { describe, it, expect, vi } from 'vitest';
import { renderEpub } from '$lib/reader/epubRenderer';
import { alignEpubToCues } from '$lib/sync/align';
import type { EpubDoc, RawCue } from '$lib/types';

function makeDoc(chapters: string[]): EpubDoc {
	return {
		title: 'T',
		author: 'A',
		language: 'ja',
		chapters: chapters.map((html, i) => {
			const doc = new DOMParser().parseFromString(
				`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`,
				// Chapters parse as XML in the real pipeline (epub/parse.ts),
				// where attribute names and tag names keep their case.
				'application/xhtml+xml'
			);
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

function makeCues(rows: [string, number, number][]): RawCue[] {
	return rows.map(([text, start, end], i) => ({ index: i, start, end, text }));
}

function setup(chapters: string[], rows: [string, number, number][]) {
	const doc = makeDoc(chapters);
	const index = alignEpubToCues(doc, makeCues(rows));
	const container = document.createElement('div');
	document.body.appendChild(container);
	const handle = renderEpub(index, doc.chapters, container);
	return { doc, index, container, handle };
}

/**
 * `n` chapters carrying real prose — enough that each one on its own satisfies
 * the mount budget, so windowing is exercised rather than short-circuited.
 * Chapters of a few characters are a separate case, covered further down.
 */
const SENTENCES_PER_CHAPTER = 120;

function bigBook(n: number) {
	const chapters: string[] = [];
	const rows: [string, number, number][] = [];
	let t = 0;
	for (let c = 0; c < n; c++) {
		const sentences = Array.from(
			{ length: SENTENCES_PER_CHAPTER },
			(_, i) => `第${c}章の第${i}文はこのように長く書かれている。`
		);
		chapters.push(`<p>${sentences.join('')}</p>`);
		for (const s of sentences) {
			rows.push([s, t, t + 1]);
			t += 1;
		}
	}
	return setup(chapters, rows);
}

/** Spine order of every chapter with content mounted. */
function mountedOrders(container: HTMLElement): string[] {
	return [...container.querySelectorAll('section.reader-chapter')]
		.filter((s) => s.children.length > 0)
		.map((s) => s.getAttribute('data-chapter')!);
}

/** A sentence belonging to a given chapter. */
function sentenceIn(index: { sentences: { id: number; chapterOrder: number }[] }, order: number) {
	return index.sentences.find((s) => s.chapterOrder === order)!;
}

describe('renderEpub', () => {
	it('creates one host section per chapter in spine order', () => {
		const { container } = setup(
			['<p>一つ目。</p>', '<p>二つ目。</p>'],
			[
				['一つ目。', 0, 1],
				['二つ目。', 1, 2]
			]
		);

		const sections = container.querySelectorAll('section.reader-chapter');
		expect(sections.length).toBe(2);
		expect(sections[0].getAttribute('data-chapter')).toBe('0');
		expect(sections[1].getAttribute('data-chapter')).toBe('1');
	});

	it('wraps each sentence in a span carrying its id and timing', () => {
		const { handle, index } = setup(
			['<p>朝が来た。鳥が鳴いた。</p>'],
			[
				['朝が来た。', 0, 2],
				['鳥が鳴いた。', 2, 4]
			]
		);

		handle.ensureVisible(index.sentences[0].id);
		const spans = handle.spansFor(index.sentences[0].id);
		expect(spans.length).toBeGreaterThan(0);
		expect(spans[0].dataset.sid).toBe(String(index.sentences[0].id));
		expect(spans[0].dataset.start).toBe(String(index.sentences[0].start));
	});

	it('preserves the rendered text of a block exactly', () => {
		const { handle, container, index } = setup(
			['<p>朝が来た。鳥が鳴いた。</p>'],
			[
				['朝が来た。', 0, 2],
				['鳥が鳴いた。', 2, 4]
			]
		);

		handle.ensureVisible(index.sentences[0].id);
		const block = container.querySelector('.reader-block')!;
		expect(block.textContent).toBe('朝が来た。鳥が鳴いた。');
	});

	it('keeps inline emphasis and ruby markup from the epub', () => {
		const { handle, container, index } = setup(
			['<p>これは<em>強調</em>と<ruby>漢字<rt>かんじ</rt></ruby>です。</p>'],
			[['これは強調と漢字です。', 0, 3]]
		);

		handle.ensureVisible(index.sentences[0].id);
		const block = container.querySelector('.reader-block')!;
		expect(block.querySelector('em')).not.toBeNull();
		expect(block.querySelector('ruby rt')?.textContent).toBe('かんじ');
	});

	it('emits multiple spans when a sentence straddles inline markup', () => {
		const { handle, index } = setup(
			['<p>これは<em>強調</em>です。</p>'],
			[['これは強調です。', 0, 3]]
		);

		handle.ensureVisible(index.sentences[0].id);
		const spans = handle.spansFor(index.sentences[0].id);
		// Text before, inside, and after the <em> are separate text nodes.
		expect(spans.length).toBeGreaterThan(1);
		expect(spans.every((s) => s.dataset.sid === String(index.sentences[0].id))).toBe(true);
		expect(spans.map((s) => s.textContent).join('')).toBe('これは強調です。');
	});

	it('strips publication styling so the reader theme stays authoritative', () => {
		const { handle, container, index } = setup(
			['<p style="color:red" class="book-style">本文である。</p>'],
			[['本文である。', 0, 2]]
		);

		handle.ensureVisible(index.sentences[0].id);
		const block = container.querySelector('.reader-block')!;
		expect(block.getAttribute('style')).toBeNull();
		expect(block.classList.contains('book-style')).toBe(false);
	});

	it('drops images that reference unresolvable zip paths', () => {
		const { handle, container, index } = setup(
			['<p>図の説明。<img src="images/fig1.png" alt="fig" /></p>'],
			[['図の説明。', 0, 2]]
		);

		handle.ensureVisible(index.sentences[0].id);
		expect(container.querySelector('img')).toBeNull();
	});

	it('marks untimed sentences so they render inert', () => {
		const { handle, index } = setup(
			['<p>権利表示のページ。</p><p>朝が来た。</p>'],
			[['朝が来た。', 5, 7]]
		);

		const untimed = index.sentences.find((s) => !s.timed)!;
		handle.ensureVisible(untimed.id);
		const spans = handle.spansFor(untimed.id);
		expect(spans[0].dataset.untimed).toBe('true');
		expect(spans[0].dataset.start).toBeUndefined();
	});

	it('mounts the active chapter and its neighbours', () => {
		const { handle, container, index } = bigBook(6);

		handle.ensureVisible(sentenceIn(index, 0).id);

		// Window of 1, and each chapter alone satisfies the budget.
		expect(mountedOrders(container)).toEqual(['0', '1']);
	});

	it('unmounts distant chapters while preserving their height', () => {
		const { handle, container, index } = bigBook(6);

		handle.ensureVisible(sentenceIn(index, 0).id);
		handle.ensureVisible(sentenceIn(index, 5).id);

		const first = container.querySelector('section[data-chapter="0"]') as HTMLElement;
		expect(first.children.length).toBe(0);
		// jsdom reports zero heights, so only the reservation mechanism is
		// asserted here, not a real pixel value.
		expect(first.style.minHeight).not.toBe('');
		expect(first.style.minWidth).toBe('');
	});

	it('reserves width instead of height when the text runs vertically', () => {
		// vertical-rl turns the block axis horizontal, so a placeholder that
		// held a height open would reserve nothing along the scrolling axis and
		// the reader would jump every time a chapter unmounted.
		const real = window.getComputedStyle;
		vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
			const style = real.call(window, el);
			return new Proxy(style, {
				get: (t, k) => (k === 'writingMode' ? 'vertical-rl' : Reflect.get(t, k))
			});
		}) as typeof window.getComputedStyle);

		const { handle, container, index } = bigBook(6);

		handle.ensureVisible(sentenceIn(index, 0).id);
		handle.ensureVisible(sentenceIn(index, 5).id);

		const first = container.querySelector('section[data-chapter="0"]') as HTMLElement;
		expect(first.style.minWidth).not.toBe('');
		expect(first.style.minHeight).toBe('');

		// Rotating back moves the reservation to the other axis: what was
		// measured across the old block axis means nothing on the new one.
		vi.restoreAllMocks();
		handle.invalidateLayout();
		expect(first.style.minHeight).not.toBe('');
		expect(first.style.minWidth).toBe('');
	});

	it('returns no spans for a sentence whose chapter is unmounted', () => {
		const { handle, index } = bigBook(6);

		handle.ensureVisible(sentenceIn(index, 5).id);

		expect(handle.spansFor(sentenceIn(index, 0).id)).toEqual([]);
	});

	it('reserves space for every unmounted chapter from the start', () => {
		// Without this the scroller is only as long as the mounted window, so
		// there is nowhere to scroll to and no way to reach the rest of the book.
		const { container } = bigBook(6);

		const reserved = [...container.querySelectorAll('section.reader-chapter')].filter(
			(s) => parseFloat((s as HTMLElement).style.minHeight) > 0
		);
		expect(reserved.length).toBe(6);
	});

	it('keeps the chapter being read mounted alongside the one being narrated', () => {
		const { handle, index, container } = bigBook(6);

		// Narration in chapter 0, reader looking at chapter 4.
		handle.ensureVisible(sentenceIn(index, 0).id);
		handle.scrollToChapter(4);

		expect(mountedOrders(container)).toEqual(['0', '1', '3', '4', '5']);
		expect(handle.viewChapter()).toBe(4);
	});

	it('releases the narration anchor when read-along is switched off', () => {
		const { handle, index, container } = bigBook(6);

		handle.ensureVisible(sentenceIn(index, 0).id);
		handle.scrollToChapter(4);
		handle.clearAudioAnchor();

		expect(mountedOrders(container)).toEqual(['3', '4', '5']);
	});

	it('mounts past its neighbours until enough text is on screen', () => {
		// Front matter is a run of one-line chapters. Windowing by chapter count
		// mounts three lines of text and unmounts the chapter filling the rest of
		// the screen, so most of the page goes blank — which is what a contents
		// page did. The budget is text, not chapters.
		const tiny = Array.from({ length: 12 }, (_, i) => `<p>目次項目${i}。</p>`);
		const rows = tiny.map((_, i) => [`目次項目${i}。`, i, i + 1] as [string, number, number]);
		const { handle, container, index } = setup(tiny, rows);

		handle.ensureVisible(sentenceIn(index, 5).id);

		// Nowhere near the budget however far it reaches, so it takes everything
		// it is allowed to rather than leaving the screen empty.
		expect(mountedOrders(container).length).toBe(12);
	});

	it('does not overrun the budget when chapters are substantial', () => {
		// The same rule must not turn into "mount the book" once chapters are
		// real: that is the stall windowing exists to prevent.
		const { handle, container, index } = bigBook(12);

		handle.ensureVisible(sentenceIn(index, 6).id);

		expect(mountedOrders(container)).toEqual(['5', '6', '7']);
	});

	it('maps a sentence to its chapter', () => {
		const chapters = Array.from({ length: 3 }, (_, i) => `<p>第${i}章の文。</p>`);
		const rows = chapters.map(
			(_, i) => [`第${i}章の文。`, i * 2, i * 2 + 1] as [string, number, number]
		);
		const { handle, index } = setup(chapters, rows);

		const inSecond = index.sentences.find((s) => s.chapterOrder === 2)!;
		expect(handle.chapterOf(inSecond.id)).toBe(2);
	});

	it('clears the container on destroy', () => {
		const { handle, container, index } = setup(['<p>本文である。</p>'], [['本文である。', 0, 2]]);

		handle.ensureVisible(index.sentences[0].id);
		handle.destroy();
		expect(container.children.length).toBe(0);
	});
});

describe('cloneForRender sanitization', () => {
	it('strips event handler attributes from cloned content', () => {
		const { container, handle, index } = setup(
			['<p onclick="window.pwned = 1" ONCLICK="window.pwned = 2">朝が来た。</p>'],
			[['朝が来た。', 0, 2]]
		);
		// Nothing is mounted until a chapter is anchored.
		handle.ensureVisible(index.sentences[0].id);

		// The block element itself is the cloned <p>, carrying the class.
		container.querySelectorAll('.reader-block').forEach((p) => {
			expect(p.hasAttribute('onclick')).toBe(false);
			// XML preserves attribute case, and browsers match event handler
			// attributes case-insensitively, so uppercase spellings must go
			// too. jsdom cannot find case-preserved names via hasAttribute
			// once the element is adopted into an HTML document, so inspect
			// the stored names directly.
			expect(p.getAttributeNames()).not.toContain('ONCLICK');
		});
	});

	it('drops script, iframe and other executable elements', () => {
		const { container, handle, index } = setup(
			[
				'<p>朝が来た。<script>window.pwned = 1</script><iframe src="https://evil.example"></iframe><form action="https://evil.example"></form></p>'
			],
			[['朝が来た。', 0, 2]]
		);
		handle.ensureVisible(index.sentences[0].id);

		expect(container.querySelector('script')).toBeNull();
		expect(container.querySelector('iframe')).toBeNull();
		expect(container.querySelector('form')).toBeNull();
	});

	it('strips srcdoc and src attributes', () => {
		const { container, handle, index } = setup(
			['<p>朝が来た。<video src="https://evil.example"></video></p>'],
			[['朝が来た。', 0, 2]]
		);
		handle.ensureVisible(index.sentences[0].id);

		// The <video> itself is dropped as an executable element, and nothing
		// else in the block may carry a code-capable attribute.
		expect(container.querySelectorAll('.reader-block [src]').length).toBe(0);
	});
});
