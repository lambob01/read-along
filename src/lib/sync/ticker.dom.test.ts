import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSyncController } from '$lib/sync/ticker';
import type { TimingIndex } from '$lib/types';

/**
 * Two timed sentences with a deliberate 1s gap between them (2→3), so tests can
 * park playback where no sentence is active.
 */
function makeIndex(): TimingIndex {
	const sentences = [
		{ id: 0, start: 1, end: 2 },
		{ id: 1, start: 3, end: 4 }
	];
	return {
		sentences,
		starts: Float64Array.from(sentences.map((s) => s.start)),
		ends: Float64Array.from(sentences.map((s) => s.end))
	};
}

/** Minimal stand-in for the singleton HTMLAudioElement the reader shares. */
function makeAudio() {
	const listeners = new Map<string, Set<() => void>>();
	return {
		currentTime: 0,
		paused: true,
		addEventListener(type: string, fn: () => void) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(fn);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners.get(type)?.delete(fn);
		},
		emit(type: string) {
			for (const fn of [...(listeners.get(type) ?? [])]) fn();
		},
		listenerCount(type: string) {
			return listeners.get(type)?.size ?? 0;
		}
	};
}

type FakeAudio = ReturnType<typeof makeAudio>;

/** Drives RAF manually so a "frame" is an explicit test step. */
let rafQueue: (() => void)[] = [];
let rafSeq = 0;
let cancelled: Set<number>;
let rafHandles: Map<number, () => void>;

/** Backs document.hidden so tests can simulate backgrounding. */
let hidden = false;

/** Milliseconds the clock advances per flushed frame. */
let frameCost = 16;

/**
 * Runs the frames currently queued, then advances the clock. The clock is
 * vitest's fake timer clock so that interval-driven ticks see realistic
 * inter-tick deltas too.
 */
function flushFrames(n: number) {
	for (let i = 0; i < n; i++) {
		const due = rafQueue;
		rafQueue = [];
		for (const fn of due) fn();
		vi.advanceTimersByTime(frameCost);
	}
}

beforeEach(() => {
	rafQueue = [];
	rafSeq = 0;
	cancelled = new Set();
	rafHandles = new Map();
	frameCost = 16;
	hidden = false;

	Object.defineProperty(document, 'hidden', {
		configurable: true,
		get: () => hidden
	});

	// Must precede the stubs: fake timers install their own requestAnimationFrame
	// and performance, and would otherwise replace the manual ones below.
	vi.useFakeTimers();

	vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
		const id = ++rafSeq;
		rafHandles.set(id, fn);
		rafQueue.push(() => {
			if (!cancelled.has(id)) fn();
		});
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		cancelled.add(id);
		rafHandles.delete(id);
	});
	// Date.now is driven by the fake timers, so every clock source agrees.
	vi.stubGlobal('performance', { now: () => Date.now() });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function setup(offset = 0) {
	const audio = makeAudio();
	const seen: (number | null)[] = [];
	const controller = createSyncController(
		audio as unknown as HTMLAudioElement,
		makeIndex(),
		(id) => seen.push(id),
		offset
	);
	return { audio, seen, controller };
}

function play(audio: FakeAudio) {
	audio.paused = false;
	audio.emit('play');
}

describe('createSyncController', () => {
	it('activates the sentence covering the current time', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);

		expect(seen).toEqual([0]);
		controller.destroy();
	});

	it('reports null once playback passes into a gap', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);

		audio.currentTime = 2.5;
		flushFrames(1);

		expect(seen).toEqual([0, null]);
		controller.destroy();
	});

	it('clears the active sentence when playback ends', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 3.5;
		play(audio);
		flushFrames(1);
		expect(seen).toEqual([1]);

		audio.currentTime = 4;
		audio.paused = true;
		audio.emit('ended');

		expect(seen).toEqual([1, null]);
		controller.destroy();
	});

	it('re-evaluates on pause so a paused gap does not stay lit', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);

		// Pause lands in the gap; the last frame still showed sentence 0.
		audio.currentTime = 2.5;
		audio.paused = true;
		audio.emit('pause');

		expect(seen).toEqual([0, null]);
		controller.destroy();
	});

	it('stops scheduling frames once paused', () => {
		const { audio, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);
		expect(rafQueue.length).toBe(1);

		audio.paused = true;
		audio.emit('pause');
		flushFrames(1);

		expect(rafQueue.length).toBe(0);
		controller.destroy();
	});

	// The mobile bug. The frame-delta heuristic can only run inside a RAF
	// callback, so when the phone suspends RAF outright the loop has no way to
	// notice and the highlight freezes on whatever was lit at suspend time.
	it('keeps advancing while RAF is suspended and audio plays on', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);
		expect(seen).toEqual([0]);

		// Screen locks: no further frames are delivered, ever.
		rafQueue = [];
		audio.currentTime = 3.5;
		vi.advanceTimersByTime(2000);
		audio.emit('timeupdate');

		expect(seen).toEqual([0, 1]);
		controller.destroy();
	});

	it('re-syncs immediately when the page becomes visible again', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);

		hidden = true;
		document.dispatchEvent(new Event('visibilitychange'));

		// Audio ran on while the loop was parked.
		audio.currentTime = 3.5;
		hidden = false;
		document.dispatchEvent(new Event('visibilitychange'));

		expect(seen).toEqual([0, 1]);
		controller.destroy();
	});

	it('does not leave RAF chains running after switching to interval mode', () => {
		const { audio, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);

		// Three consecutive frames slower than 150ms trip the switch.
		frameCost = 200;
		flushFrames(5);

		expect(rafQueue.length).toBe(0);

		// Each interval fire must not resurrect a RAF chain.
		vi.advanceTimersByTime(1000);
		expect(rafQueue.length).toBe(0);

		controller.destroy();
	});

	it('keeps exactly one interval driver after the switch', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);

		frameCost = 200;
		flushFrames(5);

		seen.length = 0;
		audio.currentTime = 3.5;
		// A single 100ms interval fire should report the change exactly once.
		vi.advanceTimersByTime(100);

		expect(seen).toEqual([1]);
		controller.destroy();
	});

	it('applies a positive offset so the text leads the audio', () => {
		const { audio, seen, controller } = setup(0.6);
		// 1.5 + 0.6 = 2.1 falls in the gap, past sentence 0. Nothing is reported
		// because the active sentence was already null.
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);
		expect(seen).toEqual([]);

		// 2.5 + 0.6 = 3.1 reaches sentence 1 early.
		audio.currentTime = 2.5;
		flushFrames(1);
		expect(seen).toEqual([1]);

		controller.destroy();
	});

	it('applies a negative offset so the text trails the audio', () => {
		const { audio, seen, controller } = setup(-1);
		// 2.5 - 1 = 1.5 still inside sentence 0.
		audio.currentTime = 2.5;
		play(audio);
		flushFrames(1);

		expect(seen).toEqual([0]);
		controller.destroy();
	});

	it('re-evaluates immediately when the offset changes while paused', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		controller.start();
		expect(seen).toEqual([0]);

		// Shifting the text forward moves 1.5 into the gap without any frames.
		controller.setOffset(1);

		expect(seen).toEqual([0, null]);
		controller.destroy();
	});

	it('tracks the audio after a seek while paused', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		controller.start();
		expect(seen).toEqual([0]);

		audio.currentTime = 3.5;
		audio.emit('seeked');

		expect(seen).toEqual([0, 1]);
		controller.destroy();
	});

	it('goes quiet when read-along is switched off', () => {
		// Only `setEnabled` will do: the controller listens to a singleton audio
		// element, so `stop()` leaves its own `timeupdate` and `play` handlers to
		// start the loop up again on the next tick.
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);
		expect(seen).toEqual([0]);

		controller.setEnabled(false);
		// The line that was lit has to go out, not freeze on the page.
		expect(seen).toEqual([0, null]);

		audio.currentTime = 3.5;
		audio.emit('timeupdate');
		flushFrames(3);
		expect(seen).toEqual([0, null]);

		controller.destroy();
	});

	it('picks the audio back up when read-along is switched on', () => {
		const { audio, seen, controller } = setup();
		audio.currentTime = 1.5;
		play(audio);
		flushFrames(1);
		controller.setEnabled(false);

		audio.currentTime = 3.5;
		controller.setEnabled(true);
		expect(seen.at(-1)).toBe(1);

		// And the loop is running again, not just the one sample.
		audio.currentTime = 1.5;
		flushFrames(1);
		expect(seen.at(-1)).toBe(0);

		controller.destroy();
	});

	it('detaches its listeners on destroy', () => {
		const { audio, controller } = setup();
		expect(audio.listenerCount('play')).toBe(1);

		controller.destroy();

		expect(audio.listenerCount('play')).toBe(0);
		expect(audio.listenerCount('pause')).toBe(0);
		expect(audio.listenerCount('ended')).toBe(0);
		expect(audio.listenerCount('seeked')).toBe(0);
	});

	it('re-samples immediately on a controller seek', () => {
		// The element's `seeked` event is covered elsewhere; this pins the
		// controller's own seek(), which sets the position AND evaluates in
		// the same call.
		const audio = makeAudio();
		const seen: (number | null)[] = [];
		const sentences = [
			{ id: 0, start: 0, end: 2 },
			{ id: 1, start: 5, end: 7 }
		];
		const index: TimingIndex = {
			sentences,
			starts: Float64Array.from(sentences.map((s) => s.start)),
			ends: Float64Array.from(sentences.map((s) => s.end))
		};
		const controller = createSyncController(audio as unknown as HTMLAudioElement, index, (id) =>
			seen.push(id)
		);

		// Paused, and no frame or timer has run: the seek has to do the
		// whole job by itself.
		controller.seek(5.5);

		expect(audio.currentTime).toBe(5.5);
		expect(seen).toEqual([1]);
		controller.destroy();
	});
});
