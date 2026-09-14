/** Elements whose text is furigana/annotation, not prose. */
const ANNOTATION_TAGS = new Set(['RT', 'RP']);

/** Block-level elements, each a separate block in reading order. */
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
 * Elements that carry no reading content. Alignment strips these from the
 * chapter bodies before computing offsets, so rendering must drop the same
 * set — otherwise the clone it wraps has text the offsets never saw.
 *
 * Tag names are uppercase; compare `tagName.toUpperCase()` against them.
 */
export const NON_PROSE_TAGS = new Set([
	'SCRIPT',
	'STYLE',
	'LINK',
	'META',
	'SVG',
	'VIDEO',
	'AUDIO',
	'IFRAME',
	'OBJECT',
	'EMBED',
	'FORM'
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

/** Whether the element has a text child that is not pure whitespace. */
function hasDirectText(el: Element): boolean {
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE && (child as Text).data.trim().length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Returns the block-level elements of a chapter body in reading order, along
 * with their child-index path from the body.
 *
 * A BLOCK_TAG is a block on its own. Any other element that directly contains
 * text is treated as one too, so `<div>前置き <em>強調</em> 後ろ</div>` is a
 * single block rather than just the `<em>`; a container of pure markup and
 * whitespace is transparent and its children are walked. The outermost
 * element wins: a block is never emitted twice, and the nested blocks of a
 * mixed container are not split out of it.
 */
export function collectBlocks(body: Element): { el: Element; path: number[] }[] {
	const out: { el: Element; path: number[] }[] = [];

	const emit = (node: Element, path: number[]) => {
		if (blockPlainText(node).trim().length > 0) {
			out.push({ el: node, path });
		}
	};

	const walk = (node: Element, path: number[]) => {
		const tag = node.tagName.toUpperCase();

		if (BLOCK_TAGS.has(tag)) {
			emit(node, path);
			return;
		}

		// Direct text makes this node a block in its own right: walking on
		// would drop that text, and emitting both it and its block children
		// would duplicate the children's prose across two blocks.
		if (hasDirectText(node)) {
			emit(node, path);
			return;
		}

		const children = Array.from(node.children);
		for (let i = 0; i < children.length; i++) {
			walk(children[i], [...path, i]);
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
