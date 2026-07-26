const HTML_TAG_RE = /<[^>]*>/g;
const BRACKET_BLOCK_RE = /\{[^}]*\}/g;
const WORD_TIMING_RE = /<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g;

const NON_SPEECH_PATTERNS = [
	/^\[music\]$/i,
	/^\[applause\]$/i,
	/^\[laughter\]$/i,
	/^\[cheers?\]$/i,
	/^\[crowd\s+noise\]$/i,
	/^♪+$/,
	/^\(\.\.\.\)$/,
	/^\[inaudible\]$/i,
	/^\[silence\]$/i,
	/^\[sighs?\]$/i
];

export function isNonSpeech(text: string): boolean {
	const clean = text.trim();
	if (!clean) return true;
	return NON_SPEECH_PATTERNS.some((p) => p.test(clean));
}

export function sanitizeText(text: string): string {
	let result = text;
	result = result.replace(WORD_TIMING_RE, '');
	result = result.replace(HTML_TAG_RE, '');
	result = result.replace(BRACKET_BLOCK_RE, '');
	result = result.replace(/\s+/g, ' ');
	return result.trim();
}
