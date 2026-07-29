<script lang="ts">
	import {
		settings,
		themeOptions,
		presetThemeOptions,
		fontOptions,
		ankiModeOptions,
		minePauseOptions,
		arrowKeyOptions,
		defaultCustomTheme,
		type SettingsState,
		type HighlightStyle,
		type AnkiMode,
		type ThemeName,
		type CustomTheme,
		type MinePause,
		type ArrowKeyMode
	} from '$lib/stores/settings';
	import { ankiVersion, deckNames, modelNames, modelFieldNames } from '$lib/anki/connect';
	import { ankiTarget } from '$lib/anki/mine';

	interface Props {
		/**
		 * Gap and non-speech options only affect the subtitle pipeline, which
		 * infers structure from audio gaps. In EPUB mode the structure is real,
		 * so the reader hides them.
		 */
		showSubtitleOptions?: boolean;
		/** Restricts to one tab and hides the tab bar, for the in-reader sheet. */
		only?: SectionId | null;
	}

	let { showSubtitleOptions = true, only = null }: Props = $props();

	type SectionId = 'appearance' | 'reading' | 'sync' | 'anki';

	const sections: { id: SectionId; label: string }[] = [
		{ id: 'appearance', label: 'Appearance' },
		{ id: 'reading', label: 'Reading' },
		{ id: 'sync', label: 'Sync' },
		{ id: 'anki', label: 'Anki' }
	];

	let active = $state<SectionId>('appearance');
	const visible = $derived(only ?? active);

	function patch(fn: (s: SettingsState) => Partial<SettingsState>) {
		settings.update((s) => ({ ...s, ...fn(s) }));
	}

	// --- Anki connection -----------------------------------------------------
	// Deck, note type and field names are pulled from the live collection so the
	// user picks from what exists instead of typing names that must match
	// exactly. Everything degrades to a text input when Anki is unreachable.

	let ankiState = $state<'idle' | 'testing' | 'ok' | 'error'>('idle');
	let ankiMessage = $state('');
	let decks = $state<string[]>([]);
	let models = $state<string[]>([]);
	let fields = $state<string[]>([]);

	async function testAnki() {
		ankiState = 'testing';
		ankiMessage = '';
		try {
			const target = ankiTarget($settings);
			const version = await ankiVersion(target);
			[decks, models] = await Promise.all([deckNames(target), modelNames(target)]);
			ankiState = 'ok';
			ankiMessage = `Connected to AnkiConnect v${version} — ${decks.length} decks.`;
			if ($settings.ankiModel) await loadFields($settings.ankiModel);
		} catch (err) {
			ankiState = 'error';
			ankiMessage = err instanceof Error ? err.message : 'Could not reach Anki.';
			decks = [];
			models = [];
			fields = [];
		}
	}

	async function loadFields(model: string) {
		if (!model) {
			fields = [];
			return;
		}
		try {
			fields = await modelFieldNames(ankiTarget($settings), model);
		} catch {
			fields = [];
		}
	}

	function chooseModel(model: string) {
		patch(() => ({ ankiModel: model }));
		loadFields(model);
	}

	// --- Custom theme --------------------------------------------------------

	const customFields: { key: keyof CustomTheme; label: string }[] = [
		{ key: 'bg', label: 'Page' },
		{ key: 'fg', label: 'Text' },
		{ key: 'accent', label: 'Accent' },
		{ key: 'accentFg', label: 'On accent' }
	];

	function patchCustom(key: keyof CustomTheme, value: string) {
		patch((s) => ({ customTheme: { ...s.customTheme, [key]: value } }));
	}

	/**
	 * Reads a built-in theme's colours out of the stylesheet rather than keeping
	 * a second copy of them here, so editing `app.css` cannot leave the seeds
	 * quietly wrong. The probe has to be in the document for the custom
	 * properties to resolve.
	 */
	function seedFrom(theme: ThemeName) {
		if (typeof document === 'undefined') return;
		const probe = document.createElement('div');
		probe.dataset.theme = theme;
		probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
		document.body.appendChild(probe);
		const cs = getComputedStyle(probe);
		const read = (prop: string, fallback: string) => {
			const v = cs.getPropertyValue(prop).trim();
			// A colour picker only accepts #rrggbb; anything else means the theme
			// used a form we cannot round-trip, so keep the default.
			return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
		};
		const seeded: CustomTheme = {
			bg: read('--bg', defaultCustomTheme.bg),
			fg: read('--fg', defaultCustomTheme.fg),
			accent: read('--accent', defaultCustomTheme.accent),
			accentFg: read('--accent-fg', defaultCustomTheme.accentFg)
		};
		probe.remove();
		patch(() => ({ theme: 'custom', customTheme: seeded }));
	}

	const lineHeights = [1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.2, 2.5];

	/** Reader shortcuts, listed where they can be looked up rather than guessed. */
	const shortcuts: { keys: string; what: string }[] = [
		{ keys: 'Space / K', what: 'Play or pause' },
		{ keys: '← →', what: 'Seek by time' },
		{ keys: 'Alt + ← →', what: 'Previous / next line' },
		{ keys: 'R', what: 'Repeat the current line' },
		{ keys: '↵', what: 'Skip to the next line' },
		{ keys: 'Shift + R', what: 'Toggle repeat mode' },
		{ keys: 'N / P', what: 'Next / previous chapter' },
		{ keys: '[ ]', what: 'Nudge the sync offset' },
		{ keys: 'A', what: 'Mine to Anki' }
	];

	/** The arrow-key rows swap when line-stepping is the unmodified behaviour. */
	const shownShortcuts = $derived(
		$settings.arrowKeys === 'time'
			? shortcuts
			: shortcuts.map((s) =>
					s.keys === '← →'
						? { keys: '← →', what: 'Previous / next line' }
						: s.keys === 'Alt + ← →'
							? { keys: 'Alt + ← →', what: 'Seek by time' }
							: s
				)
	);

	const hlStyles: { value: HighlightStyle; label: string }[] = [
		{ value: 'background', label: 'Fill' },
		{ value: 'underline', label: 'Underline' },
		{ value: 'text', label: 'Text color' },
		{ value: 'none', label: 'None' }
	];

	const anchorLabels: Record<string, string> = {
		'0.25': 'Upper',
		'0.4': 'Middle',
		'0.5': 'Center',
		'0.65': 'Lower'
	};

	function anchorLabel(v: number): string {
		return anchorLabels[String(v)] ?? `${Math.round(v * 100)}% down`;
	}

	function colorHint(style: HighlightStyle): string {
		if (style === 'background') return 'Background and text';
		if (style === 'underline') return 'Colour of the underline';
		return 'Colour the active text takes';
	}
</script>

{#snippet row(label: string, hint: string | null)}
	<div class="min-w-0">
		<span class="block text-sm font-medium text-[var(--fg)]">{label}</span>
		{#if hint}
			<span class="mt-0.5 block text-xs text-[var(--muted)]">{hint}</span>
		{/if}
	</div>
{/snippet}

{#snippet fieldRow(
	id: string,
	label: string,
	hint: string,
	value: string,
	onChange: (v: string) => void
)}
	<div>
		<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for={id}>{label}</label>
		{#if fields.length > 0}
			<select
				{id}
				{value}
				onchange={(e) => onChange(e.currentTarget.value)}
				class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
			>
				<option value="">Select…</option>
				{#each fields as f}
					<option value={f}>{f}</option>
				{/each}
			</select>
		{:else}
			<input
				{id}
				type="text"
				{value}
				oninput={(e) => onChange(e.currentTarget.value)}
				class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
			/>
		{/if}
		<p class="mt-1 text-xs text-[var(--muted)]">{hint}</p>
	</div>
{/snippet}

<div class="flex flex-col gap-5">
	{#if !only}
		<div class="flex gap-1 rounded-lg bg-[var(--surface-hover)] p-1">
			{#each sections as s}
				<button
					onclick={() => (active = s.id)}
					class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors {active ===
					s.id
						? 'bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-sm)]'
						: 'text-[var(--muted)] hover:text-[var(--fg)]'}"
				>
					{s.label}
				</button>
			{/each}
		</div>
	{/if}

	{#if visible === 'appearance'}
		<div>
			<span class="mb-2 block text-sm font-medium text-[var(--fg)]">Theme</span>
			<div class="grid grid-cols-4 gap-2">
				{#each themeOptions as t}
					<button
						onclick={() => patch(() => ({ theme: t.value }))}
						class="rounded-lg border px-2 py-2 text-xs font-medium transition-colors {t.value ===
						$settings.theme
							? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
							: 'border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]'}"
					>
						{t.label}
					</button>
				{/each}
			</div>
		</div>

		{#if $settings.theme === 'custom'}
			<div class="rounded-lg border border-[var(--border)] p-3">
				<span class="mb-1 block text-sm font-medium text-[var(--fg)]">Your colours</span>
				<p class="mb-3 text-xs text-[var(--muted)]">
					Surfaces, borders and muted text are mixed from these two, so they stay legible whichever
					pair you pick.
				</p>

				<div class="grid grid-cols-4 gap-2">
					{#each customFields as f}
						<label class="flex flex-col items-center gap-1.5">
							<input
								type="color"
								value={$settings.customTheme[f.key]}
								oninput={(e) => patchCustom(f.key, e.currentTarget.value)}
								class="h-9 w-full cursor-pointer rounded border border-[var(--border)] bg-transparent"
								aria-label="{f.label} colour"
							/>
							<span class="text-[11px] text-[var(--muted)]">{f.label}</span>
						</label>
					{/each}
				</div>

				<span class="mt-4 mb-2 block text-xs font-medium text-[var(--fg)]">Start from</span>
				<div class="flex flex-wrap gap-1.5">
					{#each presetThemeOptions as t}
						<button
							onclick={() => seedFrom(t.value)}
							class="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg)] transition-colors hover:bg-[var(--surface-hover)]"
						>
							{t.label}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<div>
			<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="font-family">
				Font
			</label>
			<select
				id="font-family"
				value={$settings.fontFamily}
				onchange={(e) => patch(() => ({ fontFamily: e.currentTarget.value }))}
				class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
			>
				{#each fontOptions as f}
					<option value={f.value}>{f.label}</option>
				{/each}
			</select>
		</div>

		<div>
			<label class="mb-2 flex items-baseline justify-between" for="font-size">
				<span class="text-sm font-medium text-[var(--fg)]">Font size</span>
				<span class="text-xs text-[var(--muted)] tabular-nums">
					{$settings.fontSize.toFixed(2)}rem
				</span>
			</label>
			<input
				id="font-size"
				type="range"
				min="0.8"
				max="2.4"
				step="0.05"
				value={$settings.fontSize}
				oninput={(e) => patch(() => ({ fontSize: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
		</div>

		<div>
			<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="line-height">
				Line height
			</label>
			<select
				id="line-height"
				value={$settings.lineHeight}
				onchange={(e) => patch(() => ({ lineHeight: parseFloat(e.currentTarget.value) }))}
				class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
			>
				{#each lineHeights as lh}
					<option value={lh}>{lh}</option>
				{/each}
			</select>
		</div>

		<div>
			<label class="mb-2 flex items-baseline justify-between" for="max-width">
				<span class="text-sm font-medium text-[var(--fg)]">
					{$settings.verticalText ? 'Column length' : 'Reading width'}
				</span>
				<span class="text-xs text-[var(--muted)] tabular-nums">{$settings.maxWidth} chars</span>
			</label>
			<input
				id="max-width"
				type="range"
				min="30"
				max="120"
				step="1"
				value={$settings.maxWidth}
				oninput={(e) => patch(() => ({ maxWidth: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
			{#if $settings.verticalText}
				<p class="mt-1 text-xs text-[var(--muted)]">
					How long each column runs, top to bottom. Capped by the height of the screen, so on a
					short window this may have no effect.
				</p>
			{/if}
		</div>

		<!--
			Only meaningful vertically. Horizontally the line-length cap above
			already leaves margins; vertical text scrolls sideways for ever, so the
			gutters have to come from narrowing the reading pane itself.
		-->
		{#if $settings.verticalText}
			<div>
				<label class="mb-2 flex items-baseline justify-between" for="vertical-width">
					<span class="text-sm font-medium text-[var(--fg)]">Reading width</span>
					<span class="text-xs text-[var(--muted)] tabular-nums">{$settings.verticalWidth}%</span>
				</label>
				<input
					id="vertical-width"
					type="range"
					min="30"
					max="100"
					step="1"
					value={$settings.verticalWidth}
					oninput={(e) => patch(() => ({ verticalWidth: parseFloat(e.currentTarget.value) }))}
					class="w-full accent-[var(--accent)]"
				/>
				<p class="mt-1 text-xs text-[var(--muted)]">
					How much of the screen the text spans, leaving gutters either side. 100% runs edge to
					edge.
				</p>
			</div>
		{/if}

		<div>
			<label class="mb-2 flex items-baseline justify-between" for="side-margins">
				<span class="text-sm font-medium text-[var(--fg)]">Side margins</span>
				<span class="text-xs text-[var(--muted)] tabular-nums">{$settings.sideMargins}px</span>
			</label>
			<input
				id="side-margins"
				type="range"
				min="0"
				max="80"
				step="2"
				value={$settings.sideMargins}
				oninput={(e) => patch(() => ({ sideMargins: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
		</div>

		<div>
			<label class="mb-2 flex items-baseline justify-between" for="para-spacing">
				<span class="text-sm font-medium text-[var(--fg)]">Paragraph spacing</span>
				<span class="text-xs text-[var(--muted)] tabular-nums">
					{$settings.paragraphSpacing.toFixed(1)}em
				</span>
			</label>
			<input
				id="para-spacing"
				type="range"
				min="0"
				max="2.5"
				step="0.1"
				value={$settings.paragraphSpacing}
				oninput={(e) => patch(() => ({ paragraphSpacing: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
		</div>

		<label class="flex items-center justify-between gap-4">
			{@render row('Justify text', 'Aligns both edges of each line')}
			<input
				type="checkbox"
				checked={$settings.justify}
				onchange={(e) => patch(() => ({ justify: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>

		<label class="flex items-center justify-between gap-4">
			{@render row('Vertical text', 'Tategaki: columns top to bottom, right to left')}
			<input
				type="checkbox"
				checked={$settings.verticalText}
				onchange={(e) => patch(() => ({ verticalText: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>
		<p class="-mt-3 text-xs text-[var(--muted)]">
			The reader scrolls sideways, starting at the right edge. Reading width becomes the height of
			each column.
		</p>
	{/if}

	{#if visible === 'reading'}
		<div>
			<span class="mb-2 block text-sm font-medium text-[var(--fg)]">Highlight style</span>
			<div class="grid grid-cols-4 gap-2">
				{#each hlStyles as h}
					<button
						onclick={() => patch(() => ({ hlStyle: h.value }))}
						class="rounded-lg border px-2 py-2 text-xs font-medium transition-colors {h.value ===
						$settings.hlStyle
							? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
							: 'border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]'}"
					>
						{h.label}
					</button>
				{/each}
			</div>
		</div>

		<!--
			Only the fill style paints behind the text, so it is the only one that
			uses the second swatch. Showing both regardless would imply the text
			colour does something in the other styles.
		-->
		{#if $settings.hlStyle !== 'none'}
			<div class="flex items-center justify-between gap-4">
				{@render row(
					$settings.hlStyle === 'background' ? 'Highlight colors' : 'Highlight color',
					colorHint($settings.hlStyle)
				)}
				<div class="flex shrink-0 gap-2">
					<input
						type="color"
						value={$settings.hlBg}
						oninput={(e) => patch(() => ({ hlBg: e.currentTarget.value }))}
						class="h-9 w-9 cursor-pointer rounded border border-[var(--border)] bg-transparent"
						aria-label={$settings.hlStyle === 'background'
							? 'Highlight background color'
							: 'Highlight color'}
					/>
					{#if $settings.hlStyle === 'background'}
						<input
							type="color"
							value={$settings.hlFg}
							oninput={(e) => patch(() => ({ hlFg: e.currentTarget.value }))}
							class="h-9 w-9 cursor-pointer rounded border border-[var(--border)] bg-transparent"
							aria-label="Highlight text color"
						/>
					{/if}
				</div>
			</div>
		{/if}

		<div>
			<label class="mb-2 flex items-baseline justify-between" for="scroll-anchor">
				<span class="text-sm font-medium text-[var(--fg)]">Highlight position</span>
				<span class="text-xs text-[var(--muted)]">{anchorLabel($settings.scrollAnchor)}</span>
			</label>
			<input
				id="scroll-anchor"
				type="range"
				min="0.15"
				max="0.75"
				step="0.05"
				value={$settings.scrollAnchor}
				oninput={(e) => patch(() => ({ scrollAnchor: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
			<p class="mt-1 text-xs text-[var(--muted)]">
				Where the current line sits as the page auto-scrolls.
			</p>
		</div>

		<label class="flex items-center justify-between gap-4">
			{@render row('Smooth scrolling', 'Animate instead of jumping')}
			<input
				type="checkbox"
				checked={$settings.smoothScroll}
				onchange={(e) => patch(() => ({ smoothScroll: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>

		<label class="flex items-center justify-between gap-4">
			{@render row('Auto-hide controls', 'Tap the page to show them again')}
			<input
				type="checkbox"
				checked={$settings.autoHideChrome}
				onchange={(e) => patch(() => ({ autoHideChrome: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>

		<div class="border-t border-[var(--border)] pt-5">
			<span class="mb-2 block text-sm font-medium text-[var(--fg)]">Arrow keys</span>
			<div class="grid grid-cols-2 gap-2">
				{#each arrowKeyOptions as a}
					<button
						onclick={() => patch(() => ({ arrowKeys: a.value as ArrowKeyMode }))}
						class="rounded-lg border px-2 py-2 text-xs font-medium transition-colors {a.value ===
						$settings.arrowKeys
							? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
							: 'border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]'}"
					>
						{a.label}
					</button>
				{/each}
			</div>
			<p class="mt-1 text-xs text-[var(--muted)]">
				Holding Alt always gives the other one, so both are reachable either way.
			</p>
		</div>

		<div>
			<label class="mb-2 flex items-baseline justify-between" for="seek-step">
				<span class="text-sm font-medium text-[var(--fg)]">Seek step</span>
				<span class="text-xs text-[var(--muted)] tabular-nums">{$settings.seekStep}s</span>
			</label>
			<input
				id="seek-step"
				type="range"
				min="2"
				max="60"
				step="1"
				value={$settings.seekStep}
				oninput={(e) => patch(() => ({ seekStep: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
		</div>

		<label class="flex items-center justify-between gap-4">
			{@render row('Repeat mode', 'Pause at the end of every line')}
			<input
				type="checkbox"
				checked={$settings.repeatMode}
				onchange={(e) => patch(() => ({ repeatMode: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>
		<p class="-mt-3 text-xs text-[var(--muted)]">
			Playback stops when a line finishes. <kbd class="text-[var(--fg)]">R</kbd> plays it again,
			<kbd class="text-[var(--fg)]">↵</kbd> moves on to the next one.
		</p>

		<label class="flex items-center justify-between gap-4">
			{@render row('Keep quotes whole', 'Play right through 「 」 without stopping')}
			<input
				type="checkbox"
				checked={$settings.repeatWholeQuotes}
				onchange={(e) => patch(() => ({ repeatWholeQuotes: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>
		<p class="-mt-3 text-xs text-[var(--muted)]">
			A line of dialogue usually runs across several cues. With this on, the whole quoted utterance
			is one repeat unit — including 『 』 nested inside it.
		</p>

		<div class="border-t border-[var(--border)] pt-5">
			<span class="mb-2 block text-sm font-medium text-[var(--fg)]">Shortcuts</span>
			<dl class="flex flex-col gap-1.5">
				{#each shownShortcuts as s}
					<div class="flex items-baseline justify-between gap-4">
						<dt class="shrink-0 font-mono text-xs text-[var(--fg)]">{s.keys}</dt>
						<dd class="text-right text-xs text-[var(--muted)]">{s.what}</dd>
					</div>
				{/each}
			</dl>
		</div>
	{/if}

	{#if visible === 'sync'}
		<div>
			<label class="mb-2 flex items-baseline justify-between" for="timing-offset">
				<span class="text-sm font-medium text-[var(--fg)]">Default timing offset</span>
				<span class="text-xs text-[var(--muted)] tabular-nums">
					{$settings.timingOffset > 0 ? '+' : ''}{$settings.timingOffset.toFixed(2)}s
				</span>
			</label>
			<input
				id="timing-offset"
				type="range"
				min="-5"
				max="5"
				step="0.05"
				value={$settings.timingOffset}
				oninput={(e) => patch(() => ({ timingOffset: parseFloat(e.currentTarget.value) }))}
				class="w-full accent-[var(--accent)]"
			/>
			<p class="mt-1 text-xs text-[var(--muted)]">
				Applies to books you have not tuned individually. Positive values move the highlight ahead
				of the audio. Each book can override this from the reader.
			</p>
		</div>

		{#if showSubtitleOptions}
			<div>
				<label class="mb-2 flex items-baseline justify-between" for="gap-threshold">
					<span class="text-sm font-medium text-[var(--fg)]">Paragraph gap</span>
					<span class="text-xs text-[var(--muted)] tabular-nums">
						{$settings.gapThreshold.toFixed(1)}s
					</span>
				</label>
				<input
					id="gap-threshold"
					type="range"
					min="0.5"
					max="3"
					step="0.1"
					value={$settings.gapThreshold}
					oninput={(e) => patch(() => ({ gapThreshold: parseFloat(e.currentTarget.value) }))}
					class="w-full accent-[var(--accent)]"
				/>
				<p class="mt-1 text-xs text-[var(--muted)]">
					Silence longer than this starts a new paragraph. Only used when a book has no EPUB.
				</p>
			</div>

			<label class="flex items-center justify-between gap-4">
				{@render row('Show non-speech cues', 'Such as [music] and [applause]')}
				<input
					type="checkbox"
					checked={$settings.showNonSpeech}
					onchange={(e) => patch(() => ({ showNonSpeech: e.currentTarget.checked }))}
					class="h-5 w-5 shrink-0 accent-[var(--accent)]"
				/>
			</label>
		{/if}
	{/if}

	{#if visible === 'anki'}
		<label class="flex items-center justify-between gap-4">
			{@render row('Enable mining', 'Adds a mine button to the reader')}
			<input
				type="checkbox"
				checked={$settings.ankiEnabled}
				onchange={(e) => patch(() => ({ ankiEnabled: e.currentTarget.checked }))}
				class="h-5 w-5 shrink-0 accent-[var(--accent)]"
			/>
		</label>

		{#if $settings.ankiEnabled}
			<div>
				<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="anki-url">
					AnkiConnect address
				</label>
				<input
					id="anki-url"
					type="url"
					value={$settings.ankiUrl}
					oninput={(e) => patch(() => ({ ankiUrl: e.currentTarget.value }))}
					placeholder="http://localhost:8765"
					class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
				/>
				<div class="mt-2 flex items-center gap-2">
					<button
						onclick={testAnki}
						disabled={ankiState === 'testing'}
						class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
					>
						{ankiState === 'testing' ? 'Connecting…' : 'Connect'}
					</button>
					{#if ankiState === 'ok'}
						<span class="text-xs text-[var(--accent)]">Connected</span>
					{/if}
				</div>
				{#if ankiMessage}
					<p class="mt-2 text-xs {ankiState === 'error' ? 'text-red-500' : 'text-[var(--muted)]'}">
						{ankiMessage}
					</p>
				{/if}
				<p class="mt-2 text-xs text-[var(--muted)]">
					Anki must be open on this device with the AnkiConnect add-on, and this site's address
					listed in AnkiConnect's <code>webCorsOriginList</code>.
				</p>
			</div>

			<div>
				<span class="mb-2 block text-sm font-medium text-[var(--fg)]">When mining</span>
				<div class="grid grid-cols-2 gap-2">
					{#each ankiModeOptions as m}
						<button
							onclick={() => patch(() => ({ ankiMode: m.value as AnkiMode }))}
							class="rounded-lg border px-2 py-2 text-xs font-medium transition-colors {m.value ===
							$settings.ankiMode
								? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
								: 'border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]'}"
						>
							{m.label}
						</button>
					{/each}
				</div>
				<p class="mt-1 text-xs text-[var(--muted)]">
					{#if $settings.ankiMode === 'update-last'}
						Attaches the clip to the most recent card you made — look the word up first, then mine
						the line it came from.
					{:else}
						Makes a new card holding the sentence and its audio.
					{/if}
				</p>
			</div>

			<div>
				<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="anki-model">
					Note type
				</label>
				{#if models.length > 0}
					<select
						id="anki-model"
						value={$settings.ankiModel}
						onchange={(e) => chooseModel(e.currentTarget.value)}
						class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
					>
						<option value="">Select…</option>
						{#each models as m}
							<option value={m}>{m}</option>
						{/each}
					</select>
				{:else}
					<input
						id="anki-model"
						type="text"
						value={$settings.ankiModel}
						oninput={(e) => patch(() => ({ ankiModel: e.currentTarget.value }))}
						placeholder="Connect to list your note types"
						class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
					/>
				{/if}
				{#if $settings.ankiMode === 'update-last'}
					<p class="mt-1 text-xs text-[var(--muted)]">
						Only used to list field names below. The card that gets updated is whichever one you
						made last.
					</p>
				{/if}
			</div>

			{#if $settings.ankiMode === 'create'}
				<div>
					<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="anki-deck">Deck</label
					>
					{#if decks.length > 0}
						<select
							id="anki-deck"
							value={$settings.ankiDeck}
							onchange={(e) => patch(() => ({ ankiDeck: e.currentTarget.value }))}
							class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
						>
							<option value="">Select…</option>
							{#each decks as d}
								<option value={d}>{d}</option>
							{/each}
						</select>
					{:else}
						<input
							id="anki-deck"
							type="text"
							value={$settings.ankiDeck}
							oninput={(e) => patch(() => ({ ankiDeck: e.currentTarget.value }))}
							placeholder="Connect to list your decks"
							class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
						/>
					{/if}
				</div>
			{/if}

			{@render fieldRow(
				'anki-audio-field',
				'Audio field',
				'Receives the [sound:…] tag',
				$settings.ankiAudioField,
				(v) => patch(() => ({ ankiAudioField: v }))
			)}

			{#if $settings.ankiMode === 'create' || $settings.ankiUpdateSentence}
				{@render fieldRow(
					'anki-sentence-field',
					'Sentence field',
					'Receives the sentence text',
					$settings.ankiSentenceField,
					(v) => patch(() => ({ ankiSentenceField: v }))
				)}
			{/if}

			{#if $settings.ankiMode === 'update-last'}
				<label class="flex items-center justify-between gap-4">
					{@render row('Also write the sentence', 'Overwrites the sentence field on that card')}
					<input
						type="checkbox"
						checked={$settings.ankiUpdateSentence}
						onchange={(e) => patch(() => ({ ankiUpdateSentence: e.currentTarget.checked }))}
						class="h-5 w-5 shrink-0 accent-[var(--accent)]"
					/>
				</label>

				<div>
					<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="anki-query">
						Last card search
					</label>
					<input
						id="anki-query"
						type="text"
						value={$settings.ankiLastCardQuery}
						oninput={(e) => patch(() => ({ ankiLastCardQuery: e.currentTarget.value }))}
						placeholder="added:1"
						class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm text-[var(--fg)]"
					/>
					<p class="mt-1 text-xs text-[var(--muted)]">
						An Anki search; the newest note it matches is the one updated. Narrow it with something
						like <code>added:1 deck:Mining</code> if you add cards from elsewhere too.
					</p>
				</div>
			{/if}

			<div>
				<label class="mb-2 block text-sm font-medium text-[var(--fg)]" for="anki-tags">Tags</label>
				<input
					id="anki-tags"
					type="text"
					value={$settings.ankiTags}
					oninput={(e) => patch(() => ({ ankiTags: e.currentTarget.value }))}
					placeholder="read-along"
					class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]"
				/>
				<p class="mt-1 text-xs text-[var(--muted)]">
					Space or comma separated. Leave blank for none.
				</p>
			</div>

			<div>
				<label class="mb-2 flex items-baseline justify-between" for="anki-pad-start">
					<span class="text-sm font-medium text-[var(--fg)]">Lead-in</span>
					<span class="text-xs text-[var(--muted)] tabular-nums">
						{$settings.ankiPadStart.toFixed(2)}s
					</span>
				</label>
				<input
					id="anki-pad-start"
					type="range"
					min="0"
					max="1.5"
					step="0.05"
					value={$settings.ankiPadStart}
					oninput={(e) => patch(() => ({ ankiPadStart: parseFloat(e.currentTarget.value) }))}
					class="w-full accent-[var(--accent)]"
				/>
			</div>

			<div>
				<label class="mb-2 flex items-baseline justify-between" for="anki-pad-end">
					<span class="text-sm font-medium text-[var(--fg)]">Tail</span>
					<span class="text-xs text-[var(--muted)] tabular-nums">
						{$settings.ankiPadEnd.toFixed(2)}s
					</span>
				</label>
				<input
					id="anki-pad-end"
					type="range"
					min="0"
					max="1.5"
					step="0.05"
					value={$settings.ankiPadEnd}
					oninput={(e) => patch(() => ({ ankiPadEnd: parseFloat(e.currentTarget.value) }))}
					class="w-full accent-[var(--accent)]"
				/>
				<p class="mt-1 text-xs text-[var(--muted)]">
					Extra audio kept around the line, so a slightly early or late timestamp does not clip a
					word.
				</p>
			</div>

			<div class="border-t border-[var(--border)] pt-5">
				<span class="mb-2 block text-sm font-medium text-[var(--fg)]">After making a card</span>
				<div class="grid grid-cols-2 gap-2">
					{#each minePauseOptions as m}
						<button
							onclick={() => patch(() => ({ ankiPauseAfter: m.value as MinePause }))}
							class="rounded-lg border px-2 py-2 text-xs font-medium transition-colors {m.value ===
							$settings.ankiPauseAfter
								? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
								: 'border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]'}"
						>
							{m.label}
						</button>
					{/each}
				</div>
				<p class="mt-1 text-xs text-[var(--muted)]">
					{minePauseOptions.find((m) => m.value === $settings.ankiPauseAfter)?.hint}
				</p>
			</div>
		{/if}
	{/if}

	<button
		onclick={() => settings.reset()}
		class="mt-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--surface-hover)]"
	>
		Reset all to defaults
	</button>
</div>
