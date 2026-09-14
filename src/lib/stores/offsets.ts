import { writable } from 'svelte/store';
import { safeSetItem } from '$lib/stores/storage';

const STORAGE_KEY = 'reader-offsets';

/** Beyond this the offset is almost certainly a mistake, not drift. */
export const MAX_OFFSET = 30;

export function clampOffset(seconds: number): number {
	if (!Number.isFinite(seconds)) return 0;
	// Kept at 2dp so slider drags produce stable, displayable values.
	return Math.round(Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, seconds)) * 100) / 100;
}

function load(): Record<string, number> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Per-book sync offsets in seconds, keyed by item id.
 *
 * Alignment drift is a property of a particular recording and transcript pair,
 * not of the user, so a book that has been tuned keeps its own value. Books
 * with no entry fall back to the global default in `settings.timingOffset`.
 */
function createOffsetStore() {
	const { subscribe, update, set } = writable<Record<string, number>>(load());

	// Reads go through this rather than re-parsing storage, so writes (which
	// merge from it) and reads cannot drift apart.
	let current: Record<string, number> = load();
	subscribe((v) => {
		current = v;
	});

	function persist(next: Record<string, number>) {
		safeSetItem(STORAGE_KEY, JSON.stringify(next));
		return next;
	}

	const store = {
		subscribe,
		/** Re-reads persisted state. Called by the cross-tab listener and tests. */
		hydrate() {
			set(load());
		},
		/** Returns the stored offset, or null when the book has never been tuned. */
		get(itemId: string): number | null {
			const stored = current[itemId];
			return typeof stored === 'number' ? stored : null;
		},
		set(itemId: string, seconds: number) {
			update((all) => persist({ ...all, [itemId]: clampOffset(seconds) }));
		},
		/** Drops the override so the book follows the global default again. */
		clear(itemId: string) {
			update((all) => {
				const next = { ...all };
				delete next[itemId];
				return persist(next);
			});
		}
	};

	if (typeof window !== 'undefined') {
		// `setItem` only fires this in *other* tabs, so the store can never
		// hear its own writes; a null key means the other tab called clear().
		window.addEventListener('storage', (event) => {
			if (event.key === null || event.key === STORAGE_KEY) store.hydrate();
		});
	}

	return store;
}

export const offsets = createOffsetStore();
