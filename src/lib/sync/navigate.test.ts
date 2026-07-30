import { describe, it, expect } from 'vitest';
import { cueIndexAt, nearestCueIndex, nextCueStart, prevCueStart } from './navigate';
import type { TimingIndex } from '$lib/types';

/** Three lines with a gap between the second and third. */
function index(spans: [number, number][]): TimingIndex {
	return {
		sentences: spans.map(([start, end], i) => ({ id: i, start, end })),
		starts: new Float64Array(spans.map((s) => s[0])),
		ends: new Float64Array(spans.map((s) => s[1]))
	};
}

const idx = index([
	[0, 2],
	[2, 4],
	[6, 8]
]);

describe('cueIndexAt', () => {
	it('finds the covering line', () => {
		expect(cueIndexAt(idx, 0)).toBe(0);
		expect(cueIndexAt(idx, 1.9)).toBe(0);
		expect(cueIndexAt(idx, 2)).toBe(1);
		expect(cueIndexAt(idx, 7)).toBe(2);
	});

	it('holds the last started line across a gap', () => {
		expect(cueIndexAt(idx, 5)).toBe(1);
	});

	it('reports nothing before the first line', () => {
		expect(cueIndexAt(index([[3, 4]]), 1)).toBe(-1);
	});

	it('handles an empty index', () => {
		expect(cueIndexAt(index([]), 1)).toBe(-1);
	});
});

describe('nextCueStart', () => {
	it('advances one line', () => {
		expect(nextCueStart(idx, 0.5)).toBe(2);
		expect(nextCueStart(idx, 2)).toBe(6);
	});

	it('jumps to the upcoming line from inside a gap', () => {
		expect(nextCueStart(idx, 5)).toBe(6);
	});

	it('reaches the first line from before the book starts', () => {
		expect(nextCueStart(index([[3, 4]]), 0)).toBe(3);
	});

	it('returns null past the last line', () => {
		expect(nextCueStart(idx, 7)).toBeNull();
	});
});

describe('prevCueStart', () => {
	it('restarts the current line once past the grace window', () => {
		expect(prevCueStart(idx, 3.5)).toBe(2);
	});

	it('steps back a line when only just into this one', () => {
		expect(prevCueStart(idx, 2.1)).toBe(0);
	});

	it('steps back from inside a gap', () => {
		// 5s is well past line 1's start, so the gap resolves to that line.
		expect(prevCueStart(idx, 5)).toBe(2);
	});

	it('returns null at the very start', () => {
		expect(prevCueStart(idx, 0.1)).toBeNull();
		expect(prevCueStart(index([]), 1)).toBeNull();
	});
});

describe('nearestCueIndex', () => {
	it('returns the covering line', () => {
		expect(nearestCueIndex(idx, 1)).toBe(0);
		expect(nearestCueIndex(idx, 7)).toBe(2);
	});

	it('picks the nearer side of a gap', () => {
		// Gap runs 4→6: the audio is unmatched here, but it is still somewhere.
		expect(nearestCueIndex(idx, 4.4)).toBe(1);
		expect(nearestCueIndex(idx, 5.6)).toBe(2);
	});

	it('answers with the first line before the book has started', () => {
		expect(nearestCueIndex(index([[3, 4]]), 0)).toBe(0);
	});

	it('stays on the last line past the end of the transcript', () => {
		expect(nearestCueIndex(idx, 500)).toBe(2);
	});

	it('has no answer for an empty index', () => {
		expect(nearestCueIndex(index([]), 1)).toBe(null);
	});
});
