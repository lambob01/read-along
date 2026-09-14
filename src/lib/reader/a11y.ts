/**
 * Keyboard and focus helpers for the reader's modal surfaces.
 */

const ACTIVATABLE_SELECTOR =
	'a[href], summary, [role="button"], [role="link"], [role="switch"], [role="menuitem"]';

/**
 * Whether the element activates itself on Space or Enter, so the reader's
 * global shortcuts must leave those keys alone while it has focus. Buttons are
 * checked by type rather than by attribute: almost every control in the chrome
 * is a `<button>`, and none of them carry a role.
 */
export function isActivatable(el: EventTarget | null): boolean {
	if (!(el instanceof Element)) return false;
	if (el instanceof HTMLButtonElement) return true;
	return el.matches(ACTIVATABLE_SELECTOR);
}

/**
 * Natively focusable elements, in DOM order. Positive tabindex values are not
 * reordered — the reader has none — and `tabindex="-1"` is excluded so
 * click-to-close backdrops do not enter the tab cycle.
 */
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]';

export function focusableWithin(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1'
	);
}

/**
 * Keeps Tab inside `container`: at the last control it wraps to the first, at
 * the first it wraps back to the last, and from outside it pulls focus in.
 * Middle-of-list Tab is left to the browser's own focus order.
 */
export function trapTab(e: KeyboardEvent, container: HTMLElement): void {
	if (e.key !== 'Tab') return;
	const items = focusableWithin(container);
	if (items.length === 0) return;

	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;
	const inside = active instanceof Node && container.contains(active);

	if (e.shiftKey ? active === first || !inside : active === last || !inside) {
		e.preventDefault();
		(e.shiftKey ? last : first).focus();
	}
}
