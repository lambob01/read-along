import type { AlignedIndex, EpubDoc, RawCue } from '$lib/types';
import { ABSClient } from '$lib/abs/client';
import { getItemSources, getFileBinary, getFileText, type ItemSources } from '$lib/abs/api';
import { parseCues } from '$lib/sync/parse';
import { parseEpub } from './parse';
import { alignEpubToCues } from '$lib/sync/align';
import { alignmentKey, loadAlignment, saveAlignment } from './cache';

export type TextSourceMode = 'epub' | 'subtitle' | 'none';

export interface TextSource {
	mode: TextSourceMode;
	/** Present when mode is 'epub'. */
	doc: EpubDoc | null;
	index: AlignedIndex | null;
	/** Present when mode is 'subtitle' — the legacy cue path. */
	cues: RawCue[] | null;
	/** True when the alignment came from cache rather than being recomputed. */
	fromCache: boolean;
	/** Non-fatal explanation when EPUB mode was attempted but not used. */
	notice: string | null;
}

/**
 * Coverage below this suggests the EPUB and the subtitle are not the same
 * edition. Falling back to the subtitle path yields a worse-structured but
 * correctly-timed read, which beats a book with mostly dead text.
 */
const MIN_USABLE_COVERAGE = 0.4;

/**
 * Resolves the text and timing sources for an item.
 *
 * EPUB supplies text and structure, the subtitle supplies timing; both are
 * required for aligned mode. When only a subtitle exists, the original
 * cue-derived pipeline is used unchanged.
 */
export async function loadTextSource(
	client: ABSClient,
	itemId: string,
	sources?: ItemSources,
	fetchFileText: (client: ABSClient, itemId: string, ino: string) => Promise<string> = getFileText
): Promise<TextSource> {
	const found = sources ?? (await getItemSources(client, itemId));

	if (!found.subIno) {
		return {
			mode: 'none',
			doc: null,
			index: null,
			cues: null,
			fromCache: false,
			notice: null
		};
	}

	let raw: string;
	try {
		raw = await fetchFileText(client, itemId, found.subIno);
	} catch (err) {
		return {
			mode: 'none',
			doc: null,
			index: null,
			cues: null,
			fromCache: false,
			notice: `Subtitle could not be downloaded (${
				err instanceof Error ? err.message : 'unknown error'
			}); no transcript.`
		};
	}
	const cues = parseCues(raw);

	if (!found.epubIno) {
		return {
			mode: 'subtitle',
			doc: null,
			index: null,
			cues,
			fromCache: false,
			notice: null
		};
	}

	// The EPUB is needed even on a cache hit: cached records store node paths,
	// not DOM, so chapter bodies must be re-parsed to render.
	let doc: EpubDoc;
	try {
		const buffer = await getFileBinary(client, itemId, found.epubIno);
		doc = parseEpub(buffer);
	} catch (err) {
		return {
			mode: 'subtitle',
			doc: null,
			index: null,
			cues,
			fromCache: false,
			notice: `EPUB could not be read (${
				err instanceof Error ? err.message : 'unknown error'
			}); using subtitle text.`
		};
	}

	const key = alignmentKey(itemId, found.epubSize, found.subSize);
	const cached = await loadAlignment(key);
	if (cached && cached.stats.coverage >= MIN_USABLE_COVERAGE) {
		return {
			mode: 'epub',
			doc,
			index: cached,
			cues,
			fromCache: true,
			notice: null
		};
	}

	if (cues.length === 0) {
		return {
			mode: 'subtitle',
			doc: null,
			index: null,
			cues,
			fromCache: false,
			notice: 'Subtitle file contained no cues.'
		};
	}

	const index = alignEpubToCues(doc, cues);

	if (index.stats.coverage < MIN_USABLE_COVERAGE) {
		const pct = Math.round(index.stats.coverage * 100);
		return {
			mode: 'subtitle',
			doc: null,
			index: null,
			cues,
			fromCache: false,
			notice: `EPUB matched only ${pct}% of the audio; it may be a different edition. Using subtitle text.`
		};
	}

	void saveAlignment(key, index);

	return { mode: 'epub', doc, index, cues, fromCache: false, notice: null };
}
