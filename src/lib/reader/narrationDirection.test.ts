import { describe, it, expect } from 'vitest';
import { narrationDirection, type Rect } from './narrationDirection';

/** Viewport rect, 1000px tall, 800px wide, at the origin. */
const VIEW: Rect = { top: 0, bottom: 1000, left: 0, right: 800 };

function rect(top: number, bottom: number, left: number, right: number): Rect {
	return { top, bottom, left, right };
}

describe('narrationDirection — horizontal text', () => {
	it('points up when the narration is above the viewport', () => {
		expect(narrationDirection(VIEW, rect(-200, -100, 0, 800), false)).toBe('up');
	});

	it('points down when the narration is below the viewport', () => {
		expect(narrationDirection(VIEW, rect(1100, 1200, 0, 800), false)).toBe('down');
	});

	it('defaults to down when the narration overlaps the viewport', () => {
		expect(narrationDirection(VIEW, rect(500, 1500, 0, 800), false)).toBe('down');
		// Touching exactly at the boundary is still "on screen".
		expect(narrationDirection(VIEW, rect(1000, 1200, 0, 800), false)).toBe('down');
	});

	it('defaults to down when the narration element is not mounted', () => {
		expect(narrationDirection(VIEW, null, false)).toBe('down');
	});
});

describe('narrationDirection — vertical text (vertical-rl)', () => {
	it('points left when the narration is further along (to the left)', () => {
		expect(narrationDirection(VIEW, rect(0, 1000, -400, -200), true)).toBe('left');
	});

	it('points right when the narration is behind (to the right)', () => {
		expect(narrationDirection(VIEW, rect(0, 1000, 900, 1100), true)).toBe('right');
	});

	it('defaults to left when the narration overlaps the viewport', () => {
		expect(narrationDirection(VIEW, rect(0, 1000, -300, 300), true)).toBe('left');
		expect(narrationDirection(VIEW, rect(0, 1000, 800, 900), true)).toBe('left');
	});

	it('defaults to left when the narration element is not mounted', () => {
		expect(narrationDirection(VIEW, null, true)).toBe('left');
	});
});
