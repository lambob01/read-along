import { describe, it, expect, afterEach } from 'vitest';
import { syncThemeColor, themeColorFor } from './themeColor';

afterEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
});

function installThemeStyle() {
	const style = document.createElement('style');
	style.textContent = `
		[data-theme='sepia'] { --bg: #f4ecd8; }
		[data-theme='dark'] { --bg: #09090b; }
	`;
	document.head.appendChild(style);
}

describe('themeColorFor', () => {
	it('reads a theme’s background out of the stylesheet', () => {
		installThemeStyle();
		expect(themeColorFor('sepia')).toBe('#f4ecd8');
	});

	it('returns null for a theme that resolves no background', () => {
		installThemeStyle();
		expect(themeColorFor('nonesuch')).toBeNull();
	});
});

describe('syncThemeColor', () => {
	it('updates the theme-color meta tag when the theme changes', () => {
		installThemeStyle();
		document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#000000" />');

		syncThemeColor('sepia');

		const meta = document.querySelector('meta[name="theme-color"]');
		expect(meta?.getAttribute('content')).toBe('#f4ecd8');
	});

	it('leaves the meta tag untouched when the theme resolves nothing', () => {
		installThemeStyle();
		document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#000000" />');

		syncThemeColor('nonesuch');

		const meta = document.querySelector('meta[name="theme-color"]');
		expect(meta?.getAttribute('content')).toBe('#000000');
	});
});
