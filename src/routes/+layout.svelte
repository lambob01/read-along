<script lang="ts">
	import '../app.css';
	import { settings, applySettingsToDOM } from '$lib/stores/settings';
	import { onMount } from 'svelte';

	let { children } = $props();

	// The store applies settings on every change; this covers the first paint,
	// which happens before any change has been made.
	onMount(() => {
		applySettingsToDOM($settings);
	});
</script>

<div class="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
	{@render children()}
</div>
