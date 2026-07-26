<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { recent, type RecentBook } from '$lib/stores/recent';
	import { ABSClient } from '$lib/abs/client';
	import { getLibraries, getLibraryItems } from '$lib/abs/api';
	import type { ABSLibrary, ABSItem } from '$lib/types';

	let libraries: ABSLibrary[] = $state([]);
	let items: ABSItem[] = $state([]);
	let selectedLibraryId: string | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let searchQuery = $state('');

	let connectionUrl = '';
	let connectionToken = '';

	connection.subscribe((s) => {
		connectionUrl = s.url;
		connectionToken = s.token;
	});

	onMount(async () => {
		if (!connectionUrl || !connectionToken) {
			await goto('/');
			return;
		}

		try {
			const client = new ABSClient(
				'/abs',
				connectionToken
			);
			const libs = await getLibraries(client);
			libraries = libs;

			if (libs.length > 0) {
				selectedLibraryId = libs[0].id;
				items = await getLibraryItems(client, libs[0].id);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load';
		} finally {
			loading = false;
		}
	});

	async function selectLibrary(id: string) {
		selectedLibraryId = id;
		loading = true;
		try {
			const client = new ABSClient('/abs', connectionToken);
			items = await getLibraryItems(client, id);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	function openItem(itemId: string) {
		goto(`/read/${itemId}`);
	}

	function getCoverUrl(itemId: string): string {
		return `/abs/api/items/${itemId}/cover?token=${encodeURIComponent(connectionToken)}`;
	}

	function progressPercent(book: Pick<RecentBook, 'position' | 'duration'>): number {
		if (!book.duration) return 0;
		return Math.min(100, Math.max(0, (book.position / book.duration) * 100));
	}

	function timeLeftLabel(book: Pick<RecentBook, 'position' | 'duration'>): string {
		const remaining = Math.max(0, book.duration - book.position);
		if (!book.duration || remaining < 60) return 'Almost done';
		const h = Math.floor(remaining / 3600);
		const m = Math.round((remaining % 3600) / 60);
		if (h > 0) return `${h}h ${m}m left`;
		return `${m}m left`;
	}

	const recentMap = $derived(new Map($recent.map((b) => [b.itemId, b])));

	const filteredItems = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return items;
		return items.filter((item) => {
			const title = item.media?.metadata?.title?.toLowerCase() || '';
			const author = item.media?.metadata?.authorName?.toLowerCase() || '';
			return title.includes(q) || author.includes(q);
		});
	});
</script>

<div class="min-h-screen bg-[var(--bg)]">
	<header class="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/80 px-4 py-4 backdrop-blur sm:px-6">
		<div class="mx-auto flex max-w-6xl items-center justify-between">
			<h1 class="text-lg font-semibold tracking-tight text-[var(--fg)]">Library</h1>
			<button
				onclick={() => {
					connection.disconnect();
					goto('/');
				}}
				class="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
			>
				Disconnect
			</button>
		</div>

		<div class="mx-auto mt-3 max-w-6xl">
			<div class="relative">
				<svg
					class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					stroke-width="2"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
				</svg>
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search by title or author…"
					aria-label="Search books"
					class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] py-2 pl-9 pr-9 text-sm text-[var(--fg)] placeholder-[var(--muted)] transition-colors focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]"
				/>
				{#if searchQuery}
					<button
						onclick={() => (searchQuery = '')}
						aria-label="Clear search"
						class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--fg)]"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				{/if}
			</div>
		</div>

		{#if libraries.length > 1}
			<div class="mx-auto mt-3 flex max-w-6xl gap-2">
				{#each libraries as lib}
					<button
						onclick={() => selectLibrary(lib.id)}
						class="rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors {selectedLibraryId === lib.id
							? 'bg-[var(--accent)] text-[var(--accent-fg)]'
							: 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'}"
					>
						{lib.name}
					</button>
				{/each}
			</div>
		{/if}
	</header>

	<main class="mx-auto max-w-6xl px-4 py-6 sm:px-6">
		{#if loading}
			<p class="text-sm text-[var(--muted)]">Loading…</p>
		{:else if error}
			<p class="text-sm text-red-500">{error}</p>
		{:else}
			{#if $recent.length > 0 && !searchQuery.trim()}
				<section class="mb-8">
					<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
						Continue Listening
					</h2>
					<div class="-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
						{#each $recent as book (book.itemId)}
							<button
								onclick={() => openItem(book.itemId)}
								class="group w-40 shrink-0 text-left sm:w-44"
							>
								<div class="relative aspect-square overflow-hidden rounded-xl bg-[var(--surface)] shadow-[var(--shadow-sm)] transition-shadow group-hover:shadow-[var(--shadow-md)]">
									<img
										src={getCoverUrl(book.itemId)}
										alt=""
										class="h-full w-full object-cover"
										loading="lazy"
									/>
									<div class="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
										<span class="flex h-10 w-10 scale-90 items-center justify-center rounded-full bg-white/90 opacity-0 shadow-lg transition-all group-hover:scale-100 group-hover:opacity-100">
											<svg class="h-4 w-4 translate-x-0.5 text-black" fill="currentColor" viewBox="0 0 24 24"
												><path d="M8 5v14l11-7z" /></svg
											>
										</span>
									</div>
									<div class="absolute inset-x-0 bottom-0 h-1 bg-black/20">
										<div
											class="h-full bg-[var(--accent)]"
											style="width: {progressPercent(book)}%"
										></div>
									</div>
								</div>
								<p class="mt-2 truncate text-sm font-medium text-[var(--fg)]">{book.title}</p>
								<p class="truncate text-xs text-[var(--muted)]">{timeLeftLabel(book)}</p>
							</button>
						{/each}
					</div>
				</section>
			{/if}

			{#if items.length === 0}
				<p class="text-sm text-[var(--muted)]">No items found</p>
			{:else if filteredItems.length === 0}
				<p class="text-sm text-[var(--muted)]">No books match "{searchQuery.trim()}"</p>
			{:else}
				{#if $recent.length > 0 && !searchQuery.trim()}
					<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
						All Books
					</h2>
				{:else if searchQuery.trim()}
					<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
						{filteredItems.length} {filteredItems.length === 1 ? 'result' : 'results'}
					</h2>
				{/if}
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
					{#each filteredItems as item}
						<button
							onclick={() => openItem(item.id)}
							class="group text-left"
						>
							<div class="relative aspect-square overflow-hidden rounded-xl bg-[var(--surface)] shadow-[var(--shadow-sm)] transition-shadow group-hover:shadow-[var(--shadow-md)]">
								<img
									src={getCoverUrl(item.id)}
									alt=""
									class="h-full w-full object-cover"
									loading="lazy"
								/>
								<div class="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
									<span class="flex h-10 w-10 scale-90 items-center justify-center rounded-full bg-white/90 opacity-0 shadow-lg transition-all group-hover:scale-100 group-hover:opacity-100">
										<svg class="h-4 w-4 translate-x-0.5 text-black" fill="currentColor" viewBox="0 0 24 24"
											><path d="M8 5v14l11-7z" /></svg
										>
									</span>
								</div>
								{#if recentMap.get(item.id)}
									<div class="absolute inset-x-0 bottom-0 h-1 bg-black/20">
										<div
											class="h-full bg-[var(--accent)]"
											style="width: {progressPercent(recentMap.get(item.id)!)}%"
										></div>
									</div>
								{/if}
							</div>
							<div class="mt-2">
								<p class="truncate text-sm font-medium text-[var(--fg)]">
									{item.media?.metadata?.title || 'Unknown'}
								</p>
								<p class="truncate text-xs text-[var(--muted)]">
									{item.media?.metadata?.authorName || 'Unknown'}
								</p>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	</main>
</div>
