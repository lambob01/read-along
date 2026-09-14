/**
 * Normalization for EPUB↔subtitle alignment.
 *
 * Both sides originate from the same text (SubPlz aligns Whisper output against
 * the EPUB and lets the book text win), but they differ in incidental ways:
 * width variants, whitespace, and punctuation that subtitle segmentation drops.
 * Normalizing both to a comparable codepoint stream makes a sequential walk
 * viable without word boundaries — necessary for Japanese.
 */

/** Punctuation and spacing treated as skippable when comparing. */
const SKIPPABLE = new Set([
	'、',
	'。',
	'，',
	'．',
	'・',
	'「',
	'」',
	'『',
	'』',
	'（',
	'）',
	'〈',
	'〉',
	'《',
	'》',
	'”',
	'“',
	'‘',
	'’',
	'"',
	"'",
	'(',
	')',
	'[',
	']',
	'{',
	'}',
	// NB: the chōonpu 'ー' (U+30FC) is deliberately absent — it is a phonetic
	// part of the word, not punctuation. The dashes below are U+2014/2015/2013
	// and ASCII hyphen, which subtitle segmentation does introduce and drop.
	'—',
	'―',
	'–',
	'-',
	'…',
	'‥',
	'･',
	',',
	'.',
	'!',
	'?',
	'！',
	'？',
	'：',
	':',
	'；',
	';',
	'~',
	'〜',
	'※',
	'\u3000'
]);

export function isSkippable(ch: string): boolean {
	if (!ch) return true;
	if (/\s/.test(ch)) return true;
	return SKIPPABLE.has(ch);
}

/**
 * A normalized character stream built from source text.
 */
export interface NormalizedStream {
	/** Normalized, skippable-free characters. */
	chars: string[];
}

/**
 * Matches a combining mark, plus the halfwidth katakana voiced/semi-voiced
 * sound marks. The latter are category Lm rather than Mn, so `\p{M}` alone
 * misses them, yet they must fold into the preceding base (ｶ + ﾞ → ガ).
 */
const COMBINING_RE = /[\p{M}\uFF9E\uFF9F]/u;

/**
 * Builds a normalized stream from source text.
 *
 * Applies NFKC to fold full-width/half-width variants, lowercases Latin, and
 * drops skippable punctuation and whitespace. Iterates by codepoint so
 * surrogate pairs are never split, and folds each base character together with
 * any trailing combining marks so composition can occur across that boundary.
 */
export function normalizeStream(source: string): NormalizedStream {
	const chars: string[] = [];

	// Group each base codepoint with its trailing combining marks so
	// composition (ｶ + ﾞ → ガ) can occur across that boundary in the NFKC pass.
	const clusters: string[] = [];
	for (const cp of source) {
		const prev = clusters[clusters.length - 1];
		if (prev !== undefined && COMBINING_RE.test(cp)) {
			clusters[clusters.length - 1] = prev + cp;
		} else {
			clusters.push(cp);
		}
	}

	for (const cluster of clusters) {
		const folded = cluster.normalize('NFKC').toLowerCase();
		for (const ch of folded) {
			if (!isSkippable(ch)) {
				chars.push(ch);
			}
		}
	}

	return { chars };
}

/** Normalizes text to a bare comparable string, discarding offsets. */
export function normalizeText(source: string): string {
	return normalizeStream(source).chars.join('');
}
