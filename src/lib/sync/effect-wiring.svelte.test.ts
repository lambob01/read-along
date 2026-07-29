import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { createRepeatController } from '$lib/sync/repeat';
import type { TimingIndex } from '$lib/types';

/**
 * The reader pushes settings into three long-lived controllers (sync, repeat,
 * autoscroll) from `$effect`s. All three are built inside a
 * `requestAnimationFrame` in `onMount`, so they are still null the first time
 * those effects run — which makes *how* the effect is written load-bearing.
 *
 * This bit the repeat-mode toggle: it did nothing until the page was reloaded.
 */

/** Stand-in for a controller created after the first effect run. */
function lateController() {
	const seen: unknown[] = [];
	return { seen, set: (v: unknown) => seen.push(v) };
}

describe('pushing a reactive value into a late-built controller', () => {
	it('loses the dependency when the value is only read inside an optional call', () => {
		let enabled = $state(false);
		let controller: ReturnType<typeof lateController> | null = null;

		const stop = $effect.root(() => {
			$effect(() => {
				// `controller` is null on the first run, so `enabled` is never
				// evaluated and the effect ends up subscribed to nothing.
				controller?.set(enabled);
			});
		});
		flushSync();

		controller = lateController();
		enabled = true;
		flushSync();

		expect(controller.seen).toEqual([]);
		stop();
	});

	it('keeps the dependency when the value is read into a local first', () => {
		let enabled = $state(false);
		let controller: ReturnType<typeof lateController> | null = null;

		const stop = $effect.root(() => {
			$effect(() => {
				const on = enabled;
				controller?.set(on);
			});
		});
		flushSync();

		controller = lateController();
		enabled = true;
		flushSync();
		enabled = false;
		flushSync();

		expect(controller.seen).toEqual([true, false]);
		stop();
	});

	it('holds for an options object built from several values', () => {
		let anchor = $state(0.4);
		let smooth = $state(true);
		let controller: ReturnType<typeof lateController> | null = null;

		const stop = $effect.root(() => {
			$effect(() => {
				const a = anchor;
				const s = smooth;
				controller?.set({ anchor: a, smooth: s });
			});
		});
		flushSync();

		controller = lateController();
		anchor = 0.6;
		flushSync();

		expect(controller.seen).toEqual([{ anchor: 0.6, smooth: true }]);
		stop();
	});
});

/**
 * The reported symptom, end to end: "it doesn't go into repeat mode, and when I
 * turn it off it's stuck — I have to reload the page." Mirrors the reader's
 * real ordering, where effects run on mount and `attachSync` builds the
 * controller a frame later.
 */
describe('the repeat toggle reaching a controller built after mount', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function index(): TimingIndex {
		const sentences = [
			{ id: 0, start: 0, end: 2 },
			{ id: 1, start: 2, end: 4 }
		];
		return {
			sentences,
			starts: Float64Array.from([0, 2]),
			ends: Float64Array.from([2, 4])
		};
	}

	function audioStub() {
		const l = new Map<string, Set<() => void>>();
		return {
			currentTime: 0,
			paused: false,
			pauseCalls: 0,
			pause() {
				this.pauseCalls++;
				this.paused = true;
			},
			addEventListener(t: string, f: () => void) {
				if (!l.has(t)) l.set(t, new Set());
				l.get(t)!.add(f);
			},
			removeEventListener(t: string, f: () => void) {
				l.get(t)?.delete(f);
			}
		};
	}

	it('turns on and off without a reload', () => {
		vi.useFakeTimers();
		const audio = audioStub();
		let repeatMode = $state(false);
		let controller: ReturnType<typeof createRepeatController> | null = null;

		const stop = $effect.root(() => {
			$effect(() => {
				const on = repeatMode;
				controller?.setEnabled(on);
			});
		});
		flushSync();

		// The frame after mount, as `attachSync` does. Read through a closure so
		// this deliberate one-shot read is not mistaken for a missed dependency.
		const initiallyOn = () => repeatMode;
		controller = createRepeatController(audio as never, index(), {
			enabled: initiallyOn(),
			getOffset: () => 0,
			onUnitEnd: () => {}
		});

		/** Plays from inside the first line to just past its end. */
		function playThroughLineEnd() {
			audio.paused = false;
			for (const t of [0.5, 1, 1.5, 2.01]) {
				audio.currentTime = t;
				vi.advanceTimersByTime(25);
			}
		}

		// Off: playing past a line end must not pause.
		playThroughLineEnd();
		expect(audio.pauseCalls).toBe(0);

		// On: it must take effect immediately, with no remount.
		repeatMode = true;
		flushSync();
		audio.currentTime = 0;
		playThroughLineEnd();
		expect(audio.pauseCalls).toBe(1);

		// Off again: and it must let go immediately too.
		repeatMode = false;
		flushSync();
		audio.currentTime = 0;
		playThroughLineEnd();
		expect(audio.pauseCalls).toBe(1);

		controller.destroy();
		stop();
	});
});
