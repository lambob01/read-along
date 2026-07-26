/** Elements whose text is furigana/annotation, not prose. */
const ANNOTATION_TAGS = new Set(['RT', 'RP']);

/** Inline elements that do not introduce a block boundary. */
const BLOCK_TAGS = new Set([
	'P',
	'H1',
	'H2',
	'H3',
	'H4',
	'H5',
	'H6',
	'LI',
	'BLOCKQUOTE',
	'DD',
	'DT',
	'FIGCAPTION',
	'PRE'
]);

/**
 * Collects the prose text nodes of an element in document order, skipping
 * furigana. Ruby base text is kept; `<rt>` readings are excluded because
 * SubPlz-generated subtitles contain no furigana, so including it would
 * guarantee alignment mismatch. The same traversal is used when wrapping
 * sentences for rendering, keeping offsets consistent.
 */
export function collectProseTextNodes(root: Node): Text[] {
	const out: Text[] = [];
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			out.push(node as Text);
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		if (ANNOTATION_TAGS.has((node as Element).tagName.toUpperCase())) return;
		for (const child of Array.from(node.childNodes)) walk(child);
	};
	walk(root);
	return out;
}

/** Concatenated prose text of an element, in the same coordinate space that
 * `collectProseTextNodes` yields. */
export function blockPlainText(root: Node): string {
	return collectProseTextNodes(root)
		.map((n) => n.data)
		.join('');
}

/**
 * Returns the block-level elements of a chapter body in reading order, along
 * with their child-index path from the body. Nested blocks are not emitted
 * twice: the outermost matching element wins.
 */
export function collectBlocks(body: Element): { el: Element; path: number[] }[] {
	const out: { el: Element; path: number[] }[] = [];

	const walk = (node: Element, path: number[]) => {
		const children = Array.from(node.children);
		const tag = node.tagName.toUpperCase();

		if (BLOCK_TAGS.has(tag)) {
			if (blockPlainText(node).trim().length > 0) {
				out.push({ el: node, path });
			}
			return;
		}

		for (let i = 0; i < children.length; i++) {
			walk(children[i], [...path, i]);
		}

		// A container holding bare text (no block children) is itself a block.
		if (children.length === 0 && blockPlainText(node).trim().length > 0) {
			out.push({ el: node, path });
		}
	};

	const topChildren = Array.from(body.children);
	for (let i = 0; i < topChildren.length; i++) {
		walk(topChildren[i], [i]);
	}

	return out;
}

/** Re-resolves an element from a chapter body given a child-index path. */
export function resolvePath(body: Element, path: number[]): Element | null {
	let current: Element | null = body;
	for (const idx of path) {
		if (!current) return null;
		current = current.children[idx] ?? null;
	}
	return current;
}
