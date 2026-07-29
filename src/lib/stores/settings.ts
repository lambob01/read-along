import { writable } from 'svelte/store';
import { DEFAULT_ANKI_URL } from '$lib/anki/connect';

export const themeOptions = [
	{ value: 'light', label: 'Light' },
	{ value: 'sepia', label: 'Sepia' },
	{ value: 'garden', label: 'Garden' },
	{ value: 'gray', label: 'Gray' },
	{ value: 'dark', label: 'Dark' },
	{ value: 'dracula', label: 'Dracula' },
	{ value: 'oled', label: 'Black' },
	{ value: 'custom', label: 'Custom' }
] as const;

export type ThemeName = (typeof themeOptions)[number]['value'];

/** Built-in themes, i.e. the ones a custom theme can be seeded from. */
export const presetThemeOptions = themeOptions.filter((t) => t.value !== 'custom');

/**
 * The four colours a user picks; every other surface is mixed from them in CSS
 * (see `[data-theme='custom']` in app.css). Asking for seven pickers produced
 * unreadable results more often than not — muted text and borders only work
 * when they sit a fixed distance from the background.
 */
export interface CustomTheme {
	bg: string;
	fg: string;
	accent: string;
	accentFg: string;
}

export const fontOptions = [
	{ value: 'Georgia, serif', label: 'Georgia' },
	{ value: 'Iowan Old Style, Palatino, serif', label: 'Iowan' },
	{ value: 'Charter, Bitstream Charter, serif', label: 'Charter' },
	{ value: '-apple-system, Inter, system-ui, sans-serif', label: 'System Sans' },
	{ value: 'Menlo, Consolas, monospace', label: 'Monospace' }
] as const;

export type HighlightStyle = 'background' | 'underline' | 'text' | 'none';

/**
 * `update-last` attaches the clip to the note you just made in Anki (typically
 * from a dictionary popup), which is the usual mining order: look the word up
 * first, then grab the audio for the line it came from. `create` is for
 * mining a line on its own.
 */
export type AnkiMode = 'update-last' | 'create';

export const ankiModeOptions = [
	{ value: 'update-last', label: 'Update last card' },
	{ value: 'create', label: 'Create new card' }
] as const;

/**
 * What the player does once a card has been written. Mining usually interrupts
 * listening anyway — the sentence has to be re-read to make the card — so where
 * playback is left matters.
 */
export type MinePause = 'none' | 'here' | 'start' | 'end';

export const minePauseOptions: { value: MinePause; label: string; hint: string }[] = [
	{ value: 'none', label: 'Keep playing', hint: 'Playback is never interrupted.' },
	{ value: 'here', label: 'Pause here', hint: 'Stops wherever the audio had got to.' },
	{
		value: 'start',
		label: 'Pause at line start',
		hint: 'Rewinds to the start of the mined line, ready to hear it again.'
	},
	{
		value: 'end',
		label: 'Pause at line end',
		hint: 'Stops at the end of the mined line, ready to carry on.'
	}
];

/** Which pair of keys steps by cue and which seeks by time. */
export type ArrowKeyMode = 'time' | 'cue';

export const arrowKeyOptions: { value: ArrowKeyMode; label: string }[] = [
	{ value: 'time', label: 'Seek by time' },
	{ value: 'cue', label: 'Step by line' }
];

export interface SettingsState {
	theme: ThemeName;
	/** Only in effect while `theme` is `custom`, but kept so it survives a switch away and back. */
	customTheme: CustomTheme;
	fontSize: number;
	lineHeight: number;
	fontFamily: string;
	maxWidth: number;
	sideMargins: number;
	paragraphSpacing: number;
	justify: boolean;
	/**
	 * Vertical Japanese typesetting (tategaki): columns run top to bottom and
	 * advance right to left. Off by default — horizontal suits every language
	 * the reader handles, vertical only some.
	 */
	verticalText: boolean;
	/**
	 * How much of the screen's width the vertical reading pane occupies, as a
	 * percentage. Vertical text scrolls sideways without end, so its horizontal
	 * extent cannot be capped the way a line length is — the pane itself is
	 * narrowed and centred, which is what puts gutters either side. No effect
	 * while reading horizontally.
	 */
	verticalWidth: number;
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

	// --- Navigation ----------------------------------------------------------
	/**
	 * What the bare arrow keys do. The other behaviour is always available on
	 * Alt/Option + arrow, so this only decides which one is unmodified.
	 */
	arrowKeys: ArrowKeyMode;
	/** Seconds the time-seek arrows move by. */
	seekStep: number;
	/** Auto-pause at the end of every line, for shadowing. Not persisted per book. */
	repeatMode: boolean;
	/**
	 * Treat a 「…」 run as one repeat unit rather than stopping inside it. A line
	 * of dialogue usually spans several cues, and half an utterance is no use to
	 * shadow.
	 */
	repeatWholeQuotes: boolean;

	// --- Anki mining ---------------------------------------------------------
	/**
	 * Off by default because turning it on routes the audio element through a
	 * Web Audio graph permanently, which is not worth doing for users who do
	 * not mine.
	 */
	ankiEnabled: boolean;
	ankiUrl: string;
	/** Only needed when AnkiConnect is configured with an apiKey. */
	ankiKey: string;
	ankiMode: AnkiMode;
	/** Anki search that identifies the "last card"; newest match wins. */
	ankiLastCardQuery: string;
	/** Field the `[sound:...]` tag is written to. Required in both modes. */
	ankiAudioField: string;
	/** Field the sentence text is written to. Required only in create mode. */
	ankiSentenceField: string;
	/** In update mode, also overwrite the sentence field with the line. */
	ankiUpdateSentence: boolean;
	ankiDeck: string;
	ankiModel: string;
	ankiTags: string;
	/** Seconds of lead-in kept before the sentence, to cover alignment slop. */
	ankiPadStart: number;
	ankiPadEnd: number;
	/** Where playback is left after a card is created or updated. */
	ankiPauseAfter: MinePause;
}

export const defaultCustomTheme: CustomTheme = {
	bg: '#09090b',
	fg: '#f4f4f5',
	accent: '#818cf8',
	accentFg: '#09090b'
};

export const defaultSettings: SettingsState = {
	theme: 'dark',
	customTheme: { ...defaultCustomTheme },
	fontSize: 1,
	lineHeight: 1.6,
	fontFamily: 'Georgia, serif',
	maxWidth: 65,
	sideMargins: 16,
	paragraphSpacing: 0.9,
	justify: false,
	verticalText: false,
	verticalWidth: 80,
	hlBg: '#fef08a',
	hlFg: '#1e293b',
	hlStyle: 'background',
	scrollAnchor: 0.4,
	smoothScroll: true,
	autoHideChrome: true,
	timingOffset: 0,
	gapThreshold: 1.2,
	showNonSpeech: false,
	arrowKeys: 'time',
	seekStep: 10,
	repeatMode: false,
	repeatWholeQuotes: true,
	ankiEnabled: false,
	ankiUrl: DEFAULT_ANKI_URL,
	ankiKey: '',
	ankiMode: 'update-last',
	ankiLastCardQuery: 'added:1',
	ankiAudioField: '',
	ankiSentenceField: '',
	ankiUpdateSentence: false,
	ankiDeck: '',
	ankiModel: '',
	ankiTags: 'read-along',
	ankiPadStart: 0.25,
	ankiPadEnd: 0.4,
	ankiPauseAfter: 'none'
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
		// `customTheme` is the one nested object here, so the top-level spread
		// would drop any colour added after the user last saved.
		return {
			...defaultSettings,
			...parsed,
			customTheme: { ...defaultCustomTheme, ...(parsed.customTheme ?? {}) }
		};
	} catch {
		return { ...defaultSettings };
	}
}

/**
 * Rough perceived lightness of a `#rrggbb` colour, 0..1. Only used to decide
 * whether a custom theme wants light or dark shadows; a wrong answer near the
 * midpoint is invisible, so sRGB luma is precise enough.
 */
export function isDarkColor(hex: string): boolean {
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return false;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
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
	root.style.setProperty('--theme-vertical-width', `${s.verticalWidth}%`);
	root.style.setProperty('--hl-bg', s.hlBg);
	root.style.setProperty('--hl-fg', s.hlFg);
	// Written under their own names rather than straight onto --bg/--fg: an
	// inline custom property outranks the `[data-theme=…]` rules, so setting
	// those directly would leak the custom palette into every other theme.
	// `app.css` maps these across only under `[data-theme='custom']`.
	root.style.setProperty('--custom-bg', s.customTheme.bg);
	root.style.setProperty('--custom-fg', s.customTheme.fg);
	root.style.setProperty('--custom-accent', s.customTheme.accent);
	root.style.setProperty('--custom-accent-fg', s.customTheme.accentFg);
	root.dataset.customDark = isDarkColor(s.customTheme.bg) ? 'true' : 'false';
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
