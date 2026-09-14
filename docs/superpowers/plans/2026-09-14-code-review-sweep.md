# Code Review Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every Critical, Important and Minor finding from the four-domain code review of 2026-09-14, with regression tests, on branch `fix/code-review-sweep`.

**Architecture:** Eight sequential tasks grouped by subsystem so each has one owner and can be reviewed independently. Alignment-affecting tasks bump `ALGORITHM_VERSION` in `src/lib/epub/cache.ts`, because CLAUDE.md mandates that any change to alignment inputs or outputs invalidates cached alignments. Tasks run in the order below: Task 2 defines the shared non-prose element set that Task 3 consumes; Task 4 adds the `markReaderDriven()` auto-scroller API that Task 5 wires from the reader page.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, Vitest (three projects: `*.dom.test.ts` jsdom, `*.svelte.test.ts` jsdom with `resolve.conditions: ['browser']`, others Node), fflate, undici, Caddy, Docker.

## Global Constraints

- Work on branch `fix/code-review-sweep`; commit per task. Commit messages are capitalized imperative sentences, no conventional-commit prefix (match `git log`, e.g. "Fix mobile desync when jumping to the narrated line").
- TDD: write the failing test first, watch it fail, then implement. No production code without a failing test (exceptions: config/docs-only steps, verified by reading).
- Tests must use real code. No `vi.mock` — the repo has none. Use dependency seams (injectable `fetch`/`deps`) instead.
- Comments: the repo explains _why_; follow its voice. Do not add noise comments.
- Any change to alignment inputs/outputs bumps `ALGORITHM_VERSION` (`src/lib/epub/cache.ts:29`). Task 1 bumps 3→4; Task 2 bumps 4→5.
- When code and CLAUDE.md disagree, fix whichever is wrong and update the doc in the same task.
- Run `npx vitest run <file>` for focused loops; `npm run test`, `npm run check`, `npm run lint` before every commit.
- Never commit secrets. `.env.local` stays untracked.

---

### Task 1: Alignment algorithm correctness and performance

**Files:**

- Modify: `src/lib/sync/align.ts:313`, `:336-340`, `:330-333`
- Modify: `src/lib/epub/cache.ts:29` (version bump)
- Test: `src/lib/sync/align.dom.test.ts`

**Fixes (review findings):**

1. Corroboration is keyed to the first matched character (`align.ts:313`), so a sentence that starts matching locally and re-anchors its tail far ahead skips corroboration. Reproduced: a >100-char sentence whose first characters match at the cursor and whose tail recurs past `LONG_JUMP` claims 0→300s uncorroborated and strands every sentence in between.
2. `stats.matchedCues` is counted before `finalize` demotes overlapping/zero-width sentences (`:336-340` vs `:382-411`), inflating the cue-match percentage shown in the reader.
3. `matchedCueIdx` scans every span for every timed sentence (`:336-340`), O(sentences × cues); measured ~1.2 s at 15k × 15k.
4. `s === null || e === null` (`:330-333`) is unreachable; cue spans tile the stream, so an in-range offset always resolves.
5. `consulted === 0` auto-corroborates a long jump near the end of the book (`:201-216`). Deliberate, but unpinned.
6. `ALGORITHM_VERSION` must bump because corroboration changes which sentences are timed.

**Interfaces:**

- Consumes: nothing new.
- Produces: unchanged `alignEpubToCues(doc, cues, opts)` signature and `AlignedIndex` shape. Do not add fields to `AlignedSentence` unless needed for stats; if you do, bump the cache version (already bumped here) and update `cache.ts` rebuild accordingly.

- [ ] **Step 1: Write failing tests** in `src/lib/sync/align.dom.test.ts`

```ts
it('requires corroboration when a long sentence re-anchors its tail', () => {
	const long = 'あ'.repeat(60) + 'い'.repeat(60); // 120 chars
	const cues = [{ start: 0, end: 100, text: long }];
	// A second cue, ~450 chars later, containing the sentence's tail, with no
	// continuation matching the following sentences.
	const filler = 'x'.repeat(450);
	cues.push({ start: 300, end: 310, text: filler + 'い'.repeat(60) });
	// A following sentence that matches where the book text continues, not after the jump.
	cues.push({ start: 320, end: 330, text: '次の文' });
	const doc = docWithBlocks([long, '次の文']);
	const out = alignEpubToCues(doc, cues);
	const first = out.sentences[0];
	expect(first.timed).toBe(false);
	// The following sentence must still be reachable — the failed tail search
	// must not leave the cursor wherever it stopped looking.
	expect(out.sentences[1].timed).toBe(true);
});

it('does not count cues for sentences finalize demotes', () => {
	// Two sentences given overlapping ranges by damaged cues: one is demoted,
	// and matchedCues must reflect only the survivor.
	// (Build cues so sentence A and B both claim the same span.)
	// expect(result.stats.matchedCues).toBe(<cues covered by surviving sentences>)
});

it('still times a long jump near the end of the book with no following sentences', () => {
	// Pins the deliberate consulted === 0 escape hatch (align.ts:201-216).
});
```

- [ ] **Step 2: Verify RED** — `npx vitest run src/lib/sync/align.dom.test.ts`. The first test must fail because the sentence is timed. The second must fail with inflated `matchedCues`. Third pins current behavior; it passes now on purpose (documenting test) — say so in its name or comment.

- [ ] **Step 3: Implement**
- Change the corroboration condition to measure the cursor displacement:

```ts
// A match that had to leap a long way is only believed if the text after
// it carries on from where it landed. The leap is measured from where the
// sentence's cues began: a sentence can match its opening locally and then
// re-anchor its tail hundreds of cues ahead, and measuring from the first
// matched character misses exactly that case.
if (timed && lastCueOffset - cursorBefore > LONG_JUMP) {
	timed = isCorroborated(cueChars, lastCueOffset + 1, sourceSentences, i + 1);
}
```

- Replace the per-sentence full span scan with a binary search + forward walk (spans are sorted and contiguous): find the first span with `end > firstCueOffset`, iterate while `span.start <= lastCueOffset`.
- Count `matchedCues` from sentences that survive `finalize`. Record each timed sentence's cue range (e.g. a parallel array indexed by sentence id), and after `finalize`, union those ranges into the count. Do not count demoted sentences.
- Delete the unreachable `s === null || e === null` branch.
- Bump `ALGORITHM_VERSION` 3→4.

- [ ] **Step 4: Verify GREEN** — focused test file passes; then `npm run test`. If `cache.test.ts` pins version 3, update it to 4 (it should assert the version gate, not the literal — if the literal is there, change it).

- [ ] **Step 5: Commit** — `git add` the three files; message: `Fix alignment corroboration distance and cue stats`.

---

### Task 2: EPUB text pipeline and alignment cache

**Files:**

- Modify: `src/lib/epub/text.ts:56-86` (`collectBlocks`), `:1-4` (stale comment)
- Modify: `src/lib/epub/parse.ts:60-72` (nav titles), `:176-180` (strip set → shared set)
- Modify: `src/lib/epub/zip.ts:14-17` (image filter), `:56-62` (root-absolute hrefs)
- Modify: `src/lib/epub/source.ts:74-83` (empty-subtitle notice), `:105-142` (cache the fallback)
- Modify: `src/lib/epub/cache.ts:29` (version bump), `:114-131` (demote on rebuild), `:43-58` (open timeout)
- Create: `src/lib/epub/text.dom.test.ts`
- Test: `src/lib/epub/cache.test.ts`, `src/lib/epub/parse.dom.test.ts`, `src/lib/epub/source.dom.test.ts`

**Fixes:**

1. `collectBlocks` (`text.ts:75`) requires `children.length === 0`, and the walk only recurses elements, so direct text in mixed containers is silently dropped: `<div>前置き <em>強調</em> 後ろ</div>` yields only `強調`; `<td>セル <b>強調</b></td>` loses `セル`. The same traversal feeds alignment and rendering.
2. `parseEpub` strips only `script/style/link/meta` (`parse.ts:176-180`), while `cloneForRender` also drops `svg/video/audio/iframe/object/embed/form`; blocks containing those elements get offsets computed against text the clone no longer has.
3. Nav landmark anchors unconditionally overwrite toc titles for the same file (`parse.ts:60-72`); NCX correctly keeps first-wins.
4. `resolveRelative` turns `/OEBPS/ch1.xhtml` into `<baseDir>/OEBPS/ch1.xhtml` (`zip.ts:56-62`).
5. `unzipSync` decompresses every entry eagerly, images included (`zip.ts:14-17`).
6. Empty subtitle without an EPUB returns no notice (`source.ts:74-83`).
7. A sub-40% coverage fallback is recomputed on every load and never cached (`source.ts:105-142`).
8. `rebuildIndex` drops/clamps sentences but leaves `timed === true` on those it drops (`cache.ts:114-131`).
9. `openDb` has no `onblocked`/timeout, so a blocked version upgrade hangs the reader forever (`cache.ts:43-58`).
10. `text.ts:4` doc comment describes `BLOCK_TAGS` as inline elements.

**Interfaces:**

- Produces (Task 3 consumes): `export const NON_PROSE_TAGS: Set<string>` in `src/lib/epub/text.ts` — the union `script/style/link/meta/svg/video/audio/iframe/object/embed/form`. `parse.ts`'s `stripNonProse` uses it. Task 3 imports it in `epubRenderer.ts` for `cloneForRender` so alignment and rendering traverse identical text.
- Bumps `ALGORITHM_VERSION` 4→5 (text collection and parse output changed).

- [ ] **Step 1: Write failing tests**
- `text.dom.test.ts` uses `document.createElement`/`DOMParser`:

```ts
it('keeps text either side of an inline element', () => {
	document.body.innerHTML = '<div>前置き <em>強調</em> 後ろ</div>';
	const blocks = collectBlocks(document.body);
	expect(blocks.map((b) => blockPlainText(b.el))).toEqual(['前置き 強調 後ろ']);
});

it('keeps direct text in a table cell', () => {
	document.body.innerHTML = '<table><tr><td>セル <b>強調</b></td></tr></table>';
	// expect one block whose text is 'セル 強調'
});

it('keeps text after a nested block by emitting the container once', () => {
	document.body.innerHTML = '<div>lead<p>para</p>tail</div>';
	// expect ['leadparatail'] — outermost wins, no loss
});

it('still recurses when a container has only whitespace direct text', () => {
	document.body.innerHTML = '<div>\n  <p>a</p>\n  <p>b</p>\n</div>';
	// expect ['a', 'b']
});
```

- `parse.dom.test.ts`: nav landmark does not overwrite a toc title for the same file; `parseXML` falls back to HTML parsing when strict XHTML fails.
- `zip.test.ts` (create if absent): root-absolute href resolution; image entries are not decompressed/available.
- `source.dom.test.ts` (extend the stub `fetchFileText` seam): empty subtitle with no EPUB yields `notice`; a <40% alignment is saved so a second load does not re-align (spy on the cache seam or use an injectable `saveAlignment`).
- `cache.test.ts`: `rebuildIndex` sets `timed = false` on sentences it drops; `openDb` resolves null after an `onblocked`.

- [ ] **Step 2: Verify RED** — each focused file. The mixed-content tests must fail with the missing text; others fail for their stated reason.

- [ ] **Step 3: Implement**
- `collectBlocks`: for a non-`BLOCK_TAG` node, if it has a direct non-whitespace text node, emit the node (if its full prose text is non-empty) and stop descending; otherwise recurse. This covers inline-only containers and mixed containers without duplicating text. Update the doc comment.
- Extract `NON_PROSE_TAGS` in `text.ts`; use it in `parse.ts`'s strip and remove the duplicate list logic from `epubRenderer.ts` in Task 3.
- `parse.ts` nav titles: set only when the file has no title yet (first wins), matching NCX.
- `zip.ts`: if the clean href starts with `/`, `return normalize(cleanHref)`; pass fflate's `filter` to `unzipSync` to skip image extensions (`.jpg .jpeg .png .gif .webp .svg .avif .bmp .tif .tiff`).
- `source.ts`: add the missing empty-cues notice in the subtitle branch; save the sub-40% alignment to cache so the decision is not recomputed (the coverage check re-runs on the loaded result).
- `cache.ts`: set `timed = false` on dropped sentences in `rebuildIndex`; add `req.onblocked` and a timeout to `openDb` that resolves `null`.
- Bump `ALGORITHM_VERSION` 4→5.

- [ ] **Step 4: Verify GREEN** — focused files then `npm run test`. Update any version literal in `cache.test.ts`.

- [ ] **Step 5: Commit** — message: `Fix EPUB text collection and alignment cache gaps`.

---

### Task 3: Renderer sanitizer, layout anchoring, highlight and progress

**Files:**

- Modify: `src/lib/reader/epubRenderer.ts:5-7,44-48` (drop `href`/`target`), `:13-25` (use shared `NON_PROSE_TAGS`), `:659` (`scrollToChapter` tagging), dead `mountAll` (`:149-150,673-676`)
- Modify: `src/lib/reader/highlight.ts:101-105` (`typeof Highlight`), `HighlightHandle.deactivate` if unused
- Modify: `src/lib/reader/progress.ts:77-83` (`formatRemaining`)
- Modify: `src/lib/epub/text.ts` only if a comment moved there in Task 2
- Test: `src/lib/reader/epubRenderer.dom.test.ts`, `src/lib/reader/highlight.dom.test.ts`, `src/lib/reader/progress.test.ts`

**Fixes:**

1. Sanitizer keeps `href` (including `javascript:`) and `target` on cloned anchors; the page's click handler that neutralises them is dead until Task 5 and must not be the only defence.
2. `cloneForRender` drops more elements than `parseEpub` (resolved by importing `NON_PROSE_TAGS` from Task 2).
3. `scrollToChapter` scrolls without tagging the scroll for the auto-scroller (`onAdjustScroll`/`noteProgrammaticScroll`), so the contents jump is read as a lost correction.
4. `formatRemaining(3599)` returns `"60m left"` and `formatRemaining(7199)` returns `"1h 60m left"`.
5. `createHighlighter` checks `CSS.highlights` but not `typeof Highlight`, so a partial implementation throws instead of using the class fallback.
6. `mountAll` is never called; `chapterOf` is test-only; `HighlightHandle.deactivate` is unused and the CSS implementation ignores its argument.
7. No test exercises `withScrollAnchor` (tests never pass a `scroller`), so its early-return path is the only one covered.

**Interfaces:**

- Consumes: `NON_PROSE_TAGS` from `src/lib/epub/text.ts`.
- Produces: `scrollToChapter` (and any programmatic scroll the renderer makes) fires the existing `onAdjustScroll` hook so callers can tag it; do not change the callback's signature.

- [ ] **Step 1: Write failing tests**
- Sanitizer: clone of `<p><a href="javascript:alert(1)">x</a></p>` has no `href`; `<a href="#note">` keeps `href="#note"`; `<a href="https://x.test" target="_blank">` drops both.
- `formatRemaining`: `3599` → `'1h left'`, `7199` → `'2h left'` (or the chosen rounding — assert no `60m` and no `1h 60m`).
- Highlight: with a truthy `CSS.highlights` and `globalThis.Highlight` removed, `createHighlighter(...).activate(el)` must not throw and must apply `.hl-active`. Restore globals in `afterEach`.
- `withScrollAnchor`: mount a chapter into a stub scroller whose `scrollTop` can change, force a mount batch that changes the anchor host's measured height, and assert the correction delta and that `onAdjustScroll` fired first. Cover both writing modes (the axis-aware branch).

- [ ] **Step 2: Verify RED** — focused files. The sanitizer and `formatRemaining` tests must fail; the highlight test must throw before the guard; the anchor test must fail or be absent of any existing coverage (write it against the real API).

- [ ] **Step 3: Implement**
- In `cloneForRender`'s cleanup: for `A` elements remove `target`; remove `href` unless `href.startsWith('#')`. Keep dropping event handlers and code attrs as now. Use `NON_PROSE_TAGS` instead of the local element list.
- `scrollToChapter`: call the `onAdjustScroll` hook (same one `withScrollAnchor` fires) immediately before `container.scrollTo(...)`.
- `formatRemaining`: round total minutes first, then split into hours/minutes (`Math.round(s / 60)`), so 3599 → `1h left`, 7199 → `2h left`.
- `highlight.ts`: fall back to the class path when `typeof Highlight === 'undefined'`.
- Remove `mountAll`; decide on `chapterOf`/`deactivate`: remove from the public handle only if nothing in `src/` uses them, and update tests; otherwise leave and test.

- [ ] **Step 4: Verify GREEN** — focused files then full suite.

- [ ] **Step 5: Commit** — message: `Harden EPUB rendering and fix progress formatting`.

---

### Task 4: Sync controllers and search

**Files:**

- Modify: `src/lib/sync/ticker.ts:136-144` (disabled visibility), `stop()` (`:5,218-221`), `destroy()`
- Modify: `src/lib/sync/repeat.ts:125` (redundant check), `:159` (lazy interval)
- Modify: `src/lib/sync/autoscroll.ts:153-167` (pending across suspend), `:128-151` (programmatic scroll), `:241-246` (zero-size), add `markReaderDriven()`
- Modify: `src/lib/sync/parse.ts:9-29,69-71` (VTT hours, dedupe)
- Modify: `src/lib/sync/normalize.ts:76-81` (`sourceIndex`)
- Create: small shared upper/lower-bound helper used by `ticker.ts`, `navigate.ts`, `repeat.ts` (e.g. `src/lib/sync/search.ts`)
- Modify: `CLAUDE.md` (autoscroll `scrollBy`/`scrollLeft` paragraph; corroboration bullet wording)
- Test: `src/lib/sync/ticker.dom.test.ts`, `repeat.test.ts`, `autoscroll.dom.test.ts`, `sync.test.ts`, `parse` tests

**Fixes:**

1. `handleVisibility` re-arms RAF even when `setEnabled(false)` (`ticker.ts:136-144`), contradicting "stops sampling".
2. `stop()` has no caller in `src/`.
3. A stale `pendingId` survives a later `suspend()` and is applied at timer expiry (`autoscroll.ts:153-167`), dragging the reader back ~3s after a contents jump.
4. The settle check ignores `suspended` and treats any untagged programmatic scroll as a lost correction (`:128-151`); the renderer's new tagging (Task 3) plus an explicit app-navigation API closes this.
5. The repeat interval is created unconditionally (`repeat.ts:159`) — runs for the page's lifetime even when repeat is off.
6. `repeat.ts:125` `from !== null` is redundant.
7. SRT/VTT tap: `parseTimestampSRT` and `parseTimestampVTT` are byte-identical (`sync/parse.ts:9-29`).
8. VTT without an hours component parses to zero cues (`sync/parse.ts:69-71`) though `parseTimestampVTT` already supports `mm:ss.mmm`.
9. `sync.test.ts:14-16` is vacuous — `sanitizeText('hello world')` contains no `{...}`.
10. `repeat.test.ts:217-229` claims `setIndex(null)` disarms but only asserts no pause.
11. `normalize.ts:76-81` `sourceIndex` is only consumed by tests.
12. The three binary searches (`ticker.ts:78-90`, `navigate.ts:18-33`, `repeat.ts:96-110`) duplicate semantics and can drift.
13. Autoscroll zero-size test pin and `destroy()` clearing document/timer state.

**Interfaces:**

- Produces: `AutoScroller.markReaderDriven(): void` — declares that an app-initiated jump (contents chapter jump) is the reason the page is moving. Implementation: `readerDriven = true; selfScrollUntil = 0; pendingId = null; suspend(); scheduleSettleCheck();`. Task 5 calls it in `jumpToEpubChapter` before scrolling.
- Produces: shared `lowerBound(starts: Float64Array, value: number): number` / `upperBound` helper with the same semantics as the existing three loops; all three call sites use it and existing tests must stay green.

- [ ] **Step 1: Write failing tests**
- Ticker: with the controller disabled, hide+show must not start a RAF loop (assert no sampling / no callbacks after visibilitychange).
- Autoscroll: gesture-suspend → `scrollTo(next)` queues pending → `markReaderDriven()` → advance fake timers past 3s → the container must not scroll back, and `onDetach` must fire. Also: `markReaderDriven()` clears a queued pending immediately.
- Autoscroll: a zero-size active element neither triggers a correction nor `onDetach` (pins "unknown, don't touch").
- `destroy()` clears its timers and the observer.
- Repeat: with repeat disabled the 25 ms interval is not created; enabling starts it and disabling clears it.
- `sync/parse.ts`: WebVTT with `MM:SS.mmm` timestamps parses cues; SRT unchanged. Fix `sanitizeText` vacuous test input to `'{karaoke}hello'` and add a real bracket-stripping assertion.
- `repeat.test.ts`: assert `armed()` before/after `setIndex(null)` or rename to match what it checks.
- `normalize.ts`: if `sourceIndex` is used nowhere in `src/`, delete it and its test expectations; otherwise document the consumer.

- [ ] **Step 2: Verify RED** — focused files.

- [ ] **Step 3: Implement**
- Ticker: guard `handleVisibility`'s RAF re-arm with `enabled && !audio.paused`; remove `stop()` (or wire it if the page needs it — grep first; if removed, update the docs comment) and ensure `destroy()` is the only teardown the page needs.
- Autoscroll: add `markReaderDriven()`; clear `pendingId` in `resume()` and when `onDetach` fires, in addition to the new method.
- Repeat: create the interval in `setEnabled(true)` and clear it in `setEnabled(false)`; drop the redundant check.
- `sync/parse.ts`: one timestamp parser handling both SRT and VTT (hours optional), used by both branches.
- Extract the shared bound helper, replace the three loops; keep behavior identical (existing tests are the proof).
- CLAUDE.md: correct the autoscroll paragraph to describe the actual `scrollTo`/`scrollLeft` implementation (or vice versa only if the code is genuinely wrong — prefer fixing the docs when the code is deliberate); make the corroboration bullet say the displacement measured is the cursor movement.

- [ ] **Step 4: Verify GREEN** — sync tests then full suite.

- [ ] **Step 5: Commit** — message: `Fix sync controller lifecycle and autoscroll hand-back`.

---

### Task 5: Reader page, routes and components

**Files:**

- Modify: `src/routes/read/[itemId]/+page.svelte` (listeners `:540-541`/`:863-864`, keyboard/focus, teardown `:837-881`, no-audio `:576-583`, `jumpToEpubChapter` `:1185`, catch `:661-665`, cover `:558`, shortcut list)
- Modify: `src/routes/library/+page.svelte:45-56` (race), `:23-43` (disposed)
- Modify: `src/routes/book/[itemId]/+page.svelte:32-47` (disposed)
- Modify: `src/routes/settings/+page.svelte:13` (back fallback), `src/app.html:6` (theme-color)
- Modify: `src/lib/components/SettingsPanel.svelte:144-156` (shortcut list), `:352,457,734,990` only if validation surfaces issues
- Test: new page/component tests where feasible; otherwise extracted helpers with tests

**Fixes:**

1. **Critical:** `scrollerEl?.addEventListener` runs in `onMount` while `loading === true`, so the element does not exist yet (`:147`, `:1352`, `:1744`). Content-link interception and `handleNarrationScroll` have never worked; footnote links kill the page; the `javascript:` href guard is absent.
2. Settings sheet is `aria-modal` with no focus trap; backdrops are focusable; Space/Enter are ceded only to `HTMLButtonElement`; Escape closes only the sheet.
3. Library `selectLibrary` is last-response-wins (`library/+page.svelte:45-56`).
4. Teardown incomplete: `chromeScrollAnim` never cancelled; controllers not nulled (`:837-881`); catch paths set state after unmount (`read`, `library`, `book`).
5. No-audio path still enables read-along, highlights sentence 0, auto-scrolls and renders a dead transport.
6. Cover/audio URLs carry `?token=`; add `referrerpolicy="no-referrer"` on covers.
7. `settings` page `history.back()` exits the app on a deep link.
8. Shortcut list drifts from the handler (`F` when read-along is off, `A` without the Anki gate, vim keys undocumented).
9. `role="presentation"` on the scroller discards semantics; chrome can only be toggled by tap.
10. Fragment link comment overpromises (renderer drops `id`s).
11. Wire `autoScroller.markReaderDriven()` in `jumpToEpubChapter` (from Task 4).
12. Remove page usages of dead store members that Task 6 deletes (`reader.setError/setLoading`, `player.setChapter`, `connection.url`, `recent.remove`, `offsets.hydrate`).

**Interfaces:**

- Consumes: `AutoScroller.markReaderDriven()` (Task 4).
- Produces: extracted, testable helpers where the page is currently untestable — at minimum a `bindScrollerListeners(el, handlers)`-style effect/helper so the attachment timing is covered by a test.

- [ ] **Step 1: Write failing tests**
- **Highest priority:** a regression test that would fail on the old attachment timing. Preferred: mount the reader page with `$app/navigation`, `$app/stores`, `connectionToken` and the ABS client seam stubbed, then assert an in-content `<a href="chapter.xhtml">` click is default-prevented. If mounting the page proves impractical, extract the wiring into a helper and test that it attaches to an element that appears after the call site returns (the loading-gate shape).
- Library race: extract the item loader behind an injectable client; two overlapping responses, assert the last _requested_ library wins.
- Disposed-guard tests are impractical at page level; assert via the extracted loader where possible, otherwise document as manually verified.

- [ ] **Step 2: Verify RED** — the listener test fails (handler never attached) and the race test fails (stale response applied).

- [ ] **Step 3: Implement**
- Attach the two listeners in a `$effect` keyed on `scrollerEl` (returning a cleanup), or after the loading gate when the element is known to exist; delete the now-duplicate remove calls in `onDestroy`. Call `autoScroller?.markReaderDriven()` in `jumpToEpubChapter` before it scrolls.
- Focus/keyboard: trap Tab within the settings sheet (or use `<dialog>` + `showModal()`), `tabindex="-1"` on backdrops, cede Space/Enter to any activatable element (`a[href]`, `summary`, `[role=button]`), close popovers on Escape. Keep the existing `handleKeyDown` structure; extract a pure `isActivatable(el)` if that makes it testable.
- Race: monotonic request id or `AbortController`; ignore stale resolutions and stale errors.
- Teardown: `cancelAnimationFrame(chromeScrollAnim)`; null controllers after destroy; add `disposed` guards to every catch; gate sync/transport creation on `!noAudioNotice`.
- `referrerpolicy="no-referrer"` on cover images; remove `role="presentation"`; add a keyboard affordance for toggling chrome.
- Fix the settings back button (`goto('/', ...)` fallback when no history) and update `theme-color` from `settings.theme`.
- Shortcut list: correct the `F`/`A` conditions and document vim keys.

- [ ] **Step 4: Verify GREEN** — focused tests, full suite, `npm run check`. Manually smoke the reader with `npm run dev` if the fake-server skill is available.

- [ ] **Step 5: Commit** — message: `Fix reader link handling and page lifecycle`.

---

### Task 6: Store persistence safety

**Files:**

- Modify: `src/lib/stores/settings.ts:254-270` (validate), `:316-321` (safe write), dead members? (`reader` is separate)
- Modify: `src/lib/stores/player.ts:192` (safe write), `:97-115` (`seekWhenReady` listeners), `:163-176` (`setSrc('')`), `:139-141` (`setChapter`/`chapter` — remove if unused after Task 5)
- Modify: `src/lib/stores/offsets.ts:43` (safe write), `:50-53` (`hydrate` or wire storage events)
- Modify: `src/lib/stores/connection.ts:23` (safe write), `:32,46` (`url` — remove if unused)
- Modify: `src/lib/stores/recent.ts:40` (safe write), `:58-64` (`remove` — remove if unused)
- Modify: `src/lib/stores/reader.ts:38-43` (`setError`/`loading`/`error` — remove if unused)
- Test: `settings.dom.test.ts`, `player.test.ts`, `connection.test.ts`, `offsets` tests

**Fixes:**

1. Persisted settings merge without type validation (`settings.ts:254-270`): a stored `"fontSize": "1.4"`, `"progressModes": {}` or `"customTheme": {"bg": null}` throws inside `subscribe(persist)` at module init → white screen.
2. Every localStorage write is unguarded (`settings:318`, `player:192`, `offsets:43`, `connection:23`, `recent:40`): `setItem` throws `QuotaExceededError`, including inside a 5 s interval and `onDestroy`.
3. `seekWhenReady` leaves listeners on the singleton if metadata never arrives (`player.ts:97-115`).
4. `setSrc('')` sets `a.src` to the page URL (`:171-174`).
5. Dead members listed above.
6. `offsets.hydrate` is documented as a cross-tab path but no `storage` listener exists.

**Interfaces:**

- Produces: `safeSetItem(key: string, value: string): void` in a shared place (e.g. `src/lib/stores/storage.ts`) used by all five stores.
- Produces: `sanitizeSettings(parsed: unknown): SettingsState` (or per-key coercion) exported for tests.

- [ ] **Step 1: Write failing tests**
- Settings: stored `{"fontSize":"1.4"}`, `{"progressModes":{}}`, `{"customTheme":{"bg":null}}`, `{"theme":"nonsense"}` each load without throwing, keep valid siblings, and fall back to defaults per bad key. Assert the `--custom-*` writes still happen for a valid custom theme (the second merge).
- `safeSetItem` swallows a throwing `setItem` (stub `Storage.prototype.setItem` to throw).
- Player: `seekWhenReady` removes its `loadedmetadata`/`error` listeners when it fires; no accumulation across calls; `setSrc('')` removes the `src` attribute.
- Offsets: if a `storage` listener is added, test that a foreign update rehydrates; otherwise assert `hydrate` is gone and comments corrected.
- Connection: connect/disconnect persist and clear.

- [ ] **Step 2: Verify RED** — focused files. The malformed-settings tests must throw before the guard.

- [ ] **Step 3: Implement**
- `sanitizeSettings`: validate types and enums per key, merge over defaults per validated key, validate each `customTheme` colour as a string matching a colour pattern (fall back per colour). `isDarkColor` already tolerates invalid input for values that pass the guard.
- `safeSetItem`: try/catch, optional in-memory fallback is not required; a failed write must not throw into callers.
- Replace every `localStorage.setItem` call.
- `seekWhenReady`: always remove both listeners in the callback and on error; track and clean up a pending registration if `setSrc` replaces the source.
- `setSrc('')`: `removeAttribute('src')` and `load()` if needed.
- Remove dead members; if `offsets.hydrate` stays, wire a `window.addEventListener('storage', ...)` in the store module and test it.

- [ ] **Step 4: Verify GREEN** — focused then full suite.

- [ ] **Step 5: Commit** — message: `Harden store persistence and audio lifecycle`.

---

### Task 7: Proxy, ABS client, deploy and configuration

**Files:**

- Modify: `Caddyfile:6-11` (`handle_path`, immutable cache headers)
- Modify: `src/routes/abs/[...path]/+server.ts:26-34,57-76` (headers, timeout, redaction)
- Modify: `src/lib/abs/proxy-target.ts:11-16` (preserve base path)
- Modify: `src/lib/abs/client.ts:28-95` (timeout/abort)
- Modify: `src/lib/abs/metadata.ts:75,84-90` (explicit bool, duration rounding, entities), `collectFiles` dedupe with `api.ts:39-46`
- Modify: `vite.config.ts:39,53` (overlap exclude)
- Modify: `docker-compose.yml`/`README.md:99` (contradiction), `docker-compose.prod.yml` (track it), `.gitignore:17-19`, `.dockerignore:4-5`, `static/robots.txt`
- Modify: `.github/workflows/*.yml` (concurrency group)
- Delete: `src/lib/vitest-examples/`
- Modify: `CLAUDE.md` (dev-proxy description)
- Test: `proxy-target.test.ts`, new `client.test.ts`, `metadata.test.ts`

**Fixes:**

1. **Critical:** `Caddyfile` `handle @abs` does not strip `/abs`, and the dev-only `+server.ts` prefix stripper is absent from the static build — production calls `http://audiobookshelf:80/abs/api/...` → 404 everywhere.
2. Proxy copies `content-length` after undici decodes a compressed body (`+server.ts:60-65`), corrupting gzipped responses.
3. Proxy logs and returns the full target URL including `?token=` (`:72-74`).
4. Proxy forwards hop-by-hop headers and returns JSON errors without `content-type`; no upstream timeout.
5. `resolveProxyTarget` silently drops a base path in `ABS_ORIGIN`.
6. `ABSClient` has no timeout/abort (`client.ts:28-95`).
7. `formatDuration` prints `"60 min"`/`"1 hr 60 min"`; `Boolean(meta.explicit)` turns `"false"` into `true`; `descriptionToParagraphs` leaves entities encoded (`metadata.ts:75,84-90`).
8. `collectFiles` duplicated in `api.ts` and `metadata.ts`.
9. Vite glob overlap: `*.dom.svelte.test.ts` runs in two projects.
10. `.env.prod.example` is ignored by `.gitignore:17-19` and absent from the repo; `.dockerignore` only excludes `.env`/`.env.local`.
11. `docker-compose.yml` no longer has `build: .` while `README.md:99` says `docker compose up -d --build`; `docker-compose.prod.yml` is untracked though it is the documented deployment artifact and contains no secrets.
12. `vitest-examples` template leftovers.
13. `robots.txt` invites indexing of a private reader; no immutable cache headers for hashed assets.
14. CLAUDE.md says Vite proxies `/abs/*`; it is the SvelteKit endpoint.

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: nothing downstream.

- [ ] **Step 1: Write failing tests**
- `proxy-target.test.ts`: a base path in the origin is preserved (`https://host/abs` + `/api/x` → `/abs/api/x`); traversal attacks still rejected.
- `client.test.ts` (new; Node project): point the client at a local `http.createServer` that never responds, with a short injected timeout, and assert an `ABSError` with a timeout message rather than a hang; a 401 maps to the existing message.
- `metadata.test.ts`: `formatDuration(3599)` → `'1 hr'`-style value with no `60 min`; `explicit: 'false'` → `false`; entity decoding.

- [ ] **Step 2: Verify RED** — focused files.

- [ ] **Step 3: Implement**
- `Caddyfile`:

```caddyfile
handle_path /abs/* {
	reverse_proxy {$ABS_ORIGIN:http://localhost:13378} {
		header_up Host {upstream_hostport}
	}
}

@immutable path /_app/immutable/*
header @immutable Cache-Control "public, max-age=31536000, immutable"
```

- Proxy: when the upstream response has `content-encoding`, skip both `content-encoding` and `content-length`; add `connection`, `keep-alive`, `upgrade`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer` to `filterHeaders`; log only `target.origin + target.pathname`; return `{ error: 'Proxy error' }` with `content-type: application/json`; pass an `AbortSignal.timeout(...)` to the upstream fetch.
- `resolveProxyTarget`: build from `new URL(origin)` and preserve its `pathname` as a prefix; keep the origin check.
- `ABSClient`: accept an optional timeout (default 30 s), pass `AbortSignal.timeout(...)` to both fetches, map aborts to `ABSError('Request timed out', 0, err)`.
- `metadata.ts`: round total minutes before splitting; parse `explicit` strictly (`=== true || === 'true'`); decode entities with a small helper or the `he`-free approach already available (do not add a dependency).
- Dedupe `collectFiles`; fix the Vite exclude; un-ignore `.env.prod.example`; `.dockerignore` pattern `.env*` (keep `.env.example` in the image if referenced); restore `build: .` in `docker-compose.yml` or fix README and the prod file's comment — pick the one consistent with how the user deploys and say which in the commit; `git add docker-compose.prod.yml`; delete `vitest-examples`; `robots.txt` disallow; CI concurrency.
- CLAUDE.md dev-proxy description.

- [ ] **Step 4: Verify GREEN** — full suite, `npm run check`, `npm run lint`; validate the Caddyfile syntax by reading (no Caddy locally) and confirm `docker compose -f docker-compose.prod.yml config` if Docker is available.

- [ ] **Step 5: Commit** — message: `Fix production proxy and deploy configuration`.

---

### Task 8: Anki mining robustness

**Files:**

- Modify: `src/lib/anki/mine.ts:85-158` (reorder, pure payload builder seam)
- Modify: `src/lib/anki/capture.ts:295-301,363-368,403` (rig leak, src guard, redaction)
- Modify: `src/lib/anki/connect.ts:70-72` (validate payload, wrap parse errors)
- Test: `mine.test.ts`, `capture.test.ts`, `connect.test.ts`

**Fixes:**

1. `mine.ts` calls `storeMediaFile` before `findNewestNote`/`notesInfo` validation, so a missing note or field orphans uploaded media. The payload orchestration is untested.
2. Failed rig creation leaks the audio element and a permanently connected `MediaElementAudioSourceNode` (`capture.ts:363-368`); an in-flight `rigPromise` is returned even when `src` differs (`:295-301`).
3. `capture.ts:403` logs the source URL with the ABS token.
4. `connect.ts:70-72` trusts `payload.result` and surfaces `res.json()` failures as raw `SyntaxError`.

**Interfaces:**

- Produces: a pure `buildMinePayload(...)`-style function (name it as fits) exported for tests, following the injectable-seam pattern from `source.ts`. The function returns the AnkiConnect actions/fields without performing I/O.

- [ ] **Step 1: Write failing tests**
- `mine.ts`: in update-last mode, when no note matches, `storeMediaFile` is never called (inject a fetch/recorder seam); when the field is missing, same; the built payload has the expected `[sound:...]`, model, deck, fields, tags.
- `capture.ts`: a rig whose metadata never arrives is disposed (element `src` cleared, nodes disconnected); a second `getRig` with a different `src` does not reuse the in-flight promise.
- `connect.ts`: a malformed 200 (`{}` or non-JSON) throws a typed error naming the cause, not a raw `SyntaxError`.

- [ ] **Step 2: Verify RED** — focused files.

- [ ] **Step 3: Implement**
- Reorder validation before `storeMediaFile`; extract the pure payload builder and call it.
- Dispose the rig on metadata failure/timeout; key the in-flight promise by `src`; redact the logged URL.
- Validate `payload.result` presence and wrap `res.json()` in try/catch with a clear error.

- [ ] **Step 4: Verify GREEN** — focused then full suite, `npm run check`, `npm run lint`.

- [ ] **Step 5: Commit** — message: `Fix Anki mining failure paths`.

---

## Final verification

After Task 8: `npm run test`, `npm run check`, `npm run lint` on the whole branch, then the final whole-branch review per subagent-driven-development. Deferred minors from the ledger are triaged there before finishing the branch.
