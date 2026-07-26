<script lang="ts">
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { ABSError, getLibraries } from '$lib/abs/api';
	import { ABSClient } from '$lib/abs/client';

	let url = $state('');
	let token = $state('');
	let error = $state('');
	let loading = $state(false);

	async function handleConnect(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		loading = true;

		try {
			const client = new ABSClient('/abs', token.trim());
			await getLibraries(client);
			connection.connect(url.trim(), token.trim());
			await goto('/library');
		} catch (err) {
			if (err instanceof ABSError) {
				error = err.message;
			} else {
				error = 'Connection failed. Check your URL and token.';
			}
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center bg-[var(--bg)]">
	<div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
		<h1 class="mb-2 text-2xl font-bold text-[var(--fg)]">Read-Along Reader</h1>
		<p class="mb-6 text-sm text-[var(--muted)]">Connect to your Audiobookshelf server</p>

		<form onsubmit={handleConnect}>
			<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="url">
				Server URL
			</label>
			<input
				id="url"
				type="text"
				bind:value={url}
				placeholder="https://audiobookshelf.example.com"
				class="mb-4 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[var(--fg)] placeholder-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-blue-500"
				required
			/>

			<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="token">
				API Token
			</label>
			<input
				id="token"
				type="password"
				bind:value={token}
				placeholder="Paste your API token from ABS Settings"
				class="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[var(--fg)] placeholder-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-blue-500"
				required
			/>
			<p class="mb-4 text-xs text-[var(--muted)]">
				In Audiobookshelf, go to <strong>Settings → API Token</strong> to generate one.
			</p>

			{#if error}
				<p class="mb-4 text-sm text-red-500">{error}</p>
			{/if}

			<button
				type="submit"
				disabled={loading}
				class="w-full rounded bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
			>
				{loading ? 'Connecting...' : 'Connect'}
			</button>
		</form>
	</div>
</div>
