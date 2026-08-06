import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRepeatController } from '$lib/sync/repeat';
import type { TimingIndex } from '$lib/types';

/**
 * Three lines. 0 and 1 are contiguous — the normal shape of SRT cues, and the
 * case where the highlight has already moved on by the time a line ends. 2 sits
 * after a 1s gap, so tests can park playback in silence.
 */
function makeIndex(): TimingIndex {
	const sentences = [
		{ id: 10, start: 0, end: 2 },
		{ id: 11, start: 2, end: 4 },
		{ id: 12, start: 5, end: 7 }
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
		pauseCalls: 0,
		pause() {
			this.pauseCalls++;
			this.paused = true;
		},
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

/** Moves playback to `time` and lets the watcher observe it. */
function playTo(audio: FakeAudio, time: number) {
	audio.currentTime = time;
	vi.advanceTimersByTime(25);
}

/** A seek, including the element's own `seeked` event. */
function seekTo(audio: FakeAudio, time: number) {
	audio.currentTime = time;
	audio.emit('seeked');
}

let audio: FakeAudio;
let ended: number[];
let offset: number;

function attach() {
	return createRepeatController(audio as unknown as HTMLAudioElement, makeIndex(), {
		getOffset: () => offset,
		onUnitEnd: (u) => ended.push(u.id)
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	audio = makeAudio();
	audio.paused = false;
	ended = [];
	offset = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createRepeatController', () => {
	it('pauses at the end of the line being played', () => {
		const c = attach();
		playTo(audio, 0.5);
		expect(c.armed()?.id ?? null).toBe(10);

		playTo(audio, 1.9);
		expect(audio.pauseCalls).toBe(0);

		playTo(audio, 2.01);
		expect(audio.pauseCalls).toBe(1);
		expect(ended).toEqual([10]);
		c.destroy();
	});

	it('reports the line that finished, not the one now under the playhead', () => {
		// Lines 10 and 11 are contiguous, so at t=2 the highlight is already on
		// 11. Repeating 11 would replay something the user has not heard.
		const c = attach();
		playTo(audio, 1);
		playTo(audio, 2.02);
		expect(ended).toEqual([10]);
		c.destroy();
	});

	it('arms the next line once playback resumes', () => {
		const c = attach();
		playTo(audio, 1);
		playTo(audio, 2.02);
		expect(c.armed()?.id ?? null).toBeNull();

		audio.paused = false;
		playTo(audio, 2.5);
		expect(c.armed()?.id ?? null).toBe(11);

		playTo(audio, 4.01);
		expect(audio.pauseCalls).toBe(2);
		expect(ended).toEqual([10, 11]);
		c.destroy();
	});

	it('does not pause in the silence between lines', () => {
		const c = attach();
		playTo(audio, 4.5);
		expect(c.armed()?.id ?? null).toBeNull();
		playTo(audio, 4.9);
		expect(audio.pauseCalls).toBe(0);

		playTo(audio, 5.5);
		expect(c.armed()?.id ?? null).toBe(12);
		c.destroy();
	});

	it('does not pause when a seek jumps past a line end', () => {
		const c = attach();
		playTo(audio, 1);
		expect(c.armed()?.id ?? null).toBe(10);

		// Without the disarm this would read as "line 10 finished".
		seekTo(audio, 2.2);
		vi.advanceTimersByTime(25);
		expect(audio.pauseCalls).toBe(0);
		expect(c.armed()?.id ?? null).toBe(11);
		c.destroy();
	});

	it('re-arms after seeking backwards into an earlier line', () => {
		const c = attach();
		playTo(audio, 3.5);
		expect(c.armed()?.id ?? null).toBe(11);

		seekTo(audio, 0.5);
		vi.advanceTimersByTime(25);
		expect(c.armed()?.id ?? null).toBe(10);

		playTo(audio, 2.01);
		expect(ended).toEqual([10]);
		c.destroy();
	});

	it('works in the highlight timeline, not the audio one', () => {
		// A book nudged +0.5s is highlighted half a second ahead of the audio, so
		// the line ends when the audio clock reads 1.5, not 2.
		offset = 0.5;
		const c = attach();
		playTo(audio, 0.2);
		expect(c.armed()?.id ?? null).toBe(10);
		playTo(audio, 1.4);
		expect(audio.pauseCalls).toBe(0);
		playTo(audio, 1.55);
		expect(ended).toEqual([10]);
		c.destroy();
	});

	it('ignores a paused element', () => {
		const c = attach();
		audio.paused = true;
		playTo(audio, 2.5);
		expect(c.armed()?.id ?? null).toBeNull();
		expect(audio.pauseCalls).toBe(0);
		c.destroy();
	});

	it('stops ticking and detaches on destroy', () => {
		const c = attach();
		playTo(audio, 1);
		c.destroy();
		expect(audio.listenerCount('seeked')).toBe(0);

		playTo(audio, 2.01);
		expect(audio.pauseCalls).toBe(0);
	});

	it('does nothing while disabled, and re-arms when switched on', () => {
		const c = attach();
		c.setEnabled(false);
		playTo(audio, 1);
		playTo(audio, 2.01);
		expect(audio.pauseCalls).toBe(0);

		c.setEnabled(true);
		playTo(audio, 2.5);
		expect(c.armed()?.id ?? null).toBe(11);
		c.destroy();
	});

	// The regression this whole shape exists for: the controller used to be
	// rebuilt whenever the reader store changed, which the sync ticker does on
	// every line boundary. Re-arming from scratch mid-line dropped the pause and
	// playback ran on for one, two or three more lines at random.
	it('keeps what it armed across unrelated churn', () => {
		const c = attach();
		playTo(audio, 1);
		expect(c.armed()?.id ?? null).toBe(10);

		// Whatever else the app does, short of changing the index, must not
		// disturb the arm.
		c.setEnabled(true);
		c.setIndex(null);
		c.setIndex(null);
		expect(audio.pauseCalls).toBe(0);
		c.destroy();
	});

	it('re-arming an identical index reference is a no-op', () => {
		const index = makeIndex();
		const c = createRepeatController(audio as unknown as HTMLAudioElement, index, {
			getOffset: () => offset,
			onUnitEnd: (u) => ended.push(u.id)
		});
		playTo(audio, 1);
		expect(c.armed()?.id ?? null).toBe(10);
		c.setIndex(index);
		expect(c.armed()?.id ?? null).toBe(10);

		playTo(audio, 2.01);
		expect(ended).toEqual([10]);
		c.destroy();
	});

	// A whole-book playthrough, which is what shook out the two real defects:
	// the controller being rebuilt mid-line, and units shorter than one tick
	// being stepped clean over. Both showed as "sometimes runs on for two or
	// three lines". Shapes and durations mirror an aligned Japanese audiobook.
	describe('playing straight through', () => {
		/** ~400 units: mostly seconds long, contiguous or gapped, a few sub-tick. */
		function longIndex(): TimingIndex {
			const sentences: { id: number; start: number; end: number }[] = [];
			const starts: number[] = [];
			const ends: number[] = [];
			let t = 0;
			for (let i = 0; i < 400; i++) {
				// Deterministic but varied: durations 0.02s–9s, gaps 0s–1.3s.
				const dur = i % 37 === 0 ? 0.02 + (i % 3) * 0.01 : 0.4 + ((i * 7) % 90) / 10;
				const gap = i % 5 === 0 ? 0 : ((i * 13) % 14) / 10;
				const start = t + gap;
				const end = start + dur;
				sentences.push({ id: i, start, end });
				starts.push(start);
				ends.push(end);
				t = end;
			}
			return { sentences, starts: Float64Array.from(starts), ends: Float64Array.from(ends) };
		}

		/** Drives playback at `rate`, resuming after each pause as a user would. */
		function playThrough(index: TimingIndex, rate: number) {
			const stops: number[] = [];
			const c = createRepeatController(audio as unknown as HTMLAudioElement, index, {
				getOffset: () => 0,
				onUnitEnd: (u) => stops.push(u.end)
			});
			const total = index.ends[index.ends.length - 1] + 1;
			for (let t = 0; t < total; t += 0.025 * rate) {
				audio.currentTime = t;
				vi.advanceTimersByTime(25);
				if (audio.paused) audio.paused = false;
			}
			c.destroy();
			return stops;
		}

		for (const rate of [0.5, 1, 1.5, 2, 3]) {
			it(`stops exactly once per unit at ${rate}x`, () => {
				const index = longIndex();
				const stops = playThrough(index, rate);
				expect(stops.length).toBe(index.ends.length);
				for (let i = 0; i < index.ends.length; i++) {
					expect(stops[i]).toBeCloseTo(index.ends[i], 6);
				}
			});
		}
	});

	it('starts disabled when asked to', () => {
		const c = createRepeatController(audio as unknown as HTMLAudioElement, makeIndex(), {
			enabled: false,
			getOffset: () => offset,
			onUnitEnd: (u) => ended.push(u.id)
		});
		playTo(audio, 1);
		playTo(audio, 2.01);
		expect(audio.pauseCalls).toBe(0);
		c.destroy();
	});

	it('does not re-fire a unit whose end exactly equals the last reported end', () => {
		// Only reachable with damaged input (two units sharing an end time),
		// but the suppression is load-bearing: a re-fire would double-pause.
		const sentences = [
			{ id: 10, start: 0, end: 2 },
			{ id: 11, start: 1, end: 2 }
		];
		const index: TimingIndex = {
			sentences,
			starts: Float64Array.from(sentences.map((s) => s.start)),
			ends: Float64Array.from(sentences.map((s) => s.end))
		};
		const c = createRepeatController(audio as unknown as HTMLAudioElement, index, {
			getOffset: () => offset,
			onUnitEnd: (u) => ended.push(u.id)
		});

		audio.paused = false;
		playTo(audio, 1.9);
		playTo(audio, 2.01);
		expect(ended).toEqual([10]);
		expect(audio.pauseCalls).toBe(1);

		// Cross the shared boundary again — a rewind whose `seeked` never
		// fires, so the scan re-finds the same end. Kept to sub-tick steps so
		// the crossing is a scan, not a jump: only the scan's dedupe stands
		// between one pause and two.
		audio.paused = false;
		playTo(audio, 0.5);
		playTo(audio, 0.7);
		playTo(audio, 0.9);
		playTo(audio, 1.1);
		playTo(audio, 1.3);
		playTo(audio, 1.5);
		playTo(audio, 1.7);
		playTo(audio, 1.9);
		playTo(audio, 2.01);
		expect(ended).toEqual([10]);
		expect(audio.pauseCalls).toBe(1);
		c.destroy();
	});
});
