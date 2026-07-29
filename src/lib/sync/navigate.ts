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
