export interface AutoScrollOptions {
	/** Where the active sentence is parked, 0 (top of view) to 1 (bottom). */
	anchor: number;
	smooth: boolean;
}

export interface AutoScroller {
	scrollTo(id: number): void;
	suspend(): void;
	resume(): void;
	setOptions(options: Partial<AutoScrollOptions>): void;
	destroy(): void;
}

const DEFAULTS: AutoScrollOptions = { anchor: 0.4, smooth: true };

/**
 * Half-height of the dead zone around the anchor, as a fraction of the
 * container. Without it every sentence would trigger a scroll, so the text
 * would creep continuously instead of settling between jumps.
 */
const DEAD_ZONE = 0.15;

export function createAutoScroller(
	container: HTMLElement,
	getSentenceEl: (id: number) => HTMLElement | undefined,
	initialOptions: Partial<AutoScrollOptions> = {}
): AutoScroller {
	let options: AutoScrollOptions = { ...DEFAULTS, ...initialOptions };
	let suspended = false;
	let suspendTimer: ReturnType<typeof setTimeout> | null = null;

	function handleInteraction() {
		suspend();
	}

	function suspend() {
		suspended = true;
		if (suspendTimer) clearTimeout(suspendTimer);
		suspendTimer = setTimeout(() => {
			suspended = false;
		}, 3000);
	}

	function resume() {
		suspended = false;
		if (suspendTimer) {
			clearTimeout(suspendTimer);
			suspendTimer = null;
		}
	}

	/**
	 * Scrolls by a delta rather than using scrollIntoView, which only supports
	 * start/center/end and so cannot honour an arbitrary anchor.
	 */
	function scrollElementToAnchor(el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		const targetY = containerRect.top + containerRect.height * options.anchor;
		const delta = rect.top + rect.height / 2 - targetY;
		if (Math.abs(delta) < 1) return;
		container.scrollBy({
			top: delta,
			behavior: options.smooth ? 'smooth' : 'auto'
		});
	}

	function isOutsideDeadZone(el: HTMLElement): boolean {
		const rect = el.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		const anchorY = containerRect.top + containerRect.height * options.anchor;
		const band = containerRect.height * DEAD_ZONE;
		return rect.bottom < anchorY - band || rect.top > anchorY + band;
	}

	// Catches the case where reflow (a chapter mounting above) moves the active
	// sentence out of view without the active id changing.
	const observer = new IntersectionObserver(
		(entries) => {
			if (suspended) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) {
					scrollElementToAnchor(entry.target as HTMLElement);
				}
			}
		},
		{ root: container, rootMargin: '-30% 0px -30% 0px', threshold: 0 }
	);

	let observedEl: HTMLElement | null = null;

	container.addEventListener('pointerdown', handleInteraction);
	container.addEventListener('wheel', handleInteraction);

	return {
		scrollTo(id: number) {
			if (suspended) return;
			const el = getSentenceEl(id);
			if (!el) return;

			if (observedEl !== el) {
				if (observedEl) observer.unobserve(observedEl);
				observer.observe(el);
				observedEl = el;
			}

			if (isOutsideDeadZone(el)) scrollElementToAnchor(el);
		},
		suspend,
		resume,
		setOptions(next: Partial<AutoScrollOptions>) {
			options = { ...options, ...next };
		},
		destroy() {
			observer.disconnect();
			if (suspendTimer) clearTimeout(suspendTimer);
			container.removeEventListener('pointerdown', handleInteraction);
			container.removeEventListener('wheel', handleInteraction);
		}
	};
}
