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
	import { cueIndexAt, nearestCueIndex, nextCueStart, prevCueStart } from '$lib/sync/navigate';
	import { buildRepeatUnits } from '$lib/sync/quotes';
	import { createRepeatController, type RepeatController } from '$lib/sync/repeat';
	import type { AlignmentStats, EpubChapter, TimingIndex } from '$lib/types';
	import { createSyncController, type SyncController } from '$lib/sync/ticker';
	import { createAutoScroller, type AutoScroller } from '$lib/sync/autoscroll';
	import { renderParagraphs } from '$lib/reader/renderer';
	import { renderEpub, type EpubRenderHandle } from '$lib/reader/epubRenderer';
	import {
		chapterProgress,
		formatRemaining,
		nextProgressMode,
		type ProgressMode
	} from '$lib/reader/progress';
	import { loadTextSource, type TextSourceMode } from '$lib/epub/source';
	import { parseStartParam } from '$lib/reader/startParam';
	import { createHighlighter, type HighlightHandle } from '$lib/reader/highlight';
	import { narrationDirection, type NarrationDirection } from '$lib/reader/narrationDirection';
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
	let showToc = $state(false);
	let settingsCloseBtn = $state<HTMLButtonElement>();
	let settingsTriggerEl: HTMLElement | null = null;

	/**
	 * Whether the audio is driving the page. Off, this is an ebook reader: the
	 * transport goes away, nothing is highlighted, and windowing follows the
	 * reader alone.
	 */
	const readAlong = $derived($settings.readAlong);

	/**
	 * The reader has moved away from the narration on purpose — scrolled the
	 * active line off the screen, or jumped to another chapter — so auto-scroll
	 * stands down until they ask to come back.
	 *
	 * This is separate from `autoScrollLocked`, which is a standing preference.
	 * Detaching is a fact about right now, and it is what makes it possible to
	 * read one chapter while the narration is in another. It matters most where
	 * alignment failed: the highlight cannot follow audio it could not match, so
	 * without this the reader is pinned to the last line that did match.
	 */
	let detached = $state(false);

	/** Which way the narration lies from the viewport, for the button's arrow. */
	let narrationDir = $state<NarrationDirection>('down');

	/** EPUB spine, for the table of contents. Empty in subtitle mode. */
	let epubChapters = $state<EpubChapter[]>([]);
	/** Spine order of the chapter on screen, for the contents list. */
	let viewChapterOrder = $state<number | null>(null);

	/** ttu-style immersive chrome: the header and player bar fade out while reading. */
	let chromeVisible = $state(true);
	let chromeTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * When the chrome hides, the top bar's layout space collapses so the
	 * reader area rises right up under the progress strip — no dead band. The
	 * scroll position is then compensated by the bar's height in lockstep, or
	 * the text under the reader's finger would jump.
	 */
	let topBarEl = $state<HTMLDivElement>();
	let topBarHeight = $state(0);

	$effect(() => {
		if (topBarEl) topBarHeight = topBarEl.offsetHeight;
	});

	let chromeScrollAnim: number | null = null;
	/** The last value `chromeVisible` had; null until the first run, which
	 *  must not compensate because nothing has moved yet. */
	let lastChromeVisible: boolean | null = null;

	/**
	 * Moves the scroll position by `delta` over the same 200ms the top bar's
	 * collapse takes, linearly, so the net visible text never shifts. Only the
	 * reading axis can be corrected: under vertical text the shift is
	 * perpendicular to it, so there the collapse relocates the view instead.
	 */
	function compensateChromeScroll(delta: number) {
		const el = scrollerEl;
		if (!el || delta === 0 || $settings.verticalText) return;
		autoScroller?.noteProgrammaticScroll();
		if (chromeScrollAnim !== null) cancelAnimationFrame(chromeScrollAnim);
		const from = el.scrollTop;
		const duration = 200;
		const start = performance.now();
		const step = () => {
			const p = Math.min(1, (performance.now() - start) / duration);
			el.scrollTop = from + delta * p;
			chromeScrollAnim = p < 1 ? requestAnimationFrame(step) : null;
		};
		chromeScrollAnim = requestAnimationFrame(step);
	}

	$effect(() => {
		const visible = chromeVisible;
		if (visible === lastChromeVisible) return;
		const wasSet = lastChromeVisible !== null;
		lastChromeVisible = visible;
		// Hiding shrinks the reader area from the top, so the content must be
		// scrolled back down to keep the reading position; revealing reverses.
		if (wasSet) compensateChromeScroll(visible ? topBarHeight : -topBarHeight);
	});

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
	let repeatController: RepeatController | null = null;
	let autoScroller: AutoScroller | null = null;
	let highlighter: HighlightHandle | null = null;
	let epubRender: EpubRenderHandle | null = null;
	let saveBookmarkInterval: ReturnType<typeof setInterval> | null = null;

	/** Which text source is driving the view. */
	let textMode = $state<TextSourceMode>('none');
	/**
	 * Where playback is heading once the audio finishes loading: the resume
	 * bookmark or the `?at=` chapter target, known at mount even though the
	 * element cannot seek until metadata arrives. The text is positioned at
	 * this time immediately; the seeked event re-aims when it lands.
	 */
	let loadTarget: number | null = null;
	/** Fraction of the book that received timing, when in EPUB mode. */
	let coverage = $state<number | null>(null);
	/** Full alignment result, for the sync report. */
	let alignStats = $state<AlignmentStats | null>(null);
	let showSyncPanel = $state(false);
	/** Non-fatal explanation when EPUB mode was attempted but not used. */
	let sourceNotice = $state<string | null>(null);
	/** Set when the page is torn down; every await in onMount must bail on it. */
	let disposed = false;
	/** The stream session exists but has no audio track. */
	let noAudioNotice = $state(false);

	let connectionToken = '';
	let gapThreshold = defaultSettings.gapThreshold;
	let showNonSpeech = defaultSettings.showNonSpeech;

	const unsubConnection = connection.subscribe((s) => {
		connectionToken = s.token;
	});

	const unsubSettings = settings.subscribe((s) => {
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
			// Only on success: a failed mine has interrupted the user enough.
			applyMinePause(target);
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
	 * Where playback is left once a card has been written. Mining takes as long
	 * as the line does, so by the time it lands the audio has moved on — which
	 * of "carry on", "stop here" and "go back to the line" is wanted depends
	 * entirely on whether the user is listening or studying.
	 */
	function applyMinePause(target: { start: number; end: number }) {
		const mode = $settings.ankiPauseAfter;
		if (mode === 'none') return;
		player.pause();
		if (mode === 'start') seekToCue(target.start);
		else if (mode === 'end') seekToCue(target.end);
	}

	/**
	 * A book that has been tuned keeps its own offset; everything else follows
	 * the global default, so fixing one bad transcript does not skew the rest.
	 */
	const bookOffset = $derived($offsets[itemId]);
	const hasBookOffset = $derived(typeof bookOffset === 'number');
	const effectiveOffset = $derived(hasBookOffset ? bookOffset : $settings.timingOffset);

	// Every effect that pushes a value into one of these controllers reads it
	// into a local FIRST. The controllers are built in a `requestAnimationFrame`
	// inside `onMount`, so they are all still null when effects first run, and
	// `controller?.set(value)` would short-circuit before evaluating `value` —
	// leaving the effect with no dependency at all, so it never runs again and
	// the setting appears frozen until a reload.
	$effect(() => {
		const offset = effectiveOffset;
		syncController?.setOffset(offset);
	});

	$effect(() => {
		const anchor = $settings.scrollAnchor;
		const smooth = $settings.smoothScroll;
		const vertical = $settings.verticalText;
		autoScroller?.setOptions({ anchor, smooth, vertical });
	});

	/**
	 * Rotating the text rotates the scrolling axis, which invalidates every
	 * placeholder the chapter windowing had measured and leaves the reader
	 * parked at an offset that no longer means anything. Re-anchor on the line
	 * being read.
	 *
	 * Guarded on the value actually changing: the effect is re-evaluated
	 * whenever settings change, and re-anchoring on every one of those would
	 * fight the autoscroller.
	 */
	let lastVertical: boolean | null = null;
	$effect(() => {
		const vertical = $settings.verticalText;
		if (lastVertical === vertical) return;
		const isFirstRun = lastVertical === null;
		lastVertical = vertical;
		if (isFirstRun) return;

		epubRender?.invalidateLayout();
		const id = lastActiveId;
		if (id === null) return;
		// After the browser has reflowed to the new axis, not during.
		requestAnimationFrame(() => {
			epubRender?.ensureVisible(id);
			autoScroller?.resume();
			autoScroller?.scrollTo(id);
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

		// `detached` is the reader having gone somewhere else on purpose. The
		// highlight above still tracks the audio, so coming back is one tap.
		if (!autoScrollLocked && !detached) {
			autoScroller?.scrollTo(id);
		}
	});

	/**
	 * Read-along on or off. Guarded on the value actually changing, because the
	 * effect re-runs on every settings change and pausing the book each time
	 * someone drags the font-size slider would be its own bug.
	 */
	let lastReadAlong: boolean | null = null;
	$effect(() => {
		const on = $settings.readAlong;
		syncController?.setEnabled(on);
		if (lastReadAlong === on) return;
		const isFirstRun = lastReadAlong === null;
		lastReadAlong = on;
		if (isFirstRun) return;

		if (on) {
			// Deliberately does not scroll. Switching read-along on while reading
			// somewhere else should not rip the page away — if the narration is
			// elsewhere the reader starts detached and is *offered* the way back.
			detached = !narrationIsOnScreen();
			if (!detached) autoScroller?.resume();
		} else {
			// An ebook reader with no transport must not leave audio playing
			// that there is no longer any control to stop.
			player.pause();
			detached = false;
			// Nothing pins the narration's chapter mounted any more, so
			// windowing follows the reader alone.
			epubRender?.clearAudioAnchor();
		}
	});

	/**
	 * The placeholders holding unmounted chapters open were measured under the
	 * old type, and every estimate derived from them scales with it. Left stale,
	 * the scrollbar lies and the text shifts as chapters mount.
	 */
	let lastLayoutKey: string | null = null;
	$effect(() => {
		const s = $settings;
		const key = [
			s.fontSize,
			s.lineHeight,
			s.fontFamily,
			s.maxWidth,
			s.sideMargins,
			s.paragraphSpacing,
			s.verticalWidth
		].join('|');
		if (lastLayoutKey === key) return;
		const isFirstRun = lastLayoutKey === null;
		lastLayoutKey = key;
		if (isFirstRun) return;
		// After the browser has reflowed to the new type, not during.
		requestAnimationFrame(() => epubRender?.invalidateLayout());
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

	$effect(() => {
		// Dependencies: the active sentence and the audio clock (audio moved),
		// and the detached flag (button appeared/disappeared). Re-aiming on
		// currentTime as well as on line boundaries keeps the arrow current
		// while the narration crosses the viewport mid-line — a sentence can
		// be several seconds long, which used to delay the flip until the
		// next line boundary. Reading the store values inside the effect body
		// is what subscribes the effect to them.
		$reader.activeSentenceId;
		$player.currentTime;
		if (!detached || !scrollerEl) return;
		narrationDir = currentNarrationDirection();
	});

	// The sheet is a dialog: focus moves in on open and back out on close.
	$effect(() => {
		if (showSettings) {
			settingsCloseBtn?.focus();
		} else if (settingsTriggerEl instanceof HTMLElement) {
			settingsTriggerEl.focus();
		}
	});

	function scheduleChromeHide() {
		if (chromeTimer) clearTimeout(chromeTimer);
		chromeTimer = setTimeout(() => {
			// Never hide chrome out from under an open popover.
			if (
				showSettings ||
				showChapterDropdown ||
				showVolumeSlider ||
				showOffsetPanel ||
				showToc ||
				showSyncPanel
			) {
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

	/**
	 * Links inside the book point at files of the EPUB, not at pages of this
	 * app. Fragment links scroll within the page and are left alone; anything
	 * else would route to the reader with a chapter filename as the item id.
	 */
	function handleContentLinkClick(e: MouseEvent) {
		const el = e.target as HTMLElement | null;
		const a = el?.closest?.('a');
		if (!a) return;
		const href = a.getAttribute('href');
		if (href && !href.startsWith('#')) e.preventDefault();
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
		// The book's own links point at files inside the EPUB, not at pages of
		// this app; without this, clicking one (a table of contents, a footnote)
		// routes here with a chapter filename as the item id and the page dies.
		scrollerEl?.addEventListener('click', handleContentLinkClick);
		scrollerEl?.addEventListener('scroll', handleNarrationScroll, { passive: true });

		const restart = $page.url.searchParams.get('restart') === '1';
		const startParam = parseStartParam($page.url.searchParams.get('at'));

		try {
			const client = new ABSClient('/abs', connectionToken);
			const item = await getItem(client, itemId);
			if (disposed) return;
			reader.setItem(item);
			reader.setLoading(true);

			const session = await getStreamSession(client, itemId);
			if (disposed) return;
			const directTrack = session.libraryItem?.media?.tracks?.[0];
			const audioSrc = directTrack?.contentUrl;
			if (audioSrc) {
				const src = `/abs${audioSrc}?token=${encodeURIComponent(connectionToken)}`;
				player.setSrc(src);
				const bookmark =
					startParam !== null ? startParam : restart ? 0 : (player.getBookmark(itemId) ?? 0);
				// Waits for metadata rather than guessing at a delay: 500ms was
				// enough on a local file and nowhere near enough for a long book
				// over a remote connection, where the seek landed before the
				// element knew its duration and was discarded.
				if (bookmark > 0) {
					loadTarget = bookmark;
					player.seekWhenReady(bookmark);
					// The element cannot move until metadata arrives, but the
					// transport can: seeding the store with the resume target
					// (and the API-known duration) keeps the seek bar and the
					// progress strip honest during the load, when the reader's
					// text is already being positioned at the target.
					player.setPosition(bookmark, item.media?.duration);
				}
			} else {
				// No track: stop whatever the previous book left playing on the
				// singleton element, or its position gets bookmarked under this
				// book's id on destroy. setSrc('') also zeroes the store's
				// currentTime, which the destroy guard relies on.
				player.setSrc('');
				noAudioNotice = true;
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
				if (disposed) return;
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
				alignStats = index.stats;

				// The ticker only reads starts/ends and sentence ids, so the
				// aligned index substitutes for a cue index without changes.
				const timingIndex = {
					paragraphs: [],
					sentences: index.timed,
					starts: index.starts,
					ends: index.ends
				};
				reader.setCueIndex(timingIndex);

				epubChapters = doc.chapters;

				requestAnimationFrame(() => {
					if (disposed || !contentEl) return;
					epubRender = renderEpub(index, doc.chapters, contentEl, {
						scroller: scrollerEl,
						onViewChapter: handleViewChapter,
						// Late-bound deliberately: the autoscroller does not exist
						// until `attachSync`, a few lines below this.
						onAdjustScroll: () => autoScroller?.noteProgrammaticScroll()
					});
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
					if (disposed || !contentEl) return;
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
			// The controllers are built here, after the effects have already run
			// once against a null controller, so the current settings have to be
			// pushed in by hand rather than waited for.
			syncController.setEnabled($settings.readAlong);
			syncController.start();

			repeatController = createRepeatController(audioEl, null, {
				enabled: $settings.repeatMode && $settings.readAlong,
				getOffset: () => effectiveOffset,
				onUnitEnd: (unit) => {
					pausedUnitStart = unit.start;
					revealChrome();
				}
			});
			// Force the memo to push the units it has (or build them now): the
			// effect may already have run before this controller existed.
			unitsBuiltFrom = null;
			syncRepeatUnits();

			// A seek is the one moment the reading position should chase the
			// audio unconditionally — including into passages alignment could not
			// match, where there is no highlight to follow.
			audioEl.addEventListener('seeked', handleAudioSeeked);
		}

		if (scrollerEl) {
			autoScroller = createAutoScroller(
				scrollerEl,
				elementFor,
				{
					anchor: $settings.scrollAnchor,
					smooth: $settings.smoothScroll,
					vertical: $settings.verticalText
				},
				{ onDetach: () => (detached = true) }
			);
		}

		// Open on the narration rather than on chapter one. With a resume or
		// chapter target known, position the text at that sentence right away:
		// the audio element is still at zero until metadata loads, so reading
		// the playhead would land on chapter one every time and then jump when
		// the seeked event finally arrives. Without a target, fall back to the
		// playhead as before.
		if ($settings.readAlong) {
			if (loadTarget !== null && loadTarget > 0) {
				const i = cueIndexAt(timingIndex, loadTarget);
				const id = i >= 0 ? (timingIndex.sentences[i]?.id ?? null) : null;
				if (id !== null) {
					detached = false;
					autoScroller?.resume();
					epubRender?.ensureVisible(id);
					// After the mount, not during: the chapter it just added
					// has to be laid out before there is anything to scroll to.
					requestAnimationFrame(() => autoScroller?.scrollTo(id));
				} else {
					goToNarration();
				}
			} else {
				goToNarration();
			}
		}
	}

	/**
	 * Puts the reading position back on the narration. Used by the follow
	 * button, by seeks, and once at load.
	 */
	function goToNarration() {
		const id = narrationSentenceId();
		if (id === null) return;
		detached = false;
		autoScroller?.resume();
		epubRender?.ensureVisible(id);
		// After the mount, not during: the chapter it just added has to be laid
		// out before there is anything to scroll to.
		requestAnimationFrame(() => autoScroller?.scrollTo(id));
	}

	/**
	 * Where the narration is relative to the viewport, for the button arrow.
	 * Falls back to the forward direction when the sentence has no mounted
	 * element or the scroller is missing.
	 */
	function currentNarrationDirection(): NarrationDirection {
		if (!scrollerEl) return $settings.verticalText ? 'left' : 'down';
		const id = narrationSentenceId();
		if (id === null) return $settings.verticalText ? 'left' : 'down';
		const el = epubRender ? epubRender.elementFor(id) : $reader.sentenceMap?.get(id);
		return narrationDirection(
			scrollerEl.getBoundingClientRect(),
			el ? el.getBoundingClientRect() : null,
			$settings.verticalText
		);
	}

	/** Re-aim the arrow as the narration moves while the reader is detached. */
	function handleNarrationScroll() {
		if (!detached) return;
		narrationDir = currentNarrationDirection();
	}

	/**
	 * The sentence the narration is at. Falls back to the nearest timed line
	 * when nothing covers the playhead, which is what keeps unmatched passages
	 * navigable instead of stranding the text where the highlight went out.
	 */
	function narrationSentenceId(): number | null {
		if ($reader.activeSentenceId !== null) return $reader.activeSentenceId;
		const index = $reader.cueIndex;
		if (!index) return null;
		const i = nearestCueIndex(index, highlightTime());
		return i === null ? null : (index.sentences[i]?.id ?? null);
	}

	/**
	 * Whether the line being narrated is in the frame. Used to decide, without
	 * moving anything, whether switching read-along on means "carry on
	 * together" or "you are reading elsewhere".
	 */
	function narrationIsOnScreen(): boolean {
		const id = narrationSentenceId();
		if (id === null || !scrollerEl) return true;
		const el = epubRender ? epubRender.elementFor(id) : $reader.sentenceMap?.get(id);
		// No element means its chapter is not even mounted.
		if (!el) return false;
		const r = el.getBoundingClientRect();
		const c = scrollerEl.getBoundingClientRect();
		return $settings.verticalText
			? r.left < c.right && r.right > c.left
			: r.top < c.bottom && r.bottom > c.top;
	}

	function handleAudioSeeked() {
		if (!$settings.readAlong) return;
		goToNarration();
	}

	/**
	 * Which chapter the reader is looking at, for the contents list.
	 *
	 * Deliberately not used to decide that the reader has moved away: the
	 * viewport crosses into the next chapter during the reader's own scroll at
	 * every chapter boundary, so a mismatch here means nothing on its own. That
	 * judgement belongs to the autoscroller, which knows which scrolls it
	 * caused itself.
	 */
	function handleViewChapter(order: number) {
		viewChapterOrder = order;
	}

	onDestroy(() => {
		disposed = true;
		unsubConnection();
		unsubSettings();
		// Only a page that actually loaded its item may record a position. The
		// audio element is a singleton that keeps playing whatever the previous
		// book had, so a failed page (a link inside the EPUB routed here with a
		// chapter filename as the item id) would otherwise write a bookmark and
		// a "Continue Listening" entry under that bogus id.
		if ($player.currentTime > 0 && $reader.item?.id === itemId) {
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
		scrollerEl?.removeEventListener('click', handleContentLinkClick);
		scrollerEl?.removeEventListener('scroll', handleNarrationScroll);
		// The audio element is a singleton that outlives this page, so the
		// controllers' listeners have to come off with it.
		player.getAudioElement()?.removeEventListener('seeked', handleAudioSeeked);
		syncController?.destroy();
		repeatController?.destroy();
		repeatController = null;
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
		// Turning it back on is a request to follow the narration again, which
		// includes coming back from wherever the reader had wandered to.
		if (!autoScrollLocked) goToNarration();
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

	const volumePercent = $derived(Math.round($player.volume * 100));

	const seekPercent = $derived(
		$player.duration > 0 ? ($player.currentTime / $player.duration) * 100 : 0
	);
	/**
	 * The progress strip's readout, cycled by tapping it: percentage of the
	 * chapter, percentage of the book, or time left in the chapter. Which
	 * readouts the cycle visits is set under Settings; chapter modes need
	 * chapter metadata, which some books lack.
	 */
	let progressMode = $state<ProgressMode>('book-pct');

	const chProgress = $derived(
		chapters.length > 0 ? chapterProgress(chapters, $player.currentTime, $player.duration) : null
	);

	/** The enabled modes this book can actually show. */
	const availableModes = $derived(
		$settings.progressModes.filter((m) => m === 'book-pct' || chProgress)
	);
	const effectiveProgressMode = $derived(
		availableModes.includes(progressMode) ? progressMode : (availableModes[0] ?? 'book-pct')
	);

	/** Fill width. Always the whole book: the mode only changes the readout,
	 *  never what the bar means. */
	const progressPercent = $derived(seekPercent);

	/** Bars mirror the reading direction: right to left under vertical text. */
	const progressRTL = $derived($settings.verticalText && $settings.reverseProgressVertical);

	/**
	 * The transport actions follow the reading direction: under vertical text,
	 * an arrow pointing along the way text advances (left) moves forward.
	 */
	const swapTransport = $derived($settings.verticalText && $settings.mirrorControlsVertical);

	/** Chapter starts as a fraction of the book, for the strip's tick marks. */
	const chapterMarkers = $derived(
		$player.duration > 0
			? chapters.map((c) => Math.min(100, (c.start / $player.duration) * 100))
			: []
	);

	const progressLabel = $derived.by(() => {
		if (effectiveProgressMode === 'book-pct' || !chProgress) {
			return `${Math.round(seekPercent)}%`;
		}
		// 1-based, and the chapter before the first one starts at is still "1".
		const ch = Math.max(0, chProgress.index) + 1;
		if (effectiveProgressMode === 'chapter-pct') {
			return `Ch ${ch} · ${Math.round(chProgress.percent)}%`;
		}
		return `Ch ${ch} · ${formatRemaining(chProgress.remaining) || '0m left'}`;
	});

	const progressTitleLabel = $derived.by(() => {
		if (effectiveProgressMode === 'book-pct' || !chProgress) return '';
		return chapters[Math.max(0, chProgress.index)]?.title || '';
	});

	function cycleProgressMode() {
		progressMode = nextProgressMode(progressMode, availableModes);
	}
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

	// --- Line navigation -----------------------------------------------------
	//
	// Everything here works in the *highlight's* timeline, not the audio
	// element's. The sync offset shifts which line is lit for a given audio
	// position, so a tuned book would otherwise land a fraction of a second into
	// the wrong place on every jump.

	function highlightTime(): number {
		const a = player.getAudioElement();
		return (a?.currentTime ?? $player.currentTime) + effectiveOffset;
	}

	/** Seeks so playback resumes exactly where `cueTime` is highlighted. */
	function seekToCue(cueTime: number) {
		player.seek(cueTime - effectiveOffset);
	}

	function stepCue(dir: 1 | -1) {
		const index = $reader.cueIndex;
		if (!index) return;
		const t = highlightTime();
		const target = dir > 0 ? nextCueStart(index, t) : prevCueStart(index, t);
		if (target === null) {
			// Off the front of the book: the start is the only place left to go.
			// Off the end: stay put rather than jumping somewhere arbitrary.
			if (dir < 0) player.seek(0);
			return;
		}
		seekToCue(target);
		revealChrome();
	}

	// --- Repeat mode ---------------------------------------------------------
	//
	// The controller is created once, alongside the sync controller, and is then
	// only enabled/disabled. It must NOT be built inside an `$effect` that reads
	// `$reader`: the ticker writes `activeSentenceId` to that store at every line
	// boundary, so the controller would be rebuilt exactly when it was about to
	// fire, and the pause would be dropped at random. See `repeat.ts`.

	/**
	 * Start of the unit an auto-pause stopped at, in highlight time. Held as a
	 * time rather than an id because `activeSentenceId` has usually moved on to
	 * the next line by then (cues are typically contiguous), so `r` would
	 * otherwise repeat something that has not been heard.
	 */
	let pausedUnitStart = $state<number | null>(null);

	/**
	 * Lines grouped into repeat units — a 「…」 run counts as one. Rebuilt only
	 * when its inputs actually change: a fresh array on every store update would
	 * disarm the controller just as often as rebuilding it did.
	 */
	let repeatUnits: TimingIndex | null = null;
	let unitsBuiltFrom: { index: TimingIndex | null; group: boolean } | null = null;

	function syncRepeatUnits() {
		const index = $reader.cueIndex ?? null;
		const group = $settings.repeatWholeQuotes;
		if (unitsBuiltFrom && unitsBuiltFrom.index === index && unitsBuiltFrom.group === group) return;
		unitsBuiltFrom = { index, group };
		repeatUnits = index ? buildRepeatUnits(index, { group }) : null;
		repeatController?.setIndex(repeatUnits);
	}

	$effect(syncRepeatUnits);

	$effect(() => {
		const on = $settings.repeatMode && $settings.readAlong;
		repeatController?.setEnabled(on);
	});

	// Resuming clears the latch, so `r` and Enter fall back to whatever is
	// actually playing once the user moves on.
	$effect(() => {
		if ($player.playing) pausedUnitStart = null;
	});

	/** Start of the repeat unit covering `t`, or the last one to have begun. */
	function unitStartAt(t: number): number | null {
		if (!repeatUnits) return null;
		const i = cueIndexAt(repeatUnits, t);
		return i >= 0 ? repeatUnits.starts[i] : null;
	}

	function toggleRepeatMode() {
		settings.update((s) => ({ ...s, repeatMode: !s.repeatMode }));
		revealChrome();
	}

	/** Replays the current unit from its first word. */
	function repeatLine() {
		const from = pausedUnitStart ?? unitStartAt(highlightTime());
		if (from === null) return;
		seekToCue(from);
		player.play();
		revealChrome();
	}

	/** Moves on to the unit after the current one and plays it. */
	function advanceLine() {
		if (!repeatUnits) return;
		// Stepping from the unit's own start, not from the playhead: after an
		// auto-pause the playhead sits on the boundary, where "next" is ambiguous.
		const target = nextCueStart(repeatUnits, pausedUnitStart ?? highlightTime());
		if (target === null) return;
		seekToCue(target);
		player.play();
		revealChrome();
	}

	// --- Free navigation -----------------------------------------------------

	function toggleReadAlong() {
		settings.update((s) => ({ ...s, readAlong: !s.readAlong }));
		revealChrome();
	}

	function jumpToEpubChapter(order: number) {
		showToc = false;
		epubRender?.scrollToChapter(order);
		// Jumping to a chapter is the clearest possible statement that the
		// reader is not following the narration right now.
		if ($settings.readAlong) {
			detached = true;
			autoScroller?.suspend();
		}
		revealChrome();
	}

	/**
	 * One screenful along the reading axis — the ebook reader's page turn.
	 * Vertical text advances leftwards, so "forward" is a negative physical x.
	 */
	function pageScroll(dir: 1 | -1) {
		const el = scrollerEl;
		if (!el) return;
		const vertical = $settings.verticalText;
		const size = vertical ? el.clientWidth : el.clientHeight;
		const delta = dir * size * 0.9;
		el.scrollBy({
			top: vertical ? 0 : delta,
			left: vertical ? -delta : 0,
			behavior: $settings.smoothScroll ? 'smooth' : 'auto'
		});
	}

	/**
	 * Ebook-mode keys: paging only, since there is no audio left to command.
	 * Both arrow pairs page the book — the horizontal pair reversed under
	 * vertical text, where the page turns leftwards.
	 */
	function handleEbookKey(e: KeyboardEvent): boolean {
		const vertical = $settings.verticalText;
		const forward = new Set(['PageDown', 'ArrowDown', vertical ? 'ArrowLeft' : 'ArrowRight']);
		const back = new Set(['PageUp', 'ArrowUp', vertical ? 'ArrowRight' : 'ArrowLeft']);

		if (e.key === ' ') {
			e.preventDefault();
			pageScroll(e.shiftKey ? -1 : 1);
			return true;
		}
		if (forward.has(e.key)) {
			e.preventDefault();
			pageScroll(1);
			return true;
		}
		if (back.has(e.key)) {
			e.preventDefault();
			pageScroll(-1);
			return true;
		}
		return false;
	}

	function handleKeyDown(e: KeyboardEvent) {
		const el = e.target;
		if (
			el instanceof HTMLInputElement ||
			el instanceof HTMLSelectElement ||
			el instanceof HTMLTextAreaElement
		)
			return;
		// A focused button activates itself on Space and Enter, so only those two
		// are ceded to it. Every other shortcut keeps working rather than going
		// dead on whichever control happened to be clicked last.
		if (el instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
		// Browser and OS shortcuts keep their meaning; only Alt is ours.
		if (e.metaKey || e.ctrlKey) return;

		// Read-along off: the transport shortcuts have nothing to act on, and
		// the keys go back to meaning what they mean in any other book reader.
		if (!$settings.readAlong) {
			if (e.key === 'A') toggleReadAlong();
			else handleEbookKey(e);
			return;
		}

		// Alt always selects the *other* arrow behaviour, so line-stepping is
		// reachable however the setting is left.
		const stepsLines = $settings.arrowKeys === 'cue' ? !e.altKey : e.altKey;

		switch (e.key) {
			case ' ':
				e.preventDefault();
				handlePlayPause();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				// Under vertical text the reading direction runs right to left,
				// so the left arrow advances, matching the on-screen buttons.
				if (stepsLines) stepCue(swapTransport ? 1 : -1);
				else if (swapTransport) player.skipForward($settings.seekStep);
				else player.skipBack($settings.seekStep);
				break;
			case 'ArrowRight':
				e.preventDefault();
				if (stepsLines) stepCue(swapTransport ? -1 : 1);
				else if (swapTransport) player.skipBack($settings.seekStep);
				else player.skipForward($settings.seekStep);
				break;
			case 'Enter':
				e.preventDefault();
				advanceLine();
				break;
			case 'r':
				repeatLine();
				break;
			case 'R':
				toggleRepeatMode();
				break;
			case 'j':
				player.skipBack($settings.seekStep);
				break;
			case 'l':
				player.skipForward($settings.seekStep);
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
			case 'A':
				toggleReadAlong();
				break;
			case 'f':
				goToNarration();
				break;
		}
	}

	const rateOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

	/**
	 * The badge only shouts when something is actually wrong. A book is never
	 * 100%: covers, contents pages and lines of bare ellipses have no audio, so
	 * treating anything short of perfect as a fault would cry wolf on every
	 * book. Below 80% the transcript and the text have genuinely diverged.
	 */
	const syncTone = $derived.by(() => {
		const c = coverage ?? 0;
		if (c >= 0.95) return 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]';
		if (c >= 0.8) return 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]';
		return 'border-red-500/40 bg-red-500/10 text-red-500';
	});
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
		<!-- Top bar. In flow, and its height collapses when the chrome hides so
		     the progress strip and reader rise up under it — the scroll
		     compensation keeps the reading position fixed. The collapse is a
		     grid row going 1fr→0fr, which animates height while clipping the
		     bar's content. -->
		<div
			bind:this={topBarEl}
			class="relative z-30 grid transition-[grid-template-rows] duration-200 ease-linear {chromeVisible
				? 'grid-rows-[1fr]'
				: 'grid-rows-[0fr]'}"
		>
			<div class="min-h-0 overflow-hidden">
				<div
					class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)]/90 px-3 py-2 backdrop-blur"
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

					<!-- Contents. The one control that moves the reader without moving
			     the audio, so it is the way out of a chapter the narration is
			     not in. -->
					{#if epubChapters.length > 0}
						<div class="relative">
							<button
								onclick={() => (showToc = !showToc)}
								class="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
								aria-label="Contents"
								title="Contents"
							>
								<svg
									class="h-5 w-5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									stroke-width="2"
								>
									<path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h10" />
								</svg>
							</button>
							{#if showToc}
								<button
									class="fixed inset-0 z-40 cursor-default"
									onclick={() => (showToc = false)}
									aria-label="Close contents"
								></button>
								<div
									class="absolute top-full right-0 z-50 mt-1 max-h-[70vh] w-72 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]"
								>
									{#each epubChapters as ch}
										<button
											onclick={() => jumpToEpubChapter(ch.order)}
											class="block w-full px-3 py-2 text-left text-sm text-[var(--fg)] hover:bg-[var(--surface-hover)] {ch.order ===
											viewChapterOrder
												? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
												: ''}"
										>
											{ch.title || `Chapter ${ch.order + 1}`}
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{/if}

					<!-- Read-along on/off. The audiobook and the ebook are the same
			     page; this decides whether the audio drives it. -->
					<button
						onclick={toggleReadAlong}
						class="flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors {readAlong
							? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
							: 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]'}"
						role="switch"
						aria-checked={readAlong}
						aria-label="Read along with the audiobook"
						title="Read-along {readAlong ? 'on' : 'off'} (Shift+A)"
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
								d="M4 14v-3a8 8 0 0116 0v3M4 14a2 2 0 012-2h1v6H6a2 2 0 01-2-2v-2zm16 0a2 2 0 00-2-2h-1v6h1a2 2 0 002-2v-2z"
							/>
							{#if !readAlong}
								<path stroke-linecap="round" d="M3 3l18 18" />
							{/if}
						</svg>
						<span
							class="relative h-3.5 w-6 shrink-0 rounded-full transition-colors {readAlong
								? 'bg-[var(--accent)]'
								: 'bg-[var(--border)]'}"
						>
							<span
								class="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all {readAlong
									? 'left-3'
									: 'left-0.5'}"
							></span>
						</span>
					</button>

					<!-- How much of the book has audio timing. Worth surfacing rather than
			     leaving to a notice: it is the one number that says whether a
			     book's read-along is trustworthy, and it varies per book. -->
					{#if alignStats && readAlong}
						<div class="relative">
							<button
								onclick={() => (showSyncPanel = !showSyncPanel)}
								class="flex items-center gap-1 rounded border px-2 py-1.5 text-xs tabular-nums transition-colors {syncTone}"
								aria-label="Sync coverage"
								title="How much of the book is synced to the audio"
							>
								<svg
									class="h-3.5 w-3.5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									stroke-width="2"
								>
									<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
								</svg>
								{Math.round((coverage ?? 0) * 100)}%
							</button>

							{#if showSyncPanel}
								<button
									class="fixed inset-0 z-40 cursor-default"
									onclick={() => (showSyncPanel = false)}
									aria-label="Close sync report"
								></button>
								<div
									class="absolute top-full right-0 z-50 mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lg)]"
								>
									<div class="mb-2 flex items-baseline justify-between">
										<span class="text-sm font-medium text-[var(--fg)]">Sync coverage</span>
										<span class="text-sm text-[var(--accent)] tabular-nums">
											{Math.round((coverage ?? 0) * 100)}%
										</span>
									</div>

									<!-- Two directions, because they fail differently: text with no
							     audio is usually front matter, audio with no text means the
							     transcript and the book have diverged. -->
									<dl class="flex flex-col gap-1.5 text-xs">
										<div class="flex items-baseline justify-between gap-3">
											<dt class="text-[var(--muted)]">Lines with audio</dt>
											<dd class="text-[var(--fg)] tabular-nums">
												{alignStats.timedSentences.toLocaleString()} of {alignStats.totalSentences.toLocaleString()}
											</dd>
										</div>
										<div class="flex items-baseline justify-between gap-3">
											<dt class="text-[var(--muted)]">Narration matched to text</dt>
											<dd class="text-[var(--fg)] tabular-nums">
												{alignStats.cueCount > 0
													? Math.round((alignStats.matchedCues / alignStats.cueCount) * 100)
													: 0}%
											</dd>
										</div>
									</dl>

									<p class="mt-2 text-xs text-[var(--muted)]">
										{#if (coverage ?? 0) >= 0.95}
											Everything the narrator reads should highlight.
										{:else}
											Unsynced passages are shown but never highlight. Scroll or use the contents to
											read through them.
										{/if}
									</p>
									<p class="mt-2 text-xs text-[var(--muted)]">
										A few percent is normal: covers, contents pages and unspoken lines have no audio
										to sync to.
									</p>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Sync offset -->
					{#if $reader.cueIndex && readAlong}
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
						onclick={() => {
							if (!showSettings && document.activeElement instanceof HTMLElement)
								settingsTriggerEl = document.activeElement;
							showSettings = !showSettings;
						}}
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
			</div>
		</div>

		<!-- Progress strip: chapter/whole-book readout with chapter markers.
		     Always visible (unlike the rest of the chrome); tapping the readout
		     cycles through the modes enabled in settings. When the chrome hides
		     the top bar's space collapses beneath it, so the strip rises to the
		     top and the reader text sits right below it. -->
		{#if readAlong}
			<div class="relative z-20 border-b border-[var(--border)] bg-[var(--bg)]/90">
				<div class="relative h-1.5 w-full bg-[var(--border)]">
					<div
						class="absolute top-[1.5px] h-[3px] bg-[var(--accent)] {progressRTL
							? 'right-0'
							: 'left-0'}"
						style="width: {progressPercent}%"
					></div>
					{#each chapterMarkers as pct}
						<div
							class="absolute top-0 h-1.5 w-px bg-[var(--fg)]/35"
							style="{progressRTL ? 'right' : 'left'}: {pct}%"
						></div>
					{/each}
				</div>
				<button
					onclick={cycleProgressMode}
					disabled={availableModes.length < 2}
					class="flex w-full items-center justify-between gap-2 px-3 pt-0.5 pb-1 text-[11px] text-[var(--muted)] tabular-nums"
					aria-label="Progress: {progressLabel}. Tap to switch"
					title="Tap to switch: chapter %, book %, time left in chapter"
				>
					<span>{progressLabel}</span>
					{#if progressTitleLabel}
						<span class="truncate text-right">{progressTitleLabel}</span>
					{/if}
				</button>
			</div>
		{/if}

		<!-- Reader area. Fills the frame; chrome floats above it so hiding the
		     chrome does not reflow the text and lose the reading position. -->
		<div
			bind:this={scrollerEl}
			onclick={handleReaderTap}
			role="presentation"
			data-vertical={$settings.verticalText}
			data-readalong={readAlong}
			class="reader-scroller reader-pane flex-1"
		>
			{#if (sourceNotice || noAudioNotice) && $reader.cueIndex}
				<!--
					Surfaced rather than logged: silent partial alignment is the
					main failure mode of the EPUB path.
				-->
				<div
					class="reader-notice rounded border border-[var(--muted)] px-3 py-2 text-sm text-[var(--muted)]"
				>
					{noAudioNotice
						? 'No audio track found for this item. You can still read the text.'
						: sourceNotice}
				</div>
			{:else if textMode === 'epub' && coverage !== null && coverage < 0.95 && readAlong}
				<div
					class="reader-notice rounded border border-[var(--muted)] px-3 py-2 text-sm text-[var(--muted)]"
				>
					{Math.round(coverage * 100)}% of the book is synced to the audio. Unsynced passages are
					shown but will not highlight — scroll or use the contents to read through them.
				</div>
			{/if}

			{#if !$reader.cueIndex}
				<div class="reader-notice flex items-center justify-center py-12">
					<div class="text-center">
						<p class="text-lg text-[var(--muted)]">No transcript available for this item</p>
						<p class="mt-2 text-sm text-[var(--muted)]">
							{noAudioNotice
								? 'No audio track was found for this item; you can still read the text.'
								: 'Press play to listen to the audiobook.'}
						</p>
					</div>
				</div>
			{:else}
				<div
					bind:this={contentEl}
					class="reader-content"
					style="font-family: var(--theme-font-family);
					font-size: var(--theme-font-size);
					line-height: var(--theme-line-height);"
				></div>
			{/if}
		</div>

		<!-- Tiny progress readout at the very bottom right. Tapping it cycles
		     through the modes enabled in settings. When the chrome is up it
		     floats just above the player bar; immersive mode parks it at the
		     edge. -->
		{#if readAlong}
			<button
				onclick={cycleProgressMode}
				disabled={availableModes.length < 2}
				class="absolute right-3 z-20 text-[11px] text-[var(--muted)] tabular-nums transition-[bottom] duration-200 disabled:opacity-50 {chromeVisible
					? 'bottom-28'
					: 'bottom-2'}"
				aria-label="Progress: {progressLabel}. Tap to switch"
				title="Tap to switch: chapter %, book %, time left in chapter"
			>
				{progressLabel}
			</button>
		{/if}

		<!-- Player bar -->
		{#if readAlong}
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
							style="background: linear-gradient(to {progressRTL
								? 'left'
								: 'right'}, var(--accent) 0%, var(--accent) {seekPercent}%, var(--border) {seekPercent}%, var(--border) 100%)"
							class="h-3 flex-1 cursor-pointer appearance-none rounded-full {progressRTL
								? '[direction:rtl]'
								: '[direction:ltr]'} [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md"
							aria-label="Seek"
						/>
						<span class="min-w-[48px] text-xs text-[var(--muted)] tabular-nums sm:min-w-[52px]">
							{formatTime($player.duration)}
						</span>
					</div>

					<!-- Controls row -->
					<div class="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
						<!-- Transport buttons. Identical in both modes; only the
						     actions swap under vertical text, so the arrow pointing
						     along the reading direction moves forward. -->
						<div class="flex items-center justify-center gap-0.5 sm:gap-1">
							<button
								onclick={swapTransport ? goToNextChapter : goToPrevChapter}
								class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
								aria-label={swapTransport ? 'Next chapter' : 'Previous chapter'}
							>
								<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
									<path d="M16.67 0l2.83 2.829-9.339 9.175 9.339 9.167-2.83 2.829-12.17-11.996z" />
								</svg>
							</button>

							<button
								onclick={() => (swapTransport ? player.skipForward(10) : player.skipBack(10))}
								class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
								aria-label={swapTransport ? 'Skip forward 10s' : 'Skip back 10s'}
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
								onclick={() => (swapTransport ? player.skipBack(10) : player.skipForward(10))}
								class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
								aria-label={swapTransport ? 'Skip back 10s' : 'Skip forward 10s'}
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
								onclick={swapTransport ? goToPrevChapter : goToNextChapter}
								class="flex min-h-[42px] min-w-[42px] items-center justify-center rounded p-2 text-[var(--fg)] hover:bg-[var(--border)] sm:min-h-[44px] sm:min-w-[44px]"
								aria-label={swapTransport ? 'Previous chapter' : 'Next chapter'}
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
										class="absolute bottom-full left-1/2 z-50 mb-1 flex -translate-x-1/2 flex-col items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2.5 shadow-[var(--shadow-lg)]"
									>
										<span class="text-[11px] text-[var(--muted)] tabular-nums">
											{volumePercent}%
										</span>
										<!--
										`direction: rtl` is what puts loud at the top: a vertical
										range runs along the block axis, so `vertical-lr` alone
										starts at the minimum and fills downwards.
										The track paints its own level, since an appearance-none
										range is otherwise fully transparent and gave no feedback
										at all.
									-->
										<input
											type="range"
											min="0"
											max="1"
											step="0.05"
											value={$player.volume}
											oninput={handleVolumeChange}
											style="background: linear-gradient(to top, var(--accent) 0%, var(--accent) {volumePercent}%, var(--border) {volumePercent}%, var(--border) 100%)"
											class="h-24 w-2 cursor-pointer appearance-none rounded-full [direction:rtl] [writing-mode:vertical-lr] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md"
											aria-label="Volume level"
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

							{#if $reader.cueIndex}
								<button
									onclick={toggleRepeatMode}
									class="flex min-h-[40px] items-center gap-1 rounded border px-2 py-1.5 text-xs sm:min-h-[44px] sm:gap-1.5 sm:px-3 sm:text-sm {$settings.repeatMode
										? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
										: 'border-[var(--border)] text-[var(--muted)]'}"
									aria-pressed={$settings.repeatMode}
									aria-label="Repeat each line"
									title="Pause at the end of each line (Shift+R). r repeats, Enter continues."
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
											d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4m14-1v2a4 4 0 01-4 4H3"
										/>
									</svg>
									<span class="hidden sm:inline">Repeat</span>
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
		{/if}

		<!-- The way back. Shown only once the reader has actually gone somewhere
		     else, so it is an offer rather than a nag. -->
		{#if readAlong && detached && $reader.cueIndex}
			<div class="absolute right-3 bottom-28 z-40">
				<button
					onclick={goToNarration}
					class="narration-btn flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--accent)] shadow-[var(--shadow-lg)]"
					title="Scroll back to the line being read (f)"
				>
					<span
						class="narration-arrow block"
						style="transform: rotate({narrationDir === 'up'
							? 180
							: narrationDir === 'left'
								? 90
								: narrationDir === 'right'
									? -90
									: 0}deg)"
					>
						<svg
							class="h-3.5 w-3.5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							stroke-width="2"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m0 0l-5-5m5 5l5-5" />
						</svg>
					</span>
					Narration
				</button>
			</div>
		{/if}

		<!-- Repeat prompt. Only while stopped at a line end, since that is the one
		     moment the two keys mean something specific. -->
		{#if $settings.repeatMode && pausedUnitStart !== null && !$player.playing && !toast}
			<div class="pointer-events-none absolute inset-x-0 bottom-28 z-40 flex justify-center px-4">
				<div
					class="pointer-events-auto flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)] shadow-[var(--shadow-lg)]"
				>
					<button
						onclick={repeatLine}
						class="rounded border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--fg)] hover:bg-[var(--surface-hover)]"
					>
						Repeat <kbd class="text-[var(--muted)]">r</kbd>
					</button>
					<button
						onclick={advanceLine}
						class="rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-1 text-xs font-medium text-[var(--accent)]"
					>
						Next <kbd class="opacity-70">↵</kbd>
					</button>
				</div>
			</div>
		{/if}

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
			<div
				class="fixed inset-0 z-50 flex justify-end"
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
				tabindex="-1"
				onkeydown={(e) => {
					if (e.key === 'Escape') showSettings = false;
				}}
			>
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
							bind:this={settingsCloseBtn}
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
