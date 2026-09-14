/**
 * The browser paints its chrome — the address bar, the status bar on mobile —
 * with `<meta name="theme-color">`, and the value baked into `app.html` cannot
 * know which theme the reader picked. Resolving the theme's own `--bg` through
 * the stylesheet keeps the chrome in step with `app.css` rather than keeping a
 * second copy of the palette that can drift.
 *
 * The probe must be in the document for the custom property to resolve, so the
 * caller has to run this in the browser.
 */
export function themeColorFor(theme: string, doc: Document = document): string | null {
	const probe = doc.createElement('div');
	probe.dataset.theme = theme;
	probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
	doc.body.appendChild(probe);
	const bg = getComputedStyle(probe).getPropertyValue('--bg').trim();
	probe.remove();
	return bg || null;
}

/**
 * Repaints the theme-color meta tag for `theme`. A theme whose background
 * cannot be resolved leaves the existing value alone rather than blanking it.
 */
export function syncThemeColor(theme: string, doc: Document = document): void {
	const meta = doc.querySelector('meta[name="theme-color"]');
	const color = themeColorFor(theme, doc);
	if (meta && color) meta.setAttribute('content', color);
}
