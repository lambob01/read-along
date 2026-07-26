<script lang="ts">
	import '../app.css';
	import { settings, defaultSettings } from '$lib/stores/settings';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		settings.subscribe((s) => {
			const root = document.documentElement;
			root.style.setProperty('--theme-font-size', `${s.fontSize}rem`);
			root.style.setProperty('--theme-line-height', String(s.lineHeight));
			root.style.setProperty('--theme-font-family', s.fontFamily);
			root.style.setProperty('--theme-max-width', `${s.maxWidth}ch`);
			root.style.setProperty('--theme-side-margins', `${s.sideMargins}px`);
			root.style.setProperty('--hl-bg', s.hlBg);
			root.style.setProperty('--hl-fg', s.hlFg);
			root.dataset.theme = s.theme;
		})();
	});

	function toggleTheme() {
		settings.update((s) => {
			const themes = ['light', 'dark', 'sepia', 'oled'] as const;
			const idx = themes.indexOf(s.theme);
			return { ...s, theme: themes[(idx + 1) % themes.length] };
		});
	}
</script>

<div class="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
	{@render children()}
</div>

<button
	onclick={toggleTheme}
	class="fixed bottom-20 right-3 z-50 sm:bottom-4 sm:right-4 rounded-full border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-lg hover:bg-[var(--border)] min-w-[44px] min-h-[44px] flex items-center justify-center"
	aria-label="Toggle theme"
>
	{#if $settings.theme === 'dark'}
		<svg class="h-5 w-5 text-[var(--fg)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" stroke-width="2"/><path stroke-linecap="round" stroke-width="2" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
	{:else if $settings.theme === 'sepia'}
		<svg class="h-5 w-5 text-[var(--fg)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke-width="2"/><path stroke-linecap="round" stroke-width="2" d="M8 2v4M16 2v4M8 18v4M16 18v4M2 8h4M18 8h4M2 16h4M18 16h4"/></svg>
	{:else}
		<svg class="h-5 w-5 text-[var(--fg)]" fill="currentColor" viewBox="0 0 24 24"><path d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/></svg>
	{/if}
</button>
