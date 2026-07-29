# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the `reader/` directory.

```bash
npm run dev          # Start dev server at http://localhost:5173
npm run build        # Build for production (adapter-static output)
npm run preview      # Preview the production build
npm run check        # Type-check with svelte-check
npm run test         # Run all tests once
npm run test:unit    # Run tests in watch mode
npm run lint         # Check formatting (prettier)
npm run format       # Auto-format all files
```

Run a single test file:

```bash
npx vitest run src/lib/sync/normalize.test.ts
```

Tests split into two projects by filename suffix:

- `*.dom.test.ts` — runs in jsdom (for EPUB parsing, alignment, renderer)
- `*.test.ts` / `*.spec.ts` — runs in Node (no DOM)

## Architecture

This is a SvelteKit SPA (adapter-static, `fallback: 'index.html'`) that renders an audiobook alongside a synchronized, highlighted transcript. It proxies all Audiobookshelf (ABS) API calls through `/abs/[...path]` so the browser never needs direct CORS access.

### Routes

- `/` — connection screen (enter ABS URL + API token, stored in `connection` store). On mount it revalidates a stored token and forwards to `/library`, so the form is only shown when there is no working credential. A 401/403 clears the stored token; any other failure (server unreachable) keeps it.
- `/library` — lists libraries and items from ABS. Grid items open the details page; "Continue Listening" resumes straight into the reader.
- `/book/[itemId]` — details page: cover, metadata, description, chapter list, progress, and whether the book has the EPUB/subtitle needed for read-along. Playback starts from here (`?restart=1` ignores the saved bookmark).
- `/read/[itemId]` — the main reader; orchestrates audio, text, sync, and highlighting
- `/settings` — standalone appearance/reading/sync settings with a live preview
- `/abs/[...path]` — server-side proxy to ABS (`+server.ts` forwards requests with auth header)

### Text source pipeline (`src/lib/epub/source.ts`)

Two modes, selected automatically at load time:

1. **`epub` mode** (preferred): downloads the EPUB and a subtitle file (SRT/VTT), aligns them via `alignEpubToCues`, caches the result in IndexedDB. The EPUB supplies rich structure (real paragraphs, ruby, headings); the subtitle supplies timing.
2. **`subtitle` mode** (fallback): uses only the subtitle file; `mergeCues` groups raw cues into paragraphs by audio gap size.

Mode falls back to subtitle when: no EPUB is attached, EPUB parse fails, or alignment coverage drops below 40%.

### Sync loop (`src/lib/sync/ticker.ts`)

`createSyncController` runs either `requestAnimationFrame` or `setInterval(100ms)`, switching automatically when RAF frame deltas exceed 150 ms (background tab / iOS throttle). On each tick it binary-searches `TimingIndex.starts`/`ends` (sorted Float64Arrays) for the current audio time plus the sync offset, and calls `onActivate(sentenceId)`.

The frame-delta heuristic only fires while frames are still arriving, so it catches a _throttled_ tab but not a _suspended_ one. A locked phone stops RAF outright while audio keeps playing, which used to freeze the highlight on whichever sentence was lit. Two extra drivers cover that: a `timeupdate` listener (still fires ~4Hz when backgrounded) and a `visibilitychange` listener that parks the loop on hide and re-samples on show. `pause`/`ended` also force a final sample, since a pause landing in a cue gap must clear the highlight rather than leave it lit.

The controller attaches listeners to the **singleton** audio element, which outlives the page, so `destroy()` (not just `stop()`) must be called on unmount or stale controllers keep firing.

`TimingIndex` is a shared interface satisfied by both `CueIndex` (subtitle path) and `AlignedIndex` (EPUB path), so the ticker is mode-agnostic.

### Line navigation and repeat (`src/lib/sync/navigate.ts`, `quotes.ts`, `repeat.ts`)

All three work in the **highlight's** timeline, not the audio element's — the reader converts with `seekToCue`/`highlightTime` by subtracting the sync offset. Navigating in audio time would land a tuned book a fraction of a second off on every jump.

`navigate.ts` is pure: upper-bound search over `starts` for prev/next line. "Previous" restarts the current line once past a 0.6s grace window, as every media player does.

`buildRepeatUnits` groups lines into **repeat units**: a run from 「 to its matching 」 (with 『』 nesting into the same depth) becomes one unit, because a line of dialogue routinely spans several cues and half an utterance is no use to shadow. It returns a `TimingIndex`, so the controller and the prev/next helpers work over units without knowing they are groups. A stray closer cannot drive the depth negative, and an unclosed 「 is capped at `maxLines` rather than swallowing the rest of the book. `r` and Enter act on units too; Alt+arrow still steps raw lines.

`createRepeatController` pauses at the end of each unit for shadowing. Three things it gets right, each of which was a bug first:

- **It is created once, in `attachSync`, and only enabled/disabled.** Building it inside an `$effect` that reads `$reader` meant the sync ticker — which writes `activeSentenceId` to that same store at every line boundary — tore it down exactly when it was about to fire. Whether the rebuild beat the 25ms tick decided whether the pause happened, so playback ran on for one, two or three lines at random. The reader memoises `buildRepeatUnits` for the same reason: a fresh array each store update would disarm it just as often.
- **It asks "did a unit end inside the interval I just played?", not "is the playhead past what I armed?"** The latter cannot see a unit shorter than one tick, because by the time it looks, the _next_ unit has already started. On report the scan resumes from the reported end, so one long tick crossing two ends still reports both.
- **It distinguishes playing from seeking by the size of the jump**, backed by a `seeked` listener that clears the scan. Otherwise a forward seek reads as having played to the end.

Under throttled timers (a backgrounded tab) the interval check cannot be trusted and it falls back to the armed unit plus `slop`, which misses roughly 10% of stops. Repeat mode is an eyes-on feature, so that degradation is deliberate. Like the ticker it attaches to the singleton audio element, so `destroy()` is mandatory.

### EPUB alignment (`src/lib/sync/align.ts`)

Builds normalized character streams for both the EPUB and subtitle, then walks them with two pointers. On divergence (Whisper insertions, omitted front matter, dropped ruby) it re-anchors by exact substring search within a 4000-character window. Each EPUB sentence inherits timing by interpolating within the cue span(s) its characters matched.

### EPUB renderer (`src/lib/reader/epubRenderer.ts`)

Mounts only the active chapter ± 1 neighbours (chapter windowing) to avoid stalls on long books. Unmounted chapters leave a placeholder `<section>` with a fixed `min-height` so scroll position does not jump. Text nodes are wrapped in `<span class="reader-sentence" data-sid="...">` for highlighting; wrapping happens back-to-front per block so earlier offsets stay valid as the DOM mutates.

### Highlighting (`src/lib/reader/highlight.ts`)

Uses the CSS Highlight API (`CSS.highlights`) when available, with a class-toggle fallback. The reader page's `$effect` calls `highlighter.activateMany(spans)` or `highlighter.activate(el)` whenever `reader.activeSentenceId` changes.

**WebKit uses the class path, not the Highlight API.** WebKit does not reliably invalidate the region a custom highlight previously painted, so clearing or replacing the active range leaves the finished sentence visibly lit while the next one paints as well — the highlight appears to accumulate. Detection is `navigator.vendor === 'Apple Computer, Inc.'`, which covers every browser on iOS since they are all WebKit, not just Safari. `preferClassFallback` overrides the detection for tests.

The class path's `reset` sweeps `getRoot()` for `.hl-active` rather than trusting the element references it was handed. Chapter windowing can unmount and remount a chapter between two activations, which would otherwise strand the class on spans the handle no longer references.

Both paths are fully styled for every `hlStyle` in `app.css` — a `::highlight()` rule and a matching `.hl-active` rule per style — so switching engines does not change appearance.

### Stores (`src/lib/stores/`)

- `player` — wraps a singleton `HTMLAudioElement`; exposes `play/pause/seek/skipBack/skipForward/setRate/setVolume/saveBookmark/getBookmark`
- `reader` — holds `ABSItem`, `cueIndex` (TimingIndex), `sentenceMap` (subtitle mode), and `activeSentenceId`
- `settings` — persists appearance, reading and sync preferences to `localStorage`. Loads by merging stored values **over** `defaultSettings`; replacing instead would deserialize newly added keys as `undefined` and push them into CSS custom properties. `applySettingsToDOM` is the single place custom properties are written.
- `offsets` — per-book sync offset in seconds, keyed by item id. Alignment drift belongs to a recording/transcript pair, so a tuned book keeps its own value; untuned books fall back to `settings.timingOffset`. The in-memory store is the source of truth for both reads and writes (`hydrate()` re-reads storage).
- `connection` — persists ABS URL and token to `localStorage`

### Anki mining (`src/lib/anki/`)

The reader's Mine button clips the current sentence's audio and sends it to
Anki over AnkiConnect, either attaching it to the last card created (default,
for the look-up-then-mine flow) or creating a new card. Off by default;
configured under Settings → Anki.

`capture.ts` obtains the audio by **re-playing it**. Clipping the source file
directly is not possible — the books are M4B, and an MP4 byte range has no
container header to decode — and taking it from a rolling buffer of what has
been played only works for lines the user happens to have just heard. So a
throwaway `Audio` element seeks to the sentence and plays it through a
zero-gain Web Audio tap while an AudioWorklet collects the PCM. This works for
any timestamp in the book, played or not, and for any format the browser
supports. It costs one sentence-length wait per mine, which is why the button
shows a percentage.

The recording always overshoots (the seek lands on a frame boundary at or
before the target, and playback is polled at 50ms), so `cutSegment` trims it
using per-chunk anchors tying frame offsets to media timestamps. Ends outside
the anchors are clamped rather than failing — the overshoot is padding.

The capture element is deliberately separate from `player`'s singleton:
`createMediaElementSource` is irreversible for an element's lifetime, so
routing the reader's own audio through a graph would risk silencing playback
whenever the context could not be resumed.

`encode.ts` writes mono 64kbps MP3 via lamejs, falling back to WAV at sample
rates LAME cannot express. Size matters because these clips land in a synced
collection — a 5s line is ~40 KB as MP3 against ~480 KB as WAV.

AnkiConnect is called straight from the browser, so **the page's origin must be
in AnkiConnect's `webCorsOriginList`** (exact match, port included). That is the
most common failure and `connect.ts` names it in the error.

"Last card" is `findNotes` over a configurable query (default `added:1`) taking
the largest id — Anki note ids are creation timestamps in ms.

### Reader chrome

The reader is modelled on ttu-ebook-reader: header and player bar are absolutely positioned over a full-height scroller and slide away while audio plays (`settings.autoHideChrome`), leaving a slim progress line with percentage and time remaining. Tapping the text toggles them. Chrome floats rather than sits in flow so hiding it does not reflow the text and lose the reading position.

`SettingsPanel.svelte` is shared between `/settings` and the reader's slide-over sheet; pass `showSubtitleOptions={false}` in EPUB mode, where gap and non-speech options do nothing.

### Deployment

Dev: Vite proxies `/abs/*` to `PUBLIC_ABS_ORIGIN` (set in `.env.local`).  
Docker: Caddy proxies `/abs/*` to `ABS_ORIGIN` and serves the static build with automatic TLS.
