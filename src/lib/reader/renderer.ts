import type { Paragraph } from '$lib/types';

export function renderParagraphs(
	paragraphs: Paragraph[],
	container: HTMLElement
): Map<number, HTMLElement> {
	container.replaceChildren();

	const sentenceMap = new Map<number, HTMLElement>();

	for (const para of paragraphs) {
		const p = document.createElement('p');
		p.className = 'reader-paragraph';

		for (const sentence of para.sentences) {
			const span = document.createElement('span');
			span.textContent = sentence.text + ' ';
			span.dataset.sid = String(sentence.id);
			span.dataset.start = String(sentence.start);
			span.dataset.end = String(sentence.end);
			span.className = 'reader-sentence';

			p.appendChild(span);
			sentenceMap.set(sentence.id, span);
		}

		container.appendChild(p);
	}

	return sentenceMap;
}
