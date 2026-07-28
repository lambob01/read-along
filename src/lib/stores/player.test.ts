import { describe, it, expect } from 'vitest';
import { clampSeek } from '$lib/stores/player';

describe('clampSeek', () => {
	it('passes the target through when it is inside a known duration', () => {
		expect(clampSeek(1200, 1800)).toBe(1200);
	});

	it('clamps to the end once the duration is known', () => {
		expect(clampSeek(9999, 1800)).toBe(1800);
	});

	it('keeps the target when the duration is not known yet', () => {
		// The regression this locks in: `duration` is NaN until metadata loads,
		// and treating that as a zero-length track clamped every seek to 0 —
		// so resuming a bookmark on a slow-loading book rewound it instead.
		expect(clampSeek(1200, NaN)).toBe(1200);
		expect(clampSeek(1200, 0)).toBe(1200);
		expect(clampSeek(1200, Infinity)).toBe(1200);
	});

	it('floors negative and non-finite targets at the start', () => {
		expect(clampSeek(-5, 1800)).toBe(0);
		expect(clampSeek(NaN, 1800)).toBe(0);
	});
});
