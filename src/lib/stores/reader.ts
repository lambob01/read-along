import { writable } from 'svelte/store';
import type { ABSItem, CueIndex } from '$lib/types';

export interface ReaderState {
	loading: boolean;
	error: string | null;
	item: ABSItem | null;
	cueIndex: CueIndex | null;
	sentenceMap: Map<number, HTMLElement> | null;
	activeSentenceId: number | null;
}

function createReaderStore() {
	const { subscribe, set, update } = writable<ReaderState>({
		loading: false,
		error: null,
		item: null,
		cueIndex: null,
		sentenceMap: null,
		activeSentenceId: null
	});

	return {
		subscribe,
		setActiveSentence(id: number | null) {
			update((s) => ({ ...s, activeSentenceId: id }));
		},
		setSentenceMap(map: Map<number, HTMLElement>) {
			update((s) => ({ ...s, sentenceMap: map }));
		},
		setCueIndex(index: CueIndex) {
			update((s) => ({ ...s, cueIndex: index }));
		},
		setItem(item: ABSItem) {
			update((s) => ({ ...s, item }));
		},
		setLoading(loading: boolean) {
			update((s) => ({ ...s, loading }));
		},
		setError(error: string | null) {
			update((s) => ({ ...s, error }));
		},
		reset() {
			set({
				loading: false,
				error: null,
				item: null,
				cueIndex: null,
				sentenceMap: null,
				activeSentenceId: null
			});
		}
	};
}

export const reader = createReaderStore();
