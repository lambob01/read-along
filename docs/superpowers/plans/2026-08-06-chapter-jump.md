# Chapter Jump from Book Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a chapter on the book details page opens the reader paused at that chapter's start time.

**Architecture:** The target position travels in the URL as `?at=<seconds>` on `/read/<itemId>`. The reader's onMount parses it with a new pure `parseStartParam` function and, when valid, seeks there via the existing `player.seekWhenReady()` instead of resuming the bookmark. The details page turns each chapter row into a button navigating to `/read/<itemId>?at=<ch.start>`.

**Tech Stack:** SvelteKit (adapter-static SPA), Svelte 5 runes, vitest (three projects by filename suffix), prettier.

## Global Constraints

- All commands run from `reader/` — the path contains a space; quote it.
- Source uses **tabs** for indentation (prettier). Do not reformat unrelated code.
- `requireAssertions: true` in vite.config.ts — every test MUST contain an expect.
- Commit message style is a plain imperative sentence, no conventional-commit prefix.
- `npm run check` reports ONE pre-existing `PUBLIC_ABS_ORIGIN` env error in `src/routes/abs/[...path]/+server.ts` when `.env.local` is absent — not a failure of this plan.
- `parseStartParam` must honor a target only when it is a finite number >= 0; missing, empty, NaN and negative values return null (fall back to the bookmark flow).
- Playback starts **paused** at the target; the seek must go through `player.seekWhenReady()`.
- `at` wins over `restart=1` when both are present.
- Out of scope: reader-side chapter jumping (the player bar dropdown already seeks; the EPUB contents button deliberately moves text only), autoplay on jump.

---

### Task 1: Pure `parseStartParam` parser with tests

**Files:**
- Create: `src/lib/reader/startParam.ts`
- Create: `src/lib/reader/startParam.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseStartParam(value: string | null): number | null` — the seconds to seek to, or null when the parameter is missing/empty/NaN/negative. Task 2 consumes this.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/reader/startParam.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseStartParam } from './startParam';

describe('parseStartParam', () => {
	it('parses a whole-number target', () => {
		expect(parseStartParam('612')).toBe(612);
	});

	it('parses a fractional target', () => {
		expect(parseStartParam('612.5')).toBe(612.5);
	});

	it('treats a missing parameter as no jump', () => {
		expect(parseStartParam(null)).toBeNull();
	});

	it('treats an empty parameter as no jump', () => {
		// /read/x?at= yields '', and Number('') is 0 — seeking to the start
		// would be a surprise for a malformed link.
		expect(parseStartParam('')).toBeNull();
	});

	it('treats non-numeric input as no jump', () => {
		expect(parseStartParam('abc')).toBeNull();
		expect(parseStartParam('1,000')).toBeNull();
	});

	it('treats negative values as no jump', () => {
		expect(parseStartParam('-5')).toBeNull();
	});

	it('treats non-finite values as no jump', () => {
		expect(parseStartParam('Infinity')).toBeNull();
		expect(parseStartParam('NaN')).toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reader/startParam.test.ts`
Expected: FAIL with "Cannot find module" (files do not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/reader/startParam.ts`:

```ts
/**
 * Parses the reader's `?at=` query parameter: the seconds to seek to on load,
 * or null when the parameter is absent or unusable.
 *
 * Number('') is 0, so an empty value must be rejected explicitly — a malformed
 * link seeking to the start of the book would be a surprise. Negative and
 * non-finite values fall back to the bookmark flow rather than seeking.
 */
export function parseStartParam(value: string | null): number | null {
	if (value === null || value.trim() === '') return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reader/startParam.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/startParam.ts src/lib/reader/startParam.test.ts
git commit -m "Parse the reader's at param as a pure, tested function"
```

---

### Task 2: Seek to the `at` param in the reader's onMount

**Files:**
- Modify: `src/routes/read/[itemId]/+page.svelte` (onMount, the bookmark-resolution block around lines 501-511)

**Interfaces:**
- Consumes: `parseStartParam(value: string | null): number | null` from `$lib/reader/startParam` (Task 1); `player.seekWhenReady` (existing); `$page.url.searchParams` (existing)
- Produces: the reader seeks to `?at=` when present and valid, before falling back to restart/bookmark

- [ ] **Step 1: Write the failing test**

This is a route page with no unit-test harness in this repo (established convention: `npm run check` + live verification). The parser behavior is pinned by Task 1's tests; this task's verification is the check command in Step 3. There is no failing-test step; instead verify the wiring compiles:

Run: `npm run check`
Expected: only the pre-existing `PUBLIC_ABS_ORIGIN` env error.

- [ ] **Step 2: Implement the wiring**

In `src/routes/read/[itemId]/+page.svelte`:

1. Add the import alongside the other `$lib` imports (near the `loadTextSource` import, line ~30):

```ts
	import { parseStartParam } from '$lib/reader/startParam';
```

2. In `onMount`, next to the existing restart line (currently `const restart = $page.url.searchParams.get('restart') === '1';`), add:

```ts
		const startParam = parseStartParam($page.url.searchParams.get('at'));
```

3. Replace the bookmark resolution inside the `if (audioSrc)` block:

```ts
			if (audioSrc) {
				const src = `/abs${audioSrc}?token=${encodeURIComponent(connectionToken)}`;
				player.setSrc(src);
				const bookmark =
					startParam !== null
						? startParam
						: restart
							? 0
							: (player.getBookmark(itemId) ?? 0);
				// Waits for metadata rather than guessing at a delay: 500ms was
				// enough on a local file and nowhere near enough for a long book
				// over a remote connection, where the seek landed before the
				// element knew its duration and was discarded.
				if (bookmark > 0) player.seekWhenReady(bookmark);
			}
```

(`bookmark > 0` stays as the guard: `at=0` seeks nowhere, which is correct for chapter 1. `at` wins over `restart` by construction — it is checked first.)

- [ ] **Step 3: Verify**

Run: `npm run check && npm run test`
Expected: check reports only the pre-existing env error; all tests pass (309 + 7 new from Task 1).

- [ ] **Step 4: Commit**

```bash
git add "src/routes/read/[itemId]/+page.svelte"
git commit -m "Seek to the at param instead of the bookmark when present"
```

---

### Task 3: Make details-page chapters clickable

**Files:**
- Modify: `src/routes/book/[itemId]/+page.svelte` (the Chapters list, lines 279-293)

**Interfaces:**
- Consumes: `goto` from `$app/navigation` (already imported); `itemId` (already derived); `ch.start`/`ch.title` (already in scope)
- Produces: each chapter row navigates to `/read/<itemId>?at=<ch.start>`

- [ ] **Step 1: Verify the current state**

Run: `npm run check`
Expected: only the pre-existing `PUBLIC_ABS_ORIGIN` env error.

- [ ] **Step 2: Implement the clickable rows**

In `src/routes/book/[itemId]/+page.svelte`, replace the `<ol>` block (lines 279-293) with:

```svelte
					<ol class="mt-3 divide-y divide-[var(--border)]">
						{#each visibleChapters as ch, i}
							<li>
								<button
									onclick={() => goto(`/read/${itemId}?at=${ch.start}`)}
									class="flex w-full items-baseline gap-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
									aria-label={`Jump to chapter ${i + 1}: ${ch.title}`}
									title={`Jump to chapter ${i + 1}`}
								>
									<span class="w-6 shrink-0 text-xs text-[var(--muted)] tabular-nums">
										{i + 1}
									</span>
									<span class="min-w-0 flex-1 truncate text-sm text-[var(--fg)]">
										{ch.title}
									</span>
									<span class="shrink-0 text-xs text-[var(--muted)] tabular-nums">
										{formatTimestamp(ch.start)}
									</span>
								</button>
							</li>
						{/each}
					</ol>
```

(The `Show all N chapters` toggle below is untouched.)

- [ ] **Step 3: Verify**

Run: `npm run check && npm run test`
Expected: check reports only the pre-existing env error; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add "src/routes/book/[itemId]/+page.svelte"
git commit -m "Make details-page chapters jump into the reader at their start"
```

---

### Task 4: Final verification

**Files:** none

- [ ] **Step 1: Full automated verification**

Run: `npm run test && npm run check && npm run lint`
Expected: all tests pass; check clean except the pre-existing env error; prettier clean.

- [ ] **Step 2: Live click-through on the dev server**

With the dev server running (it proxies to the real ABS via `.env.local`):

1. Open `/book/<some item id>` and click a non-first chapter row.
2. Expect: navigation to `/read/<itemId>?at=<seconds>`; the reader loads; the seek bar's position and the current time show the chapter start; the highlight/text is positioned at/near that chapter; playback is paused.
3. Press play and confirm audio resumes from the chapter start.
4. Refresh the page with `?at=` still in the URL — it must re-seek to the chapter.

- [ ] **Step 3: Report**

Summarize what was verified and confirm the branch is ready.

---

## Self-Review

- **Spec coverage:** URL contract → Tasks 1+2 (parse rule, seekWhenReady, paused, at-wins-over-restart); details-page clickability → Task 3; edge cases → Task 1's tests (NaN/negative/missing/empty) + Task 2's `bookmark > 0` guard (at=0 no-op, out-of-range clamped by clampSeek inside seekWhenReady); no-audio path untouched (Task 2 only edits inside `if (audioSrc)`); testing → Task 1 unit tests + Task 4 live pass. All spec requirements accounted for.
- **Placeholder scan:** every task has exact code, commands, and expectations; Task 2's no-failing-test step is explicit about why (repo convention for route pages) and names the verification command.
- **Type consistency:** `parseStartParam(value: string | null): number | null` is defined in Task 1 and consumed in Task 2 with the same signature; `ch.start`/`ch.title` come from the existing `chapters` shape used in the current markup.
