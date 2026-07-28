<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { connection } from '$lib/stores/connection';
	import { player } from '$lib/stores/player';
	import { reader } from '$lib/stores/reader';
	import { recent } from '$lib/stores/recent';
	import { offsets, clampOffset, MAX_OFFSET } from '$lib/stores/offsets';
	import { settings, defaultSettings } from '$lib/stores/settings';
	import SettingsPanel from '$lib/components/SettingsPanel.svelte';
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
	import { primeCapture, releaseCapture } from '$lib/anki/capture';
	import { mineSentence } from '$lib/anki/mine';

	// Route params are typed as possibly-undefined; this page cannot render
	// without an id, so narrow once here rather than at every call site.
	const itemId = $derived($page.params.itemId ?? '');

	let scrollerEl = $state<HTMLDivElement>();
	let contentEl = $state<HTMLDivElement>();
	let showSettings = $state(false);
	let showChapterDropdown = $state(false);
	let showVolumeSlider = $state(false);
	let showOffsetPanel = $state(false);

	/** ttu-style immersive chrome: the header and player bar fade out while reading. */
	let chromeVisible = $state(true);
	let chromeTimer: ReturnType<typeof setTimeout> | null = null;

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

	// --- Anki mining ---------------------------------------------------------

	/**
	 * The highlight clears in the gaps between cues, but a line is usually
	 * mined a beat after it finishes. Holding the last highlighted sentence
	 * keeps the button aimed at what the user just heard.
	 */
	let lastActiveId = $state<number | null>(null);
	let mining = $state(false);
	/** Capture progress, 0..1 — a mine takes as long as the line does. */
	let mineProgress = $state(0);
	/** The first mine of a book loads its index, which has no percentage. */
	let minePhase = $state<'preparing' | 'recording'>('recording');
	let toast = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	const sentenceById = $derived.by(() => {
		const map = new Map<number, { id: number; start: number; end: number; text?: string }>();
		for (const s of $reader.cueIndex?.sentences ?? []) map.set(s.id, s);
		return map;
	});

	const mineTarget = $derived(
		lastActiveId === null ? null : (sentenceById.get(lastActiveId) ?? null)
	);
	const canMine = $derived($settings.ankiEnabled && mineTarget !== null && !mining);

	$effect(() => {
		const id = $reader.activeSentenceId;
		if (id !== null) lastActiveId = id;
	});

	function showToast(kind: 'ok' | 'err', text: string) {
		if (toastTimer) clearTimeout(toastTimer);
		toast = { kind, text };
		toastTimer = setTimeout(() => (toast = null), kind === 'err' ? 8000 : 4000);
	}

	async function mineCurrent() {
		const target = mineTarget;
		if (!target || mining) return;
		revealChrome();
		mining = true;
		mineProgress = 0;
		minePhase = 'preparing';
		// Must happen on the click itself: an AudioContext only leaves the
		// suspended state from within a user gesture, and a suspended one
		// produces no frames for the capture to collect.
		primeCapture();
		try {
			const result = await mineSentence(
				{
					itemId,
					audioSrc: player.getSrc(),
					text: target.text ?? '',
					start: target.start,
					end: target.end,
					onProgress: (f) => (mineProgress = f),
					onPhase: (p) => (minePhase = p)
				},
				$settings
			);
			const kb = Math.round(result.byteLength / 1024);
			const verb = result.action === 'created' ? 'Created card' : 'Updated last card';
			showToast('ok', `${verb} · ${kb} KB`);
		} catch (err) {
			// Logged as well as shown: the toast has to stay short, and the
			// stack is what identifies which step gave up.
			console.error('[readalong] mine failed', err);
			showToast('err', err instanceof Error ? err.message : 'Mining failed');
		} finally {
			mining = false;
			mineProgress = 0;
		}
	}

	/**
	 * A book that has been tuned keeps its own offset; everything else follows
	 * the global default, so fixing one bad transcript does not skew the rest.
	 */
	const bookOffset = $derived($offsets[itemId]);
	const hasBookOffset = $derived(typeof bookOffset === 'number');
	const effectiveOffset = $derived(hasBookOffset ? bookOffset : $settings.timingOffset);

	$effect(() => {
		syncController?.setOffset(effectiveOffset);
	});

	$effect(() => {
		autoScroller?.setOptions({
			anchor: $settings.scrollAnchor,
			smooth: $settings.smoothScroll
		});
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

	// Chrome hides only while audio is actually playing: a paused reader is
	// being looked at, not read along with.
	$effect(() => {
		if (!$settings.autoHideChrome || !$player.playing) {
			if (chromeTimer) clearTimeout(chromeTimer);
			chromeTimer = null;
			chromeVisible = true;
			return;
		}
		scheduleChromeHide();
	});

	function scheduleChromeHide() {
		if (chromeTimer) clearTimeout(chromeTimer);
		chromeTimer = setTimeout(() => {
			// Never hide chrome out from under an open popover.
			if (showSettings || showChapterDropdown || showVolumeSlider || showOffsetPanel) {
				scheduleChromeHide();
				return;
			}
			chromeVisible = false;
		}, 2500);
	}

	function revealChrome() {
		chromeVisible = true;
		if ($settings.autoHideChrome && $player.playing) scheduleChromeHide();
	}

	/** Tapping the page toggles chrome, matching ttu's reader. */
	function handleReaderTap(e: MouseEvent) {
		// A tap that lands on a text selection is the user reading, not toggling.
		if (window.getSelection()?.toString()) return;
		if (chromeVisible) {
			chromeVisible = false;
			if (chromeTimer) clearTimeout(chromeTimer);
		} else {
			revealChrome();
		}
	}

	onMount(async () => {
		if (!connectionToken) {
			await goto('/');
			return;
		}

		// Scoping the sweep to the rendered text keeps it off the rest of the page;
		// contentEl is not bound yet, so it is resolved lazily on each call.
		highlighter = createHighlighter({ getRoot: () => contentEl ?? document });
		window.addEventListener('keydown', handleKeyDown);

		const restart = $page.url.searchParams.get('restart') === '1';

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
				const bookmark = restart ? 0 : (player.getBookmark(itemId) ?? 0);
				if (bookmark > 0) {
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

					attachSync(timingIndex, (id) => epubRender?.elementFor(id));
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
					const sentenceMap = renderParagraphs(cueIndex.paragraphs, contentEl);
					reader.setSentenceMap(sentenceMap);

					attachSync(cueIndex, (id) => sentenceMap.get(id));
				});
			}

			reader.setLoading(false);
		} catch (err) {
			errorState = err instanceof Error ? err.message : 'Failed to load item';
		} finally {
			loading = false;
		}
	});

	/** Shared by both text pipelines; only the element lookup differs. */
	function attachSync(
		timingIndex: Parameters<typeof createSyncController>[1],
		elementFor: (id: number) => HTMLElement | undefined
	) {
		const audioEl = player.getAudioElement();
		if (audioEl) {
			syncController = createSyncController(
				audioEl,
				timingIndex,
				(id) => reader.setActiveSentence(id),
				effectiveOffset
			);
			syncController.start();
		}

		if (scrollerEl) {
			autoScroller = createAutoScroller(scrollerEl, elementFor, {
				anchor: $settings.scrollAnchor,
				smooth: $settings.smoothScroll
			});
		}
	}

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
		if (chromeTimer) clearTimeout(chromeTimer);
		if (toastTimer) clearTimeout(toastTimer);
		// The capture tap is deliberately left attached: it belongs to the
		// singleton audio element, and createMediaElementSource cannot be
		// re-run on an element that already has one.
		window.removeEventListener('keydown', handleKeyDown);
		// The audio element is a singleton that outlives this page, so the
		// controller's listeners have to come off with it.
		syncController?.destroy();
		autoScroller?.destroy();
		highlighter?.reset();
		epubRender?.destroy();
		epubRender = null;
		// The capture element holds this book's audio index; a different book
		// needs a different one.
		releaseCapture();
		reader.reset();
		player.pause();
		if (sleepInterval) clearInterval(sleepInterval);
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

	function toggleAutoScroll() {
		autoScrollLocked = !autoScrollLocked;
		if (!autoScrollLocked && $reader.activeSentenceId !== null) {
			autoScroller?.scrollTo($reader.activeSentenceId);
		}
	}

	function nudgeOffset(delta: number) {
		offsets.set(itemId, clampOffset(effectiveOffset + delta));
	}

	function setOffsetValue(value: number) {
		offsets.set(itemId, value);
	}

	function clearBookOffset() {
		offsets.clear(itemId);
	}

	function setSleepTimer(opt: SleepOption | null) {
		if (sleepInterval) clearInterval(sleepInterval);
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
					if (sleepInterval) clearInterval(sleepInterval);
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
					if (sleepInterval) clearInterval(sleepInterval);
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

	function formatRemaining(s: number): string {
		if (!Number.isFinite(s) || s <= 0) return '';
		const h = Math.floor(s / 3600);
		const m = Math.round((s % 3600) / 60);
		if (h > 0) return `${h}h ${m}m left`;
		return `${m}m left`;
	}

	function formatOffset(v: number): string {
		return `${v > 0 ? '+' : ''}${v.toFixed(2)}s`;
	}

	const chapters = $derived($reader.item?.media?.chapters || []);
	const currentChapterIdx = $derived(
		chapters.length > 0 ? chapters.findLastIndex((c) => $player.currentTime >= c.start) : -1
	);
	const currentChapter = $derived(
		currentChapterIdx >= 0 ? chapters[currentChapterIdx]?.title || '' : chapters[0]?.title || ''
	);

	const seekPercent = $derived(
		$player.duration > 0 ? ($player.currentTime / $player.duration) * 100 : 0
	);

	const remainingLabel = $derived(
		$player.duration > 0 ? formatRemaining($player.duration - $player.currentTime) : ''
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
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLSelectElement ||
			e.target instanceof HTMLButtonElement
		)
			return;
		switch (e.key) {
			case ' ':
				e.preventDefault();
				handlePlayPause();
				break;
			case 'ArrowLeft':
				player.skipBack(10);
				break;
			case 'ArrowRight':
				player.skipForward(10);
				break;
			case 'j':
				player.skipBack(10);
				break;
			case 'l':
				player.skipForward(10);
				break;
			case 'k':
				handlePlayPause();
				break;
			case 'h':
				player.skipBack(5);
				break;
			case 'n':
				goToNextChapter();
				break;
			case 'p':
				goToPrevChapter();
				break;
			case '[':
				nudgeOffset(-0.1);
				revealChrome();
				break;
			case ']':
				nudgeOffset(0.1);
				revealChrome();
				break;
			case 'a':
				if ($settings.ankiEnabled) mineCurrent();
				break;
		}
	}

	const rateOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
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
	<div class="relative flex h-dvh flex-col overflow-hidden bg-[var(--bg)]">
		<!-- Top bar -->
		<div
			class="absolute inset-x-0 top-0 z-30 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)]/90 px-3 py-2 backdrop-blur transition-transform duration-200 {chromeVisible
				? 'translate-y-0'
				: '-translate-y-full'}"
		>
			<button
				onclick={() => goto(`/book/${itemId}`)}
				class="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
				aria-label="Back to book details"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
			</button>

			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium text-[var(--fg)]">
					{$reader.item?.media?.metadata?.title || 'Untitled'}
				</p>
				<p class="truncate text-xs text-[var(--muted)]">
					{$reader.item?.media?.metadata?.authorName || ''}
					{#if currentChapter}&middot; {currentChapter}{/if}
				</p>
			</div>

			<!-- Sync offset -->
			{#if $reader.cueIndex}
				<div class="relative">
					<button
						onclick={() => (showOffsetPanel = !showOffsetPanel)}
						class="flex items-center gap-1 rounded border px-2 py-1.5 text-xs tabular-nums transition-colors {effectiveOffset !==
						0
							? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
							: 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]'}"
						aria-label="Adjust sync offset"
					>
						<svg
							class="h-3.5 w-3.5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							stroke-width="2"
						>
							<circle cx="12" cy="12" r="9" />
							<path stroke-linecap="round" d="M12 7v5l3 2" />
						</svg>
						{formatOffset(effectiveOffset)}
					</button>

					{#if showOffsetPanel}
						<button
							class="fixed inset-0 z-40 cursor-default"
							onclick={() => (showOffsetPanel = false)}
							aria-label="Close sync offset"
						></button>
						<div
							class="absolute top-full right-0 z-50 mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lg)]"
						>
							<div class="mb-2 flex items-baseline justify-between">
								<span class="text-sm font-medium text-[var(--fg)]">Sync offset</span>
								<span class="text-sm text-[var(--accent)] tabular-nums">
									{formatOffset(effectiveOffset)}
								</span>
							</div>

							<div class="flex items-center gap-2">
								<button
									onclick={() => nudgeOffset(-0.1)}
									class="h-9 w-9 shrink-0 rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
									aria-label="Move highlight later"
								>
									−
								</button>
								<input
									type="range"
									min={-MAX_OFFSET}
									max={MAX_OFFSET}
									step="0.05"
									value={effectiveOffset}
									oninput={(e) => setOffsetValue(parseFloat(e.currentTarget.value))}
									class="min-w-0 flex-1 accent-[var(--accent)]"
									aria-label="Sync offset in seconds"
								/>
								<button
									onclick={() => nudgeOffset(0.1)}
									class="h-9 w-9 shrink-0 rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
									aria-label="Move highlight earlier"
								>
									+
								</button>
							</div>

							<p class="mt-2 text-xs text-[var(--muted)]">
								{#if effectiveOffset > 0}
									Highlight runs {effectiveOffset.toFixed(2)}s ahead of the audio.
								{:else if effectiveOffset < 0}
									Highlight runs {Math.abs(effectiveOffset).toFixed(2)}s behind the audio.
								{:else}
									Highlight follows the audio exactly.
								{/if}
							</p>

							<div class="mt-2 flex items-center justify-between gap-2">
								<span class="text-xs text-[var(--muted)]">
									{hasBookOffset ? 'Saved for this book' : 'Using global default'}
								</span>
								<div class="flex gap-2">
									<button
										onclick={() => setOffsetValue(0)}
										class="rounded px-2 py-1 text-xs text-[var(--fg)] hover:bg-[var(--surface-hover)]"
									>
										Zero
									</button>
									{#if hasBookOffset}
										<button
											onclick={clearBookOffset}
											class="rounded px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)]"
										>
											Use default
										</button>
									{/if}
								</div>
							</div>
							<p class="mt-2 text-xs text-[var(--muted)]">Keys: [ and ] adjust by 0.1s.</p>
						</div>
					{/if}
				</div>
			{/if}

			<button
				onclick={() => (showSettings = !showSettings)}
				class="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
				aria-label="Settings"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/>
					<circle
						cx="12"
						cy="12"
						r="3"
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
					/>
				</svg>
			</button>
		</div>

		<!-- Reader area. Fills the frame; chrome floats above it so hiding the
		     chrome does not reflow the text and lose the reading position. -->
		<div
			bind:this={scrollerEl}
			onclick={handleReaderTap}
			role="presentation"
			class="flex-1 overflow-y-auto px-[var(--theme-side-margins)] pt-16 pb-28"
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
					{Math.round(coverage * 100)}% of the book is synced to the audio. Unsynced passages are
					shown but will not highlight.
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

		<!-- Slim progress line, the only chrome that survives immersive mode. -->
		<div class="pointer-events-none absolute inset-x-0 bottom-0 z-20">
			<div
				class="flex items-center justify-between px-3 pb-1 text-[11px] text-[var(--muted)] tabular-nums transition-opacity duration-200 {chromeVisible
					? 'opacity-0'
					: 'opacity-100'}"
			>
				<span>{Math.round(seekPercent)}%</span>
				<span>{remainingLabel}</span>
			</div>
			<div class="h-0.5 w-full bg-[var(--border)]">
				<div class="h-full bg-[var(--accent)]" style="width: {seekPercent}%"></div>
			</div>
		</div>

		<!-- Player bar -->
		<div
			class="absolute inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] px-2 py-2 transition-transform duration-200 sm:px-3 {chromeVisible
				? 'translate-y-0'
				: 'translate-y-full'}"
		>
			<div class="mx-auto flex max-w-2xl flex-col gap-1.5 sm:gap-2">
				<!-- Seek bar -->
				<div class="flex items-center gap-1.5 sm:gap-2">
					<span
						class="min-w-[48px] text-right text-xs text-[var(--muted)] tabular-nums sm:min-w-[52px]"
					>
						{formatTime($player.currentTime)}
					</span>
					<input
						type="range"
						min="0"
						max={$player.duration || 0}
						value={$player.currentTime}
						oninput={handleSeek}
						style="background: linear-gradient(to right, var(--accent) 0%, var(--accent) {seekPercent}%, var(--border) {seekPercent}%, var(--border) 100%)"
						class="h-3 flex-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md"
						aria-label="Seek"
					/>
					<span class="min-w-[48px] text-xs text-[var(--muted)] tabular-nums sm:min-w-[52px]">
						{formatTime($player.duration)}
					</span>
				</div>

				<!-- Controls row -->
				<div class="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
					<!-- Transport buttons -->
					<div class="flex items-center justify-center gap-0.5 sm:gap-1">
						<button
							onclick={goToPrevChapter}
							class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
							aria-label="Previous chapter"
						>
							<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M16.67 0l2.83 2.829-9.339 9.175 9.339 9.167-2.83 2.829-12.17-11.996z" />
							</svg>
						</button>

						<button
							onclick={() => player.skipBack(10)}
							class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
							aria-label="Skip back 10s"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"
								/>
							</svg>
						</button>

						<button
							onclick={handlePlayPause}
							class="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full p-2.5 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px] sm:p-3"
							aria-label={$player.playing ? 'Pause' : 'Play'}
						>
							{#if $player.playing}
								<svg class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
									<path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
								</svg>
							{:else}
								<svg class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
									<path d="M8 5v14l11-7z" />
								</svg>
							{/if}
						</button>

						<button
							onclick={() => player.skipForward(10)}
							class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
							aria-label="Skip forward 10s"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z"
								/>
							</svg>
						</button>

						<button
							onclick={goToNextChapter}
							class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
							aria-label="Next chapter"
						>
							<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M7.33 24l-2.83-2.829 9.339-9.175-9.339-9.167 2.83-2.829 12.17 11.996z" />
							</svg>
						</button>
					</div>

					<!-- Utility controls -->
					<div class="flex items-center justify-center gap-1.5 sm:gap-2">
						<!-- Volume -->
						<div class="relative">
							<button
								onclick={() => (showVolumeSlider = !showVolumeSlider)}
								class="flex min-h-[40px] min-w-[40px] items-center justify-center rounded p-1.5 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px]"
								aria-label="Volume"
							>
								<svg
									class="h-4 w-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									stroke-width="2"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M6.5 8.5H4a1 1 0 00-1 1v5a1 1 0 001 1h2.5l4 4V4.5l-4 4z"
									/>
								</svg>
							</button>
							{#if showVolumeSlider}
								<button
									class="fixed inset-0 z-40 cursor-default"
									onclick={() => (showVolumeSlider = false)}
									aria-label="Close volume"
								></button>
								<div
									class="absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 rounded border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg"
								>
									<input
										type="range"
										min="0"
										max="1"
										step="0.05"
										value={$player.volume}
										oninput={handleVolumeChange}
										class="h-16 w-6 appearance-none rounded-full [writing-mode:vertical-lr] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)]"
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
								class="min-h-[40px] cursor-pointer appearance-none rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1.5 text-xs text-[var(--fg)] sm:min-h-[44px] sm:px-2 sm:text-sm"
								aria-label="Sleep timer"
							>
								{#each sleepPresets as p}
									<option value={p.value ?? 'off'}>{p.label}</option>
								{/each}
							</select>
							{#if sleepRemaining}
								<span
									class="absolute -top-5 left-1/2 -translate-x-1/2 text-xs whitespace-nowrap text-[var(--accent)]"
								>
									{sleepRemaining}
								</span>
							{/if}
						</div>

						{#if chapters.length > 0}
							<div class="relative">
								<button
									onclick={() => (showChapterDropdown = !showChapterDropdown)}
									class="min-h-[40px] max-w-[140px] truncate rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:max-w-[180px] sm:text-sm"
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
									<div
										class="absolute bottom-full left-1/2 z-50 mb-1 max-h-56 w-72 -translate-x-1/2 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg sm:left-0 sm:w-64 sm:translate-x-0"
									>
										{#each chapters as ch, i}
											<button
												onclick={() => {
													jumpToChapter(i);
													showChapterDropdown = false;
												}}
												class="block w-full px-3 py-2.5 text-left text-sm text-[var(--fg)] hover:bg-[var(--border)] sm:py-2 {i ===
												currentChapterIdx
													? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
													: ''}"
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
							class="min-h-[40px] rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1.5 text-xs text-[var(--fg)] sm:min-h-[44px] sm:px-2 sm:text-sm"
							aria-label="Playback speed"
						>
							{#each rateOptions as r}
								<option value={r}>{r}x</option>
							{/each}
						</select>

						{#if $settings.ankiEnabled}
							<button
								onclick={mineCurrent}
								disabled={!canMine}
								class="flex min-h-[40px] items-center gap-1 rounded border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--fg)] transition-colors hover:bg-[var(--border)] disabled:opacity-40 sm:min-h-[44px] sm:gap-1.5 sm:px-3 sm:text-sm"
								aria-label="Mine this sentence to Anki"
								title="Mine this sentence to Anki (a)"
							>
								{#if mining}
									<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
										<circle
											cx="12"
											cy="12"
											r="9"
											stroke="currentColor"
											stroke-width="2"
											opacity="0.25"
										/>
										<path
											d="M21 12a9 9 0 00-9-9"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
										/>
									</svg>
								{:else}
									<svg
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
										stroke-width="2"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M12 4v12m0 0l-4-4m4 4l4-4M5 19h14"
										/>
									</svg>
								{/if}
								<span class="hidden sm:inline">
									{#if !mining}
										Mine
									{:else if minePhase === 'preparing'}
										Loading
									{:else}
										{Math.round(mineProgress * 100)}%
									{/if}
								</span>
							</button>
						{/if}

						<button
							onclick={toggleAutoScroll}
							class="flex min-h-[40px] items-center gap-1 rounded border px-2 py-1.5 text-xs sm:min-h-[44px] sm:gap-1.5 sm:px-3 sm:text-sm {autoScrollLocked
								? 'border-[var(--border)] text-[var(--muted)]'
								: 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'}"
							aria-label={autoScrollLocked ? 'Enable auto-scroll' : 'Disable auto-scroll'}
						>
							<span
								class="inline-block h-2 w-2 rounded-full {autoScrollLocked
									? 'bg-[var(--muted)]'
									: 'bg-[var(--accent)]'}"
							></span>
							<span class="hidden sm:inline">Autoscroll</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Mining result. Sits above the player bar so it stays readable when
		     the chrome slides away. -->
		{#if toast}
			<div
				class="pointer-events-none absolute inset-x-0 bottom-28 z-40 flex justify-center px-4"
				role="status"
				aria-live="polite"
			>
				<div
					class="max-w-md rounded-lg border px-3 py-2 text-sm shadow-[var(--shadow-lg)] {toast.kind ===
					'err'
						? 'border-red-500/40 bg-[var(--surface)] text-red-500'
						: 'border-[var(--accent)] bg-[var(--surface)] text-[var(--fg)]'}"
				>
					{toast.text}
				</div>
			</div>
		{/if}

		<!-- Settings sheet -->
		{#if showSettings}
			<div class="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="Settings">
				<button
					class="absolute inset-0 bg-black/30"
					onclick={() => (showSettings = false)}
					aria-label="Close settings"
				></button>
				<div
					class="relative flex h-full w-full max-w-[360px] flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-4"
				>
					<div class="mb-4 flex items-center justify-between">
						<h2 class="text-lg font-semibold text-[var(--fg)]">Settings</h2>
						<button
							onclick={() => (showSettings = false)}
							class="rounded p-1 text-[var(--muted)] hover:text-[var(--fg)]"
							aria-label="Close"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
					</div>

					<SettingsPanel showSubtitleOptions={textMode !== 'epub'} />

					{#if textMode === 'epub'}
						<p class="mt-4 text-sm text-[var(--muted)]">
							Text is from the EPUB, so paragraph and sentence breaks come from the book itself. Gap
							and non-speech options do not apply.
						</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
