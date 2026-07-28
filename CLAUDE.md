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

### EPUB alignment (`src/lib/sync/align.ts`)

Builds normalized character streams for both the EPUB and subtitle, then walks them with two pointers. On divergence (Whisper insertions, omitted front matter, dropped ruby) it re-anchors by exact substring search within a 4000-character window. Each EPUB sentence inherits timing by interpolating within the cue span(s) its characters matched.

### EPUB renderer (`src/lib/reader/epubRenderer.ts`)

Mounts only the active chapter ± 1 neighbours (chapter windowing) to avoid stalls on long books. Unmounted chapters leave a placeholder `<section>` with a fixed `min-height` so scroll position does not jump. Text nodes are wrapped in `<span class="reader-sentence" data-sid="...">` for highlighting; wrapping happens back-to-front per block so earlier offsets stay valid as the DOM mutates.

### Highlighting (`src/lib/reader/highlight.ts`)

Uses the CSS Highlight API (`CSS.highlights`) when available, with a class-toggle fallback. The reader page's `$effect` calls `highlighter.activateMany(spans)` or `highlighter.activate(el)` whenever `reader.activeSentenceId` changes.

### Stores (`src/lib/stores/`)

- `player` — wraps a singleton `HTMLAudioElement`; exposes `play/pause/seek/skipBack/skipForward/setRate/setVolume/saveBookmark/getBookmark`
- `reader` — holds `ABSItem`, `cueIndex` (TimingIndex), `sentenceMap` (subtitle mode), and `activeSentenceId`
- `settings` — persists appearance, reading and sync preferences to `localStorage`. Loads by merging stored values **over** `defaultSettings`; replacing instead would deserialize newly added keys as `undefined` and push them into CSS custom properties. `applySettingsToDOM` is the single place custom properties are written.
- `offsets` — per-book sync offset in seconds, keyed by item id. Alignment drift belongs to a recording/transcript pair, so a tuned book keeps its own value; untuned books fall back to `settings.timingOffset`. The in-memory store is the source of truth for both reads and writes (`hydrate()` re-reads storage).
- `connection` — persists ABS URL and token to `localStorage`

### Reader chrome

The reader is modelled on ttu-ebook-reader: header and player bar are absolutely positioned over a full-height scroller and slide away while audio plays (`settings.autoHideChrome`), leaving a slim progress line with percentage and time remaining. Tapping the text toggles them. Chrome floats rather than sits in flow so hiding it does not reflow the text and lose the reading position.

`SettingsPanel.svelte` is shared between `/settings` and the reader's slide-over sheet; pass `showSubtitleOptions={false}` in EPUB mode, where gap and non-speech options do nothing.

### Deployment

Dev: Vite proxies `/abs/*` to `PUBLIC_ABS_ORIGIN` (set in `.env.local`).  
Docker: Caddy proxies `/abs/*` to `ABS_ORIGIN` and serves the static build with automatic TLS.
