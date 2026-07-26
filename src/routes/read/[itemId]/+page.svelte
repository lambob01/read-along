<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { player } from '$lib/stores/player';
	import { reader } from '$lib/stores/reader';
	import { recent } from '$lib/stores/recent';
	import { settings, defaultSettings } from '$lib/stores/settings';
	import { ABSClient } from '$lib/abs/client';
	import { getItem, getStreamSession } from '$lib/abs/api';
	import { mergeCues } from '$lib/sync/merge';
	import { buildIndex } from '$lib/sync/index';
	import { createSyncController, type SyncController } from '$lib/sync/ticker';
	import { createAutoScroller, type AutoScroller } from '$lib/sync/autoscroll';
	import { renderParagraphs } from '$lib/reader/renderer';
	import { renderEpub, type EpubRenderHandle } from '$lib/reader/epubRenderer';
	import { loadTextSource, type TextSourceMode } from '$lib/epub/source';
	import { createHighlighter, type HighlightHandle } from '$lib/reader/highlight';

	// Route params are typed as possibly-undefined; this page cannot render
	// without an id, so narrow once here rather than at every call site.
	const itemId = $derived($page.params.itemId ?? '');

	let scrollerEl = $state<HTMLDivElement>();
	let contentEl = $state<HTMLDivElement>();
	let playerEl = $state<HTMLAudioElement>();
	let showSettings = $state(false);
	let showChapterDropdown = $state(false);
	let showVolumeSlider = $state(false);

	type SleepOption = number | 'chapter';
	const sleepPresets: { label: string; value: SleepOption | null }[] = [
		{ label: 'Off', value: null },
		{ label: '15 min', value: 15 },
		{ label: '30 min', value: 30 },
		{ label: '45 min', value: 45 },
		{ label: '60 min', value: 60 },
		{ label: 'End of chapter', value: 'chapter' }
	];
	let sleepTimer: SleepOption | null = $state(null);
	let sleepEndTime: number | null = $state(null);
	let sleepRemaining: string = $state('');
	let sleepInterval: ReturnType<typeof setInterval> | null = null;
	let autoScrollLocked = $state(false);
	let loading = $state(true);
	let errorState = $state('');

	let syncController: SyncController | null = null;
	let autoScroller: AutoScroller | null = null;
	let highlighter: HighlightHandle | null = null;
	let epubRender: EpubRenderHandle | null = null;
	let saveBookmarkInterval: ReturnType<typeof setInterval> | null = null;

	/** Which text source is driving the view. */
	let textMode = $state<TextSourceMode>('none');
	/** Fraction of the book that received timing, when in EPUB mode. */
	let coverage = $state<number | null>(null);
	/** Non-fatal explanation when EPUB mode was attempted but not used. */
	let sourceNotice = $state<string | null>(null);

	let connectionToken = '';
	let connectionUrl = '';
	let gapThreshold = defaultSettings.gapThreshold;
	let showNonSpeech = defaultSettings.showNonSpeech;

	connection.subscribe((s) => {
		connectionToken = s.token;
		connectionUrl = s.url;
	});

	settings.subscribe((s) => {
		gapThreshold = s.gapThreshold;
		showNonSpeech = s.showNonSpeech;
	});

	$effect(() => {
		const id = $reader.activeSentenceId;
		if (!highlighter) return;

		if (id === null) {
			// No timed sentence covers the current playback position (a gap
			// between cues, non-speech audio, or past the last timed sentence).
			// Without this, whatever was highlighted before stays lit forever.
			highlighter.reset();
			return;
		}

		if (epubRender) {
			// Mount the chapter first, or the sentence's spans will not exist.
			epubRender.ensureVisible(id);
			const spans = epubRender.spansFor(id);
			if (spans.length === 0) {
				highlighter.reset();
				return;
			}
			highlighter.activateMany(spans);
		} else {
			const el = $reader.sentenceMap?.get(id);
			if (!el) {
				highlighter.reset();
				return;
			}
			highlighter.activate(el);
		}

		if (!autoScrollLocked) {
			autoScroller?.scrollTo(id);
		}
	});

	onMount(async () => {
		if (!connectionToken) {
			await goto('/');
			return;
		}

		highlighter = createHighlighter();
		window.addEventListener('keydown', handleKeyDown);

		try {
			const client = new ABSClient('/abs', connectionToken);
			const item = await getItem(client, itemId);
			reader.setItem(item);
			reader.setLoading(true);

			const session = await getStreamSession(client, itemId);
			const directTrack = session.libraryItem?.media?.tracks?.[0];
			const audioSrc = directTrack?.contentUrl;
			if (audioSrc) {
				const src = `/abs${audioSrc}?token=${encodeURIComponent(connectionToken)}`;
				player.setSrc(src);
				const bookmark = player.getBookmark(itemId);
				if (bookmark && bookmark > 0) {
					setTimeout(() => player.seek(bookmark), 500);
				}
			}

			saveBookmarkInterval = setInterval(() => {
				if ($player.currentTime > 0) {
					player.saveBookmark(itemId, $player.currentTime);
					recent.record({
						itemId,
						title: item.media?.metadata?.title || 'Untitled',
						authorName: item.media?.metadata?.authorName || '',
						duration: $player.duration || 0,
						position: $player.currentTime
					});
				}
			}, 5000);

			let source;
			try {
				source = await loadTextSource(client, itemId);
			} catch (err) {
				source = null;
				sourceNotice = err instanceof Error ? err.message : 'No transcript';
			}

			textMode = source?.mode ?? 'none';
			if (source?.notice) sourceNotice = source.notice;

			if (source && source.mode === 'epub' && source.index && source.doc) {
				const index = source.index;
				const doc = source.doc;
				coverage = index.stats.coverage;

				// The ticker only reads starts/ends and sentence ids, so the
				// aligned index substitutes for a cue index without changes.
				const timingIndex = {
					paragraphs: [],
					sentences: index.timed,
					starts: index.starts,
					ends: index.ends
				};
				reader.setCueIndex(timingIndex);

				requestAnimationFrame(() => {
					if (!contentEl) return;
					epubRender = renderEpub(index, doc.chapters, contentEl);
					// Mount the opening chapters so there is text before playback.
					epubRender.ensureVisible(index.sentences[0]?.id ?? 0);

					const audioEl = player.getAudioElement();
					if (audioEl) {
						syncController = createSyncController(
							audioEl,
							timingIndex,
							(id) => {
								reader.setActiveSentence(id);
							}
						);
						syncController.start();
					}

					if (scrollerEl) {
						autoScroller = createAutoScroller(scrollerEl, (id) =>
							epubRender?.elementFor(id)
						);
					}
				});
			} else if (source && source.cues && source.cues.length > 0) {
				const cues = source.cues;
				const paragraphs = mergeCues(cues, {
					gapThreshold,
					showNonSpeech
				});
				const cueIndex = buildIndex(paragraphs);
				reader.setCueIndex(cueIndex);

				requestAnimationFrame(() => {
					if (!contentEl) return;
					const sentenceMap = renderParagraphs(
						cueIndex.paragraphs,
						contentEl
					);
					reader.setSentenceMap(sentenceMap);

					const audioEl = player.getAudioElement();
					if (audioEl) {
						syncController = createSyncController(
							audioEl,
							cueIndex,
							(id) => {
								reader.setActiveSentence(id);
							}
						);
						syncController.start();
					}

					if (scrollerEl) {
						autoScroller = createAutoScroller(
							scrollerEl,
							(id) => sentenceMap.get(id)
						);
					}
				});
			}

			reader.setLoading(false);
		} catch (err) {
			errorState =
				err instanceof Error ? err.message : 'Failed to load item';
		} finally {
			loading = false;
		}
	});

	onDestroy(() => {
		if ($player.currentTime > 0) {
			player.saveBookmark(itemId, $player.currentTime);
			recent.record({
				itemId,
				title: $reader.item?.media?.metadata?.title || 'Untitled',
				authorName: $reader.item?.media?.metadata?.authorName || '',
				duration: $player.duration || 0,
				position: $player.currentTime
			});
		}
		if (saveBookmarkInterval) clearInterval(saveBookmarkInterval);
		syncController?.stop();
		autoScroller?.destroy();
		highlighter?.reset();
		epubRender?.destroy();
		epubRender = null;
		reader.reset();
		player.pause();
		clearInterval(sleepInterval!);
	});
	

	function handlePlayPause() {
		if ($player.playing) {
			player.pause();
		} else {
			player.play();
		}
	}

	function handleSeek(e: Event) {
		const input = e.target as HTMLInputElement;
		player.seek(parseFloat(input.value));
	}

	function handleRateChange(e: Event) {
		const select = e.target as HTMLSelectElement;
		player.setRate(parseFloat(select.value));
	}

	function handleChapterChange(e: Event) {
		const select = e.target as HTMLSelectElement;
		player.setChapter(parseInt(select.value));
	}

	function toggleAutoScroll() {
		autoScrollLocked = !autoScrollLocked;
		if (!autoScrollLocked && $reader.activeSentenceId !== null) {
			autoScroller?.scrollTo($reader.activeSentenceId);
		}
	}

	function setSleepTimer(opt: SleepOption | null) {
		clearInterval(sleepInterval!);
		sleepTimer = opt;
		if (opt === null) {
			sleepEndTime = null;
			sleepRemaining = '';
			return;
		}
		if (opt === 'chapter') {
			sleepEndTime = null;
			sleepRemaining = 'End of chapter';
			sleepInterval = setInterval(() => {
				const idx = chapters.findLastIndex((c) => $player.currentTime >= c.start);
				const next = chapters[idx + 1];
				if (next && $player.currentTime >= next.start) {
					player.pause();
					clearInterval(sleepInterval!);
					sleepTimer = null;
					sleepEndTime = null;
					sleepRemaining = '';
				}
			}, 1000);
		} else {
			const end = Date.now() + opt * 60 * 1000;
			sleepEndTime = end;
			function updateRemaining() {
				const left = Math.max(0, Math.ceil((sleepEndTime! - Date.now()) / 1000));
				const m = Math.floor(left / 60);
				const s = left % 60;
				sleepRemaining = `${m}:${s.toString().padStart(2, '0')}`;
				if (left <= 0) {
					player.pause();
					clearInterval(sleepInterval!);
					sleepTimer = null;
					sleepEndTime = null;
					sleepRemaining = '';
				}
			}
			updateRemaining();
			sleepInterval = setInterval(updateRemaining, 1000);
		}
	}

	function handleVolumeChange(e: Event) {
		const input = e.target as HTMLInputElement;
		player.setVolume(parseFloat(input.value));
	}

	function formatTime(s: number): string {
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = Math.floor(s % 60);
		return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
	}

	const chapters = $derived($reader.item?.media?.chapters || []);
	const currentChapterIdx = $derived(
		chapters.length > 0
			? chapters.findLastIndex((c) => $player.currentTime >= c.start)
			: -1
	);
	const currentChapter = $derived(
		currentChapterIdx >= 0 ? chapters[currentChapterIdx]?.title || '' : chapters[0]?.title || ''
	);

	const seekPercent = $derived(
		$player.duration > 0 ? ($player.currentTime / $player.duration) * 100 : 0
	);

	function goToNextChapter() {
		if (chapters.length === 0) return;
		const next = chapters.findIndex((c) => c.start > $player.currentTime);
		if (next >= 0) player.seek(chapters[next].start);
	}
	function goToPrevChapter() {
		if (chapters.length === 0) return;
		const idx = chapters.findLastIndex((c) => $player.currentTime - 1 > c.start);
		if (idx >= 0) player.seek(chapters[idx].start);
		else player.seek(0);
	}
	function jumpToChapter(idx: number) {
		if (idx >= 0 && idx < chapters.length) player.seek(chapters[idx].start);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return;
		switch (e.key) {
			case ' ': e.preventDefault(); handlePlayPause(); break;
			case 'ArrowLeft': player.skipBack(10); break;
			case 'ArrowRight': player.skipForward(10); break;
			case 'j': player.skipBack(10); break;
			case 'l': player.skipForward(10); break;
			case 'k': handlePlayPause(); break;
			case 'h': player.skipBack(5); break;
			case 'n': goToNextChapter(); break;
			case 'p': goToPrevChapter(); break;
		}
	}

	const rateOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
	const fontSizes = Array.from({ length: 13 }, (_, i) => 0.8 + i * 0.1);
	const lineHeights = [
		1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.2, 2.5
	];
	const themes: { value: string; label: string }[] = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
		{ value: 'sepia', label: 'Sepia' },
		{ value: 'oled', label: 'OLED' }
	];
</script>

{#if loading}
	<div class="flex min-h-screen items-center justify-center bg-[var(--bg)]">
		<p class="text-[var(--muted)]">Loading...</p>
	</div>
{:else if errorState}
	<div class="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--bg)]">
		<p class="text-red-500">{errorState}</p>
		<button
			onclick={() => goto('/library')}
			class="rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)]"
		>
			Back to Library
		</button>
	</div>
{:else}
	<div class="flex h-dvh flex-col bg-[var(--bg)]">
		<!-- Top bar -->
		<div class="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
			<button
				onclick={() => goto('/library')}
				class="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
				aria-label="Back to library"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
					><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"
					/></svg
				>
			</button>

			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium text-[var(--fg)]">
					{$reader.item?.media?.metadata?.title || 'Untitled'}
				</p>
				<p class="truncate text-xs text-[var(--muted)]">
					{$reader.item?.media?.metadata?.authorName || ''}
					{#if currentChapter} &middot; {currentChapter}{/if}
				</p>
			</div>

			<button
				onclick={() => (showSettings = !showSettings)}
				class="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
				aria-label="Settings"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
					><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/><circle cx="12" cy="12" r="3" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					/></svg
				>
			</button>
		</div>

		<!-- Reader area -->
		<div
			bind:this={scrollerEl}
			class="flex-1 overflow-y-auto px-[var(--theme-side-margins)] py-6"
		>
			{#if sourceNotice && $reader.cueIndex}
				<!--
					Surfaced rather than logged: silent partial alignment is the
					main failure mode of the EPUB path.
				-->
				<div
					class="mx-auto mb-4 rounded border border-[var(--muted)] px-3 py-2 text-sm text-[var(--muted)]"
					style="max-width: var(--theme-max-width);"
				>
					{sourceNotice}
				</div>
			{:else if textMode === 'epub' && coverage !== null && coverage < 0.95}
				<div
					class="mx-auto mb-4 rounded border border-[var(--muted)] px-3 py-2 text-sm text-[var(--muted)]"
					style="max-width: var(--theme-max-width);"
				>
					{Math.round(coverage * 100)}% of the book is synced to the audio.
					Unsynced passages are shown but will not highlight.
				</div>
			{/if}

			{#if !$reader.cueIndex}
				<div
					class="mx-auto flex items-center justify-center py-12"
					style="max-width: var(--theme-max-width);
					font-family: var(--theme-font-family);
					font-size: var(--theme-font-size);
					line-height: var(--theme-line-height);"
				>
					<div class="text-center">
						<p class="text-lg text-[var(--muted)]">No transcript available for this item</p>
						<p class="mt-2 text-sm text-[var(--muted)]">Press play to listen to the audiobook.</p>
					</div>
				</div>
			{:else}
				<div
					bind:this={contentEl}
					class="mx-auto"
					style="max-width: var(--theme-max-width);
					font-family: var(--theme-font-family);
					font-size: var(--theme-font-size);
					line-height: var(--theme-line-height);"
				></div>
			{/if}
		</div>

		<!-- Player bar -->
		<div class="border-t border-[var(--border)] bg-[var(--surface)] px-2 py-2 sm:px-3">
			<div class="mx-auto flex max-w-2xl flex-col gap-1.5 sm:gap-2">
				<!-- Seek bar -->
				<div class="flex items-center gap-1.5 sm:gap-2">
					<span class="text-xs tabular-nums text-[var(--muted)] min-w-[48px] text-right sm:min-w-[52px]">
						{formatTime($player.currentTime)}
					</span>
					<input
						type="range"
						min="0"
						max={$player.duration || 0}
						value={$player.currentTime}
						oninput={handleSeek}
						style="background: linear-gradient(to right, var(--accent) 0%, var(--accent) {seekPercent}%, var(--border) {seekPercent}%, var(--border) 100%)"
						class="h-3 flex-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer"
					/>
					<span class="text-xs tabular-nums text-[var(--muted)] min-w-[48px] sm:min-w-[52px]">
						{formatTime($player.duration)}
					</span>
				</div>

				<!-- Controls row -->
				<div class="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
					<!-- Transport buttons -->
					<div class="flex items-center justify-center gap-0.5 sm:gap-1">
						<button
							onclick={goToPrevChapter}
							class="rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] min-w-[42px] min-h-[42px] sm:min-w-[44px] sm:min-h-[44px] flex items-center justify-center"
							aria-label="Previous chapter"
						>
							<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M16.67 0l2.83 2.829-9.339 9.175 9.339 9.167-2.83 2.829-12.17-11.996z"/>
							</svg>
						</button>

						<button
							onclick={() => player.skipBack(10)}
							class="rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] min-w-[42px] min-h-[42px] sm:min-w-[44px] sm:min-h-[44px] flex items-center justify-center"
							aria-label="Skip back 10s"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
								><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"
								/></svg
							>
						</button>

						<button
							onclick={handlePlayPause}
							class="rounded-full p-2.5 sm:p-3 text-[var(--fg)] hover:bg-[var(--border)] min-w-[48px] min-h-[48px] sm:min-w-[44px] sm:min-h-[44px] flex items-center justify-center"
							aria-label={$player.playing ? 'Pause' : 'Play'}
						>
							{#if $player.playing}
								<svg class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"
									><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg
								>
							{:else}
								<svg class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"
									><path d="M8 5v14l11-7z" /></svg
								>
							{/if}
						</button>

						<button
							onclick={() => player.skipForward(10)}
							class="rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] min-w-[42px] min-h-[42px] sm:min-w-[44px] sm:min-h-[44px] flex items-center justify-center"
							aria-label="Skip forward 10s"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
								><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z"
								/></svg
							>
						</button>

						<button
							onclick={goToNextChapter}
							class="rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] min-w-[42px] min-h-[42px] sm:min-w-[44px] sm:min-h-[44px] flex items-center justify-center"
							aria-label="Next chapter"
						>
							<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M7.33 24l-2.83-2.829 9.339-9.175-9.339-9.167 2.83-2.829 12.17 11.996z"/>
							</svg>
						</button>
					</div>

					<!-- Utility controls -->
					<div class="flex items-center justify-center gap-1.5 sm:gap-2">
						<!-- Volume -->
						<div class="relative">
							<button
								onclick={() => (showVolumeSlider = !showVolumeSlider)}
								class="rounded p-1.5 text-[var(--fg)] hover:bg-[var(--border)] min-w-[40px] min-h-[40px] sm:min-h-[44px] flex items-center justify-center"
								aria-label="Volume"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M6.5 8.5H4a1 1 0 00-1 1v5a1 1 0 001 1h2.5l4 4V4.5l-4 4z"/>
								</svg>
							</button>
							{#if showVolumeSlider}
								<button
									class="fixed inset-0 z-40 cursor-default"
									onclick={() => (showVolumeSlider = false)}
									aria-label="Close volume"
								></button>
								<div class="absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 rounded border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg">
									<input
										type="range"
										min="0"
										max="1"
										step="0.05"
										value={$player.volume}
										oninput={handleVolumeChange}
										class="h-16 w-6 appearance-none rounded-full [writing-mode:vertical-lr] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:cursor-pointer"
										aria-label="Volume slider"
									/>
								</div>
							{/if}
						</div>

						<!-- Sleep timer -->
						<div class="relative">
							<select
								value={sleepTimer ?? 'off'}
								onchange={(e) => {
									const v = e.currentTarget.value;
									if (v === 'off') setSleepTimer(null);
									else if (v === 'chapter') setSleepTimer('chapter');
									else setSleepTimer(parseInt(v));
								}}
								class="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 sm:px-2 py-1.5 text-xs sm:text-sm text-[var(--fg)] min-h-[40px] sm:min-h-[44px] cursor-pointer appearance-none"
								aria-label="Sleep timer"
							>
								{#each sleepPresets as p}
									<option value={p.value ?? 'off'}>{p.label}</option>
								{/each}
							</select>
							{#if sleepRemaining}
								<span class="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs text-[var(--accent)]">{sleepRemaining}</span>
							{/if}
						</div>

						{#if chapters.length > 0}
							<div class="relative">
								<button
									onclick={() => (showChapterDropdown = !showChapterDropdown)}
									class="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs sm:text-sm text-[var(--fg)] min-h-[40px] sm:min-h-[44px] max-w-[140px] sm:max-w-[180px] truncate hover:bg-[var(--border)]"
									aria-label="Chapter"
								>
									{currentChapter || 'Chapters'}
								</button>
								{#if showChapterDropdown}
									<button
										class="fixed inset-0 z-40 cursor-default"
										onclick={() => (showChapterDropdown = false)}
										aria-label="Close chapter list"
									></button>
									<div class="absolute {false ? '' : 'bottom-full mb-1'} left-1/2 z-50 max-h-56 w-72 -translate-x-1/2 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg sm:left-0 sm:w-64 sm:translate-x-0">
										{#each chapters as ch, i}
											<button
												onclick={() => {
													jumpToChapter(i);
													showChapterDropdown = false;
												}}
												class="block w-full px-3 py-2.5 sm:py-2 text-left text-sm text-[var(--fg)] hover:bg-[var(--border)] {i === currentChapterIdx ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : ''}"
											>
												{formatTime(ch.start)} — {ch.title}
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						<select
							value={$player.rate}
							onchange={handleRateChange}
							class="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 sm:px-2 py-1.5 text-xs sm:text-sm text-[var(--fg)] min-h-[40px] sm:min-h-[44px]"
							aria-label="Playback speed"
						>
							{#each rateOptions as r}
								<option value={r}>{r}x</option>
							{/each}
						</select>

						<button
							onclick={toggleAutoScroll}
							class="rounded border px-2 sm:px-3 py-1.5 text-xs sm:text-sm min-h-[40px] sm:min-h-[44px] flex items-center gap-1 sm:gap-1.5 {autoScrollLocked
								? 'border-[var(--border)] text-[var(--muted)]'
								: 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'}"
							aria-label={autoScrollLocked ? 'Enable auto-scroll' : 'Disable auto-scroll'}
						>
							<span class="inline-block h-2 w-2 rounded-full {autoScrollLocked ? 'bg-[var(--muted)]' : 'bg-[var(--accent)]'}"></span>
							<span class="hidden sm:inline">Autoscroll</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Settings panel -->
		{#if showSettings}
			<div
				class="fixed inset-0 z-50 flex justify-end"
				role="dialog"
				aria-label="Settings"
			>
				<button
					class="absolute inset-0 bg-black/30"
					onclick={() => (showSettings = false)}
					aria-label="Close settings"
				></button>
				<div class="relative flex h-full w-full max-w-[320px] flex-col gap-4 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-4">
					<div class="flex items-center justify-between">
						<h2 class="text-lg font-semibold text-[var(--fg)]">Settings</h2>
						<button
							onclick={() => (showSettings = false)}
							class="rounded p-1 text-[var(--muted)] hover:text-[var(--fg)]"
							aria-label="Close"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
								><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"
								/></svg
							>
						</button>
					</div>

					<!-- Theme -->
					<div>
						<span class="mb-1 block text-sm font-medium text-[var(--fg)]">Theme</span>
						<div class="flex gap-2">
							{#each themes as t}
								<button
									onclick={() => settings.update((s) => ({ ...s, theme: t.value as typeof s.theme }))}
									class="flex-1 rounded border px-2 py-1.5 text-sm {t.value === $settings.theme
										? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
										: 'border-[var(--border)] text-[var(--fg)]'}"
								>
									{t.label}
								</button>
							{/each}
						</div>
					</div>

					<!-- Font size -->
					<div>
						<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="font-size-slider">
							Font Size ({$settings.fontSize}rem)
						</label>
						<input
							id="font-size-slider"
							type="range"
							min="0.8"
							max="2"
							step="0.1"
							value={$settings.fontSize}
							oninput={(e) =>
								settings.update((s) => ({
									...s,
									fontSize: parseFloat(e.currentTarget.value)
								}))}
							class="w-full"
						/>
					</div>

					<!-- Line height -->
					<div>
						<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="line-height-select">
							Line Height ({$settings.lineHeight})
						</label>
						<select
							id="line-height-select"
							value={$settings.lineHeight}
							onchange={(e) =>
								settings.update((s) => ({
									...s,
									lineHeight: parseFloat(e.currentTarget.value)
								}))}
							class="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[var(--fg)]"
						>
							{#each lineHeights as lh}
								<option value={lh}>{lh}</option>
							{/each}
						</select>
					</div>

					<!-- Max width -->
					<div>
						<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="max-width-slider">
							Max Width ({$settings.maxWidth}ch)
						</label>
						<input
							id="max-width-slider"
							type="range"
							min="40"
							max="90"
							step="5"
							value={$settings.maxWidth}
							oninput={(e) =>
								settings.update((s) => ({
									...s,
									maxWidth: parseFloat(e.currentTarget.value)
								}))}
							class="w-full"
						/>
					</div>

					<!-- Margins -->
					<div>
						<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="margins-slider">
							Side Margins ({$settings.sideMargins}px)
						</label>
						<input
							id="margins-slider"
							type="range"
							min="0"
							max="64"
							step="4"
							value={$settings.sideMargins}
							oninput={(e) =>
								settings.update((s) => ({
									...s,
									sideMargins: parseFloat(e.currentTarget.value)
								}))}
							class="w-full"
						/>
					</div>

					<!-- Highlight colors -->
					<div>
						<span class="mb-1 block text-sm font-medium text-[var(--fg)]">Highlight Color</span>
						<div class="flex gap-2">
							<input
								type="color"
								value={$settings.hlBg}
								oninput={(e) =>
									settings.update((s) => ({
										...s,
										hlBg: e.currentTarget.value
									}))}
								class="h-10 w-10 cursor-pointer rounded border border-[var(--border)]"
								aria-label="Highlight background"
							/>
							<input
								type="color"
								value={$settings.hlFg}
								oninput={(e) =>
									settings.update((s) => ({
										...s,
										hlFg: e.currentTarget.value
									}))}
								class="h-10 w-10 cursor-pointer rounded border border-[var(--border)]"
								aria-label="Highlight foreground"
							/>
						</div>
					</div>

					<!--
						Gap threshold and non-speech filtering only affect the
						subtitle pipeline, which infers structure from audio gaps.
						In EPUB mode the structure is real, so these do nothing.
					-->
					{#if textMode !== 'epub'}
						<!-- Gap threshold -->
						<div>
							<label class="mb-1 block text-sm font-medium text-[var(--fg)]" for="gap-threshold-slider">
								Gap Threshold ({$settings.gapThreshold}s)
							</label>
							<input
								id="gap-threshold-slider"
								type="range"
								min="0.5"
								max="3"
								step="0.1"
								value={$settings.gapThreshold}
								oninput={(e) =>
									settings.update((s) => ({
										...s,
										gapThreshold: parseFloat(e.currentTarget.value)
									}))}
								class="w-full"
							/>
						</div>

						<!-- Show non-speech -->
						<div class="flex items-center justify-between">
							<label class="text-sm font-medium text-[var(--fg)]" for="show-non-speech">
								Show non-speech cues
							</label>
							<input
								id="show-non-speech"
								type="checkbox"
								checked={$settings.showNonSpeech}
								onchange={(e) =>
									settings.update((s) => ({
										...s,
										showNonSpeech: e.currentTarget.checked
									}))}
								class="h-5 w-5"
							/>
						</div>
					{:else}
						<div class="text-sm text-[var(--muted)]">
							Text is from the EPUB, so paragraph and sentence breaks come
							from the book itself. Gap and non-speech options do not apply.
						</div>
					{/if}

					<!-- Reset -->
					<button
						onclick={() => settings.reset()}
						class="rounded border border-[var(--border)] px-4 py-2 text-sm text-[var(--fg)] hover:bg-[var(--border)]"
					>
						Reset to defaults
					</button>
				</div>
			</div>
		{/if}
	</div>
{/if}
