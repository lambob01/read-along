import type { AlignedIndex, AlignedSentence, EpubChapter } from '$lib/types';
import { collectProseTextNodes, resolvePath } from '$lib/epub/text';

/** Attributes stripped from cloned EPUB nodes. */
const DROP_ATTRS = ['style', 'class', 'id', 'width', 'height', 'align'];

/**
 * Clones an EPUB element for rendering, discarding publication styling so the
 * reader's own theme stays authoritative, while keeping semantic markup
 * (emphasis, ruby, headings) that the subtitle path used to throw away.
 */
function cloneForRender(el: Element): HTMLElement {
	const clone = el.cloneNode(true) as HTMLElement;
	const all: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
	for (const node of all) {
		for (const attr of DROP_ATTRS) node.removeAttribute(attr);
		// Images inside an EPUB reference zip-internal paths that will not
		// resolve; drop them rather than render broken placeholders.
		if (node.tagName === 'IMG' || node.tagName === 'SVG') node.remove();
	}
	return clone;
}

/**
 * Wraps the character range [from, to) of `block`'s prose text in <span>
 * elements carrying the sentence id.
 *
 * A range may straddle inline elements, so this can emit several spans for one
 * sentence; all are returned. Traversal mirrors `collectProseTextNodes`, so
 * offsets stay consistent with the ones alignment produced.
 */
function wrapRange(
	block: HTMLElement,
	from: number,
	to: number,
	sentence: AlignedSentence
): HTMLElement[] {
	const spans: HTMLElement[] = [];
	let cursor = 0;

	// Snapshot first: wrapping mutates the tree as we go.
	for (const node of collectProseTextNodes(block)) {
		const len = node.data.length;
		const nodeStart = cursor;
		const nodeEnd = cursor + len;
		cursor = nodeEnd;

		if (nodeEnd <= from || nodeStart >= to) continue;

		const localStart = Math.max(0, from - nodeStart);
		const localEnd = Math.min(len, to - nodeStart);
		if (localEnd <= localStart) continue;

		const span = document.createElement('span');
		span.className = 'reader-sentence';
		span.dataset.sid = String(sentence.id);
		if (sentence.timed) {
			span.dataset.start = String(sentence.start);
			span.dataset.end = String(sentence.end);
		} else {
			span.dataset.untimed = 'true';
		}

		const range = document.createRange();
		range.setStart(node, localStart);
		range.setEnd(node, localEnd);
		range.surroundContents(span);
		spans.push(span);
	}

	return spans;
}

/** Maps a sentence id to every span that renders part of it. */
export type SentenceSpanMap = Map<number, HTMLElement[]>;

export interface RenderedChapter {
	order: number;
	el: HTMLElement;
	spans: SentenceSpanMap;
}

export interface EpubRenderHandle {
	/** Ensures the chapter containing `sentenceId` is mounted, plus neighbours. */
	ensureVisible(sentenceId: number): void;
	/** All spans for a sentence, empty when its chapter is not mounted. */
	spansFor(sentenceId: number): HTMLElement[];
	/** First span of a sentence, for autoscroll. */
	elementFor(sentenceId: number): HTMLElement | undefined;
	/** Mounts every chapter. Used when the book is small enough not to window. */
	mountAll(): void;
	/**
	 * Drops the cached placeholder sizes. Call after the writing mode changes:
	 * the reserved extents were measured along the old block axis and mean
	 * nothing once that axis has rotated.
	 */
	invalidateLayout(): void;
	destroy(): void;
}

/**
 * Renders an aligned EPUB into `container`, mounting only the active chapter
 * and its immediate neighbours.
 *
 * Windowing is not optional at this size: a full book carries far more text
 * than a subtitle file, and mounting every chapter reproduces the iOS stalls
 * that windowed cue rendering was introduced to fix. Each chapter gets a
 * placeholder element that retains its measured height, so scroll position does
 * not jump when a chapter unmounts.
 */
export function renderEpub(
	index: AlignedIndex,
	chapters: EpubChapter[],
	container: HTMLElement,
	opts: { window?: number } = {}
): EpubRenderHandle {
	const windowSize = opts.window ?? 1;
	container.replaceChildren();

	const byChapter = new Map<number, AlignedSentence[]>();
	for (const s of index.sentences) {
		const list = byChapter.get(s.chapterOrder);
		if (list) list.push(s);
		else byChapter.set(s.chapterOrder, [s]);
	}

	const blocksById = new Map(index.blocks.map((b) => [b.id, b]));
	const chapterByOrder = new Map(chapters.map((c) => [c.order, c]));
	const sentenceChapter = new Map<number, number>();
	for (const s of index.sentences) sentenceChapter.set(s.id, s.chapterOrder);

	const hosts = new Map<number, HTMLElement>();
	const mounted = new Map<number, RenderedChapter>();
	/** Extent an unmounted chapter reserves along the block (scrolling) axis. */
	const blockSizes = new Map<number, number>();

	/**
	 * True under `writing-mode: vertical-rl`, where the block axis is
	 * horizontal. Read from the live container rather than passed in, so the
	 * renderer stays ignorant of the setting that drives it.
	 */
	function isVertical(): boolean {
		if (typeof getComputedStyle !== 'function') return false;
		return getComputedStyle(container).writingMode.startsWith('vertical');
	}

	// One host per chapter, in spine order, so scroll geometry is stable.
	const orders = [...chapterByOrder.keys()].sort((a, b) => a - b);
	for (const order of orders) {
		const host = document.createElement('section');
		host.className = 'reader-chapter';
		host.dataset.chapter = String(order);
		container.appendChild(host);
		hosts.set(order, host);
	}

	function mount(order: number): RenderedChapter | null {
		const existing = mounted.get(order);
		if (existing) return existing;

		const chapter = chapterByOrder.get(order);
		const host = hosts.get(order);
		if (!chapter || !host) return null;

		const spans: SentenceSpanMap = new Map();
		const sentences = byChapter.get(order) ?? [];
		const frag = document.createDocumentFragment();

		// Group this chapter's sentences by the block they came from.
		const perBlock = new Map<number, AlignedSentence[]>();
		for (const s of sentences) {
			const list = perBlock.get(s.blockId);
			if (list) list.push(s);
			else perBlock.set(s.blockId, [s]);
		}

		for (const [blockId, blockSentences] of perBlock) {
			const meta = blocksById.get(blockId);
			if (!meta) continue;
			const source = resolvePath(chapter.body, meta.nodePath);
			if (!source) continue;

			const rendered = cloneForRender(source);
			rendered.classList.add('reader-block');

			// Wrap from the end backwards so earlier offsets stay valid as the
			// tree is mutated.
			const ordered = [...blockSentences].sort((a, b) => b.blockOffsetStart - a.blockOffsetStart);
			for (const s of ordered) {
				const wrapped = wrapRange(rendered, s.blockOffsetStart, s.blockOffsetEnd, s);
				if (wrapped.length > 0) spans.set(s.id, wrapped);
			}

			frag.appendChild(rendered);
		}

		host.replaceChildren(frag);
		host.style.minHeight = '';
		host.style.minWidth = '';

		const record: RenderedChapter = { order, el: host, spans };
		mounted.set(order, record);
		return record;
	}

	function unmount(order: number): void {
		const record = mounted.get(order);
		if (!record) return;
		// Preserve the extent occupied along the scrolling axis so unmounting
		// does not shift scroll position. That axis is vertical normally and
		// horizontal under vertical-rl, so the reservation moves between
		// min-height and min-width. Written as physical properties rather than
		// `min-block-size` because the logical form is not universally
		// reflected in CSSOM, and a silently ignored reservation would show up
		// as the reader jumping while it scrolls.
		const rect = record.el.getBoundingClientRect();
		const vertical = isVertical();
		const size = vertical ? rect.width : rect.height;
		if (size > 0) blockSizes.set(order, size);
		record.el.replaceChildren();
		const reserved = `${blockSizes.get(order) ?? 0}px`;
		record.el.style.minHeight = vertical ? '' : reserved;
		record.el.style.minWidth = vertical ? reserved : '';
		mounted.delete(order);
	}

	function ensureChapter(order: number): void {
		const keep = new Set<number>();
		for (let o = order - windowSize; o <= order + windowSize; o++) {
			if (chapterByOrder.has(o)) keep.add(o);
		}

		for (const active of [...mounted.keys()]) {
			if (!keep.has(active)) unmount(active);
		}
		for (const target of keep) mount(target);
	}

	return {
		ensureVisible(sentenceId: number) {
			const order = sentenceChapter.get(sentenceId);
			if (order === undefined) return;
			if (!mounted.has(order)) ensureChapter(order);
		},
		spansFor(sentenceId: number) {
			const order = sentenceChapter.get(sentenceId);
			if (order === undefined) return [];
			return mounted.get(order)?.spans.get(sentenceId) ?? [];
		},
		elementFor(sentenceId: number) {
			return this.spansFor(sentenceId)[0];
		},
		mountAll() {
			for (const order of orders) mount(order);
		},
		invalidateLayout() {
			blockSizes.clear();
			// Collapse the placeholders too: a stale extent on the new axis is
			// worse than none, and they are re-measured on the next unmount.
			for (const [order, host] of hosts) {
				if (mounted.has(order)) continue;
				host.style.minHeight = '';
				host.style.minWidth = '';
			}
		},
		destroy() {
			for (const order of [...mounted.keys()]) unmount(order);
			container.replaceChildren();
		}
	};
}
