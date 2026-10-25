import { describe, expect, it } from 'vitest';
import { defaultSettings, isDarkTheme, toggledTheme } from './settings';

describe('isDarkTheme', () => {
	it.each(['dark', 'oled', 'dracula', 'gray'] as const)('treats %s as dark', (theme) => {
		expect(isDarkTheme({ ...defaultSettings, theme })).toBe(true);
	});

	it.each(['light', 'sepia', 'garden'] as const)('treats %s as light', (theme) => {
		expect(isDarkTheme({ ...defaultSettings, theme })).toBe(false);
	});

	it('reads the background of a custom theme', () => {
		const custom = { ...defaultSettings.customTheme };

		expect(
			isDarkTheme({
				...defaultSettings,
				theme: 'custom',
				customTheme: { ...custom, bg: '#000000' }
			})
		).toBe(true);
		expect(
			isDarkTheme({
				...defaultSettings,
				theme: 'custom',
				customTheme: { ...custom, bg: '#ffffff' }
			})
		).toBe(false);
	});
});

describe('toggledTheme', () => {
	it('turns a dark theme light', () => {
		expect(toggledTheme({ ...defaultSettings, theme: 'oled' })).toBe('light');
	});

	it('turns a light theme dark', () => {
		expect(toggledTheme({ ...defaultSettings, theme: 'sepia' })).toBe('dark');
	});

	it('returns to dark after a toggle from dark', () => {
		const light = toggledTheme({ ...defaultSettings, theme: 'dark' });
		expect(toggledTheme({ ...defaultSettings, theme: light })).toBe('dark');
	});
});
