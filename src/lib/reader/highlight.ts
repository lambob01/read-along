export interface HighlightHandle {
	activate(el: HTMLElement): void;
	deactivate(el: HTMLElement): void;
	reset(): void;
}

function createCSSHighlight(): HighlightHandle {
	let currentRange: Range | null = null;

	return {
		activate(el: HTMLElement) {
			this.reset();
			const range = new Range();
			range.selectNodeContents(el);
			const highlight = new Highlight(range);
			CSS.highlights.set('active-sentence', highlight);
			currentRange = range;
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
	let currentEl: HTMLElement | null = null;

	return {
		activate(el: HTMLElement) {
			this.reset();
			el.classList.add('hl-active');
			currentEl = el;
		},
		deactivate(el: HTMLElement) {
			el.classList.remove('hl-active');
			if (currentEl === el) currentEl = null;
		},
		reset() {
			if (currentEl) {
				currentEl.classList.remove('hl-active');
				currentEl = null;
			}
		}
	};
}

export function createHighlighter(): HighlightHandle {
	if (typeof CSS !== 'undefined' && CSS.highlights) {
		return createCSSHighlight();
	}
	return createClassFallback();
}
