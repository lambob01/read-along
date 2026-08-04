import { describe, it, expect } from 'vitest';
import {
	PROGRESS_MODES,
	nextProgressMode,
	chapterBounds,
	chapterProgress,
	formatRemaining
} from './progress';

const chapters = [
	{ start: 0, end: 600, title: 'Ch1' },
	{ start: 600, end: 1200, title: 'Ch2' },
	{ start: 1200, end: 1800, title: 'Ch3' }
];

describe('nextProgressMode', () => {
	it('cycles through every mode and wraps', () => {
		let mode = PROGRESS_MODES[0];
		for (const expected of [...PROGRESS_MODES.slice(1), PROGRESS_MODES[0]]) {
			mode = nextProgressMode(mode, PROGRESS_MODES);
			expect(mode).toBe(expected);
		}
	});

	it('cycles only through the enabled modes', () => {
		expect(nextProgressMode('book-pct', ['book-pct', 'chapter-left'])).toBe('chapter-left');
		expect(nextProgressMode('chapter-left', ['book-pct', 'chapter-left'])).toBe('book-pct');
	});

	it('resumes from the first enabled mode when the current one is off', () => {
		expect(nextProgressMode('chapter-pct', ['book-pct', 'chapter-left'])).toBe('book-pct');
	});

	it('stays put when nothing is enabled', () => {
		expect(nextProgressMode('book-pct', [])).toBe('book-pct');
	});
});

describe('chapterBounds', () => {
	it('finds the covering chapter', () => {
		expect(chapterBounds(chapters, 0, 1800)).toEqual({ index: 0, start: 0, end: 600 });
		expect(chapterBounds(chapters, 599.9, 1800)).toEqual({ index: 0, start: 0, end: 600 });
		expect(chapterBounds(chapters, 600, 1800)).toEqual({ index: 1, start: 600, end: 1200 });
		expect(chapterBounds(chapters, 1799, 1800)).toEqual({ index: 2, start: 1200, end: 1800 });
	});

	it('covers the gap before the first chapter with its start', () => {
		expect(chapterBounds(chapters, -5, 1800)).toEqual({ index: -1, start: 0, end: 600 });
	});

	it('falls back to duration when a chapter end is missing', () => {
		expect(chapterBounds([{ start: 100, end: 0 }], 150, 300)).toEqual({
			index: 0,
			start: 100,
			end: 300
		});
	});

	it('falls back to duration for a chapter whose end is bad', () => {
		expect(chapterBounds([{ start: 100, end: 50 }], 150, 300)).toEqual({
			index: 0,
			start: 100,
			end: 300
		});
	});

	it('returns null without chapter metadata', () => {
		expect(chapterBounds([], 10, 100)).toBeNull();
	});
});

describe('chapterProgress', () => {
	it('computes percent and remaining within the chapter', () => {
		expect(chapterProgress(chapters, 300, 1800)).toEqual({
			index: 0,
			percent: 50,
			remaining: 300
		});
	});

	it('clamps before the first chapter', () => {
		expect(chapterProgress(chapters, -5, 1800)).toEqual({
			index: -1,
			percent: 0,
			remaining: 605
		});
	});

	it('clamps past the last chapter', () => {
		expect(chapterProgress(chapters, 2000, 1800)).toEqual({
			index: 2,
			percent: 100,
			remaining: 0
		});
	});

	it('returns null without chapter metadata', () => {
		expect(chapterProgress([], 10, 100)).toBeNull();
	});
});

describe('formatRemaining', () => {
	it('formats minutes', () => {
		expect(formatRemaining(12 * 60 + 20)).toBe('12m left');
	});

	it('formats hours', () => {
		expect(formatRemaining(3600 + 5 * 60)).toBe('1h 5m left');
	});

	it('rounds a sub-minute up rather than dropping it', () => {
		expect(formatRemaining(30)).toBe('1m left');
	});

	it('returns empty at or below zero', () => {
		expect(formatRemaining(0)).toBe('');
		expect(formatRemaining(-5)).toBe('');
		expect(formatRemaining(Number.NaN)).toBe('');
	});
});
