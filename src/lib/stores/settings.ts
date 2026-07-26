import { writable } from 'svelte/store';

function persistedLocal<T>(key: string, defaultValue: T) {
	const stored =
		typeof localStorage !== 'undefined'
			? localStorage.getItem(key)
			: null;
	const initial: T = stored ? JSON.parse(stored) : defaultValue;
	return writable<T>(initial);
}

export interface SettingsState {
	theme: 'light' | 'dark' | 'sepia' | 'oled';
	fontSize: number;
	lineHeight: number;
	fontFamily: string;
	maxWidth: number;
	sideMargins: number;
	hlBg: string;
	hlFg: string;
	gapThreshold: number;
	showNonSpeech: boolean;
}

export const defaultSettings: SettingsState = {
	theme: 'dark',
	fontSize: 1,
	lineHeight: 1.6,
	fontFamily: 'Georgia, serif',
	maxWidth: 65,
	sideMargins: 16,
	hlBg: '#fef08a',
	hlFg: '#1e293b',
	gapThreshold: 1.2,
	showNonSpeech: false
};

function createSettingsStore() {
	const store = persistedLocal('reader-settings', defaultSettings);

	const { subscribe, set, update } = store;

	function applyToDOM(settings: SettingsState) {
		const root = document.documentElement;
		root.style.setProperty('--theme-font-size', `${settings.fontSize}rem`);
		root.style.setProperty(
			'--theme-line-height',
			String(settings.lineHeight)
		);
		root.style.setProperty('--theme-font-family', settings.fontFamily);
		root.style.setProperty('--theme-max-width', `${settings.maxWidth}ch`);
		root.style.setProperty(
			'--theme-side-margins',
			`${settings.sideMargins}px`
		);
		root.style.setProperty('--hl-bg', settings.hlBg);
		root.style.setProperty('--hl-fg', settings.hlFg);
		root.dataset.theme = settings.theme;
	}

	if (typeof localStorage !== 'undefined') {
		let current: SettingsState;
		subscribe((s) => {
			current = s;
			localStorage.setItem('reader-settings', JSON.stringify(s));
			applyToDOM(s);
		});

		return {
			subscribe,
			update(fn: (s: SettingsState) => SettingsState) {
				update((s) => {
					const next = fn(s);
					applyToDOM(next);
					return next;
				});
			},
			set(s: SettingsState) {
				set(s);
				applyToDOM(s);
			},
			reset() {
				set(defaultSettings);
				applyToDOM(defaultSettings);
			}
		};
	}

	return { subscribe, set, update, reset: () => set(defaultSettings) };
}

export const settings = createSettingsStore();
