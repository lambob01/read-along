<script lang="ts">
	import { goto } from '$app/navigation';
	import SettingsPanel from '$lib/components/SettingsPanel.svelte';
	import { settings } from '$lib/stores/settings';
</script>

<div class="min-h-screen bg-[var(--bg)]">
	<header
		class="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/85 px-4 py-3 backdrop-blur sm:px-6"
	>
		<div class="mx-auto flex max-w-2xl items-center gap-2">
			<button
				onclick={() => history.back()}
				class="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
				aria-label="Back"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
			<h1 class="text-lg font-semibold tracking-tight text-[var(--fg)]">Settings</h1>
		</div>
	</header>

	<main class="mx-auto max-w-2xl px-4 py-6 sm:px-6">
		<!-- A live specimen: every appearance control below retargets this block,
		     so the effect is visible without opening a book. In vertical mode it
		     scrolls sideways from the right, exactly as the reader does. -->
		<div class="mb-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
			<p class="mb-2 text-xs tracking-wide text-[var(--muted)] uppercase">Preview</p>
			<div
				data-vertical={$settings.verticalText}
				class="reader-content reader-pane {$settings.verticalText ? 'h-64 overflow-x-auto' : ''}"
				style="font-family: var(--theme-font-family);
				font-size: var(--theme-font-size);
				line-height: var(--theme-line-height);
				text-align: var(--theme-text-align);"
			>
				<p class="reader-paragraph">
					The harbour had emptied by the time she reached the quay, and the gulls had gone quiet.
				</p>
				<p class="reader-paragraph" style="margin-block-end: 0;">
					<span class="hl-preview">This sentence shows the active highlight.</span>
					The rest of the paragraph stays as it is until the audio reaches it.
				</p>
			</div>
		</div>

		<SettingsPanel />

		<div class="mt-8 border-t border-[var(--border)] pt-6">
			<button
				onclick={() => goto('/library')}
				class="text-sm font-medium text-[var(--accent)] hover:underline"
			>
				Back to library
			</button>
		</div>
	</main>
</div>

<style>
	/*
		Mirrors the reader's highlight treatments. The reader itself uses the CSS
		Highlight API against live ranges, which cannot be applied to static
		sample markup, so the preview restates the same styles on a plain span.
	*/
	.hl-preview {
		border-radius: 2px;
	}

	:global(:root[data-hl-style='background']) .hl-preview {
		background-color: var(--hl-bg);
		color: var(--hl-fg);
	}

	:global(:root[data-hl-style='underline']) .hl-preview {
		text-decoration: underline 0.12em var(--hl-bg);
		text-underline-offset: 0.18em;
	}

	:global(:root[data-hl-style='text']) .hl-preview {
		color: var(--hl-bg);
		font-weight: 600;
	}
</style>
