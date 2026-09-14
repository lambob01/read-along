<script lang="ts">
	import '../app.css';
	import { settings, applySettingsToDOM } from '$lib/stores/settings';
	import { syncThemeColor } from '$lib/themeColor';
	import { onMount } from 'svelte';

	let { children } = $props();

	// The store applies settings on every change; this covers the first paint,
	// which happens before any change has been made.
	onMount(() => {
		applySettingsToDOM($settings);
	});

	// Browser chrome takes its colour from the meta tag, which no theme rule
	// can reach; repaint it whenever the theme changes.
	$effect(() => {
		const theme = $settings.theme;
		syncThemeColor(theme);
	});
</script>

<div class="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
	{@render children()}
</div>
