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

Tests split into three projects by filename suffix:

- `*.dom.test.ts` — runs in jsdom (for EPUB parsing, alignment, renderer)
- `*.svelte.test.ts` — runs in jsdom **with `resolve.conditions: ['browser']`**, for runes outside a component. Without that condition jsdom resolves Svelte's server build, where `$effect` never runs and every such test passes vacuously.
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

### Read-along, and reading away from it

`settings.readAlong` decides whether the audio drives the page at all. Off, the reader is a plain ebook: `syncController.setEnabled(false)` clears the highlight and stops sampling (`stop()` alone would not hold — the controller listens to the singleton audio element, so its own `play`/`timeupdate` handlers would restart the loop), playback is paused because there is no longer a transport to stop it with, the audio anchor is released, and the arrow keys go back to paging.

Even with it on, the reader has to be able to go elsewhere. Three mechanisms:

- **`detached`** — the autoscroller reports (`onDetach`) that the active line has been scrolled clean off the screen, or out of the mounted window entirely. Auto-scrolling then stands down until the reader asks to come back, rather than dragging them to the narration three seconds later. A "Narration" button (and `f`) calls `goToNarration()`. Detach is judged from a settled scroll position, not from the gesture that started it — a touch fling scrolls long after the finger has gone — and scrolls the autoscroller performed itself are excluded by time, or scrolling back would instantly count as scrolling away.
- **`nearestCueIndex`** (`navigate.ts`) — where the audio _is_, as opposed to which line is playing. In a stretch alignment could not match there is no active sentence at all, so a seek into one would otherwise leave the text wherever it last was, a chapter behind. Used on every `seeked` and once at load.
- **The contents button** — the EPUB spine, jumping the reader without moving the audio. In an unmatched chapter it is the only thing that can.

`INSTANT_JUMP_VIEWPORTS` in the autoscroller drops smooth scrolling for jumps over three viewports: a chapter change or a seek across a windowed book can be tens of thousands of pixels, and animating that takes seconds and scrolls through everything in between.

### EPUB alignment (`src/lib/sync/align.ts`)

Builds normalized character streams for both the EPUB and subtitle, then walks them with two pointers. On divergence (Whisper insertions, omitted front matter, dropped ruby) it re-anchors by exact substring search ahead of the cursor. Each EPUB sentence inherits timing by interpolating within the cue span(s) its characters matched.

The cue cursor only ever moves forward, so **anything that moves it wrongly is unrecoverable** — every later sentence whose cues lie behind it is stranded, and the symptom is a run of unsynced text whose words are plainly present in the subtitle. Two rules keep it honest, both of which were bugs first:

- **The cursor reflects what was matched, never where the search stopped.** A sentence that ends up timed resumes at `lastCueOffset + 1`; one that fails is rolled back to where it started, so it costs nothing. Previously a failed anchor search kept whatever ground it had covered while looking.
- **A sentence's tail is searched for nearby, not across the book.** The 4000-character window applies only before a sentence has matched anything, where it has to cover a theme song or a chapter announcement the book does not contain. Once the sentence has started matching, the rest of it is contiguous by definition and the window drops to `max(200, 4 × length)`. Without that, a sentence whose tail the subtitle omits finds those words recurring minutes away, claims the whole span, and `finalize` then demotes every sentence legitimately inside it — one bad jump costing a chapter.
- **A long jump must be corroborated by what follows it** (`isCorroborated`). Beyond `LONG_JUMP` characters, the match only stands if one of the next few sentences also appears just after the landing point. The case this exists for is the **table of contents**: its entries are the book's chapter titles, the narrator reads those titles aloud, so every entry matches _perfectly_ — hours ahead of where the reading is. Nothing about the match itself gives it away; only the absence of continuation does. On 氷菓 the contents dragged the cursor past the whole opening chapter, leaving that letter at 1 of 30 sentences timed (93.4% overall). With corroboration it is 28 of 30, and the book is 96.4% — the rest being front matter, the contents itself, and lines of bare ellipses that are genuinely unspoken.

`findAnchor` compares stream elements directly rather than indexing a joined string: an astral codepoint (rare kanji such as 𠮟) is one element but two UTF-16 units, so a joined anchor desynchronises from the first such character on.

`ALGORITHM_VERSION` in `epub/cache.ts` must be bumped whenever any of this changes, or readers keep whatever coverage the old algorithm gave them — the cache key is only the item id and the two file sizes.

### Vertical text (tategaki)

`settings.verticalText` puts `writing-mode: vertical-rl` on the reader via a `data-vertical` attribute. Horizontal stays the default. `vertical-rl` is right-to-left by definition — columns run top to bottom, each new one starts left of the last — so the reader scrolls **horizontally and backwards**, and browsers park the initial scroll position at the right edge themselves.

The reading surface is written in **logical properties** so one set of rules serves both modes: `max-inline-size` is the line length either way, `margin-block-end` is paragraph spacing either way. Physical properties are used only where something really is physical — the header and player bar sit at the top and bottom of the screen whichever way the text runs, so the scroller's padding stays physical.

The two width settings are not the same axis, which is why the labels swap. `maxWidth` is the line length: horizontally that is the column's width, vertically its height ("Column length"), and vertically it is also capped by the height of the window. `verticalWidth` has no horizontal counterpart — vertical text scrolls sideways without end, so there is no width to cap and gutters can only come from narrowing the reading pane itself, which is what `.reader-pane[data-vertical]` does with a physical `width` plus auto left/right margins. Logical spellings would be wrong there: those elements are themselves `vertical-rl`, so `margin-inline` on them means top and bottom.

Two places could not follow that rule and are axis-aware in code instead:

- **`createAutoScroller`** projects rects onto the reading axis (`project()`), negating x under vertical-rl so "further along" is always a larger number. `scrollBy` then takes the negated delta back, which also avoids `scrollLeft`, whose origin in a right-to-left scroller differs between engines. `rootMargin` is baked into an `IntersectionObserver` at construction, so changing mode rebuilds it.
- **`renderEpub`'s chapter placeholders** reserve space along the block axis, which rotates. It reads the live `writing-mode` off the container and writes `min-height` or `min-width` accordingly — physical rather than `min-block-size`, because the logical form is not reliably reflected in CSSOM and a silently dropped reservation shows up as the reader jumping while it scrolls. `invalidateLayout()` clears the cache when the mode changes, since the stored extents were measured on the other axis.

Notices keep `writing-mode: horizontal-tb` so they stay glanceable, which means their logical properties resolve against _their_ mode, not the reader's — hence the physical sizing in their vertical-mode rule.

### EPUB renderer (`src/lib/reader/epubRenderer.ts`)

Mounts only the chapters near an anchor ± 1 neighbour (chapter windowing) to avoid stalls on long books. Text nodes are wrapped in `<span class="reader-sentence" data-sid="...">` for highlighting; wrapping happens back-to-front per block so earlier offsets stay valid as the DOM mutates.

Three things make a windowed book behave like a whole one, and without any of them the reader is trapped in whatever chapter the audio last lit:

- **Every chapter reserves space, mounted or not.** An unmounted chapter is otherwise zero-length, so the scroller is only as long as the mounted window and there is physically nowhere to scroll to. Measured chapters reserve their real extent; the rest are estimated from their character count against the px-per-character rate the measured ones give. Only chapters carrying at least `MIN_SAMPLE_CHARS` of prose calibrate that rate — a 14-character title page occupying a whole block of space implies a rate an order of magnitude too high, which on a real book turned 20 chapters into 800,000px of scrollbar.
- **Two anchors.** The narration pins one chapter (`ensureVisible`) and the viewport pins another (an `IntersectionObserver` over the chapter hosts); the mounted set is the union. Reading ahead of or behind the audio therefore works across chapters, and keeps working when the audio sits in a stretch alignment could not match. `clearAudioAnchor()` drops the first when read-along is switched off.
- **`withScrollAnchor` compensates for its own reflow.** Anything changing size before the viewport drags everything after it along, so the chapter the viewport starts in is measured either side of a mount batch and the difference is scrolled back out. `.reader-scroller` sets `overflow-anchor: none` so this is the only correction: the browsers that do scroll anchoring natively do not all agree, and two corrections for one reflow read as a jump.

Placeholder extents are physical (`min-height`/`min-width`, whichever the block axis currently is) rather than `min-block-size`, because the logical form is not reliably reflected in CSSOM and a silently dropped reservation shows up as the reader jumping while it scrolls. `invalidateLayout()` drops every measurement and re-derives; the reader calls it when the writing mode or any type setting changes, since every estimate scales with those.

### Highlighting (`src/lib/reader/highlight.ts`)

Uses the CSS Highlight API (`CSS.highlights`) when available, with a class-toggle fallback. The reader page's `$effect` calls `highlighter.activateMany(spans)` or `highlighter.activate(el)` whenever `reader.activeSentenceId` changes.

**WebKit uses the class path, not the Highlight API.** WebKit does not reliably invalidate the region a custom highlight previously painted, so clearing or replacing the active range leaves the finished sentence visibly lit while the next one paints as well — the highlight appears to accumulate. Detection is `navigator.vendor === 'Apple Computer, Inc.'`, which covers every browser on iOS since they are all WebKit, not just Safari. `preferClassFallback` overrides the detection for tests.

The class path's `reset` sweeps `getRoot()` for `.hl-active` rather than trusting the element references it was handed. Chapter windowing can unmount and remount a chapter between two activations, which would otherwise strand the class on spans the handle no longer references.

Both paths are fully styled for every `hlStyle` in `app.css` — a `::highlight()` rule and a matching `.hl-active` rule per style — so switching engines does not change appearance.

### Stores (`src/lib/stores/`)

- `player` — wraps a singleton `HTMLAudioElement`; exposes `play/pause/seek/skipBack/skipForward/setRate/setVolume/saveBookmark/getBookmark`
- `reader` — holds `ABSItem`, `cueIndex` (TimingIndex), `sentenceMap` (subtitle mode), and `activeSentenceId`
- `settings` — persists appearance, reading and sync preferences to `localStorage`. Loads by merging stored values **over** `defaultSettings`; replacing instead would deserialize newly added keys as `undefined` and push them into CSS custom properties. `customTheme` is merged a second time because the top-level spread would drop colours added after a user's last save. `applySettingsToDOM` is the single place custom properties are written — it writes the user theme under `--custom-*` names, never straight onto `--bg`/`--fg`, because an inline custom property outranks the `[data-theme=…]` rules and would leak the custom palette into every other theme. `app.css` maps them across (and mixes the greys between them) only under `[data-theme='custom']`.
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

### Pushing settings into the reader's controllers

The sync, repeat and autoscroll controllers are all built inside a `requestAnimationFrame` in `onMount`, so they are **still null the first time the reader's effects run**. That makes the shape of those effects load-bearing:

```js
$effect(() => {
	controller?.setThing(value); // WRONG: `value` is never read on the first
}); //                              run, so the effect subscribes to nothing
//                                  and never fires again

$effect(() => {
	const v = value; // right: the dependency is registered whether or not
	controller?.setThing(v); //  the controller exists yet
});
```

The wrong form silently freezes a setting until the page is reloaded — it is what made the repeat-mode toggle look stuck. `effect-wiring.svelte.test.ts` pins both forms.

### Reader chrome

The reader is modelled on ttu-ebook-reader: header and player bar are absolutely positioned over a full-height scroller and slide away while audio plays (`settings.autoHideChrome`), leaving a slim progress line with percentage and time remaining. Tapping the text toggles them. Chrome floats rather than sits in flow so hiding it does not reflow the text and lose the reading position.

`SettingsPanel.svelte` is shared between `/settings` and the reader's slide-over sheet; pass `showSubtitleOptions={false}` in EPUB mode, where gap and non-speech options do nothing.

### Deployment

Dev: Vite proxies `/abs/*` to `PUBLIC_ABS_ORIGIN` (set in `.env.local`).  
Docker: Caddy proxies `/abs/*` to `ABS_ORIGIN` and serves the static build with automatic TLS.
