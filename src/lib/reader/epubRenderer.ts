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
	/** Spine order of the chapter a sentence belongs to. */
	chapterOf(sentenceId: number): number | undefined;
	/** Spine order of the chapter currently filling the viewport. */
	viewChapter(): number | null;
	/** Scrolls the reading surface to the start of a chapter. */
	scrollToChapter(order: number): void;
	/**
	 * Stops the narration pinning a chapter mounted. Called when read-along is
	 * switched off, so windowing follows the reader alone.
	 */
	clearAudioAnchor(): void;
	/** Mounts every chapter. Used when the book is small enough not to window. */
	mountAll(): void;
	/**
	 * Drops the cached placeholder sizes. Call after anything that changes how
	 * the text lays out — writing mode, font size, line height, column width.
	 * The reserved extents were measured under the old layout and every
	 * estimate derived from them is wrong once it changes.
	 */
	invalidateLayout(): void;
	destroy(): void;
}

export interface EpubRenderOptions {
	/** Chapters kept mounted either side of an anchor. */
	window?: number;
	/**
	 * The scrolling ancestor of `container`. Without it the renderer cannot
	 * compensate for its own layout changes, and chapters mounting above the
	 * viewport shift the text under the reader's eyes.
	 */
	scroller?: HTMLElement | null;
	/** Fired when the chapter the reader is looking at changes. */
	onViewChapter?: (order: number) => void;
	/**
	 * Fired immediately before the renderer scrolls to correct its own reflow.
	 * Whatever else watches the scroller has to be told, or the correction
	 * reads as the reader having scrolled.
	 */
	onAdjustScroll?: () => void;
}

/**
 * Extent reserved for an unmounted chapter no estimate covers, in px. Nonzero
 * because a zero-height placeholder is unreachable: the scroller would have no
 * length there, so the chapter could never be scrolled to in order to mount.
 *
 * About one line, and deliberately not more. A front matter chapter is a single
 * line of text; reserving a screenful for it means that mounting it collapses
 * the page by the difference, and a run of twenty such chapters — a contents
 * page, a colophon, a half-title — collapses it by thousands of pixels. Every
 * one of those collapses is a scroll correction fighting the reader's own
 * scrolling.
 */
const MIN_PLACEHOLDER = 32;

/**
 * Characters of text to keep mounted around an anchor.
 *
 * Windowing by chapter count assumes chapters are all roughly a screenful,
 * which front matter is not: anchoring on a one-line contents entry with a
 * one-chapter window mounts three lines of text and unmounts the chapter
 * filling the rest of the screen, so most of the page goes blank. Counting
 * characters instead makes the guarantee the reader actually needs — enough
 * text on screen — and costs nothing extra where chapters really are large.
 */
const MOUNT_BUDGET_CHARS = 4000;

/**
 * Chapters either side of an anchor that the budget may reach for. Bounds the
 * work when a book is nothing but tiny chapters.
 */
const MAX_SPREAD = 12;

/**
 * Prose a chapter must carry before its measurement is allowed to calibrate
 * the estimate for other chapters.
 *
 * Front matter is what makes this necessary. A title page is a handful of
 * characters occupying a whole block of vertical space, so the pixels-per-
 * character it implies is an order of magnitude too high — measured against a
 * real book it turned 20 chapters into 800,000px of scrollbar. Below the
 * threshold a chapter is still measured for its own placeholder; it just does
 * not get a vote on everyone else's.
 */
const MIN_SAMPLE_CHARS = 1000;

/**
 * Renders an aligned EPUB into `container`, mounting only the chapters near
 * where the reader or the narration is.
 *
 * Windowing is not optional at this size: a full book carries far more text
 * than a subtitle file, and mounting every chapter reproduces the iOS stalls
 * that windowed cue rendering was introduced to fix.
 *
 * Two things make a windowed book behave like a whole one:
 *
 * - **Every chapter reserves space, mounted or not.** An unmounted chapter is
 *   otherwise zero-length, so the scroller is only as long as the mounted
 *   window and there is physically nowhere to scroll to — the reader is pinned
 *   to whatever the audio last lit. Measured chapters reserve their real
 *   extent; the rest are estimated from their character count against the
 *   px-per-character rate the measured ones give.
 * - **Two anchors, not one.** The narration pins one chapter and the viewport
 *   pins another, and the mounted set is the union. Reading ahead of (or
 *   behind) the audio therefore works, including across chapters, and stays
 *   working when the audio sits in a stretch the alignment could not match.
 */
export function renderEpub(
	index: AlignedIndex,
	chapters: EpubChapter[],
	container: HTMLElement,
	opts: EpubRenderOptions = {}
): EpubRenderHandle {
	const windowSize = opts.window ?? 1;
	const scroller = opts.scroller ?? null;
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
	/** Extent a chapter occupies along the block (scrolling) axis, once seen. */
	const measured = new Map<number, number>();
	/** Characters of prose per chapter, the basis for estimating the rest. */
	const chapterChars = new Map<number, number>();
	for (const [order, list] of byChapter) {
		let n = 0;
		for (const s of list) n += s.text.length;
		chapterChars.set(order, n);
	}
	/** Paragraphs per chapter — spacing and ragged last lines scale with these. */
	const chapterBlocks = new Map<number, number>();
	for (const b of index.blocks) {
		chapterBlocks.set(b.chapterOrder, (chapterBlocks.get(b.chapterOrder) ?? 0) + 1);
	}

	/** Chapter the narration is in, and the one the reader is looking at. */
	let audioAnchor: number | null = null;
	let viewAnchor: number | null = null;

	/**
	 * True under `writing-mode: vertical-rl`, where the block axis is
	 * horizontal. Read from the live container rather than passed in, so the
	 * renderer stays ignorant of the setting that drives it.
	 */
	function isVertical(): boolean {
		if (typeof getComputedStyle !== 'function') return false;
		return getComputedStyle(container).writingMode.startsWith('vertical');
	}

	/**
	 * Where a rect starts along the reading axis. Vertically that is its top;
	 * under vertical-rl reading arrives from the right and advances leftwards,
	 * so the near edge is the right one and the axis is measured negated —
	 * "further into the book" is a larger number in both modes.
	 */
	function nearEdge(rect: DOMRect, vertical: boolean): number {
		return vertical ? -rect.right : rect.top;
	}

	/** Block-axis extent of a rect. */
	function extent(rect: DOMRect, vertical: boolean): number {
		return vertical ? rect.width : rect.height;
	}

	function measure(order: number, host: HTMLElement, vertical: boolean): void {
		const size = extent(host.getBoundingClientRect(), vertical);
		if (size > 0) measured.set(order, size);
	}

	/**
	 * Pixels per character under the current layout, from the chapters actually
	 * measured so far, or null before there are any. One rate for the whole book
	 * is crude, but it only has to make the scrollbar roughly honest: any
	 * chapter the reader reaches is measured for real on the way past.
	 */
	function pxPerChar(): number | null {
		let px = 0;
		let chars = 0;
		for (const [order, size] of measured) {
			const c = chapterChars.get(order) ?? 0;
			if (c >= MIN_SAMPLE_CHARS && size > 0) {
				px += size;
				chars += c;
			}
		}
		return chars > 0 ? px / chars : null;
	}

	/**
	 * What a chapter would occupy under the current type, for before any chapter
	 * big enough to calibrate from has been mounted.
	 *
	 * Without it the whole book falls back to the placeholder floor, and a
	 * scrollbar claiming a 130,000px book is 1,500px long is not a scrollbar.
	 * Characters alone are not enough here: paragraph spacing and the half-empty
	 * last line of every paragraph together account for a third of a chapter's
	 * height, which is why the naive form came out at half the true size.
	 *
	 * One CJK character to the em is the assumption; Latin runs about half that,
	 * so this over-reserves there. That is the safe direction, and a real
	 * measurement replaces it the moment the reader arrives.
	 */
	function typeMetricEstimate(order: number): number | null {
		if (typeof getComputedStyle !== 'function') return null;
		const style = getComputedStyle(container);
		const fontSize = parseFloat(style.fontSize);
		if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
		const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;

		// The inline axis is the one lines run along, and it rotates with the
		// writing mode just as the block axis does.
		const rect = container.getBoundingClientRect();
		const inlineExtent = isVertical() ? rect.height : rect.width;
		if (inlineExtent <= 0) return null;

		const spacing = parseFloat(style.getPropertyValue('--theme-paragraph-spacing')) || 0.9;
		const charsPerLine = Math.max(10, inlineExtent / fontSize);
		const chars = chapterChars.get(order) ?? 0;
		const blocks = chapterBlocks.get(order) ?? 1;
		// Half a line per paragraph for the ragged last line.
		const lines = chars / charsPerLine + blocks * 0.5;
		return lines * lineHeight + blocks * spacing * fontSize;
	}

	function reservedFor(order: number, rate: number | null): number {
		const known = measured.get(order);
		if (known !== undefined && known > 0) return known;
		const chars = chapterChars.get(order) ?? 0;
		if (chars === 0) return MIN_PLACEHOLDER;
		// A rate from real chapters of this very book beats any model of it.
		if (rate !== null) return Math.max(MIN_PLACEHOLDER, chars * rate);
		return Math.max(MIN_PLACEHOLDER, typeMetricEstimate(order) ?? MIN_PLACEHOLDER);
	}

	/**
	 * Gives every unmounted chapter its extent back. Written as physical
	 * properties rather than `min-block-size` because the logical form is not
	 * universally reflected in CSSOM, and a silently ignored reservation shows
	 * up as the reader jumping while it scrolls.
	 */
	function applyPlaceholders(vertical: boolean): void {
		const rate = pxPerChar();
		for (const [order, host] of hosts) {
			if (mounted.has(order)) continue;
			const reserved = `${Math.round(reservedFor(order, rate))}px`;
			host.style.minHeight = vertical ? '' : reserved;
			host.style.minWidth = vertical ? reserved : '';
		}
	}

	/**
	 * Runs a batch of mounts and unmounts without moving the text the reader is
	 * looking at.
	 *
	 * Anything changing size *before* the viewport drags everything after it
	 * along, so the chapter the viewport starts in is measured either side of
	 * the change and the difference is scrolled back out. The reader's own
	 * `overflow-anchor: none` leaves this as the only correction, since the
	 * browsers that do scroll anchoring natively do not all agree and two
	 * corrections are worse than one.
	 */
	function withScrollAnchor(fn: (vertical: boolean) => void): void {
		const vertical = isVertical();
		if (!scroller) {
			fn(vertical);
			return;
		}

		const viewNear = nearEdge(scroller.getBoundingClientRect(), vertical);
		let anchorHost: HTMLElement | null = null;
		let before = 0;
		for (const order of orders) {
			const host = hosts.get(order);
			if (!host) continue;
			const near = nearEdge(host.getBoundingClientRect(), vertical);
			// Hosts are laid out in spine order, so the last one starting at or
			// before the viewport is the one the viewport starts inside.
			if (near > viewNear + 1) break;
			anchorHost = host;
			before = near;
		}

		fn(vertical);

		if (!anchorHost) return;
		const delta = nearEdge(anchorHost.getBoundingClientRect(), vertical) - before;
		if (Math.abs(delta) < 1) return;
		opts.onAdjustScroll?.();
		// `scrollBy` takes physical deltas, so the negated vertical axis is
		// negated back on the way out.
		scroller.scrollBy({
			top: vertical ? 0 : delta,
			left: vertical ? -delta : 0,
			behavior: 'auto'
		});
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

	function mount(order: number, vertical: boolean): RenderedChapter | null {
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
		// Measured on the way in as well as the way out: the first mounted
		// chapter is what calibrates every other chapter's estimate, and until
		// something has been measured the whole book is placeholder-sized.
		measure(order, host, vertical);
		return record;
	}

	function unmount(order: number, vertical: boolean): void {
		const record = mounted.get(order);
		if (!record) return;
		measure(order, record.el, vertical);
		record.el.replaceChildren();
		mounted.delete(order);
	}

	/**
	 * Mounts the window around every live anchor and unmounts the rest. Both
	 * anchors are honoured, so reading away from the narration does not fight
	 * the narration for what is on screen.
	 */
	/**
	 * Adds the chapters around `anchor` to `keep`: its immediate neighbours
	 * always, then outwards until enough text is mounted to fill the screen
	 * several times over.
	 */
	function windowAround(anchor: number, keep: Set<number>): void {
		let budget = MOUNT_BUDGET_CHARS;
		const take = (order: number) => {
			if (!chapterByOrder.has(order) || keep.has(order)) return;
			keep.add(order);
			budget -= chapterChars.get(order) ?? 0;
		};

		take(anchor);
		for (let d = 1; d <= MAX_SPREAD; d++) {
			if (d > windowSize && budget <= 0) break;
			take(anchor - d);
			take(anchor + d);
		}
	}

	function reconcile(): void {
		const keep = new Set<number>();
		for (const anchor of [audioAnchor, viewAnchor]) {
			if (anchor === null) continue;
			windowAround(anchor, keep);
		}
		if (keep.size === 0) return;

		const drop = [...mounted.keys()].filter((o) => !keep.has(o));
		const add = [...keep].filter((o) => !mounted.has(o)).sort((a, b) => a - b);
		if (drop.length === 0 && add.length === 0) return;

		withScrollAnchor((vertical) => {
			for (const order of drop) unmount(order, vertical);
			for (const order of add) mount(order, vertical);
			applyPlaceholders(vertical);
		});
	}

	function setViewAnchor(order: number): void {
		if (order === viewAnchor) return;
		viewAnchor = order;
		reconcile();
		opts.onViewChapter?.(order);
	}

	/**
	 * Tracks which chapters are on screen so windowing follows the reader.
	 * Absent in jsdom, where nothing is laid out and the audio anchor is the
	 * only one that can mean anything.
	 */
	const onScreen = new Set<number>();
	let viewObserver: IntersectionObserver | null = null;
	if (typeof IntersectionObserver === 'function') {
		viewObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const order = Number((entry.target as HTMLElement).dataset.chapter);
					if (Number.isNaN(order)) continue;
					if (entry.isIntersecting) onScreen.add(order);
					else onScreen.delete(order);
				}
				if (onScreen.size === 0) return;
				// The earliest chapter on screen is the one being read: reading
				// runs out of a chapter before the next one comes into view.
				setViewAnchor(Math.min(...onScreen));
			},
			{ root: scroller, threshold: 0 }
		);
		for (const host of hosts.values()) viewObserver.observe(host);
	}

	// Before anything is mounted the book still has to be scrollable end to
	// end, or there is nowhere to scroll to in order to mount it.
	applyPlaceholders(isVertical());

	return {
		ensureVisible(sentenceId: number) {
			const order = sentenceChapter.get(sentenceId);
			if (order === undefined) return;
			if (order === audioAnchor && mounted.has(order)) return;
			audioAnchor = order;
			reconcile();
		},
		chapterOf(sentenceId: number) {
			return sentenceChapter.get(sentenceId);
		},
		viewChapter() {
			return viewAnchor;
		},
		clearAudioAnchor() {
			if (audioAnchor === null) return;
			audioAnchor = null;
			reconcile();
		},
		scrollToChapter(order: number) {
			const host = hosts.get(order);
			if (!host) return;
			setViewAnchor(order);
			if (!scroller) return;
			const vertical = isVertical();
			const style = getComputedStyle(scroller);
			// The scroller's own padding clears the floating header, so landing
			// the chapter at the padding edge rather than the border edge keeps
			// its first line out from under the chrome.
			const pad = parseFloat(vertical ? style.paddingRight : style.paddingTop) || 0;
			const target = nearEdge(scroller.getBoundingClientRect(), vertical) + pad;
			const delta = nearEdge(host.getBoundingClientRect(), vertical) - target;
			scroller.scrollBy({
				top: vertical ? 0 : delta,
				left: vertical ? -delta : 0,
				behavior: 'auto'
			});
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
			const vertical = isVertical();
			for (const order of orders) mount(order, vertical);
		},
		invalidateLayout() {
			measured.clear();
			withScrollAnchor((vertical) => {
				// Re-measure what is on screen first: those measurements are what
				// every remaining estimate is calibrated from, and the old ones
				// were taken under a layout that no longer applies.
				for (const [order, record] of mounted) measure(order, record.el, vertical);
				applyPlaceholders(vertical);
			});
		},
		destroy() {
			viewObserver?.disconnect();
			const vertical = isVertical();
			for (const order of [...mounted.keys()]) unmount(order, vertical);
			container.replaceChildren();
		}
	};
}
