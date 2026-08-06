import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';

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

describe('connection store persistence', () => {
	it('falls back to defaults on corrupt storage', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage({ 'reader-connection': '{oops' }));
		const { connection } = await import('$lib/stores/connection');
		expect(get(connection)).toEqual({ url: '', token: '', connected: false });
	});

	it('falls back to defaults when the stored value is not an object', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage({ 'reader-connection': 'null' }));
		const { connection } = await import('$lib/stores/connection');
		expect(get(connection).token).toBe('');
	});

	it('loads a valid stored credential', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-connection': JSON.stringify({ url: '', token: 'abc', connected: true })
			})
		);
		const { connection } = await import('$lib/stores/connection');
		expect(get(connection).token).toBe('abc');
	});
});
