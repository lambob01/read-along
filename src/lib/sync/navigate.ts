import type { TimingIndex } from '$lib/types';

/**
 * Stepping between lines rather than by a fixed number of seconds.
 *
 * All times here are in the *index's* domain — the highlight timeline — not the
 * audio element's. The reader converts by subtracting the book's sync offset,
 * so a line that has been nudged still starts playing at its first word.
 */

/**
 * Index of the line covering `time`, or of the last one that started before it
 * when `time` falls in a gap. -1 when nothing has started yet.
 *
 * `starts` is sorted and non-overlapping (the ticker's binary search depends on
 * the same property), so a plain upper-bound search is enough.
 */
export function cueIndexAt(index: TimingIndex, time: number): number {
	const { starts } = index;
	let lo = 0;
	let hi = starts.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] <= time) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/**
 * Index of the line nearest `time`, whether or not one covers it.
 *
 * `cueIndexAt` answers "which line is playing", and correctly answers "none"
 * in a gap. This answers "where in the book is the audio", which still has an
 * answer when the transcript does not cover it — the stretches alignment could
 * not match, where the highlight goes out but the narration carries on. Without
 * it a jump into an unmatched passage leaves the text wherever it last was,
 * which is what strands the reader a chapter behind the narration.
 *
 * In a gap it picks whichever side the audio is nearer, so a long unmatched
 * passage hands over to the following line halfway through rather than sitting
 * on the last line before it for minutes.
 */
export function nearestCueIndex(index: TimingIndex, time: number): number | null {
	const { starts, ends } = index;
	if (starts.length === 0) return null;
	const i = cueIndexAt(index, time);
	if (i < 0) return 0;
	const next = i + 1;
	if (next < starts.length && time > ends[i]) {
		if (starts[next] - time < time - ends[i]) return next;
	}
	return i;
}

/** Start of the first line beginning after `time`, or null at the end of the book. */
export function nextCueStart(index: TimingIndex, time: number): number | null {
	const i = cueIndexAt(index, time) + 1;
	return i < index.starts.length ? index.starts[i] : null;
}

/**
 * Start of the line to jump back to.
 *
 * Once `grace` seconds into a line, back goes to that line's own start — the
 * same rule every music player uses, and the one that makes "play that again"
 * a single keypress. Before that it goes to the previous line.
 */
export function prevCueStart(index: TimingIndex, time: number, grace = 0.6): number | null {
	const { starts } = index;
	if (starts.length === 0) return null;
	const i = cueIndexAt(index, time);
	// Before the first line, or in the lead-in gap: there is nothing behind.
	if (i < 0) return null;
	if (time - starts[i] > grace) return starts[i];
	return i > 0 ? starts[i - 1] : null;
}
