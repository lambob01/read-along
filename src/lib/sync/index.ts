import type { Paragraph, CueIndex } from '$lib/types';

export function buildIndex(paragraphs: Paragraph[]): CueIndex {
	const sentences = paragraphs.flatMap((p) => p.sentences);
	sentences.sort((a, b) => a.start - b.start);

	return {
		paragraphs,
		sentences,
		starts: new Float64Array(sentences.map((s) => s.start)),
		ends: new Float64Array(sentences.map((s) => s.end))
	};
}
