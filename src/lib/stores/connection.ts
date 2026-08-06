import { writable, type Writable } from 'svelte/store';

function persisted<T>(key: string, defaultValue: T): Writable<T> {
	// The store is read at module init, so a corrupt value here throws before
	// any UI can catch it — the app white-screens. Every other persisted
	// store in the app wraps its reads the same way.
	let initial: T = defaultValue;
	if (typeof localStorage !== 'undefined') {
		try {
			const parsed = JSON.parse(localStorage.getItem(key) || '');
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				initial = parsed as T;
			}
		} catch {
			/* corrupt storage falls back to the default */
		}
	}

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
	const { subscribe, set, update } = persisted<ConnectionState>('reader-connection', {
		url: '',
		token: '',
		connected: false
	});

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
