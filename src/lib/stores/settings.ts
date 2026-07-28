import { writable } from 'svelte/store';

export const themeOptions = [
	{ value: 'light', label: 'Light' },
	{ value: 'sepia', label: 'Sepia' },
	{ value: 'garden', label: 'Garden' },
	{ value: 'gray', label: 'Gray' },
	{ value: 'dark', label: 'Dark' },
	{ value: 'dracula', label: 'Dracula' },
	{ value: 'oled', label: 'Black' }
] as const;

export type ThemeName = (typeof themeOptions)[number]['value'];

export const fontOptions = [
	{ value: 'Georgia, serif', label: 'Georgia' },
	{ value: 'Iowan Old Style, Palatino, serif', label: 'Iowan' },
	{ value: 'Charter, Bitstream Charter, serif', label: 'Charter' },
	{ value: '-apple-system, Inter, system-ui, sans-serif', label: 'System Sans' },
	{ value: 'Menlo, Consolas, monospace', label: 'Monospace' }
] as const;

export type HighlightStyle = 'background' | 'underline' | 'text' | 'none';

export interface SettingsState {
	theme: ThemeName;
	fontSize: number;
	lineHeight: number;
	fontFamily: string;
	maxWidth: number;
	sideMargins: number;
	paragraphSpacing: number;
	justify: boolean;
	hlBg: string;
	hlFg: string;
	hlStyle: HighlightStyle;
	/** Where in the viewport the active sentence is parked, 0 (top) to 1 (bottom). */
	scrollAnchor: number;
	smoothScroll: boolean;
	/** Hides the header and player bar until the reader is tapped. */
	autoHideChrome: boolean;
	/** Global fallback for per-book sync offset, in seconds. */
	timingOffset: number;
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
	paragraphSpacing: 0.9,
	justify: false,
	hlBg: '#fef08a',
	hlFg: '#1e293b',
	hlStyle: 'background',
	scrollAnchor: 0.4,
	smoothScroll: true,
	autoHideChrome: true,
	timingOffset: 0,
	gapThreshold: 1.2,
	showNonSpeech: false
};

const STORAGE_KEY = 'reader-settings';

/**
 * Reads persisted settings over the defaults. Merging rather than replacing
 * matters because settings added after a user's last visit would otherwise
 * deserialize as undefined and reach the DOM as "undefined" CSS values.
 */
function loadSettings(): SettingsState {
	if (typeof localStorage === 'undefined') return { ...defaultSettings };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...defaultSettings };
		const parsed = JSON.parse(raw) as Partial<SettingsState>;
		return { ...defaultSettings, ...parsed };
	} catch {
		return { ...defaultSettings };
	}
}

export function applySettingsToDOM(s: SettingsState) {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	root.style.setProperty('--theme-font-size', `${s.fontSize}rem`);
	root.style.setProperty('--theme-line-height', String(s.lineHeight));
	root.style.setProperty('--theme-font-family', s.fontFamily);
	root.style.setProperty('--theme-max-width', `${s.maxWidth}ch`);
	root.style.setProperty('--theme-side-margins', `${s.sideMargins}px`);
	root.style.setProperty('--theme-paragraph-spacing', `${s.paragraphSpacing}em`);
	root.style.setProperty('--theme-text-align', s.justify ? 'justify' : 'start');
	root.style.setProperty('--hl-bg', s.hlBg);
	root.style.setProperty('--hl-fg', s.hlFg);
	root.dataset.theme = s.theme;
	root.dataset.hlStyle = s.hlStyle;
}

function createSettingsStore() {
	const { subscribe, set, update } = writable<SettingsState>(loadSettings());

	function persist(s: SettingsState) {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
		}
		applySettingsToDOM(s);
	}

	subscribe(persist);

	return {
		subscribe,
		update(fn: (s: SettingsState) => SettingsState) {
			update(fn);
		},
		set(s: SettingsState) {
			set(s);
		},
		reset() {
			set({ ...defaultSettings });
		}
	};
}

export const settings = createSettingsStore();
