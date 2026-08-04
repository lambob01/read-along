import { writable } from 'svelte/store';

export interface RecentBook {
	itemId: string;
	title: string;
	authorName: string;
	duration: number;
	position: number;
	updatedAt: number;
}

const KEY = 'reader-recent';
const MAX_ENTRIES = 5;

/**
 * An ABS item id is a UUID (or a plain number on very old servers) — never a
 * file name. Chapter filenames such as `part0005.html` have been recorded here
 * by a reader page that failed to load and wrote its bogus route parameter
 * instead, so anything containing a path separator or an extension is dropped.
 */
function isValidItemId(id: string): boolean {
	return typeof id === 'string' && id.length > 0 && !/[./]/.test(id);
}

function load(): RecentBook[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(b): b is RecentBook => !!b && typeof b.itemId === 'string' && isValidItemId(b.itemId)
		);
	} catch {
		return [];
	}
}

function persist(list: RecentBook[]) {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(KEY, JSON.stringify(list));
}

function createRecentStore() {
	const { subscribe, update } = writable<RecentBook[]>(load());

	return {
		subscribe,
		/** Upserts a book to the front of the list, trimming to MAX_ENTRIES. */
		record(entry: Omit<RecentBook, 'updatedAt'>) {
			if (!isValidItemId(entry.itemId)) return;
			update((list) => {
				const rest = list.filter((b) => b.itemId !== entry.itemId);
				const next = [{ ...entry, updatedAt: Date.now() }, ...rest].slice(0, MAX_ENTRIES);
				persist(next);
				return next;
			});
		},
		remove(itemId: string) {
			update((list) => {
				const next = list.filter((b) => b.itemId !== itemId);
				persist(next);
				return next;
			});
		}
	};
}

export const recent = createRecentStore();
