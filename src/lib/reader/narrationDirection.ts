/**
 * Which way the narration lies from the viewport, for the "Narration" button
 * arrow. Horizontal text reads top-to-bottom, so above is "up" and below is
 * "down"; vertical-rl reads right-to-left, so further along is "left" and
 * behind is "right".
 *
 * The rects are structural (`Pick<DOMRect, ...>`) so the function is testable
 * in node, where there is no DOMRect global. A null narration rect (chapter
 * not mounted) or an on-screen narration falls back to the forward direction,
 * which is what the button means when the target is ambiguous.
 */
export type NarrationDirection = 'up' | 'down' | 'left' | 'right';

export type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

export function narrationDirection(
	viewRect: Rect,
	narrRect: Rect | null,
	vertical: boolean
): NarrationDirection {
	if (!narrRect) return vertical ? 'left' : 'down';
	if (vertical) {
		if (narrRect.right < viewRect.left) return 'left';
		if (narrRect.left > viewRect.right) return 'right';
		return 'left';
	}
	if (narrRect.bottom < viewRect.top) return 'up';
	if (narrRect.top > viewRect.bottom) return 'down';
	return 'down';
}
