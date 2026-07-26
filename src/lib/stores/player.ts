import { writable } from 'svelte/store';

export interface PlayerState {
	currentTime: number;
	duration: number;
	playing: boolean;
	rate: number;
	volume: number;
	chapter: number;
}

let audio: HTMLAudioElement | null = null;

function getAudio(): HTMLAudioElement | null {
	if (typeof Audio === 'undefined') return null;
	if (!audio) {
		audio = new Audio();
		audio.preservesPitch = true;
	}
	return audio;
}

function createPlayerStore() {
	const { subscribe, update } = writable<PlayerState>({
		currentTime: 0,
		duration: 0,
		playing: false,
		rate: 1,
		volume: 1,
		chapter: 0
	});

	function withAudio<T>(fn: (a: HTMLAudioElement) => T, fallback: T): T {
		const a = getAudio();
		if (!a) return fallback;
		return fn(a);
	}

	function noop() {}

	const BOOKMARKS_KEY = 'reader-bookmarks';

	function loadBookmarks(): Record<string, number> {
		if (typeof localStorage === 'undefined') return {};
		try {
			return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '{}');
		} catch {
			return {};
		}
	}

	const player = {
		subscribe,
		play() {
			withAudio((a) => a.play().catch(noop), undefined);
		},
		pause() {
			withAudio((a) => a.pause(), undefined);
		},
		seek(time: number) {
			withAudio((a) => {
				a.currentTime = Math.max(0, Math.min(time, a.duration || 0));
			}, undefined);
		},
		setRate(rate: number) {
			const clamped = Math.max(0.5, Math.min(3, rate));
			withAudio((a) => { a.playbackRate = clamped; }, undefined);
		},
		setVolume(vol: number) {
			const clamped = Math.max(0, Math.min(1, vol));
			withAudio((a) => { a.volume = clamped; }, undefined);
			update((s) => ({ ...s, volume: clamped }));
		},
		skipBack(seconds: number = 10) {
			withAudio((a) => {
				a.currentTime = Math.max(0, a.currentTime - seconds);
			}, undefined);
		},
		skipForward(seconds: number = 10) {
			withAudio((a) => {
				a.currentTime = Math.min(a.duration || 0, a.currentTime + seconds);
			}, undefined);
		},
		setChapter(n: number) {
			update((s) => ({ ...s, chapter: n }));
		},
		setSrc(url: string) {
			withAudio((a) => {
				a.src = url;
				a.load();
			}, undefined);
			initEvents();
		},
		getAudioElement(): HTMLAudioElement | null {
			return getAudio();
		},
		saveBookmark(itemId: string, time: number) {
			if (typeof localStorage === 'undefined') return;
			const bookmarks = loadBookmarks();
			bookmarks[itemId] = time;
			localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
		},
		getBookmark(itemId: string): number | null {
			const bookmarks = loadBookmarks();
			return bookmarks[itemId] ?? null;
		}
	};

	function initEvents() {
		const a = getAudio();
		if (!a) return;

		if (a.dataset.eventsSetup === '1') return;
		a.dataset.eventsSetup = '1';

		a.addEventListener('timeupdate', () => {
			update((s) => ({ ...s, currentTime: a.currentTime }));
		});
		a.addEventListener('durationchange', () => {
			update((s) => ({ ...s, duration: a.duration || 0 }));
		});
		a.addEventListener('play', () => {
			update((s) => ({ ...s, playing: true }));
		});
		a.addEventListener('pause', () => {
			update((s) => ({ ...s, playing: false }));
		});
		a.addEventListener('ended', () => {
			update((s) => ({ ...s, playing: false }));
		});
		a.addEventListener('ratechange', () => {
			update((s) => ({ ...s, rate: a.playbackRate }));
		});
	}

	return player;
}

export const player = createPlayerStore();
