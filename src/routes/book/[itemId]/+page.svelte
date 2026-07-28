<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { player } from '$lib/stores/player';
	import { recent } from '$lib/stores/recent';
	import { ABSClient } from '$lib/abs/client';
	import { getItem } from '$lib/abs/api';
	import {
		toBookDetails,
		formatDuration,
		formatSize,
		descriptionToParagraphs,
		type BookDetails
	} from '$lib/abs/metadata';

	const itemId = $derived($page.params.itemId ?? '');

	let details = $state<BookDetails | null>(null);
	let chapters = $state<{ start: number; title: string }[]>([]);
	let loading = $state(true);
	let error = $state('');
	let descriptionExpanded = $state(false);
	let showAllChapters = $state(false);

	let connectionToken = '';
	connection.subscribe((s) => {
		connectionToken = s.token;
	});

	onMount(async () => {
		if (!connectionToken) {
			await goto('/');
			return;
		}
		try {
			const client = new ABSClient('/abs', connectionToken);
			const item = await getItem(client, itemId);
			details = toBookDetails(item);
			chapters = item?.media?.chapters ?? [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load book';
		} finally {
			loading = false;
		}
	});

	const coverUrl = $derived(
		`/abs/api/items/${itemId}/cover?token=${encodeURIComponent(connectionToken)}`
	);

	const savedPosition = $derived(player.getBookmark(itemId) ?? 0);
	const recentEntry = $derived($recent.find((b) => b.itemId === itemId));

	const progressPercent = $derived.by(() => {
		const total = details?.duration || recentEntry?.duration || 0;
		if (!total || !savedPosition) return 0;
		return Math.min(100, (savedPosition / total) * 100);
	});

	const paragraphs = $derived(descriptionToParagraphs(details?.description ?? null));

	const visibleChapters = $derived(showAllChapters ? chapters : chapters.slice(0, 8));

	function formatTimestamp(s: number): string {
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = Math.floor(s % 60);
		const mm = m.toString().padStart(2, '0');
		const ss = sec.toString().padStart(2, '0');
		return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
	}

	function open(fromStart = false) {
		goto(`/read/${itemId}${fromStart ? '?restart=1' : ''}`);
	}
</script>

<div class="min-h-screen bg-[var(--bg)]">
	<header
		class="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/85 px-4 py-3 backdrop-blur sm:px-6"
	>
		<div class="mx-auto flex max-w-4xl items-center gap-2">
			<button
				onclick={() => goto('/library')}
				class="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
				aria-label="Back to library"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
			<span class="truncate text-sm font-medium text-[var(--fg)]">
				{details?.title ?? 'Book'}
			</span>
		</div>
	</header>

	<main class="mx-auto max-w-4xl px-4 py-6 sm:px-6">
		{#if loading}
			<p class="text-sm text-[var(--muted)]">Loading…</p>
		{:else if error}
			<p class="text-sm text-red-500">{error}</p>
		{:else if details}
			<div class="flex flex-col gap-6 sm:flex-row sm:gap-8">
				<div class="mx-auto w-48 shrink-0 sm:mx-0 sm:w-56">
					<div
						class="aspect-square overflow-hidden rounded-xl bg-[var(--surface)] shadow-[var(--shadow-lg)]"
					>
						<img src={coverUrl} alt="" class="h-full w-full object-cover" />
					</div>
				</div>

				<div class="min-w-0 flex-1">
					<h1 class="text-2xl font-semibold tracking-tight text-[var(--fg)]">
						{details.title}
					</h1>
					{#if details.subtitle}
						<p class="mt-1 text-base text-[var(--muted)]">{details.subtitle}</p>
					{/if}
					<p class="mt-2 text-sm text-[var(--fg)]">{details.authorName}</p>
					{#if details.narratorName}
						<p class="text-sm text-[var(--muted)]">Narrated by {details.narratorName}</p>
					{/if}
					{#if details.seriesName}
						<p class="mt-1 text-sm text-[var(--muted)]">{details.seriesName}</p>
					{/if}

					<!-- Sync capability is the one thing that decides whether this app
					     can do its job on a given book, so it is stated up front. -->
					<div class="mt-4 flex flex-wrap gap-2">
						{#if details.hasSubtitle && details.hasEpub}
							<span
								class="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]"
							>
								Read-along ready
							</span>
						{:else if details.hasSubtitle}
							<span
								class="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]"
							>
								Transcript only
							</span>
						{:else}
							<span
								class="rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--muted)]"
							>
								Audio only — no transcript
							</span>
						{/if}
						{#if details.explicit}
							<span
								class="rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--muted)]"
							>
								Explicit
							</span>
						{/if}
					</div>

					{#if progressPercent > 0}
						<div class="mt-5">
							<div class="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
								<div
									class="h-full rounded-full bg-[var(--accent)]"
									style="width: {progressPercent}%"
								></div>
							</div>
							<p class="mt-1.5 text-xs text-[var(--muted)]">
								{Math.round(progressPercent)}% · {formatTimestamp(savedPosition)} in
							</p>
						</div>
					{/if}

					<div class="mt-5 flex flex-wrap gap-2">
						<button
							onclick={() => open(false)}
							class="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--accent-fg)] shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--accent-hover)]"
						>
							{savedPosition > 0 ? 'Continue reading' : 'Start reading'}
						</button>
						{#if savedPosition > 0}
							<button
								onclick={() => open(true)}
								class="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[var(--fg)] transition-colors hover:bg-[var(--surface-hover)]"
							>
								Start over
							</button>
						{/if}
					</div>
				</div>
			</div>

			<dl
				class="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--border)] pt-6 sm:grid-cols-4"
			>
				<div>
					<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">Duration</dt>
					<dd class="mt-1 text-sm text-[var(--fg)]">{formatDuration(details.duration)}</dd>
				</div>
				<div>
					<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">Chapters</dt>
					<dd class="mt-1 text-sm text-[var(--fg)]">{details.chapterCount || '—'}</dd>
				</div>
				{#if details.publishedYear}
					<div>
						<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">Published</dt>
						<dd class="mt-1 text-sm text-[var(--fg)]">{details.publishedYear}</dd>
					</div>
				{/if}
				{#if details.publisher}
					<div>
						<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">Publisher</dt>
						<dd class="mt-1 truncate text-sm text-[var(--fg)]">{details.publisher}</dd>
					</div>
				{/if}
				{#if details.language}
					<div>
						<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">Language</dt>
						<dd class="mt-1 text-sm text-[var(--fg)]">{details.language}</dd>
					</div>
				{/if}
				{#if formatSize(details.sizeBytes)}
					<div>
						<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">Size</dt>
						<dd class="mt-1 text-sm text-[var(--fg)]">{formatSize(details.sizeBytes)}</dd>
					</div>
				{/if}
				{#if details.isbn}
					<div>
						<dt class="text-xs tracking-wide text-[var(--muted)] uppercase">ISBN / ASIN</dt>
						<dd class="mt-1 truncate text-sm text-[var(--fg)]">{details.isbn}</dd>
					</div>
				{/if}
			</dl>

			{#if details.genres.length > 0}
				<div class="mt-6 flex flex-wrap gap-2">
					{#each details.genres as genre}
						<span class="rounded-full bg-[var(--surface)] px-3 py-1 text-xs text-[var(--muted)]">
							{genre}
						</span>
					{/each}
				</div>
			{/if}

			{#if paragraphs.length > 0}
				<section class="mt-8 border-t border-[var(--border)] pt-6">
					<h2 class="text-sm font-semibold tracking-wide text-[var(--muted)] uppercase">
						Description
					</h2>
					<div
						class="mt-3 space-y-3 text-sm leading-relaxed text-[var(--fg)] {descriptionExpanded
							? ''
							: 'line-clamp-6'}"
					>
						{#each paragraphs as para}
							<p>{para}</p>
						{/each}
					</div>
					{#if paragraphs.join(' ').length > 400}
						<button
							onclick={() => (descriptionExpanded = !descriptionExpanded)}
							class="mt-2 text-sm font-medium text-[var(--accent)] hover:underline"
						>
							{descriptionExpanded ? 'Show less' : 'Show more'}
						</button>
					{/if}
				</section>
			{/if}

			{#if chapters.length > 0}
				<section class="mt-8 border-t border-[var(--border)] pt-6">
					<h2 class="text-sm font-semibold tracking-wide text-[var(--muted)] uppercase">
						Chapters
					</h2>
					<ol class="mt-3 divide-y divide-[var(--border)]">
						{#each visibleChapters as ch, i}
							<li class="flex items-baseline gap-3 py-2">
								<span class="w-6 shrink-0 text-xs text-[var(--muted)] tabular-nums">
									{i + 1}
								</span>
								<span class="min-w-0 flex-1 truncate text-sm text-[var(--fg)]">
									{ch.title}
								</span>
								<span class="shrink-0 text-xs text-[var(--muted)] tabular-nums">
									{formatTimestamp(ch.start)}
								</span>
							</li>
						{/each}
					</ol>
					{#if chapters.length > 8}
						<button
							onclick={() => (showAllChapters = !showAllChapters)}
							class="mt-2 text-sm font-medium text-[var(--accent)] hover:underline"
						>
							{showAllChapters ? 'Show fewer' : `Show all ${chapters.length} chapters`}
						</button>
					{/if}
				</section>
			{/if}
		{/if}
	</main>
</div>
