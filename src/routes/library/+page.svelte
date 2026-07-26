<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { ABSClient } from '$lib/abs/client';
	import { getLibraries, getLibraryItems } from '$lib/abs/api';
	import type { ABSLibrary, ABSItem } from '$lib/types';

	let libraries: ABSLibrary[] = $state([]);
	let items: ABSItem[] = $state([]);
	let selectedLibraryId: string | null = $state(null);
	let loading = $state(true);
	let error = $state('');

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

	function getCoverUrl(item: ABSItem): string {
		return `/abs/api/items/${item.id}/cover?token=${encodeURIComponent(connectionToken)}`;
	}
</script>

<div class="min-h-screen bg-[var(--bg)]">
	<header class="border-b border-[var(--border)] px-4 py-3">
		<div class="flex items-center justify-between">
			<h1 class="text-lg font-semibold text-[var(--fg)]">Library</h1>
			<button
				onclick={() => {
					connection.disconnect();
					goto('/');
				}}
				class="text-sm text-[var(--muted)] hover:text-[var(--fg)]"
			>
				Disconnect
			</button>
		</div>

		{#if libraries.length > 1}
			<div class="mt-2 flex gap-2">
				{#each libraries as lib}
					<button
						onclick={() => selectLibrary(lib.id)}
						class="rounded px-3 py-1 text-sm {selectedLibraryId === lib.id
							? 'bg-blue-600 text-white'
							: 'bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--border)]'}"
					>
						{lib.name}
					</button>
				{/each}
			</div>
		{/if}
	</header>

	<main class="p-4">
		{#if loading}
			<p class="text-[var(--muted)]">Loading...</p>
		{:else if error}
			<p class="text-red-500">{error}</p>
		{:else if items.length === 0}
			<p class="text-[var(--muted)]">No items found</p>
		{:else}
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{#each items as item}
					<button
						onclick={() => openItem(item.id)}
						class="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] text-left hover:shadow-md transition-shadow"
					>
						<div class="aspect-[3/4] overflow-hidden bg-[var(--border)]">
							{#if getCoverUrl(item)}
								<img
									src={getCoverUrl(item)}
									alt={item.media?.metadata?.title || ''}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
							{:else}
								<div class="flex h-full items-center justify-center text-4xl text-[var(--muted)]">
									📖
								</div>
							{/if}
						</div>
						<div class="p-2">
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
	</main>
</div>
