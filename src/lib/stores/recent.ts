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

function load(): RecentBook[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
		return Array.isArray(parsed) ? parsed : [];
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
