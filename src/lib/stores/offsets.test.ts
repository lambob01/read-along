import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { offsets, clampOffset, MAX_OFFSET } from '$lib/stores/offsets';

/** Neither the node nor the jsdom project supplies one, so tests bring their own. */
function makeLocalStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

beforeEach(() => {
	vi.stubGlobal('localStorage', makeLocalStorage());
	offsets.hydrate();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('clampOffset', () => {
	it('limits the magnitude in both directions', () => {
		expect(clampOffset(999)).toBe(MAX_OFFSET);
		expect(clampOffset(-999)).toBe(-MAX_OFFSET);
	});

	it('rounds to two decimals', () => {
		expect(clampOffset(1.23456)).toBe(1.23);
	});

	it('treats non-finite input as no offset', () => {
		expect(clampOffset(NaN)).toBe(0);
		expect(clampOffset(Infinity)).toBe(0);
		expect(clampOffset(-Infinity)).toBe(0);
	});
});

describe('offsets store', () => {
	it('returns null for a book that has never been tuned', () => {
		expect(offsets.get('book-1')).toBeNull();
	});

	it('round-trips a per-book value', () => {
		offsets.set('book-1', 1.5);
		expect(offsets.get('book-1')).toBe(1.5);
		expect(get(offsets)['book-1']).toBe(1.5);
	});

	it('keeps books independent', () => {
		offsets.set('book-1', 1.5);
		offsets.set('book-2', -2);
		expect(offsets.get('book-1')).toBe(1.5);
		expect(offsets.get('book-2')).toBe(-2);
	});

	it('clamps on write', () => {
		offsets.set('book-1', 500);
		expect(offsets.get('book-1')).toBe(MAX_OFFSET);
	});

	it('distinguishes a stored zero from an absent entry', () => {
		offsets.set('book-1', 0);
		expect(offsets.get('book-1')).toBe(0);
		expect(offsets.get('book-2')).toBeNull();
	});

	it('clearing restores the fallback', () => {
		offsets.set('book-1', 3);
		offsets.clear('book-1');
		expect(offsets.get('book-1')).toBeNull();
	});

	it('survives corrupt storage', () => {
		localStorage.setItem('reader-offsets', 'not json');
		offsets.hydrate();
		expect(offsets.get('book-1')).toBeNull();
	});
});
