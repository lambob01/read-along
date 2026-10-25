<script lang="ts">
	import { isDarkTheme, settings, toggledTheme } from '$lib/stores/settings';

	const dark = $derived(isDarkTheme($settings));

	function toggle() {
		settings.update((s) => ({ ...s, theme: toggledTheme(s) }));
	}
</script>

<button
	type="button"
	onclick={toggle}
	aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
	aria-pressed={dark}
	title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
	class="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:outline-none"
>
	{#if dark}
		<svg
			class="h-4 w-4"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
			stroke-width="1.8"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path
				stroke-linecap="round"
				d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"
			/>
		</svg>
	{:else}
		<svg
			class="h-4 w-4"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
			stroke-width="1.8"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M20.5 14.2A8.5 8.5 0 019.8 3.5 8.5 8.5 0 1020.5 14.2z"
			/>
		</svg>
	{/if}
</button>
