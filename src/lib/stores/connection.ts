import { writable, type Writable } from 'svelte/store';

function persisted<T>(key: string, defaultValue: T): Writable<T> {
	const stored =
		typeof localStorage !== 'undefined'
			? localStorage.getItem(key)
			: null;
	const initial: T = stored ? JSON.parse(stored) : defaultValue;

	const store = writable<T>(initial);

	if (typeof localStorage !== 'undefined') {
		store.subscribe((value) => {
			localStorage.setItem(key, JSON.stringify(value));
		});
	}

	return store;
}

export interface ConnectionState {
	url: string;
	token: string;
	connected: boolean;
}

function createConnectionStore() {
	const { subscribe, set, update } = persisted<ConnectionState>(
		'reader-connection',
		{ url: '', token: '', connected: false }
	);

	return {
		subscribe,
		connect(url: string, token: string) {
			set({ url, token, connected: true });
		},
		disconnect() {
			set({ url: '', token: '', connected: false });
		},
		set
	};
}

export const connection = createConnectionStore();
