# Chapter Jump from Book Details Design

**Date:** 2026-08-06
**Status:** Approved (user)

## Goal

Clicking a chapter in the book details page (`/book/[itemId]`) opens the reader at that chapter's start time, paused, ready to play — consistent with the existing "Continue reading" button.

## Architecture

The target position travels in the URL as a query parameter: `?at=<seconds>`. The reader already consumes URL parameters for position (`?restart=1` ignores the bookmark); `at` follows the same pattern, overrides the bookmark, and wins if both are present. No new stores, no cross-page state, survives refresh and browser back/forward.

## URL Contract

- `GET /read/<itemId>?at=<seconds>` — open the reader and seek to `<seconds>` once the audio metadata is known, instead of resuming the bookmark.
- `at` must be a finite number >= 0. Missing, NaN, or negative values fall back to the normal bookmark flow.
- The seek happens via the existing `player.seekWhenReady()`, which waits for `loadedmetadata` (a remote book can take many seconds to answer) and `clampSeek` bounds an out-of-range target.
- Playback starts paused at the target. The reader's 5s bookmark interval then records the new position from there on.

## Reader Changes (`src/routes/read/[itemId]/+page.svelte`, onMount)

- Parse the parameter once: `at` honored only when `Number.isFinite(at) && at >= 0`.
- Bookmark resolution becomes: `at` present → `at`; else `restart=1` → 0; else saved bookmark.
- No other onMount behavior changes; the no-audio path (`setSrc('')` + notice) is untouched and simply never seeks.

## Details Page Changes (`src/routes/book/[itemId]/+page.svelte`)

- Each chapter row in the Chapters list becomes a `<button>` with the existing number/title/timestamp layout, hover highlight, and an `aria-label` naming the chapter.
- Clicking navigates to `/read/<itemId>?at=<ch.start>`.
- The "Show all N chapters" toggle is unchanged.

## Edge Cases

| Case                                            | Behavior                                             |
| ----------------------------------------------- | ---------------------------------------------------- |
| `at` missing / NaN / negative                   | Falls back to bookmark flow                          |
| `at` beyond the book's duration                 | `clampSeek` clamps to the end once duration is known |
| Book with no audio track                        | Existing no-audio notice; no seek is attempted       |
| `at` present together with `restart=1`          | `at` wins                                            |
| Refresh / back / forward with `?at=` in the URL | Re-seeks to the chapter — intended                   |

## Testing

The parsing rule is extracted as a pure function `parseStartParam(value: string | null): number | null` in `src/lib/reader/startParam.ts`, unit-tested for valid/NaN/negative/missing inputs (matching the repo's `navigate.ts` pattern). Route wiring is verified with `npm run check` and a live click-through on the dev server.

## Out of Scope

- Reader-side "jump to chapter" (the player bar's chapter dropdown already seeks; the EPUB contents button deliberately moves text only).
- Autoplay on chapter jump (user chose paused).
