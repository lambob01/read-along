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

export interface AutoScrollHooks {
	/**
	 * The reader has scrolled the active sentence clean off the screen (or out
	 * of the mounted window entirely), i.e. gone somewhere else in the book on
	 * purpose. Auto-scrolling should stop until they ask to come back — dragging
	 * them to the narration three seconds later is the behaviour this replaces.
	 */
	onDetach?: () => void;
}

export interface AutoScroller {
	scrollTo(id: number): void;
	suspend(): void;
	resume(): void;
	/**
	 * Declares that a scroll about to happen was not the reader's doing.
	 *
	 * Chapter windowing corrects its own reflow by scrolling (see
	 * `withScrollAnchor`), and that correction is indistinguishable from a
	 * gesture once it reaches the scroll event. Untagged, mounting a chapter
	 * would suspend auto-scrolling and then report the reader as having moved
	 * away — at every chapter boundary, while they sat still and listened.
	 */
	noteProgrammaticScroll(): void;
	setOptions(options: Partial<AutoScrollOptions>): void;
	destroy(): void;
}

const DEFAULTS: AutoScrollOptions = { anchor: 0.4, smooth: true, vertical: false };

/**
 * Quiet time after the last scroll event before the position is judged settled.
 * A touch fling keeps scrolling long after the finger has gone, so the check
 * cannot hang off the gesture that started it.
 */
const SETTLE_MS = 400;

/**
 * How long a scroll this scroller started itself is expected to take. Scroll
 * events it caused must not read as the reader moving away, or a smooth
 * scroll back to the narration would immediately detach again.
 */
const SELF_SCROLL_MS = 900;

/**
 * The same allowance for a layout correction, which is instant rather than
 * animated and so needs only the frame or two before its scroll event lands.
 * Kept short because real gestures inside the window are ignored.
 */
const SELF_ADJUST_MS = 250;

/**
 * A jump longer than this many viewports is a seek, a chapter change or the
 * first line after loading, not the text advancing. Animating it wastes a
 * second and lands nowhere useful, so those go instantly whatever the setting.
 */
const INSTANT_JUMP_VIEWPORTS = 3;

/**
 * Half-height of the dead zone around the anchor, as a fraction of the
 * container. Without it every sentence would trigger a scroll, so the text
 * would creep continuously instead of settling between jumps.
 */
const DEAD_ZONE = 0.15;

export function createAutoScroller(
	container: HTMLElement,
	getSentenceEl: (id: number) => HTMLElement | undefined,
	initialOptions: Partial<AutoScrollOptions> = {},
	hooks: AutoScrollHooks = {}
): AutoScroller {
	let options: AutoScrollOptions = { ...DEFAULTS, ...initialOptions };
	let suspended = false;
	let suspendTimer: ReturnType<typeof setTimeout> | null = null;
	/** Last sentence asked for, i.e. where the narration is on the page. */
	let activeId: number | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let selfScrollUntil = 0;

	function now(): number {
		return typeof performance === 'object' ? performance.now() : Date.now();
	}

	function handleInteraction() {
		// A gesture during a scroll of our own is still the reader taking over.
		selfScrollUntil = 0;
		suspend();
		scheduleSettleCheck();
	}

	/**
	 * Scroll events carry no indication of who caused them, so the ones this
	 * scroller caused are filtered by time. Everything else is the reader —
	 * including the tail of a fling, which is why the suspension is extended
	 * here rather than only when the gesture starts.
	 */
	function handleScroll() {
		if (now() < selfScrollUntil) return;
		suspend();
		scheduleSettleCheck();
	}

	function scheduleSettleCheck() {
		if (!hooks.onDetach) return;
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = null;
			if (activeId === null) return;
			const el = getSentenceEl(activeId);
			// No element means its chapter is no longer even mounted, which is
			// as far away as it is possible to get.
			if (!el || isOffScreen(el)) hooks.onDetach?.();
		}, SETTLE_MS);
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
		// Resuming is always a deliberate "follow along again", so a detach
		// check still pending from the scroll that led here would undo it.
		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = null;
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
		const view = project(container.getBoundingClientRect());
		const delta = r.near + r.size / 2 - anchorPoint();
		if (Math.abs(delta) < 1) return;
		const far = Math.abs(delta) > view.size * INSTANT_JUMP_VIEWPORTS;
		selfScrollUntil = now() + SELF_SCROLL_MS;
		container.scrollBy({
			top: options.vertical ? 0 : delta,
			left: options.vertical ? -delta : 0,
			behavior: options.smooth && !far ? 'smooth' : 'auto'
		});
	}

	function isOutsideDeadZone(el: HTMLElement): boolean {
		const r = project(el.getBoundingClientRect());
		const anchor = anchorPoint();
		const band = project(container.getBoundingClientRect()).size * DEAD_ZONE;
		return r.far < anchor - band || r.near > anchor + band;
	}

	/** Not merely past the anchor — entirely out of the frame. */
	function isOffScreen(el: HTMLElement): boolean {
		const r = project(el.getBoundingClientRect());
		const view = project(container.getBoundingClientRect());
		if (r.size === 0) return false;
		return r.far < view.near || r.near > view.far;
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
	container.addEventListener('scroll', handleScroll, { passive: true });

	return {
		scrollTo(id: number) {
			activeId = id;
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
		noteProgrammaticScroll() {
			selfScrollUntil = Math.max(selfScrollUntil, now() + SELF_ADJUST_MS);
		},
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
			if (settleTimer) clearTimeout(settleTimer);
			container.removeEventListener('pointerdown', handleInteraction);
			container.removeEventListener('wheel', handleInteraction);
			container.removeEventListener('scroll', handleScroll);
		}
	};
}
