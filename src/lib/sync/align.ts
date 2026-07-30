import type {
	RawCue,
	EpubDoc,
	EpubBlock,
	AlignedSentence,
	AlignedIndex,
	AlignmentStats
} from '$lib/types';
import { collectBlocks, blockPlainText } from '$lib/epub/text';
import { normalizeStream, normalizeText } from './normalize';

/** Sentence-final punctuation for Japanese and Latin scripts. */
const SENTENCE_END_RE = /[。．！？!?…]+[」』”）)]*|[.!?]+["')\]]*(?=\s|$)/g;

interface SourceSentence {
	blockId: number;
	chapterOrder: number;
	text: string;
	blockOffsetStart: number;
	blockOffsetEnd: number;
}

/**
 * Splits a block's plain text into sentences, returning offsets within the
 * block. Unlike the subtitle path this uses real punctuation rather than audio
 * gaps, because the EPUB carries genuine structure.
 */
export function splitSentences(text: string): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	let cursor = 0;

	SENTENCE_END_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SENTENCE_END_RE.exec(text)) !== null) {
		const end = match.index + match[0].length;
		if (text.slice(cursor, end).trim().length > 0) {
			spans.push({ start: cursor, end });
		}
		cursor = end;
	}

	if (cursor < text.length && text.slice(cursor).trim().length > 0) {
		spans.push({ start: cursor, end: text.length });
	}

	return spans.length > 0 ? spans : [{ start: 0, end: text.length }];
}

/** Flattens an EPUB into blocks and sentences in reading order. */
function flattenEpub(doc: EpubDoc): {
	blocks: EpubBlock[];
	sentences: SourceSentence[];
} {
	const blocks: EpubBlock[] = [];
	const sentences: SourceSentence[] = [];
	let blockId = 0;

	for (const chapter of doc.chapters) {
		for (const { el, path } of collectBlocks(chapter.body)) {
			const text = blockPlainText(el);
			const id = blockId++;

			blocks.push({
				id,
				chapterOrder: chapter.order,
				nodePath: path,
				tag: el.tagName.toLowerCase(),
				streamStart: 0,
				streamEnd: 0
			});

			for (const span of splitSentences(text)) {
				sentences.push({
					blockId: id,
					chapterOrder: chapter.order,
					text: text.slice(span.start, span.end),
					blockOffsetStart: span.start,
					blockOffsetEnd: span.end
				});
			}
		}
	}

	return { blocks, sentences };
}

/** Per-cue span within the normalized subtitle stream. */
interface CueSpan {
	cue: RawCue;
	start: number;
	end: number;
}

/**
 * Builds the normalized subtitle stream by concatenating cue text, recording
 * which normalized range each cue occupies so a matched EPUB offset can be
 * resolved back to a timestamp.
 */
function buildCueStream(cues: RawCue[]): { chars: string[]; spans: CueSpan[] } {
	const chars: string[] = [];
	const spans: CueSpan[] = [];

	for (const cue of cues) {
		const normalized = normalizeText(cue.text);
		if (normalized.length === 0) continue;
		const start = chars.length;
		for (const ch of normalized) chars.push(ch);
		spans.push({ cue, start, end: chars.length });
	}

	return { chars, spans };
}

/**
 * Window, in characters, searched ahead when re-anchoring *before* a sentence
 * has matched anything. It has to cover whatever the subtitle carries that the
 * book does not — a theme song, a chapter announcement, a Whisper hallucination.
 */
const REANCHOR_WINDOW = 4000;

/**
 * The window once a sentence has begun matching, which is far tighter.
 *
 * A sentence's cues are contiguous, so the rest of it is nearby by definition.
 * Searching thousands of characters ahead for the tail of a sentence finds
 * common phrasing somewhere else in the book instead, and the damage is not
 * confined to that sentence: the match runs to a timestamp minutes away, and
 * `finalize` then demotes every sentence that legitimately falls inside the
 * range it has claimed. One bad jump takes a whole chapter with it.
 */
function tailWindow(sentenceLength: number): number {
	return Math.max(200, sentenceLength * 4);
}

/** Preferred length of the exact-match run used to re-anchor. */
const ANCHOR_LEN = 12;
/** Shortest run accepted when fewer than ANCHOR_LEN characters remain. */
const MIN_ANCHOR_LEN = 4;

/**
 * Cue characters a match may skip before it has to be corroborated.
 *
 * Skipping some is normal and the wide window exists for it: the recording
 * carries a theme song, a chapter announcement, a Whisper hallucination that
 * the book does not. Skipping a lot on the strength of one sentence is not
 * evidence of anything, because the cursor never rewinds and a wrong jump
 * strands every sentence whose audio it has leapt over.
 */
const LONG_JUMP = 400;
/** How soon after a match its successor must appear for the jump to stand. */
const CONTINUITY_WINDOW = 400;
/** Successors consulted before giving up on corroboration. */
const CONTINUITY_LOOKAHEAD = 3;

/**
 * Finds where `needle` resumes in `hay` at or after `from`, by locating an
 * exact run of characters. Returns -1 when no anchor is found in the window.
 * This is the recovery path for local divergence (Whisper insertions, dropped
 * ruby, omitted front matter).
 *
 * The run length adapts to the remaining input: short sentences would otherwise
 * never re-anchor. MIN_ANCHOR_LEN floors it, since very short runs match by
 * chance in Japanese and would produce spurious jumps.
 */
function findAnchor(
	hay: string[],
	from: number,
	needle: string[],
	needleFrom: number,
	window: number
): number {
	const remaining = needle.length - needleFrom;
	if (remaining < MIN_ANCHOR_LEN) return -1;
	const len = Math.min(ANCHOR_LEN, remaining);
	const limit = Math.min(hay.length, from + window);

	for (let i = from; i + len <= limit; i++) {
		let k = 0;
		// Element-wise, not against a joined string: an astral codepoint is one
		// element here but two UTF-16 units in a string, so indexing a joined
		// anchor desynchronises the comparison from the first rare kanji on.
		while (k < len && hay[i + k] === needle[needleFrom + k]) k++;
		if (k === len) return i;
	}
	return -1;
}

/**
 * Whether the sentences after `nextIndex` continue from `from`, which is what
 * makes a long jump believable.
 *
 * A table of contents is the case this exists for. Its entries are the book's
 * chapter titles, the narrator reads those titles aloud, so each entry matches
 * — perfectly, and minutes or hours ahead of where the reading actually is.
 * Nothing about the match itself gives it away; only what follows does. Real
 * text continues into the next sentence, a contents entry does not.
 *
 * Sentences too short to anchor on (a line of ellipses, an interjection) prove
 * nothing either way and are stepped over rather than counted as failures.
 */
function isCorroborated(
	cueChars: string[],
	from: number,
	sources: SourceSentence[],
	nextIndex: number
): boolean {
	let consulted = 0;
	for (let j = nextIndex; j < sources.length && consulted < CONTINUITY_LOOKAHEAD; j++) {
		const next = normalizeStream(sources[j].text).chars;
		if (next.length < MIN_ANCHOR_LEN) continue;
		consulted++;
		if (findAnchor(cueChars, from, next, 0, CONTINUITY_WINDOW) !== -1) return true;
	}
	// Nothing left to ask: the end of the book cannot corroborate itself.
	return consulted === 0;
}

/** Maps a normalized subtitle offset to a time by interpolating within its cue. */
function timeAt(spans: CueSpan[], offset: number, edge: 'start' | 'end'): number | null {
	// spans are sorted and contiguous; binary search for the covering span.
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const span = spans[mid];
		if (offset < span.start) hi = mid - 1;
		else if (offset >= span.end) lo = mid + 1;
		else {
			const { cue } = span;
			const width = span.end - span.start;
			// For an end edge, advance past the matched character so a
			// single-character match still yields a non-zero duration.
			const pos = edge === 'end' ? offset - span.start + 1 : offset - span.start;
			const frac = width > 0 ? Math.min(pos / width, 1) : 0;
			return cue.start + (cue.end - cue.start) * frac;
		}
	}
	// Past the final cue.
	if (spans.length > 0 && offset >= spans[spans.length - 1].end) {
		return spans[spans.length - 1].cue.end;
	}
	return null;
}

export interface AlignOptions {
	/** Minimum matched-character fraction for a sentence to be considered timed. */
	minSentenceMatch?: number;
}

/**
 * Aligns an EPUB against subtitle cues, producing timed sentences.
 *
 * Strategy: build normalized character streams for both sides and walk them
 * with two pointers. Because the subtitle text was itself derived from this
 * EPUB, the streams agree for long runs; on divergence we re-anchor by exact
 * substring search within a bounded window. Each EPUB sentence then inherits
 * timing from the subtitle offsets its characters matched.
 *
 * Sentences with no match (front/back matter, headings, theme songs) are
 * emitted with `timed: false` and excluded from the timing arrays, so they can
 * never be highlighted and cannot break the ticker's monotonic binary search.
 */
export function alignEpubToCues(
	doc: EpubDoc,
	cues: RawCue[],
	opts: AlignOptions = {}
): AlignedIndex {
	const { minSentenceMatch = 0.5 } = opts;
	const { blocks, sentences: sourceSentences } = flattenEpub(doc);
	const { chars: cueChars, spans } = buildCueStream(cues);

	// Normalized stream per sentence, plus a global EPUB stream offset.
	const sentences: AlignedSentence[] = [];
	let streamCursor = 0;
	let cueCursor = 0;
	const matchedCueIdx = new Set<number>();

	for (let i = 0; i < sourceSentences.length; i++) {
		const src = sourceSentences[i];
		const norm = normalizeStream(src.text);
		const streamStart = streamCursor;
		streamCursor += norm.chars.length;

		let matched = 0;
		let firstCueOffset = -1;
		let lastCueOffset = -1;
		let local = 0;
		// Where this sentence started, so a sentence that fails can be made to
		// cost nothing. See the restore below.
		const cursorBefore = cueCursor;

		while (local < norm.chars.length) {
			if (cueCursor < cueChars.length && cueChars[cueCursor] === norm.chars[local]) {
				if (firstCueOffset === -1) firstCueOffset = cueCursor;
				lastCueOffset = cueCursor;
				matched++;
				cueCursor++;
				local++;
				continue;
			}

			const window = matched === 0 ? REANCHOR_WINDOW : tailWindow(norm.chars.length);
			const anchor = findAnchor(cueChars, cueCursor, norm.chars, local, window);
			if (anchor === -1) break;
			cueCursor = anchor;
		}

		const ratio = norm.chars.length > 0 ? matched / norm.chars.length : 0;
		let timed = ratio >= minSentenceMatch && firstCueOffset !== -1;

		// A match that had to leap a long way is only believed if the text after
		// it carries on from where it landed.
		if (timed && firstCueOffset - cursorBefore > LONG_JUMP) {
			timed = isCorroborated(cueChars, lastCueOffset + 1, sourceSentences, i + 1);
		}

		// The cursor must reflect what was *matched*, never where the search
		// gave up. A failed anchor search leaves it wherever it stopped looking,
		// and because it never rewinds, everything the skipped cues belonged to
		// is stranded — a run of unsynced text whose words are plainly there in
		// the subtitle. A sentence that matched nothing usable therefore costs
		// nothing; one that matched resumes immediately after its last character.
		cueCursor = timed ? lastCueOffset + 1 : cursorBefore;

		let start = 0;
		let end = 0;
		if (timed) {
			const s = timeAt(spans, firstCueOffset, 'start');
			const e = timeAt(spans, lastCueOffset, 'end');
			if (s === null || e === null) {
				sentences.push(makeSentence(i, src, streamStart, streamCursor, 0, 0, false));
				continue;
			}
			start = s;
			end = e;
			for (let k = 0; k < spans.length; k++) {
				if (spans[k].end > firstCueOffset && spans[k].start <= lastCueOffset) {
					matchedCueIdx.add(k);
				}
			}
		}

		sentences.push(makeSentence(i, src, streamStart, streamCursor, start, end, timed));
	}

	return finalize(blocks, sentences, cues.length, matchedCueIdx.size);
}

function makeSentence(
	id: number,
	src: SourceSentence,
	streamStart: number,
	streamEnd: number,
	start: number,
	end: number,
	timed: boolean
): AlignedSentence {
	return {
		id,
		start,
		end,
		text: src.text.trim(),
		timed,
		blockId: src.blockId,
		chapterOrder: src.chapterOrder,
		streamStart,
		streamEnd,
		blockOffsetStart: src.blockOffsetStart,
		blockOffsetEnd: src.blockOffsetEnd
	};
}

/**
 * Builds the timing arrays, enforcing the invariants `ticker.ts` relies on:
 * `starts` must be sorted ascending and ranges must not overlap, otherwise its
 * binary search can return the wrong sentence or none at all.
 *
 * `merge.ts` guaranteed this implicitly because cues arrive ordered. Alignment
 * offers no such guarantee, so non-monotonic or zero-width entries are demoted
 * to untimed rather than silently corrupting the index.
 */
function finalize(
	blocks: EpubBlock[],
	sentences: AlignedSentence[],
	cueCount: number,
	matchedCues: number
): AlignedIndex {
	const candidates = sentences
		.filter((s) => s.timed)
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const timed: AlignedSentence[] = [];
	let prevEnd = -Infinity;

	for (const s of candidates) {
		if (s.end <= s.start) {
			s.timed = false;
			continue;
		}
		if (s.start < prevEnd) {
			// Overlaps the previous sentence: clamp forward if that leaves a
			// usable range, otherwise demote.
			if (s.end - prevEnd < 0.05) {
				s.timed = false;
				continue;
			}
			s.start = prevEnd;
		}
		timed.push(s);
		prevEnd = s.end;
	}

	const starts = new Float64Array(timed.length);
	const ends = new Float64Array(timed.length);
	for (let i = 0; i < timed.length; i++) {
		starts[i] = timed[i].start;
		ends[i] = timed[i].end;
	}

	// Record each block's normalized stream extent for chapter windowing.
	const byBlock = new Map<number, { min: number; max: number }>();
	for (const s of sentences) {
		const cur = byBlock.get(s.blockId);
		if (!cur) byBlock.set(s.blockId, { min: s.streamStart, max: s.streamEnd });
		else {
			cur.min = Math.min(cur.min, s.streamStart);
			cur.max = Math.max(cur.max, s.streamEnd);
		}
	}
	for (const block of blocks) {
		const extent = byBlock.get(block.id);
		if (extent) {
			block.streamStart = extent.min;
			block.streamEnd = extent.max;
		}
	}

	const stats: AlignmentStats = {
		totalSentences: sentences.length,
		timedSentences: timed.length,
		coverage: sentences.length > 0 ? timed.length / sentences.length : 0,
		cueCount,
		matchedCues
	};

	return { blocks, sentences, timed, starts, ends, stats };
}
