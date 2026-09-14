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

/** Nearest own descriptor, so an installed throwing getter can be undone. */
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalLocalStorage) {
		Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
	} else {
		delete (globalThis as { localStorage?: unknown }).localStorage;
	}
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

	it('swallows storage whose very access throws', () => {
		// Blocked third-party storage throws from the property getter itself,
		// before `setItem` is ever reached.
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new DOMException('denied', 'SecurityError');
			}
		});

		expect(() => safeSetItem('reader-test', 'value')).not.toThrow();
	});

	it('does nothing when the environment has no storage at all', () => {
		expect(() => safeSetItem('reader-test', 'value')).not.toThrow();
	});
});
