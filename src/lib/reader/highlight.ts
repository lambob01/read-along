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

function createCSSHighlight(): HighlightHandle {
	let currentRange: Range | null = null;

	return {
		activate(el: HTMLElement) {
			this.activateMany([el]);
		},
		activateMany(els: HTMLElement[]) {
			this.reset();
			if (els.length === 0) return;
			const ranges = els.map((el) => {
				const range = new Range();
				range.selectNodeContents(el);
				return range;
			});
			// The Custom Highlight API accepts multiple ranges per highlight.
			CSS.highlights.set('active-sentence', new Highlight(...ranges));
			currentRange = ranges[0];
		},
		deactivate(el: HTMLElement) {
			this.reset();
		},
		reset() {
			CSS.highlights.delete('active-sentence');
			currentRange = null;
		}
	};
}

function createClassFallback(): HighlightHandle {
	let currentEls: HTMLElement[] = [];

	return {
		activate(el: HTMLElement) {
			this.activateMany([el]);
		},
		activateMany(els: HTMLElement[]) {
			this.reset();
			for (const el of els) el.classList.add('hl-active');
			currentEls = [...els];
		},
		deactivate(el: HTMLElement) {
			el.classList.remove('hl-active');
			currentEls = currentEls.filter((e) => e !== el);
		},
		reset() {
			for (const el of currentEls) el.classList.remove('hl-active');
			currentEls = [];
		}
	};
}

export function createHighlighter(): HighlightHandle {
	if (typeof CSS !== 'undefined' && CSS.highlights) {
		return createCSSHighlight();
	}
	return createClassFallback();
}
