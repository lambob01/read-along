export interface AutoScroller {
	scrollTo(id: number): void;
	suspend(): void;
	resume(): void;
	destroy(): void;
}

export function createAutoScroller(
	container: HTMLElement,
	getSentenceEl: (id: number) => HTMLElement | undefined
): AutoScroller {
	let suspended = false;
	let suspendTimer: ReturnType<typeof setTimeout> | null = null;
	let isProgrammaticScroll = false;

	function handlePointerDown() {
		suspend();
	}

	function handleWheel() {
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

	const observer = new IntersectionObserver(
		(entries) => {
			if (suspended) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) {
					const el = entry.target as HTMLElement;
					isProgrammaticScroll = true;
					el.scrollIntoView({
						behavior: 'smooth',
						block: 'center'
					});
					requestAnimationFrame(() => {
						isProgrammaticScroll = false;
					});
				}
			}
		},
		{
			root: container,
			rootMargin: '-30% 0px -30% 0px',
			threshold: 0
		}
	);

	let observedEl: HTMLElement | null = null;

	container.addEventListener('pointerdown', handlePointerDown);
	container.addEventListener('wheel', handleWheel);

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

			const rect = el.getBoundingClientRect();
			const containerRect = container.getBoundingClientRect();
			const safeTop = containerRect.top + containerRect.height * 0.35;
			const safeBottom = containerRect.top + containerRect.height * 0.65;

			if (rect.bottom < safeTop || rect.top > safeBottom) {
				isProgrammaticScroll = true;
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				requestAnimationFrame(() => {
					isProgrammaticScroll = false;
				});
			}
		},
		suspend,
		resume,
		destroy() {
			observer.disconnect();
			if (suspendTimer) clearTimeout(suspendTimer);
			container.removeEventListener('pointerdown', handlePointerDown);
			container.removeEventListener('wheel', handleWheel);
		}
	};
}
