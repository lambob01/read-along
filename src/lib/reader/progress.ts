/**
 * Which readout the bottom progress bar shows. Tapping the bar cycles through
 * them; the book-pct mode is what the bar has always shown.
 */
export type ProgressMode = 'chapter-pct' | 'book-pct' | 'chapter-left';

export const PROGRESS_MODES: ProgressMode[] = ['chapter-pct', 'book-pct', 'chapter-left'];

/**
 * The next mode after `mode` in the cycle, wrapping around. Only modes in
 * `enabled` are visited — the settings let the user pick which readouts the
 * tap cycles between. A mode that was just switched off stays off: when the
 * current one is not enabled, the cycle resumes from the first enabled one.
 */
export function nextProgressMode(mode: ProgressMode, enabled: ProgressMode[]): ProgressMode {
	if (enabled.length === 0) return mode;
	const i = enabled.indexOf(mode);
	if (i >= 0) return enabled[(i + 1) % enabled.length];
	return enabled[0];
}

export interface ChapterBounds {
	/** Index into `chapters`, or -1 when nothing has started yet. */
	index: number;
	start: number;
	end: number;
}

/**
 * The chapter covering `time`. Returns null when there is no chapter metadata.
 *
 * A chapter's `end` is not always trustworthy — ABS omits it for the last
 * chapter, and a stray zero would make the span degenerate — so any end that
 * does not extend past the start falls back to the media duration.
 */
export function chapterBounds(
	chapters: { start: number; end: number }[],
	time: number,
	duration: number
): ChapterBounds | null {
	if (chapters.length === 0) return null;
	const index = chapters.findLastIndex((c) => time >= c.start);
	// Front matter lands before the first chapter's start; it still belongs to
	// chapter one, whose end is known, so only the end fallback below varies.
	const chapter = index >= 0 ? chapters[index] : chapters[0];
	const start = chapter.start;
	const end = chapter.end > start ? chapter.end : duration > start ? duration : start;
	return { index, start, end };
}

export interface ChapterProgress {
	index: number;
	/** How far through the chapter, 0..100. */
	percent: number;
	/** Seconds until the chapter ends, never negative. */
	remaining: number;
}

export function chapterProgress(
	chapters: { start: number; end: number }[],
	time: number,
	duration: number
): ChapterProgress | null {
	const bounds = chapterBounds(chapters, time, duration);
	if (bounds === null) return null;
	const span = bounds.end - bounds.start;
	const elapsed = time - bounds.start;
	const percent = span > 0 ? Math.min(1, Math.max(0, elapsed / span)) * 100 : 0;
	return {
		index: bounds.index,
		percent,
		remaining: Math.max(0, bounds.end - time)
	};
}

/** `12m left`, `1h 5m left`, or empty when nothing is left. */
export function formatRemaining(s: number): string {
	if (!Number.isFinite(s) || s <= 0) return '';
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	if (h > 0) return `${h}h ${m}m left`;
	return `${m}m left`;
}
