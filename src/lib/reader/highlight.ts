export interface HighlightHandle {
	activate(el: HTMLElement): void;
	deactivate(el: HTMLElement): void;
	/**
	 * Highlights a sentence rendered as several elements. EPUB sentences can
	 * straddle inline markup (<em>, <ruby>), so one sentence may occupy more
	 * than one span.
	 */
	activateMany(els: HTMLElement[]): void;
	reset(): void;
}

export const ACTIVE_CLASS = 'hl-active';

function createCSSHighlight(): HighlightHandle {
	return {
		activate(el: HTMLElement) {
			this.activateMany([el]);
		},
		activateMany(els: HTMLElement[]) {
			if (els.length === 0) {
				this.reset();
				return;
			}
			const ranges = els.map((el) => {
				const range = new Range();
				range.selectNodeContents(el);
				return range;
			});
			// The Custom Highlight API accepts multiple ranges per highlight.
			// Setting replaces the previous entry, so no separate delete is needed.
			CSS.highlights.set('active-sentence', new Highlight(...ranges));
		},
		deactivate() {
			this.reset();
		},
		reset() {
			CSS.highlights.delete('active-sentence');
		}
	};
}

/**
 * Toggles a class on the sentence's spans instead of using the Highlight API.
 *
 * `reset` sweeps the DOM rather than trusting the previously returned
 * references: chapter windowing can unmount and remount a chapter between two
 * activations, which would strand the class on elements this handle no longer
 * has a reference to.
 */
function createClassHighlight(getRoot: () => ParentNode): HighlightHandle {
	let currentEls: HTMLElement[] = [];

	function clearAll() {
		for (const el of currentEls) el.classList.remove(ACTIVE_CLASS);
		currentEls = [];
		for (const el of getRoot().querySelectorAll(`.${ACTIVE_CLASS}`)) {
			el.classList.remove(ACTIVE_CLASS);
		}
	}

	return {
		activate(el: HTMLElement) {
			this.activateMany([el]);
		},
		activateMany(els: HTMLElement[]) {
			clearAll();
			for (const el of els) el.classList.add(ACTIVE_CLASS);
			currentEls = [...els];
		},
		deactivate(el: HTMLElement) {
			el.classList.remove(ACTIVE_CLASS);
			currentEls = currentEls.filter((e) => e !== el);
		},
		reset: clearAll
	};
}

/**
 * WebKit does not reliably invalidate the region a custom highlight previously
 * painted, so clearing or replacing the active range can leave the old text
 * visibly lit while the new range paints as well. This covers every browser on
 * iOS, not just Safari, since they all run on WebKit.
 */
function isWebKit(): boolean {
	if (typeof navigator === 'undefined') return false;
	return navigator.vendor === 'Apple Computer, Inc.';
}

export interface HighlighterOptions {
	/** Scope for the class sweep. Defaults to the whole document. */
	getRoot?: () => ParentNode;
	/** Overrides engine detection. Exposed for tests. */
	preferClassFallback?: boolean;
}

export function createHighlighter(options: HighlighterOptions = {}): HighlightHandle {
	const getRoot = options.getRoot ?? (() => document);
	const preferClass = options.preferClassFallback ?? isWebKit();

	const hasNative = typeof CSS !== 'undefined' && Boolean(CSS.highlights);
	if (hasNative && !preferClass) {
		return createCSSHighlight();
	}
	return createClassHighlight(getRoot);
}
