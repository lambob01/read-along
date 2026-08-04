import { describe, it, expect, afterEach, vi } from 'vitest';

function makeLocalStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

const valid = {
	itemId: '95eefe69-9a28-4d3e-8445-9d85265db0d3',
	title: '氷菓',
	authorName: '米澤穂信',
	duration: 19283,
	position: 251,
	updatedAt: 1785860064015
};

/**
 * A reader page that failed to load has recorded its bogus route parameter —
 * an EPUB chapter filename such as `part0005.html` — as an item id. Those
 * entries surface in "Continue Listening" with covers that 404, so they are
 * dropped on load and never accepted on record.
 */
describe('recent store sanitization', () => {
	it('drops file-like item ids when loading persisted entries', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-recent': JSON.stringify([
					valid,
					{ ...valid, itemId: 'part0005.html', position: 39.4 },
					{ ...valid, itemId: 'part0008.html', position: 5.2 }
				])
			})
		);

		const { recent } = await import('$lib/stores/recent');
		const { get } = await import('svelte/store');

		expect(get(recent)).toEqual([valid]);
	});

	it('never records an entry under a file-like item id', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage());
		const { recent } = await import('$lib/stores/recent');
		const { get } = await import('svelte/store');

		recent.record({ ...valid, itemId: 'part0009.html' });
		expect(get(recent)).toEqual([]);
	});

	it('keeps a real item id', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage());
		const { recent } = await import('$lib/stores/recent');
		const { get } = await import('svelte/store');

		const { updatedAt, ...entry } = valid;
		recent.record(entry);
		expect(get(recent)).toHaveLength(1);
		expect(get(recent)[0].itemId).toBe(valid.itemId);
	});
});
