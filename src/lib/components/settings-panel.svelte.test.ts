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
});

describe('SettingsPanel', () => {
	it('hides the subtitle options in EPUB mode and shows them otherwise', async () => {
		// `mount` must come from the same module graph as the component:
		// `vi.resetModules()` re-executes the svelte client runtime, and a
		// `mount` from the pre-reset copy would never initialise the one the
		// component renders with.
		const { default: SettingsPanel } = await import('./SettingsPanel.svelte');
		const { mount, flushSync } = await import('svelte');

		// Both mounts pin `only: 'sync'` — #gap-threshold lives in the sync
		// section, and the component defaults to the appearance tab, so without
		// pinning the tab the assertion would pass for the wrong reason.
		const epubHost = document.createElement('div');
		mount(SettingsPanel, { target: epubHost, props: { showSubtitleOptions: false, only: 'sync' } });
		flushSync();
		expect(epubHost.querySelector('#gap-threshold')).toBeNull();

		const subtitleHost = document.createElement('div');
		mount(SettingsPanel, {
			target: subtitleHost,
			props: { showSubtitleOptions: true, only: 'sync' }
		});
		flushSync();
		expect(subtitleHost.querySelector('#gap-threshold')).not.toBeNull();
	});

	it('writes a control change into the settings store', async () => {
		const { default: SettingsPanel } = await import('./SettingsPanel.svelte');
		const { mount, flushSync } = await import('svelte');
		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');

		const host = document.createElement('div');
		mount(SettingsPanel, { target: host, props: { showSubtitleOptions: true, only: 'reading' } });
		flushSync();

		// The reading tab's checkboxes are labelled rows; find "Read along" by
		// its label text rather than assuming checkbox order.
		const row = [...host.querySelectorAll('label')].find((l) =>
			l.textContent?.includes('Read along')
		);
		const readAlong = row?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
		expect(readAlong).not.toBeNull();
		readAlong!.checked = true;
		readAlong!.dispatchEvent(new Event('change'));
		flushSync();

		expect(get(settings).readAlong).toBe(true);
	});
});
