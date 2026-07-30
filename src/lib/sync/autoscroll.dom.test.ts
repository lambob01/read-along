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

describe('detaching', () => {
	// The reader scrolling away from the narration used to be undone three
	// seconds later, which is what made a book with unmatched audio impossible
	// to read around: every attempt to move was dragged back.

	function scroll(container: HTMLElement) {
		container.dispatchEvent(new Event('wheel'));
		container.dispatchEvent(new Event('scroll'));
	}

	it('reports the reader having scrolled the active line off screen', async () => {
		vi.useFakeTimers();
		const container = makeContainer();
		// Well past the bottom of the 600px-high frame.
		const el = makeSentence({ x: 0, y: 2400, w: 400, h: 40 });
		const onDetach = vi.fn();
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false }, { onDetach });

		s.scrollTo(1);
		scroll(container);
		await vi.advanceTimersByTimeAsync(500);

		expect(onDetach).toHaveBeenCalled();
		s.destroy();
		vi.useRealTimers();
	});

	it('reports it when the line is no longer rendered at all', async () => {
		// Chapter windowing can unmount the narration's chapter outright once
		// the reader has scrolled far enough away.
		vi.useFakeTimers();
		const container = makeContainer();
		const el = makeSentence({ x: 0, y: 100, w: 400, h: 40 });
		const onDetach = vi.fn();
		let mounted: HTMLElement | undefined = el;
		const s = createAutoScroller(
			container,
			() => mounted,
			{ anchor: 0.4, smooth: false },
			{ onDetach }
		);

		s.scrollTo(1);
		mounted = undefined;
		scroll(container);
		await vi.advanceTimersByTimeAsync(500);

		expect(onDetach).toHaveBeenCalled();
		s.destroy();
		vi.useRealTimers();
	});

	it('leaves a small nudge alone', async () => {
		vi.useFakeTimers();
		const container = makeContainer();
		// Off the anchor but still on the screen: the reader is reading, not
		// going somewhere.
		const el = makeSentence({ x: 0, y: 500, w: 400, h: 40 });
		const onDetach = vi.fn();
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false }, { onDetach });

		s.scrollTo(1);
		scroll(container);
		await vi.advanceTimersByTimeAsync(500);

		expect(onDetach).not.toHaveBeenCalled();
		s.destroy();
		vi.useRealTimers();
	});

	it('does not detach on a scroll declared as a layout correction', async () => {
		// Chapter windowing scrolls to cancel out its own reflow. Every chapter
		// boundary does it, and untagged it would report the reader as having
		// walked away from a book they were sitting still and listening to.
		vi.useFakeTimers();
		const container = makeContainer();
		const el = makeSentence({ x: 0, y: 2400, w: 400, h: 40 });
		const onDetach = vi.fn();
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false }, { onDetach });

		s.scrollTo(1);
		await vi.advanceTimersByTimeAsync(2000);
		s.noteProgrammaticScroll();
		container.dispatchEvent(new Event('scroll'));
		await vi.advanceTimersByTimeAsync(500);

		expect(onDetach).not.toHaveBeenCalled();
		s.destroy();
		vi.useRealTimers();
	});

	it('does not detach on the scroll it performed itself', async () => {
		// Otherwise scrolling back to the narration would immediately count as
		// scrolling away from it, and the button would never work twice.
		vi.useFakeTimers();
		const container = makeContainer();
		const el = makeSentence({ x: 0, y: 2400, w: 400, h: 40 });
		const onDetach = vi.fn();
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: false }, { onDetach });

		s.scrollTo(1);
		// scrollBy is stubbed, so the element does not actually move — the only
		// thing keeping this quiet is that the scroll was ours.
		container.dispatchEvent(new Event('scroll'));
		await vi.advanceTimersByTimeAsync(500);

		expect(onDetach).not.toHaveBeenCalled();
		s.destroy();
		vi.useRealTimers();
	});
});

describe('long jumps', () => {
	it('goes instantly rather than animating across the book', () => {
		// A chapter jump or a seek can be tens of thousands of pixels. Animating
		// that takes seconds and scrolls through everything in between.
		const container = makeContainer();
		const behaviors: (ScrollBehavior | undefined)[] = [];
		container.scrollBy = ((opts: ScrollToOptions) => {
			behaviors.push(opts.behavior);
			scrolls.push({ top: opts.top ?? 0, left: opts.left ?? 0 });
		}) as HTMLElement['scrollBy'];

		const near = makeSentence({ x: 0, y: 500, w: 400, h: 40 });
		const far = makeSentence({ x: 0, y: 40000, w: 400, h: 40 });
		let el = near;
		const s = createAutoScroller(container, () => el, { anchor: 0.4, smooth: true });

		s.scrollTo(1);
		expect(behaviors[0]).toBe('smooth');

		el = far;
		s.scrollTo(2);
		expect(behaviors[1]).toBe('auto');
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
