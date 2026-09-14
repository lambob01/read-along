/**
 * Binary searches shared by the sync controllers.
 *
 * The ticker's covering lookup, line navigation and repeat's end scan all ask
 * the same question of the same sorted `Float64Array`s — which boundary lies
 * before/after this time. Each used to carry its own copy of the loop, which is
 * exactly the kind of duplication that drifts: a fix applied to one copy leaves
 * the others behind. These names follow the interval they bound rather than the
 * C++ namesakes: `lowerBound` is the entry below the value, `upperBound` the
 * one above it.
 */

/**
 * Index of the last entry at or before `value`, or -1 when every entry is
 * greater (including an empty array). Answers "which line has started by
 * `time`", which is also the index of the only line that can cover it.
 */
export function lowerBound(sorted: Float64Array, value: number): number {
	let lo = 0;
	let hi = sorted.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] <= value) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/**
 * Index of the first entry strictly after `value`, or `sorted.length` when
 * every entry is at or before it. Used to find the next line to end without
 * mistaking an entry that ended exactly at the previous sample for one that
 * finished inside the interval just played.
 */
export function upperBound(sorted: Float64Array, value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] > value) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}
