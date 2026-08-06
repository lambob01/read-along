import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { clampSeek } from '$lib/stores/player';

function makeLocalStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

/** Minimal HTMLAudioElement stand-in. */
class FakeAudio {
	currentTime = 0;
	duration = NaN;
	paused = true;
	playbackRate = 1;
	preservesPitch = true;
	src = '';
	dataset: Record<string, string> = {};
	readyState = 0;
	loadCalls = 0;
	listeners = new Map<string, Set<() => void>>();
	load() {
		this.loadCalls++;
	}
	addEventListener(type: string, fn: () => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(fn);
	}
	removeEventListener(type: string, fn: () => void) {
		this.listeners.get(type)?.delete(fn);
	}
	dispatchEvent(event: Event) {
		for (const fn of this.listeners.get(event.type) ?? []) fn();
		return true;
	}
}

beforeEach(() => {
	vi.stubGlobal('localStorage', makeLocalStorage());
	vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('clampSeek', () => {
	it('passes the target through when it is inside a known duration', () => {
		expect(clampSeek(1200, 1800)).toBe(1200);
	});

	it('clamps to the end once the duration is known', () => {
		expect(clampSeek(9999, 1800)).toBe(1800);
	});

	it('keeps the target when the duration is not known yet', () => {
		expect(clampSeek(1200, NaN)).toBe(1200);
		expect(clampSeek(1200, 0)).toBe(1200);
		expect(clampSeek(1200, Infinity)).toBe(1200);
	});

	it('floors negative and non-finite targets at the start', () => {
		expect(clampSeek(-5, 1800)).toBe(0);
		expect(clampSeek(NaN, 1800)).toBe(0);
	});
});

describe('player store', () => {
	it('resets playback state when the source changes', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.setSrc('book-a.mp3');
		// The store follows the element via timeupdate; simulate book A having
		// actually played to 42s before the source changes. Without the event
		// the store never holds the old position and the test passes pre-fix.
		const a = player.getAudioElement() as unknown as FakeAudio;
		a.currentTime = 42;
		a.duration = 300;
		a.dispatchEvent(new Event('timeupdate'));

		player.setSrc('book-b.mp3');

		const s = get(player);
		// Between setSrc and the new source's first timeupdate the store must
		// not claim book A's position — the bookmark interval would persist it
		// under book B.
		expect(s.currentTime).toBe(0);
		expect(s.duration).toBe(0);
		expect(s.playing).toBe(false);
	});

	it('skipForward does not rewind while the duration is unknown', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		const a = player.getAudioElement() as unknown as FakeAudio;
		a.currentTime = 100;
		a.duration = NaN;
		player.skipForward(10);
		// The regression: `Math.min(a.duration || 0, ...)` turned the unknown
		// duration into a clamp to zero — skipping forward during a slow
		// metadata load rewound the book to the start.
		expect(a.currentTime).toBe(110);
	});

	it('skipForward clamps to the end once the duration is known', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		const a = player.getAudioElement() as unknown as FakeAudio;
		a.currentTime = 25;
		a.duration = 30;
		player.skipForward(10);
		expect(a.currentTime).toBe(30);
	});

	it('treats non-object bookmarks JSON as empty', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		localStorage.setItem('reader-bookmarks', 'null');
		expect(player.getBookmark('book-1')).toBeNull();
		localStorage.setItem('reader-bookmarks', '"a string"');
		expect(player.getBookmark('book-1')).toBeNull();
		localStorage.setItem('reader-bookmarks', '[1,2]');
		expect(player.getBookmark('book-1')).toBeNull();
	});

	it('round-trips a bookmark', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.saveBookmark('book-1', 123.5);
		expect(player.getBookmark('book-1')).toBe(123.5);
	});

	it('setPosition seeds the display position before metadata loads', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.setSrc('book-a.mp3');
		player.setPosition(612.5, 3600);

		const s = get(player);
		expect(s.currentTime).toBe(612.5);
		expect(s.duration).toBe(3600);
	});

	it('setPosition clamps to the seeded duration', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.setPosition(9999, 3600);

		expect(get(player).currentTime).toBe(3600);
	});

	it('setPosition keeps the current duration when none is given', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.setPosition(30, 3600);
		player.setPosition(60);

		const s = get(player);
		expect(s.currentTime).toBe(60);
		expect(s.duration).toBe(3600);
	});

	it('setPosition rejects an unusable duration', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.setPosition(30, NaN);
		player.setPosition(60, -5);

		expect(get(player).duration).toBe(0);
	});
});
