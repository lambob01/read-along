import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAutoScroller } from '$lib/sync/autoscroll';

/**
 * jsdom lays nothing out, so geometry is stubbed: the point under test is the
 * arithmetic that turns "where is this sentence" into "which way do I scroll",
 * and in particular that vertical-rl reverses the axis.
 */

const VIEW = { width: 1000, height: 600 };

function rect(box: { x: number; y: number; w: number; h: number }): DOMRect {
	return {
		left: box.x,
		right: box.x + box.w,
		top: box.y,
		bottom: box.y + box.h,
		width: box.w,
		height: box.h,
		x: box.x,
		y: box.y,
		toJSON: () => ({})
	} as DOMRect;
}

let scrolls: { top: number; left: number }[] = [];

function makeContainer(): HTMLElement {
	const el = document.createElement('div');
	el.getBoundingClientRect = () => rect({ x: 0, y: 0, w: VIEW.width, h: VIEW.height });
	el.scrollBy = ((opts: ScrollToOptions) => {
		scrolls.push({ top: opts.top ?? 0, left: opts.left ?? 0 });
	}) as HTMLElement['scrollBy'];
	return el;
}

function makeSentence(box: { x: number; y: number; w: number; h: number }): HTMLElement {
	const el = document.createElement('span');
	el.getBoundingClientRect = () => rect(box);
	return el;
}

beforeEach(() => {
	scrolls = [];
	// The scroller observes for reflow; jsdom has no IntersectionObserver.
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	);
});

describe('horizontal reading', () => {
	it('scrolls down to bring a sentence below the anchor up to it', () => {
		const container = makeContainer();
		// anchor 0.4 of 600 = y 240. Sentence centre is at y 500.
		const el = makeSentence({ x: 0, y: 480, w: 400, h: 40 });
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false });

		s.scrollTo(1);
		expect(scrolls).toEqual([{ top: 260, left: 0 }]);
		s.destroy();
	});

	it('scrolls up for a sentence above the anchor', () => {
		const container = makeContainer();
		const el = makeSentence({ x: 0, y: 20, w: 400, h: 40 });
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false });

		s.scrollTo(1);
		expect(scrolls[0].top).toBeLessThan(0);
		expect(scrolls[0].left).toBe(0);
		s.destroy();
	});

	it('leaves a sentence already near the anchor alone', () => {
		const container = makeContainer();
		const el = makeSentence({ x: 0, y: 230, w: 400, h: 20 });
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false });

		s.scrollTo(1);
		expect(scrolls).toEqual([]);
		s.destroy();
	});
});

describe('vertical-rl reading', () => {
	// Reading starts at the right edge (x = 1000) and advances leftwards, so
	// anchor 0.4 sits 40% of the way in: x = 1000 - 400 = 600.

	it('scrolls left to bring a sentence further along up to the anchor', () => {
		const container = makeContainer();
		// Sentence centre at x 300 — past the anchor, i.e. further into the book.
		const el = makeSentence({ x: 280, y: 0, w: 40, h: 400 });
		const s = createAutoScroller(container, () => el, {
			anchor: 0.4,
			smooth: false,
			vertical: true
		});

		s.scrollTo(1);
		// Moving the viewport towards the book's end means smaller x, so the
		// physical delta must be negative.
		expect(scrolls).toHaveLength(1);
		expect(scrolls[0].top).toBe(0);
		expect(scrolls[0].left).toBe(-300);
		s.destroy();
	});

	it('scrolls right for a sentence not yet reached', () => {
		const container = makeContainer();
		// Centre at x 900, between the anchor and the right edge.
		const el = makeSentence({ x: 880, y: 0, w: 40, h: 400 });
		const s = createAutoScroller(container, () => el, {
			anchor: 0.4,
			smooth: false,
			vertical: true
		});

		s.scrollTo(1);
		expect(scrolls[0].left).toBe(300);
		expect(scrolls[0].top).toBe(0);
		s.destroy();
	});

	it('leaves a sentence already near the anchor alone', () => {
		const container = makeContainer();
		const el = makeSentence({ x: 590, y: 0, w: 20, h: 400 });
		const s = createAutoScroller(container, () => el, {
			anchor: 0.4,
			smooth: false,
			vertical: true
		});

		s.scrollTo(1);
		expect(scrolls).toEqual([]);
		s.destroy();
	});

	it('honours an anchor nearer the start of the line', () => {
		const container = makeContainer();
		// anchor 0.25 → x = 1000 - 250 = 750. Centre at x 300.
		const el = makeSentence({ x: 280, y: 0, w: 40, h: 400 });
		const s = createAutoScroller(container, () => el, {
			anchor: 0.25,
			smooth: false,
			vertical: true
		});

		s.scrollTo(1);
		expect(scrolls[0].left).toBe(-450);
		s.destroy();
	});
});

describe('switching writing mode', () => {
	it('changes which axis is scrolled without rebuilding the scroller', () => {
		const container = makeContainer();
		const el = makeSentence({ x: 280, y: 480, w: 40, h: 40 });
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false });

		s.scrollTo(1);
		expect(scrolls[0].top).not.toBe(0);
		expect(scrolls[0].left).toBe(0);

		s.setOptions({ vertical: true });
		s.scrollTo(1);
		expect(scrolls[1].top).toBe(0);
		expect(scrolls[1].left).not.toBe(0);
		s.destroy();
	});
});
