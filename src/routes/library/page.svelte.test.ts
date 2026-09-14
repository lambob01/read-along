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

function jsonResponse(data: unknown) {
	return {
		ok: true,
		status: 200,
		headers: { get: () => 'application/json' },
		json: async () => data,
		text: async () => JSON.stringify(data)
	} as unknown as Response;
}

const LIBRARIES = [
	{ id: 'alpha', name: 'Alpha' },
	{ id: 'beta', name: 'Beta' }
];

function item(libraryId: string) {
	return {
		id: `${libraryId}-book`,
		media: { metadata: { title: `${libraryId} book`, authorName: 'A' } }
	};
}

/**
 * The shelf sends one request per library click with no cancellation, so a
 * slow earlier response can land after a later one. The page must show the
 * last library asked for, not the last to answer.
 */
describe('library page', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	});

	it('keeps the last requested library when responses land out of order', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage());
		const pending = new Map<string, () => void>();
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string | URL | Request) => {
				const path = String(url);
				if (path.endsWith('/api/libraries')) {
					return Promise.resolve(jsonResponse({ libraries: LIBRARIES }));
				}
				const match = /\/(alpha|beta)\/items/.exec(path);
				if (match) {
					const id = match[1];
					return new Promise((resolve) => {
						pending.set(id, () => resolve(jsonResponse({ results: [item(id)] })));
					});
				}
				return Promise.resolve(jsonResponse({ results: [] }));
			})
		);

		const { connection } = await import('$lib/stores/connection');
		connection.connect('test-token');
		const { default: LibraryPage } = await import('./+page.svelte');
		const { mount, flushSync, unmount } = await import('svelte');

		const host = document.createElement('div');
		document.body.appendChild(host);
		const instance = mount(LibraryPage, { target: host });

		// Mount fetches the first library; wait until that request is pending.
		await vi.waitFor(() => expect(pending.has('alpha')).toBe(true));
		flushSync();

		const beta = [...host.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Beta')
		) as HTMLButtonElement;
		beta.click();
		await vi.waitFor(() => expect(pending.has('beta')).toBe(true));

		// Beta answers first, then Alpha's straggler arrives. Give the stale
		// response time to run to completion before judging the shelf.
		pending.get('beta')!();
		await vi.waitFor(() => expect(host.textContent).toContain('beta book'));
		pending.get('alpha')!();
		await new Promise((resolve) => setTimeout(resolve, 20));
		flushSync();

		expect(host.textContent).toContain('beta book');
		expect(host.textContent).not.toContain('alpha book');
		unmount(instance);
	});
});
