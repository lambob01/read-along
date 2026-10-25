<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { connection } from '$lib/stores/connection';
	import { recent, type RecentBook } from '$lib/stores/recent';
	import { ABSClient } from '$lib/abs/client';
	import { getLibraries, getLibraryItems } from '$lib/abs/api';
	import { createLatestRequests } from '$lib/abs/latest';
	import type { ABSLibrary, ABSItem } from '$lib/types';

	let libraries: ABSLibrary[] = $state([]);
	let items: ABSItem[] = $state([]);
	let selectedLibraryId: string | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let searchQuery = $state('');

	let connectionToken = '';
	let disposed = false;
	/** Latest-response-wins, so a slow earlier library cannot clobber a later one. */
	const itemsRequest = createLatestRequests();

	const unsubConnection = connection.subscribe((s) => {
		connectionToken = s.token;
	});

	async function loadItems(client: ABSClient, id: string) {
		loading = true;
		error = '';
		await itemsRequest.run(
			() => getLibraryItems(client, id),
			(result) => {
				items = result;
				loading = false;
			},
			(err) => {
				error = err instanceof Error ? err.message : 'Failed to load';
				loading = false;
			}
		);
	}

	onMount(async () => {
		if (!connectionToken) {
			await goto('/');
			return;
		}

		const client = new ABSClient('/abs', connectionToken);
		try {
			const libs = await getLibraries(client);
			if (disposed) return;
			libraries = libs;

			if (libs.length > 0) {
				selectedLibraryId = libs[0].id;
				await loadItems(client, libs[0].id);
			} else {
				loading = false;
			}
		} catch (err) {
			if (disposed) return;
			error = err instanceof Error ? err.message : 'Failed to load';
			loading = false;
		}
	});

	function selectLibrary(id: string) {
		selectedLibraryId = id;
		void loadItems(new ABSClient('/abs', connectionToken), id);
	}

	/** Books open to their details page; playback starts from there. */
	function openItem(itemId: string) {
		goto(`/book/${itemId}`);
	}

	/** "Continue Listening" keeps the one-tap resume the shelf implies. */
	function resumeItem(itemId: string) {
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

	const librarySummary = $derived.by(() => {
		if (loading) return 'Loading library…';
		if (items.length === 0) return 'No books yet';
		const books = `${items.length} ${items.length === 1 ? 'book' : 'books'}`;
		return $recent.length > 0 ? `${books} · ${$recent.length} in progress` : books;
	});

	const filteredItems = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return items;
		return items.filter((item) => {
			const title = item.media?.metadata?.title?.toLowerCase() || '';
			const author = item.media?.metadata?.authorName?.toLowerCase() || '';
			return title.includes(q) || author.includes(q);
		});
	});

	onDestroy(() => {
		disposed = true;
		itemsRequest.cancel();
		unsubConnection();
	});
</script>

<svelte:head>
	<title>Library · Read-Along</title>
</svelte:head>

<div class="min-h-screen bg-[var(--bg)]">
	<header class="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
		<div class="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
			<div class="flex min-w-0 items-baseline gap-3">
				<span class="truncate text-sm font-semibold tracking-[-0.02em] text-[var(--fg)]">
					Read-Along
				</span>
				<span
					class="hidden text-xs font-medium tracking-wide text-[var(--muted)] uppercase sm:inline"
				>
					Library
				</span>
			</div>
			<div class="flex shrink-0 items-center gap-1.5">
				<ThemeToggle />
				<button
					onclick={() => goto('/settings')}
					class="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:outline-none"
					aria-label="Settings"
					title="Settings"
				>
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
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
						/>
						<circle cx="12" cy="12" r="3" />
					</svg>
				</button>
				<span class="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden="true"></span>
				<button
					onclick={() => {
						connection.disconnect();
						goto('/');
					}}
					class="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:outline-none"
				>
					Disconnect
				</button>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
		<div class="flex flex-col gap-6 border-b border-[var(--border)] pt-9 pb-6 sm:pt-12">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight text-[var(--fg)] sm:text-3xl">Library</h1>
				<p class="mt-2 text-sm text-[var(--muted)]">
					{librarySummary}
				</p>
			</div>

			<div class="relative w-full max-w-md">
				<svg
					class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					stroke-width="2"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
					/>
				</svg>
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search by title or author…"
					aria-label="Search books"
					class="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] pr-9 pl-9 text-sm text-[var(--fg)] shadow-[var(--shadow-sm)] transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] focus:outline-none"
				/>
				{#if searchQuery}
					<button
						onclick={() => (searchQuery = '')}
						aria-label="Clear search"
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:outline-none"
					>
						<svg
							class="h-4 w-4"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							stroke-width="2"
							aria-hidden="true"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				{/if}
			</div>

			{#if libraries.length > 1}
				<div class="flex gap-2 overflow-x-auto pb-0.5">
					{#each libraries as lib}
						<button
							onclick={() => selectLibrary(lib.id)}
							aria-current={selectedLibraryId === lib.id ? 'true' : undefined}
							class="shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:outline-none {selectedLibraryId ===
							lib.id
								? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-[var(--shadow-sm)]'
								: 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'}"
						>
							{lib.name}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="mt-9">
			{#if loading}
				<div
					class="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-sm)]"
					role="status"
					aria-busy="true"
				>
					<span class="sr-only">Loading library…</span>
					{#each Array(4) as _}
						<div
							class="flex items-center gap-3 border-b border-[var(--border)] p-2 last:border-b-0"
						>
							<div
								class="aspect-[2/3] w-10 shrink-0 animate-pulse rounded-lg bg-[var(--surface-hover)]"
							></div>
							<div class="min-w-0 flex-1 space-y-2">
								<div class="h-3 w-1/3 animate-pulse rounded-full bg-[var(--surface-hover)]"></div>
								<div class="h-2.5 w-1/4 animate-pulse rounded-full bg-[var(--surface-hover)]"></div>
							</div>
						</div>
					{/each}
				</div>
			{:else if error}
				<p class="border-l-2 border-red-500 pl-3 text-sm text-red-500">{error}</p>
			{:else}
				{#if $recent.length > 0 && !searchQuery.trim()}
					<section>
						<div
							class="flex items-baseline justify-between gap-4 border-b border-[var(--border)] pb-2"
						>
							<h2 class="text-sm font-semibold tracking-wide text-[var(--muted)] uppercase">
								Continue listening
							</h2>
							<span class="text-xs text-[var(--muted)] tabular-nums">
								{$recent.length}
							</span>
						</div>
						<div
							class="mt-3 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]"
						>
							{#each $recent as book (book.itemId)}
								<button
									onclick={() => resumeItem(book.itemId)}
									class="group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-inset sm:gap-4 sm:px-4"
								>
									<img
										src={getCoverUrl(book.itemId)}
										alt=""
										class="aspect-[2/3] w-10 shrink-0 rounded-lg object-cover shadow-[var(--shadow-sm)]"
										loading="lazy"
										referrerpolicy="no-referrer"
									/>
									<div class="min-w-0 flex-1">
										<div class="flex items-baseline justify-between gap-3">
											<p class="truncate text-sm font-medium text-[var(--fg)]">{book.title}</p>
											<span
												class="hidden shrink-0 text-xs text-[var(--muted)] tabular-nums sm:inline"
											>
												{Math.round(progressPercent(book))}%
											</span>
										</div>
										<p class="mt-0.5 truncate text-xs text-[var(--muted)]">
											{book.authorName || 'Unknown'} · {timeLeftLabel(book)}
										</p>
										<div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
											<div
												class="h-full rounded-full bg-[var(--accent)]"
												style="width: {progressPercent(book)}%"
											></div>
										</div>
									</div>
									<svg
										class="h-4 w-4 shrink-0 text-[var(--muted)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--accent)]"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
										stroke-width="2"
										aria-hidden="true"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M5 12h14M13 6l6 6-6 6"
										/>
									</svg>
									<span class="sr-only">Resume</span>
								</button>
							{/each}
						</div>
					</section>
				{/if}

				{#if items.length === 0}
					<p class="py-12 text-sm text-[var(--muted)]">No items found</p>
				{:else if filteredItems.length === 0}
					<p class="py-12 text-sm text-[var(--muted)]">
						No books match “{searchQuery.trim()}”
					</p>
				{:else}
					<section class={$recent.length > 0 && !searchQuery.trim() ? 'mt-10' : ''}>
						<div
							class="mb-5 flex items-baseline justify-between gap-4 border-b border-[var(--border)] pb-2"
						>
							<h2 class="text-sm font-semibold tracking-wide text-[var(--muted)] uppercase">
								{searchQuery.trim() ? 'Search results' : 'All books'}
							</h2>
							<span class="text-xs text-[var(--muted)] tabular-nums">
								{searchQuery.trim()
									? `${filteredItems.length} ${filteredItems.length === 1 ? 'result' : 'results'}`
									: filteredItems.length}
							</span>
						</div>
						<div
							class="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5"
						>
							{#each filteredItems as item (item.id)}
								<button
									onclick={() => openItem(item.id)}
									class="group block min-w-0 rounded-xl text-left focus-visible:outline-none"
								>
									<div
										class="relative aspect-[2/3] overflow-hidden rounded-xl bg-[var(--surface)] shadow-[var(--shadow-sm)] transition-shadow group-hover:shadow-[var(--shadow-md)] group-focus-visible:ring-2 group-focus-visible:ring-[var(--accent-soft)] group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-[var(--bg)]"
									>
										<img
											src={getCoverUrl(item.id)}
											alt=""
											class="h-full w-full object-cover"
											loading="lazy"
											referrerpolicy="no-referrer"
										/>
										{#if recentMap.get(item.id)}
											<div class="absolute inset-x-0 bottom-0 h-1.5 bg-black/20">
												<div
													class="h-full bg-[var(--accent)]"
													style="width: {progressPercent(recentMap.get(item.id)!)}%"
												></div>
											</div>
										{/if}
									</div>
									<p
										class="mt-2.5 line-clamp-2 text-sm leading-snug font-medium text-[var(--fg)] group-hover:underline group-hover:underline-offset-2"
									>
										{item.media?.metadata?.title || 'Unknown'}
									</p>
									<p class="mt-0.5 truncate text-xs text-[var(--muted)]">
										{item.media?.metadata?.authorName || 'Unknown'}
									</p>
								</button>
							{/each}
						</div>
					</section>
				{/if}
			{/if}
		</div>
	</main>
</div>
