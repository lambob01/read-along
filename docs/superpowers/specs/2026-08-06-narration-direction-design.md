# Directional Narration Button Design

**Date:** 2026-08-06
**Status:** Approved (user)

## Goal

The reader's floating "Narration" button (shown when the reader is detached from the narration) animates in once when it appears, and its arrow points toward where the narration actually is — up, down, left or right — with the arrow visibly rotating when the direction changes. No persistent animation while the button is visible.

## Current State

`src/routes/read/[itemId]/+page.svelte:2056-2075` renders a pill button (bottom-right, above the player bar) when `readAlong && detached && $reader.cueIndex`. Its arrow always points **down**, regardless of where the narration is. `narrationSentenceId()` (line 672) already resolves the narration's sentence id; `epubRender.elementFor(id)` / `$reader.sentenceMap.get(id)` resolve its element.

## Direction Logic

While the button is visible, compare the narration element's rect against the scroller viewport rect:

| Narration position | Horizontal text | Vertical text (vertical-rl) |
| --- | --- | --- |
| Before the viewport (already read) | Arrow **up** | Arrow **right** (behind) |
| After the viewport (ahead) | Arrow **down** | Arrow **left** (further along) |
| Element unmounted / on-screen | **down** (default, forward) | **left** (default, forward) |

Under `vertical-rl` reading advances leftwards, so "further along" is left and "behind" is right.

Extracted as a pure function for testing:

```ts
export type NarrationDirection = 'up' | 'down' | 'left' | 'right';

export function narrationDirection(
	viewRect: DOMRect,
	narrRect: DOMRect | null,
	vertical: boolean
): NarrationDirection
```

Returns the default forward direction when `narrRect` is null (unmounted chapter) or when the narration is inside the viewport.

## Arrow Rotation Animation

The arrow SVG is wrapped in a span; the direction maps to a CSS rotation of the SVG:
`down` = 0°, `up` = 180°, `left` = +90°, `right` = −90° (the base SVG points down). A ~200ms `transition: transform` on the wrapper makes a direction change swing the arrow visibly.

## Appear Animation

The button's container gets a CSS keyframe animation (fade in + ~8px translate toward the button's resting spot) that runs **once on mount**. Because the button is conditionally rendered (`{#if detached ...}`), it remounts every time it appears and the animation naturally re-runs; nothing repeats while it stays visible. Animation is in `src/app.css` (or a scoped block in the page) and respects `prefers-reduced-motion` by being disabled there.

## Reactivity

`narrationDir` is a `$state` updated by two triggers while the button is visible:

1. An `$effect` on `$reader.activeSentenceId` — the narration moved (audio advanced or a seek landed).
2. A `scroll` listener on the scroller, active only while detached — the user scrolled past or back to the narration.

The autoscroller is suspended while detached, so these scrolls are user-initiated; no fight with programmatic scrolling. Each update is two `getBoundingClientRect()` calls.

## Error Handling

- No `cueIndex` → button not rendered (existing condition).
- Narration sentence has no mounted element → default forward direction (function contract).
- Vertical mode toggled while detached → direction recomputes via the effect chain (the vertical flag is read inside the computation).

## Testing

- `narrationDirection` is a pure function in `src/lib/reader/narrationDirection.ts` with unit tests pinning all 9 cells of the table above (up/down/left/right/on-screen/unmounted × horizontal/vertical).
- Page wiring verified with `npm run check` + live check on the dev server: wander away from the narration (button appears with animation, arrow points the right way), scroll past it (arrow flips), jump chapters with `n`/`p` (arrow re-aims), vertical text (arrow points left/right).

## Out of Scope

- Persistent/pulsing animations on the button.
- Animating the button's dismissal.
- Changing the button's position or label.
