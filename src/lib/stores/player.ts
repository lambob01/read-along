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
let currentSrc = '';

/**
 * Bounds a seek target against the media's duration.
 *
 * Only clamps against a duration the element actually knows. Until metadata
 * loads `duration` is NaN, and the original `Math.min(time, duration || 0)`
 * turned that into a clamp to zero — so a seek issued during the load, a
 * resumed bookmark above all, silently rewound the book to the start. An
 * out-of-range value is safe to pass through: the element records it as the
 * default playback start position and applies it once it knows better.
 */
export function clampSeek(time: number, duration: number): number {
	if (!Number.isFinite(time) || time < 0) return 0;
	const known = Number.isFinite(duration) && duration > 0;
	return known ? Math.min(time, duration) : time;
}

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
				a.currentTime = clampSeek(time, a.duration);
			}, undefined);
		},
		/**
		 * Seeks once the media knows its own duration, or immediately if it
		 * already does.
		 *
		 * Resuming races the metadata load, and a big remote file can take many
		 * seconds to answer. The element is a singleton shared between books, so
		 * a pending seek is dropped if the source changes under it — otherwise
		 * opening a second book could inherit the first one's position.
		 */
		seekWhenReady(time: number) {
			withAudio((a) => {
				if (a.readyState >= HTMLMediaElement.HAVE_METADATA) {
					player.seek(time);
					return;
				}
				const srcAtRequest = currentSrc;
				const cleanup = () => {
					a.removeEventListener('loadedmetadata', onReady);
					a.removeEventListener('error', cleanup);
				};
				function onReady() {
					cleanup();
					if (currentSrc === srcAtRequest) player.seek(time);
				}
				a.addEventListener('loadedmetadata', onReady);
				a.addEventListener('error', cleanup);
			}, undefined);
		},
		setRate(rate: number) {
			const clamped = Math.max(0.5, Math.min(3, rate));
			withAudio((a) => {
				a.playbackRate = clamped;
			}, undefined);
		},
		setVolume(vol: number) {
			const clamped = Math.max(0, Math.min(1, vol));
			withAudio((a) => {
				a.volume = clamped;
			}, undefined);
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
			currentSrc = url;
			withAudio((a) => {
				a.src = url;
				a.load();
			}, undefined);
			initEvents();
		},
		getAudioElement(): HTMLAudioElement | null {
			return getAudio();
		},
		/**
		 * The URL as it was handed in, not the element's resolved `src`. Anki
		 * capture re-plays this on its own element, and the element's own value
		 * is absolutized and empty before the first `setSrc`.
		 */
		getSrc(): string {
			return currentSrc;
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
