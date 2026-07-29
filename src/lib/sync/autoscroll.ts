export interface AutoScrollOptions {
	/**
	 * Where the active sentence is parked along the reading axis, 0 (where
	 * reading starts) to 1 (where it ends). Vertically that is top→bottom;
	 * in vertical-rl it is right→left.
	 */
	anchor: number;
	smooth: boolean;
	/**
	 * Vertical Japanese typesetting (`writing-mode: vertical-rl`): columns run
	 * down, successive columns run right to left, so the container scrolls
	 * horizontally and *backwards*.
	 */
	vertical: boolean;
}

export interface AutoScroller {
	scrollTo(id: number): void;
	suspend(): void;
	resume(): void;
	setOptions(options: Partial<AutoScrollOptions>): void;
	destroy(): void;
}

const DEFAULTS: AutoScrollOptions = { anchor: 0.4, smooth: true, vertical: false };

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
	 * Projects a rect onto the reading axis: (near edge, far edge, extent),
	 * where "near" is the edge reading arrives from.
	 *
	 * Vertically that is top→bottom. In vertical-rl the block axis is
	 * horizontal and reversed, so the near edge is the *right* one and the axis
	 * is measured leftwards — which is what lets one set of arithmetic below
	 * serve both modes.
	 */
	function project(rect: DOMRect): { near: number; far: number; size: number } {
		if (!options.vertical) return { near: rect.top, far: rect.bottom, size: rect.height };
		return { near: -rect.right, far: -rect.left, size: rect.width };
	}

	/** Position along the reading axis where the active sentence should sit. */
	function anchorPoint(): number {
		const c = project(container.getBoundingClientRect());
		return c.near + c.size * options.anchor;
	}

	/**
	 * Scrolls by a delta rather than using scrollIntoView, which only supports
	 * start/center/end and so cannot honour an arbitrary anchor.
	 *
	 * `scrollBy` takes physical deltas, and a positive one always moves the
	 * viewport towards larger coordinates whatever the scroll origin — so the
	 * axis-flipped delta is negated back on the way out. That also sidesteps
	 * `scrollLeft`, whose origin in a right-to-left scroller differs between
	 * engines.
	 */
	function scrollElementToAnchor(el: HTMLElement) {
		const r = project(el.getBoundingClientRect());
		const delta = r.near + r.size / 2 - anchorPoint();
		if (Math.abs(delta) < 1) return;
		container.scrollBy({
			top: options.vertical ? 0 : delta,
			left: options.vertical ? -delta : 0,
			behavior: options.smooth ? 'smooth' : 'auto'
		});
	}

	function isOutsideDeadZone(el: HTMLElement): boolean {
		const r = project(el.getBoundingClientRect());
		const anchor = anchorPoint();
		const band = project(container.getBoundingClientRect()).size * DEAD_ZONE;
		return r.far < anchor - band || r.near > anchor + band;
	}

	// Catches the case where reflow (a chapter mounting ahead of the active one)
	// moves it out of view without the active id changing.
	let observedEl: HTMLElement | null = null;
	let observer = makeObserver();

	function makeObserver(): IntersectionObserver {
		return new IntersectionObserver(
			(entries) => {
				if (suspended) return;
				for (const entry of entries) {
					if (!entry.isIntersecting) {
						scrollElementToAnchor(entry.target as HTMLElement);
					}
				}
			},
			{
				root: container,
				// Insets the root along the reading axis only — which axis that
				// is depends on the writing mode. Order is top right bottom left.
				rootMargin: options.vertical ? '0px -30% 0px -30%' : '-30% 0px -30% 0px',
				threshold: 0
			}
		);
	}

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
			const wasVertical = options.vertical;
			options = { ...options, ...next };
			// `rootMargin` is baked in at construction, so a change of writing
			// mode needs a new observer or it would keep insetting the old axis.
			if (options.vertical !== wasVertical) {
				observer.disconnect();
				observer = makeObserver();
				if (observedEl) observer.observe(observedEl);
			}
		},
		destroy() {
			observer.disconnect();
			if (suspendTimer) clearTimeout(suspendTimer);
			container.removeEventListener('pointerdown', handleInteraction);
			container.removeEventListener('wheel', handleInteraction);
		}
	};
}
