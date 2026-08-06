# Directional Narration Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reader's "Narration" button animates in once when it appears and its arrow points toward where the narration actually is, rotating when the direction changes — no persistent animation while visible.

**Architecture:** A pure `narrationDirection(viewRect, narrRect, vertical)` function maps the narration element's rect against the scroller's rect to `'up' | 'down' | 'left' | 'right'` (vertical-rl reads right-to-left, so "ahead" is left). The reader page holds a `narrationDir` `$state`, recomputed by an effect on `$reader.activeSentenceId` and by a passive scroll listener while detached. The arrow is an SVG inside a rotation wrapper (`transform: rotate(...)` with a 200ms CSS transition); the button gets a one-shot fade/slide keyframe animation that runs on each mount (it is conditionally rendered). Both animations are disabled under `prefers-reduced-motion`.

**Tech Stack:** SvelteKit (adapter-static SPA), Svelte 5 runes, vitest (three projects by filename suffix), Tailwind v4 + `src/app.css`.

## Global Constraints

- All commands run from `reader/` — the path contains a space; quote it.
- Source uses **tabs** for indentation (prettier). Do not reformat unrelated code.
- `requireAssertions: true` in vite.config.ts — every test MUST contain an expect.
- Commit message style is a plain imperative sentence, no conventional-commit prefix.
- `npm run check` must stay clean (`.env.local` exists in this checkout; if it is ever absent, one pre-existing `PUBLIC_ABS_ORIGIN` env error in `src/routes/abs/[...path]/+server.ts` is expected — not a failure).
- The direction function's rect parameter type is `Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>` — a structural shape so node tests (which have no `DOMRect` global) can pass plain objects; real `DOMRect`s satisfy it.
- Direction defaults: narration element unmounted (null) or on-screen → forward direction (`down` horizontal, `left` vertical).
- Rotation mapping: `down` = 0deg, `up` = 180deg, `left` = 90deg, `right` = -90deg (base arrow SVG points down; positive CSS rotation is clockwise).
- The arrow transition is ~200ms; the appear animation is a fade + 8px translate, ~200ms ease-out, **once per mount**.
- Both animations are disabled under `prefers-reduced-motion`.
- Out of scope: persistent/pulsing animations, dismissal animation, changing the button's position or label.

---

### Task 1: Pure `narrationDirection` function with tests

**Files:**
- Create: `src/lib/reader/narrationDirection.ts`
- Create: `src/lib/reader/narrationDirection.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type NarrationDirection = 'up' | 'down' | 'left' | 'right'` and `narrationDirection(viewRect: Rect, narrRect: Rect | null, vertical: boolean): NarrationDirection` where `type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>`. Task 2 consumes both.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/reader/narrationDirection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { narrationDirection, type Rect } from './narrationDirection';

/** Viewport rect, 1000px tall, 800px wide, at the origin. */
const VIEW: Rect = { top: 0, bottom: 1000, left: 0, right: 800 };

function rect(top: number, bottom: number, left: number, right: number): Rect {
	return { top, bottom, left, right };
}

describe('narrationDirection — horizontal text', () => {
	it('points up when the narration is above the viewport', () => {
		expect(narrationDirection(VIEW, rect(100, 200, 0, 800), false)).toBe('up');
	});

	it('points down when the narration is below the viewport', () => {
		expect(narrationDirection(VIEW, rect(1100, 1200, 0, 800), false)).toBe('down');
	});

	it('defaults to down when the narration overlaps the viewport', () => {
		expect(narrationDirection(VIEW, rect(500, 1500, 0, 800), false)).toBe('down');
		// Touching exactly at the boundary is still "on screen".
		expect(narrationDirection(VIEW, rect(1000, 1200, 0, 800), false)).toBe('down');
	});

	it('defaults to down when the narration element is not mounted', () => {
		expect(narrationDirection(VIEW, null, false)).toBe('down');
	});
});

describe('narrationDirection — vertical text (vertical-rl)', () => {
	it('points left when the narration is further along (to the left)', () => {
		expect(narrationDirection(VIEW, rect(0, 1000, -400, -200), true)).toBe('left');
	});

	it('points right when the narration is behind (to the right)', () => {
		expect(narrationDirection(VIEW, rect(0, 1000, 900, 1100), true)).toBe('right');
	});

	it('defaults to left when the narration overlaps the viewport', () => {
		expect(narrationDirection(VIEW, rect(0, 1000, -300, 300), true)).toBe('left');
		expect(narrationDirection(VIEW, rect(0, 1000, 800, 900), true)).toBe('left');
	});

	it('defaults to left when the narration element is not mounted', () => {
		expect(narrationDirection(VIEW, null, true)).toBe('left');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reader/narrationDirection.test.ts`
Expected: FAIL with "Cannot find module" (files do not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/reader/narrationDirection.ts`:

```ts
/**
 * Which way the narration lies from the viewport, for the "Narration" button
 * arrow. Horizontal text reads top-to-bottom, so above is "up" and below is
 * "down"; vertical-rl reads right-to-left, so further along is "left" and
 * behind is "right".
 *
 * The rects are structural (`Pick<DOMRect, ...>`) so the function is testable
 * in node, where there is no DOMRect global. A null narration rect (chapter
 * not mounted) or an on-screen narration falls back to the forward direction,
 * which is what the button means when the target is ambiguous.
 */
export type NarrationDirection = 'up' | 'down' | 'left' | 'right';

export type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

export function narrationDirection(
	viewRect: Rect,
	narrRect: Rect | null,
	vertical: boolean
): NarrationDirection {
	if (!narrRect) return vertical ? 'left' : 'down';
	if (vertical) {
		if (narrRect.right < viewRect.left) return 'left';
		if (narrRect.left > viewRect.right) return 'right';
		return 'left';
	}
	if (narrRect.bottom < viewRect.top) return 'up';
	if (narrRect.top > viewRect.bottom) return 'down';
	return 'down';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reader/narrationDirection.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/narrationDirection.ts src/lib/reader/narrationDirection.test.ts
git commit -m "Add a pure narration-direction resolver with tests"
```

---

### Task 2: Aim the arrow in the reader page

**Files:**
- Modify: `src/routes/read/[itemId]/+page.svelte`

**Interfaces:**
- Consumes: `narrationDirection`, `NarrationDirection` from `$lib/reader/narrationDirection` (Task 1); `narrationSentenceId()` (already in the file, line ~672); `epubRender.elementFor(id)` / `$reader.sentenceMap.get(id)` (already used in the file); `$settings.verticalText`; `$reader.activeSentenceId`
- Produces: a `narrationDir` `$state` kept current while the reader is detached, and the button's arrow wrapped in a rotation span driven by it

- [ ] **Step 1: Verify the current state**

Run: `npm run check`
Expected: clean.

- [ ] **Step 2: Implement**

In `src/routes/read/[itemId]/+page.svelte`:

1. Add the import alongside the other `$lib` imports:

```ts
	import { narrationDirection, type NarrationDirection } from '$lib/reader/narrationDirection';
```

2. Near the `detached` state (line ~68), add:

```ts
	/** Which way the narration lies from the viewport, for the button's arrow. */
	let narrationDir = $state<NarrationDirection>('down');
```

3. Near `goToNarration` (line ~682), add the resolver and the scroll handler:

```ts
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
```

4. Add the re-aim effect next to the other controller-pushing effects (after the autoHideChrome effect):

```ts
	$effect(() => {
		// Dependencies: the active sentence (audio moved) and the detached
		// flag (button appeared/disappeared). Reading the store values inside
		// the effect body is what subscribes the effect to them.
		$reader.activeSentenceId;
		if (!detached || !scrollerEl) return;
		narrationDir = currentNarrationDirection();
	});
```

5. Register the scroll listener in `onMount`, next to the existing `scrollerEl?.addEventListener('click', handleContentLinkClick);` line:

```ts
		scrollerEl?.addEventListener('scroll', handleNarrationScroll, { passive: true });
```

6. Remove it in `onDestroy`, next to the existing `scrollerEl?.removeEventListener('click', handleContentLinkClick);` line:

```ts
		scrollerEl?.removeEventListener('scroll', handleNarrationScroll);
```

7. Replace the button's arrow SVG (lines 2063-2071) with the rotation wrapper:

```svelte
					<span
						class="narration-arrow block"
						style="transform: rotate({narrationDir === 'up' ? 180 : narrationDir === 'left' ? 90 : narrationDir === 'right' ? -90 : 0}deg)"
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
```

(The base SVG points down; the rotation map comes from the plan's Global Constraints. The wrapper is `block` so transform applies.)

- [ ] **Step 3: Verify**

Run: `npm run check && npm run test`
Expected: clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add "src/routes/read/[itemId]/+page.svelte"
git commit -m "Aim the narration button arrow at where the narration is"
```

---

### Task 3: Appear animation and arrow transition

**Files:**
- Modify: `src/app.css`

**Interfaces:**
- Consumes: the `narration-arrow` class from Task 2, the button's markup
- Produces: the one-shot appear animation (`.narration-btn` class on the button) and the arrow's `transform` transition, both disabled under `prefers-reduced-motion`

- [ ] **Step 1: Verify the current state**

Run: `npm run check`
Expected: clean.

- [ ] **Step 2: Implement the CSS**

Append to `src/app.css`:

```css
/* The Narration button slides in once when it appears — it is conditionally
   rendered, so the animation re-runs on each appearance and never repeats
   while it stays visible. */
@keyframes narration-pop {
	from {
		opacity: 0;
		transform: translateY(8px);
	}
	to {
		opacity: 1;
		transform: none;
	}
}

.narration-btn {
	animation: narration-pop 200ms ease-out;
}

.narration-arrow {
	transition: transform 200ms ease;
}

@media (prefers-reduced-motion: reduce) {
	.narration-btn {
		animation: none;
	}
	.narration-arrow {
		transition: none;
	}
}
```

- [ ] **Step 3: Apply the class in the page**

In `src/routes/read/[itemId]/+page.svelte`, add `narration-btn` to the Narration button's class list (line ~2060), so the existing classes become:

```svelte
					class="narration-btn flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--accent)] shadow-[var(--shadow-lg)]"
```

- [ ] **Step 4: Verify**

Run: `npm run check && npm run lint`
Expected: clean (lint now covers the whole repo — the docs files are prettier-formatted from the earlier fix, so nothing else should fail; if a docs file fails, report it, do not reformat it).

- [ ] **Step 5: Commit**

```bash
git add src/app.css "src/routes/read/[itemId]/+page.svelte"
git commit -m "Animate the narration button's appearance and arrow flip"
```

---

### Task 4: Final verification

**Files:** none

- [ ] **Step 1: Full automated verification**

Run: `npm run test && npm run check && npm run lint`
Expected: all tests pass (316 + 8 new); check clean; prettier clean.

- [ ] **Step 2: Live check on the dev server**

With the dev server running (http://localhost:5174, proxying to the real ABS):

1. Open a book and start playback. Scroll far away from the narration (or jump chapters with `n`/`p`).
2. Expect: the Narration button appears with a one-shot fade/slide; its arrow points toward the narration — up when the narration is above, down when below.
3. Scroll past the narration: the arrow rotates to the new direction (~200ms).
4. Use `n`/`p` to jump the audio to a chapter far away: the arrow re-aims as `activeSentenceId` changes.
5. Enable vertical text under Settings: the arrow points left (ahead) or right (behind).
6. Confirm no animation repeats while the button stays visible.
7. In devtools, emulate `prefers-reduced-motion: reduce` and confirm both animations are gone.

- [ ] **Step 3: Report**

Summarize what was verified and confirm the feature is ready.

---

## Self-Review

- **Spec coverage:** direction table → Task 1 (all 9 cells, including on-screen/unmounted defaults and the exact-boundary case); arrow rotation → Task 2 step 7 (rotation map in Global Constraints); appear animation → Task 3 (fade + 8px translate, once per mount, reduced-motion off); reactivity → Task 2 (effect on activeSentenceId + detached, passive scroll listener while detached); testing → Task 1's 8 tests + Task 4 live pass. All spec sections covered.
- **Placeholder scan:** every task has exact code, exact commands, exact expectations.
- **Type consistency:** `NarrationDirection`, `Rect`, and `narrationDirection(viewRect, narrRect, vertical)` are defined in Task 1 and consumed identically in Task 2; the class names `narration-arrow` (Task 2) and `narration-btn` (Task 3) match across tasks.
