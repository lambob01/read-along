import type { TimingIndex } from '$lib/types';

/**
 * Grouping lines into repeat units.
 *
 * A line of dialogue routinely runs across several subtitle cues, and stopping
 * inside one is useless for shadowing — you want the whole utterance. Japanese
 * marks that span explicitly, so a run from 「 to its matching 」 is treated as
 * a single unit. `『』` nests inside `「」` and counts towards the same depth.
 *
 * The result is itself a `TimingIndex`, so the repeat controller and the
 * prev/next helpers work over units without knowing they are groups.
 */

const OPENERS = '「『';
const CLOSERS = '」』';

/** Net quote depth a piece of text opens, never dropping below zero. */
function depthDelta(text: string, depth: number): number {
	let d = depth;
	for (const ch of text) {
		if (OPENERS.includes(ch)) d++;
		// A stray closer (a transcript that lost its opener) must not push the
		// depth negative, or the next real 「 would start one level short.
		else if (CLOSERS.includes(ch)) d = Math.max(0, d - 1);
	}
	return d;
}

export interface RepeatUnitOptions {
	/** When false the index is returned untouched — every line is its own unit. */
	group?: boolean;
	/**
	 * Runaway guard. A transcript that opens 「 and never closes it would
	 * otherwise swallow the rest of the book into one unit. The longest run in
	 * a real aligned book measured 21 lines, so this only ever fires on damage.
	 */
	maxLines?: number;
}

export function buildRepeatUnits(index: TimingIndex, opts: RepeatUnitOptions = {}): TimingIndex {
	const { group = true, maxLines = 60 } = opts;
	if (!group) return index;

	const src = index.sentences;
	const n = src.length;
	const units: { id: number; start: number; end: number; text?: string }[] = [];

	let i = 0;
	while (i < n) {
		let j = i;
		let depth = depthDelta(src[i].text ?? '', 0);
		while (depth > 0 && j + 1 < n && j - i + 1 < maxLines) {
			j++;
			depth = depthDelta(src[j].text ?? '', depth);
		}
		units.push({
			id: src[i].id,
			start: index.starts[i],
			end: index.ends[j],
			// Joined so a unit still carries readable text; nothing reads it today.
			text: src
				.slice(i, j + 1)
				.map((s) => s.text ?? '')
				.join('')
		});
		i = j + 1;
	}

	return {
		sentences: units,
		starts: Float64Array.from(units.map((u) => u.start)),
		ends: Float64Array.from(units.map((u) => u.end))
	};
}
