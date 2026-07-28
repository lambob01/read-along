export interface RawCue {
	index: number;
	start: number;
	end: number;
	text: string;
}

export interface Sentence {
	id: number;
	start: number;
	end: number;
	text: string;
	cueIds: number[];
}

export interface Paragraph {
	id: number;
	sentences: Sentence[];
}

/**
 * The minimum timing contract the sync ticker needs: monotonic, non-overlapping
 * ranges plus an id per range. Both the subtitle-derived `CueIndex` and the
 * EPUB-derived `AlignedIndex` satisfy it, so the ticker works with either.
 */
export interface TimingIndex {
	/**
	 * `text` is not used by the ticker — timing is the whole contract — but both
	 * real indexes carry it, and Anki mining needs the line it is clipping.
	 */
	sentences: { id: number; start: number; end: number; text?: string }[];
	starts: Float64Array;
	ends: Float64Array;
}

export interface CueIndex extends TimingIndex {
	paragraphs: Paragraph[];
	sentences: Sentence[];
}

export interface ABSLibrary {
	id: string;
	name: string;
}

export interface ABSItem {
	id: string;
	media: {
		metadata: { title: string; authorName: string };
		coverPath: string;
		audioFiles: { ino: string; metadata: { filename: string } }[];
		chapters: { id: number; start: number; end: number; title: string }[];
	};
}

export interface ABSSession {
	id: string;
	audioTracks: { relPath: string; contentUrl: string }[];
}

export interface MergeOptions {
	gapThreshold?: number;
	showNonSpeech?: boolean;
}

// ---------------------------------------------------------------------------
// EPUB text source
// ---------------------------------------------------------------------------

/** One spine item (chapter) of an EPUB, parsed to a DOM body element. */
export interface EpubChapter {
	id: string;
	/** Spine order, 0-based. */
	order: number;
	href: string;
	title: string | null;
	/** Parsed <body> of the chapter's XHTML. Not serializable. */
	body: HTMLElement;
}

export interface EpubDoc {
	title: string | null;
	author: string | null;
	language: string | null;
	chapters: EpubChapter[];
}

/**
 * A block-level renderable unit taken from the EPUB (paragraph, heading, etc).
 * `nodePath` locates the source element within its chapter body so the unit can
 * be re-resolved after a cache round-trip.
 */
export interface EpubBlock {
	id: number;
	chapterOrder: number;
	/** Child-index path from the chapter body down to this element. */
	nodePath: number[];
	tag: string;
	/** Normalized-stream offset range covered by this block. */
	streamStart: number;
	streamEnd: number;
}

/**
 * A sentence sourced from the EPUB. Unlike `Sentence`, timing is derived from
 * alignment against the subtitle rather than being intrinsic, so it may be
 * absent — front/back matter and headings usually have no audio.
 */
export interface AlignedSentence {
	id: number;
	/** Interpolated from overlapping cues. Both 0 when `timed` is false. */
	start: number;
	end: number;
	text: string;
	/** False when no cue could be matched; such units are never highlighted. */
	timed: boolean;
	blockId: number;
	chapterOrder: number;
	/** Character offsets within the concatenated normalized EPUB stream. */
	streamStart: number;
	streamEnd: number;
	/** Character offsets within the block's plain text, for DOM range wrapping. */
	blockOffsetStart: number;
	blockOffsetEnd: number;
}

export interface AlignmentStats {
	/** Fraction of EPUB sentences that received timing, 0..1. */
	coverage: number;
	totalSentences: number;
	timedSentences: number;
	cueCount: number;
	matchedCues: number;
}

/**
 * Result of aligning an EPUB against a subtitle file. `starts`/`ends` contain
 * only timed sentences, sorted and non-overlapping, so the existing ticker's
 * binary search works unchanged.
 */
export interface AlignedIndex {
	blocks: EpubBlock[];
	/** All sentences in reading order, timed and untimed. */
	sentences: AlignedSentence[];
	/** Timed subset, ordered by `start`. Parallel to `starts`/`ends`. */
	timed: AlignedSentence[];
	starts: Float64Array;
	ends: Float64Array;
	stats: AlignmentStats;
}
