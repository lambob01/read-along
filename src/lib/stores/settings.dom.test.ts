import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applySettingsToDOM, defaultSettings } from '$lib/stores/settings';

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

describe('settings persistence', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	// Settings added after a user's last visit are absent from their stored
	// blob. Replacing instead of merging would send `undefined` into the CSS
	// custom properties and blank out the reader.
	it('fills in keys missing from older persisted settings', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({ theme: 'sepia', fontSize: 1.4 })
			})
		);

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');
		const s = get(settings);

		expect(s.theme).toBe('sepia');
		expect(s.fontSize).toBe(1.4);
		expect(s.timingOffset).toBe(defaultSettings.timingOffset);
		expect(s.scrollAnchor).toBe(defaultSettings.scrollAnchor);
		expect(s.hlStyle).toBe(defaultSettings.hlStyle);
	});

	it('falls back to defaults on corrupt storage', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage({ 'reader-settings': '{oops' }));

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');

		expect(get(settings)).toEqual(defaultSettings);
	});

	it('writes changes back to storage', async () => {
		const store = makeLocalStorage();
		vi.stubGlobal('localStorage', store);

		const { settings } = await import('$lib/stores/settings');
		settings.update((s) => ({ ...s, fontSize: 1.8 }));

		const written = JSON.parse(store.getItem('reader-settings')!);
		expect(written.fontSize).toBe(1.8);
	});
});

describe('applySettingsToDOM', () => {
	it('writes every themed custom property', () => {
		applySettingsToDOM({
			...defaultSettings,
			theme: 'dracula',
			fontSize: 1.25,
			maxWidth: 72,
			paragraphSpacing: 1.4,
			justify: true,
			hlStyle: 'underline'
		});

		const root = document.documentElement;
		expect(root.style.getPropertyValue('--theme-font-size')).toBe('1.25rem');
		expect(root.style.getPropertyValue('--theme-max-width')).toBe('72ch');
		expect(root.style.getPropertyValue('--theme-paragraph-spacing')).toBe('1.4em');
		expect(root.style.getPropertyValue('--theme-text-align')).toBe('justify');
		expect(root.dataset.theme).toBe('dracula');
		expect(root.dataset.hlStyle).toBe('underline');
	});

	it('maps unjustified text to a start alignment', () => {
		applySettingsToDOM({ ...defaultSettings, justify: false });
		expect(document.documentElement.style.getPropertyValue('--theme-text-align')).toBe('start');
	});

	it('never emits undefined into a custom property', () => {
		// Guards the merge contract from the consuming side.
		applySettingsToDOM(defaultSettings);
		const style = document.documentElement.getAttribute('style') ?? '';
		expect(style).not.toContain('undefined');
	});
});
