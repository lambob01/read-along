import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The reader page's scroller does not exist when `onMount` runs: the whole
 * book view sits behind `{#if loading}`, and loading only clears once the
 * item, session and text source have all come back. Attaching its listeners
 * at mount therefore attached them to nothing — content links were never
 * intercepted. These tests mount the page against fake ABS responses and
 * drive the real DOM.
 */

function makeLocalStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

/** Minimal `Response` shape the ABS client accepts. */
function jsonResponse(data: unknown) {
	return {
		ok: true,
		status: 200,
		headers: { get: () => 'application/json' },
		json: async () => data,
		text: async () => JSON.stringify(data)
	} as unknown as Response;
}

const ITEM = { id: 'item-1', media: { metadata: { title: 'Test Book' }, duration: 120 } };

/** An item with no audio track and no subtitle: the ebook view, plus notice. */
async function fetchWithoutAudio(url: string | URL | Request) {
	const path = String(url);
	if (path.includes('/play')) return jsonResponse({ libraryItem: { media: {} } });
	return jsonResponse(ITEM);
}

async function mountReader(fetchImpl: (url: string | URL | Request) => Promise<Response>) {
	vi.stubGlobal('localStorage', makeLocalStorage());
	vi.stubGlobal('fetch', vi.fn(fetchImpl));

	// `$app/stores`' page is populated by the client router, which never runs
	// in a test; set it directly so `$page.params` and `$page.url` resolve.
	const { stores } =
		// @ts-expect-error — the runtime client is plain JS with no declarations.
		await import('../../../../node_modules/@sveltejs/kit/src/runtime/client/client.js');
	stores.page.set({
		params: { itemId: 'item-1' },
		url: new URL('http://localhost/read/item-1')
	});
	const { connection } = await import('$lib/stores/connection');
	connection.connect('test-token');

	const { default: Page } = await import('./+page.svelte');
	const { mount, flushSync, unmount: unmountComponent } = await import('svelte');

	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(Page, { target: host });

	await vi.waitFor(() => {
		expect(host.querySelector('.reader-scroller')).not.toBeNull();
	});
	flushSync();

	return {
		host,
		flushSync,
		unmount: () => {
			unmountComponent(instance);
			host.remove();
		}
	};
}

beforeEach(() => {
	vi.resetModules();
	// jsdom has no media stack; the player only needs these to be callable.
	vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

describe('reader page', () => {
	it('intercepts in-content links after the loading gate', async () => {
		const { host, unmount } = await mountReader(fetchWithoutAudio);
		const scroller = host.querySelector('.reader-scroller')!;

		const chapterLink = document.createElement('a');
		chapterLink.setAttribute('href', 'chapter-3.xhtml');
		scroller.appendChild(chapterLink);
		const chapterClick = new MouseEvent('click', { bubbles: true, cancelable: true });
		chapterLink.dispatchEvent(chapterClick);

		const fragmentLink = document.createElement('a');
		fragmentLink.setAttribute('href', '#fn1');
		scroller.appendChild(fragmentLink);
		const fragmentClick = new MouseEvent('click', { bubbles: true, cancelable: true });
		fragmentLink.dispatchEvent(fragmentClick);

		expect(chapterClick.defaultPrevented).toBe(true);
		expect(fragmentClick.defaultPrevented).toBe(false);
		unmount();
	});

	it('renders no transport when the item has no audio track', async () => {
		const { host, unmount } = await mountReader(fetchWithoutAudio);

		expect(host.querySelector('[aria-label="Seek"]')).toBeNull();
		expect(host.querySelector('[aria-label="Play"]')).toBeNull();
		unmount();
	});

	it('toggles the chrome with the C key', async () => {
		const { host, flushSync, unmount } = await mountReader(fetchWithoutAudio);
		const back = host.querySelector('[aria-label="Back to book details"]');
		const bar = back?.closest('div.grid') as HTMLElement;

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
		flushSync();

		expect(bar.className).toContain('grid-rows-[0fr]');
		unmount();
	});

	it('keeps Tab inside the settings sheet', async () => {
		const { host, flushSync, unmount } = await mountReader(fetchWithoutAudio);

		(host.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click();
		flushSync();

		const close = host.querySelector('[aria-label="Close"]') as HTMLButtonElement;
		const reset = [...host.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Reset all to defaults')
		) as HTMLButtonElement;

		// Opening the sheet moves focus to its close button.
		expect(document.activeElement).toBe(close);

		reset.focus();
		const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		reset.dispatchEvent(tab);

		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(close);
		unmount();
	});
});
