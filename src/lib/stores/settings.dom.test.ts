import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applySettingsToDOM, defaultCustomTheme, defaultSettings } from '$lib/stores/settings';

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
		document.documentElement.removeAttribute('style');
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

	// A stored blob can carry a value of the wrong type: an older version wrote
	// strings for numbers, or the JSON was hand-edited. Validation happens at
	// module init, where a throw is a white screen, and a bad key must cost only
	// itself — not the whole blob of valid preferences around it.
	it('falls back on a wrongly typed number but keeps valid siblings', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({ theme: 'sepia', fontSize: '1.4' })
			})
		);

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');
		const s = get(settings);

		expect(s.theme).toBe('sepia');
		expect(s.fontSize).toBe(defaultSettings.fontSize);
	});

	it('falls back on an enum value that is not a member', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({ theme: 'nonsense', fontSize: 1.4 })
			})
		);

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');
		const s = get(settings);

		expect(s.theme).toBe(defaultSettings.theme);
		expect(s.fontSize).toBe(1.4);
	});

	it('falls back when progressModes is not an array of known modes', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({ progressModes: {}, timingOffset: 2.5 })
			})
		);

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');
		const s = get(settings);

		expect(s.progressModes).toEqual(defaultSettings.progressModes);
		expect(s.timingOffset).toBe(2.5);
	});

	it('rejects an unknown mode inside an otherwise valid progressModes list', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({ progressModes: ['book-pct', 'bogus'] })
			})
		);

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');

		expect(get(settings).progressModes).toEqual(defaultSettings.progressModes);
	});

	it('falls back per custom theme colour, keeping the valid ones', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({
					theme: 'custom',
					customTheme: { bg: null, fg: '#ffffff' }
				})
			})
		);

		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');
		const s = get(settings);

		expect(s.customTheme.bg).toBe(defaultCustomTheme.bg);
		expect(s.customTheme.fg).toBe('#ffffff');
		expect(s.customTheme.accent).toBe(defaultCustomTheme.accent);
	});

	it('applies a stored valid custom theme to the DOM', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-settings': JSON.stringify({
					theme: 'custom',
					customTheme: {
						bg: '#112233',
						fg: '#f0f0f0',
						accent: '#445566',
						accentFg: '#000000'
					}
				})
			})
		);

		await import('$lib/stores/settings');

		const root = document.documentElement;
		expect(root.style.getPropertyValue('--custom-bg')).toBe('#112233');
		expect(root.style.getPropertyValue('--custom-fg')).toBe('#f0f0f0');
		expect(root.style.getPropertyValue('--custom-accent')).toBe('#445566');
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
