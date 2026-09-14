import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeSetItem } from '$lib/stores/storage';

/** Neither project supplies a localStorage (see offsets.test.ts), so bring one. */
function makeLocalStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('safeSetItem', () => {
	it('writes through when storage accepts the value', () => {
		const storage = makeLocalStorage();
		vi.stubGlobal('localStorage', storage);

		safeSetItem('reader-test', 'value');

		expect(storage.getItem('reader-test')).toBe('value');
	});

	it('swallows a setItem that throws', () => {
		const storage = makeLocalStorage();
		storage.setItem = () => {
			throw new DOMException('quota exceeded', 'QuotaExceededError');
		};
		vi.stubGlobal('localStorage', storage);

		expect(() => safeSetItem('reader-test', 'value')).not.toThrow();
	});

	it('does nothing when the environment has no storage at all', () => {
		expect(() => safeSetItem('reader-test', 'value')).not.toThrow();
	});
});
