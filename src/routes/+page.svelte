<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { ABSError, getLibraries } from '$lib/abs/api';
	import { ABSClient } from '$lib/abs/client';

	let url = $state('');
	let token = $state('');
	let error = $state('');
	let loading = $state(false);
	/** Blocks the form while a stored credential is being revalidated. */
	let restoring = $state(true);

	/**
	 * The credentials were already persisted; nothing ever read them back, so
	 * every visit landed on this form. Revalidate rather than trusting the
	 * stored token blindly, since it may have been revoked server-side.
	 */
	onMount(async () => {
		const stored = $connection;
		if (!stored.token) {
			restoring = false;
			return;
		}

		url = stored.url;
		token = stored.token;

		try {
			const client = new ABSClient('/abs', stored.token);
			await getLibraries(client);
			await goto('/library');
			return;
		} catch (err) {
			// Only a rejected token should force a re-entry. A server that is
			// merely unreachable would otherwise wipe a good token offline.
			if (err instanceof ABSError && (err.status === 401 || err.status === 403)) {
				connection.disconnect();
				token = '';
				error = 'Your saved token was rejected. Please reconnect.';
			} else {
				error = 'Could not reach the server. Check the connection and retry.';
			}
		} finally {
			restoring = false;
		}
	});

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

{#if restoring}
	<div class="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
		<p class="text-sm text-[var(--muted)]">Reconnecting…</p>
	</div>
{:else}
	<div class="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
		<div class="w-full max-w-sm">
			<div class="mb-8 flex flex-col items-center text-center">
				<div
					class="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] shadow-[var(--shadow-md)]"
				>
					<svg
						class="h-6 w-6 text-[var(--accent-fg)]"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						stroke-width="2"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M12 6.253v13M12 6.253C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
						/>
					</svg>
				</div>
				<h1 class="text-xl font-semibold tracking-tight text-[var(--fg)]">Read-Along</h1>
				<p class="mt-1 text-sm text-[var(--muted)]">Connect to your Audiobookshelf server</p>
			</div>

			<div
				class="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-md)]"
			>
				<form onsubmit={handleConnect} class="flex flex-col gap-4">
					<div>
						<label
							class="mb-1.5 block text-xs font-medium tracking-wide text-[var(--muted)] uppercase"
							for="url"
						>
							Server URL
						</label>
						<input
							id="url"
							type="text"
							bind:value={url}
							placeholder="https://audiobookshelf.example.com"
							class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--fg)] placeholder-[var(--muted)] transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] focus:outline-none"
							required
						/>
					</div>

					<div>
						<label
							class="mb-1.5 block text-xs font-medium tracking-wide text-[var(--muted)] uppercase"
							for="token"
						>
							API Token
						</label>
						<input
							id="token"
							type="password"
							bind:value={token}
							placeholder="Paste your API token"
							class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--fg)] placeholder-[var(--muted)] transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] focus:outline-none"
							required
						/>
						<p class="mt-1.5 text-xs text-[var(--muted)]">
							Settings &rarr; API Token in your Audiobookshelf admin panel.
						</p>
					</div>

					{#if error}
						<p class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>
					{/if}

					<button
						type="submit"
						disabled={loading}
						class="mt-1 w-full rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-fg)] shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
					>
						{loading ? 'Connecting…' : 'Connect'}
					</button>
				</form>
			</div>
		</div>
	</div>
{/if}
