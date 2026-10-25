import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
	vi.stubGlobal('localStorage', makeLocalStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	document.body.innerHTML = '';
});

describe('ThemeToggle', () => {
	it('flips between dark and light and persists the choice', async () => {
		const { default: ThemeToggle } = await import('./ThemeToggle.svelte');
		const { mount, flushSync, unmount } = await import('svelte');
		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');

		expect(get(settings).theme).toBe('dark');

		const host = document.createElement('div');
		document.body.appendChild(host);
		const instance = mount(ThemeToggle, { target: host });
		flushSync();

		const button = host.querySelector('button');
		expect(button).not.toBeNull();
		expect(button!.getAttribute('aria-label')).toBe('Switch to light mode');
		expect(button!.getAttribute('aria-pressed')).toBe('true');

		button!.click();
		flushSync();

		expect(get(settings).theme).toBe('light');
		expect(button!.getAttribute('aria-label')).toBe('Switch to dark mode');
		expect(button!.getAttribute('aria-pressed')).toBe('false');
		expect(JSON.parse(localStorage.getItem('reader-settings')!).theme).toBe('light');

		unmount(instance);
	});
});
