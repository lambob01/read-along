import type { TimingIndex } from '$lib/types';
import { cueIndexAt } from './navigate';

/**
 * Repeat mode: pause at the end of every unit, so it can be re-heard or
 * repeated before moving on. A unit is one line, or a whole 「…」 run — see
 * `buildRepeatUnits`.
 *
 * The controller derives the armed unit from the audio element's clock on each
 * tick rather than following the ticker's active sentence. That is what makes a
 * seek need no special handling — the next tick simply re-arms from wherever
 * playback now is — and it means the pause lands on the unit's own end even
 * when the highlight has already moved on to the next one.
 *
 * **The controller must outlive individual store updates.** An earlier version
 * was created inside a `$effect` that read `$reader.cueIndex`; because the sync
 * ticker writes `activeSentenceId` to that same store on every line change, the
 * controller was torn down and rebuilt at each boundary, losing what it had
 * armed. Whether the rebuild beat the 25ms tick decided whether the pause
 * happened at all, so playback ran on for one, two or three lines at random.
 * Hence `setEnabled`/`setIndex` instead of a fresh controller per change.
 *
 * Like `createSyncController` it attaches to the singleton audio element, so
 * `destroy()` is mandatory on unmount.
 */

export interface ArmedUnit {
	id: number;
	start: number;
	end: number;
}

export interface RepeatController {
	setEnabled(on: boolean): void;
	/** Swapping the index disarms; passing the same reference is a no-op. */
	setIndex(index: TimingIndex | null): void;
	destroy(): void;
	/** The unit currently being waited on. Exposed for tests. */
	armed(): ArmedUnit | null;
}

export interface RepeatOptions {
	/** Read fresh each tick: the offset can be nudged while playing. */
	getOffset: () => number;
	/** Called after the pause, with the unit that just finished. */
	onUnitEnd: (unit: ArmedUnit) => void;
	enabled?: boolean;
	tickMs?: number;
	/**
	 * How far past a unit's end still counts as having played through it.
	 * A forward seek landing inside this window reads as a natural finish,
	 * which costs one spurious pause; a smaller number would instead miss real
	 * finishes whenever timers are throttled and the clock jumps.
	 */
	slop?: number;
}

export function createRepeatController(
	audio: HTMLAudioElement,
	initialIndex: TimingIndex | null,
	opts: RepeatOptions
): RepeatController {
	const tickMs = opts.tickMs ?? 25;
	const slop = opts.slop ?? 1;
	/**
	 * The largest jump in playback position that still counts as having got
	 * there by playing rather than seeking. One tick at the maximum 3x rate is
	 * 3·tickMs, and the tick after a pause can be two of those out, so this
	 * needs to clear 6·tickMs with room for jitter. Seeks are caught by the
	 * `seeked` listener rather than by this bound, which only has to be tight
	 * enough that a seek racing a tick cannot look like normal playback.
	 */
	const maxStep = (tickMs / 1000) * 8;

	let index = initialIndex;
	let enabled = opts.enabled ?? true;
	let armed: ArmedUnit | null = null;
	/** Position at the previous tick, to tell playing apart from seeking. */
	let prevT: number | null = null;
	/** End of the unit last reported, so a pause is never announced twice. */
	let lastReportedEnd: number | null = null;

	function report(unit: ArmedUnit) {
		armed = null;
		lastReportedEnd = unit.end;
		// Resume scanning from this unit's end, not from the playhead. One tick
		// can carry the playhead over two ends when a very short unit follows a
		// long one; rewinding the scan means the second is found on the next
		// tick instead of being lost.
		prevT = unit.end;
		audio.pause();
		opts.onUnitEnd(unit);
	}

	/** Smallest k with `ends[k] > x`, or -1 past the last unit. */
	function firstEndAfter(ends: Float64Array, x: number): number {
		let lo = 0;
		let hi = ends.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (ends[mid] > x) {
				found = mid;
				hi = mid - 1;
			} else {
				lo = mid + 1;
			}
		}
		return found;
	}

	function unitAt(idx: TimingIndex, i: number): ArmedUnit {
		return { id: idx.sentences[i].id, start: idx.starts[i], end: idx.ends[i] };
	}

	function tick() {
		if (!enabled || !index || audio.paused) return;
		const t = audio.currentTime + opts.getOffset();
		// `prevT` is deliberately not cleared on pause: resuming has to be able
		// to see that the position advanced by one tick.
		const played = prevT !== null && t > prevT && t - prevT <= maxStep;
		const from = prevT;
		prevT = t;

		if (played && from !== null) {
			// Did a unit finish inside the interval just played? Asking the
			// question this way — rather than "is the playhead past what we
			// armed" — is what catches a unit shorter than one tick. Looking up
			// the unit under the playhead would miss it entirely, because by
			// then the *next* unit has already begun.
			const k = firstEndAfter(index.ends, from);
			if (k >= 0 && index.ends[k] <= t && index.ends[k] !== lastReportedEnd) {
				report(unitAt(index, k));
				return;
			}
		} else if (armed && t >= armed.end && t < armed.end + slop) {
			// Fallback for when the interval cannot be trusted — throttled
			// timers, or the first tick after a resume. The armed unit is all
			// there is to go on, so `slop` absorbs however far the clock jumped.
			report(armed);
			return;
		}

		// Keep the fallback's arm current: whichever unit covers the playhead.
		// Gaps arm nothing, so a pause always lands on a unit's own end rather
		// than in the silence after it.
		const i = cueIndexAt(index, t);
		armed = i >= 0 && t < index.ends[i] ? unitAt(index, i) : null;
	}

	// A seek disarms immediately rather than waiting for the next tick, so
	// jumping forward cannot be mistaken for having played to the end.
	const disarm = () => {
		armed = null;
		prevT = null;
		lastReportedEnd = null;
	};
	audio.addEventListener('seeked', disarm);
	const timer = setInterval(tick, tickMs);

	return {
		setEnabled(on: boolean) {
			if (enabled === on) return;
			enabled = on;
			disarm();
		},
		setIndex(next: TimingIndex | null) {
			if (index === next) return;
			index = next;
			disarm();
		},
		destroy() {
			clearInterval(timer);
			audio.removeEventListener('seeked', disarm);
			armed = null;
		},
		armed() {
			return armed;
		}
	};
}
