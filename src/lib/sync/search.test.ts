import { describe, it, expect } from 'vitest';
import { lowerBound, upperBound } from './search';

/** Duplicated values on purpose: the boundaries are what matter. */
const sorted = Float64Array.from([1, 3, 3, 7]);

describe('lowerBound', () => {
	it('finds the last entry at or before the value', () => {
		expect(lowerBound(sorted, 3)).toBe(2);
		expect(lowerBound(sorted, 4)).toBe(2);
		expect(lowerBound(sorted, 7)).toBe(3);
	});

	it('reports -1 before the first entry', () => {
		expect(lowerBound(sorted, 0.5)).toBe(-1);
		expect(lowerBound(new Float64Array(), 1)).toBe(-1);
	});
});

describe('upperBound', () => {
	it('finds the first entry strictly after the value', () => {
		expect(upperBound(sorted, 3)).toBe(3);
		expect(upperBound(sorted, 2)).toBe(1);
		expect(upperBound(sorted, 7)).toBe(4);
	});

	it('reports the length when nothing is after', () => {
		expect(upperBound(sorted, 100)).toBe(4);
		expect(upperBound(new Float64Array(), 1)).toBe(0);
	});
});
