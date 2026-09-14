import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';

/** Neither project supplies a localStorage (see offsets.test.ts), so bring one. */
function makeLocalStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

/**
 * `setItem` does not fire `storage` in the tab that wrote it, so these events
 * only ever arrive from another tab. Without a listener the in-memory store
 * silently diverges from what is persisted.
 */
describe('offsets cross-tab sync', () => {
	it('rehydrates when another tab writes the offsets key', async () => {
		const storage = makeLocalStorage();
		vi.stubGlobal('localStorage', storage);
		const { offsets } = await import('$lib/stores/offsets');

		expect(offsets.get('book-1')).toBeNull();
		storage.setItem('reader-offsets', JSON.stringify({ 'book-1': 2.5 }));
		window.dispatchEvent(new StorageEvent('storage', { key: 'reader-offsets' }));

		expect(offsets.get('book-1')).toBe(2.5);
		expect(get(offsets)['book-1']).toBe(2.5);
	});

	it('ignores storage events for other keys', async () => {
		const storage = makeLocalStorage();
		vi.stubGlobal('localStorage', storage);
		const { offsets } = await import('$lib/stores/offsets');

		storage.setItem('reader-offsets', JSON.stringify({ 'book-1': 2.5 }));
		window.dispatchEvent(new StorageEvent('storage', { key: 'reader-other' }));

		expect(offsets.get('book-1')).toBeNull();
	});

	it('rehydrates on clear() from another tab', async () => {
		const storage = makeLocalStorage({
			'reader-offsets': JSON.stringify({ 'book-1': 2.5 })
		});
		vi.stubGlobal('localStorage', storage);
		const { offsets } = await import('$lib/stores/offsets');

		expect(offsets.get('book-1')).toBe(2.5);
		storage.clear();
		// A clear() event carries a null key.
		window.dispatchEvent(new StorageEvent('storage', { key: null }));

		expect(offsets.get('book-1')).toBeNull();
	});
});
