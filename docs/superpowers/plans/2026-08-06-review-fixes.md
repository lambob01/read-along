# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every Critical and Important issue found in the 2026-08-06 three-reviewer code review of the read-along app, excluding the Web Worker migration (explicitly deferred by the user).

**Architecture:** Sixteen small, independent fixes across four subsystems (sync/epub parsing, reader/routes, stores, anki), each task TDD'd against the existing vitest projects (`*.test.ts` = node, `*.dom.test.ts` = jsdom, `*.svelte.test.ts` = jsdom + browser conditions) and committed separately. The reader page (`src/routes/read/[itemId]/+page.svelte`) concentrates four of the tasks and is edited in place; the ABS proxy gains a new pure, testable module for its URL resolution.

**Tech Stack:** Svelte 5 (runes), SvelteKit adapter-static, TypeScript, vitest 4 (three projects by filename suffix), jsdom.

## Global Constraints

- All commands run from `reader/` (`/Users/albert/projects/read along/reader`). The path contains a space; quote it.
- Source uses **tabs** for indentation (prettier config). Do not reformat unrelated code.
- Tests: `npx vitest run <path>`; type-check: `npm run check`; format check: `npm run lint` (prettier).
- Commit message style (from `git log`): imperative sentence, no conventional-commit prefix, e.g. `Stop failed reader pages recording bogus recent entries`.
- `requireAssertions: true` is set in vite.config.ts — every test MUST contain an `expect`.
- Do NOT bump `ALGORITHM_VERSION` in `src/lib/epub/cache.ts` for any task in this plan: none of them changes the alignment algorithm, and the cached data is already clean.
- Do not modify the singleton `player` store's public API shape (function names/signatures used by routes stay stable; internal behavior changes are allowed).
- The Web Worker migration is OUT OF SCOPE (deferred). The connection-screen URL field is being REMOVED (user decision).
- Read-only review rule: reviewers and implementers must never mutate files outside their task's list.

---

### Task 1: Normalize CRLF and BOM in cue parsing

**Files:**

- Modify: `src/lib/sync/parse.ts:106-111` (`parseCues`)
- Test: `src/lib/sync/sync.test.ts` (append a `describe('parseCues line endings')` block)

**Interfaces:**

- Consumes: `parseVTT`, `parseSRT`, `WEBVTT_HEADER` (already in file)
- Produces: unchanged `parseCues(raw: string): RawCue[]` signature — SRT/VTT files with `\r\n` line endings or a leading BOM now parse as multiple cues instead of collapsing into one garbage cue

**Why:** The SRT regex and VTT splitter both require literal `\n\n`; Windows-edited files (Aegisub, Subtitle Edit, subtitle download sites) use `\r\n` and contain no `\n\n` sequence, so the entire file became a single cue. A leading `\uFEFF` (BOM) breaks the `WEBVTT` header test.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/sync/sync.test.ts`:

```ts
describe('parseCues line endings', () => {
	const srt = `1\r\n00:00:01,000 --> 00:00:02,500\r\nHello world\r\n\r\n2\r\n00:00:03,000 --> 00:00:05,000\r\nHow are you?`;

	it('parses CRLF SRT files as multiple cues', () => {
		const cues = parseCues(srt);
		expect(cues).toHaveLength(2);
		expect(cues[0].text).toBe('Hello world');
		expect(cues[1].text).toBe('How are you?');
	});

	it('parses CRLF VTT files as multiple cues', () => {
		const vtt = `WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.500\r\nFirst cue\r\n\r\n00:00:03.000 --> 00:00:05.000\r\nSecond cue`;
		const cues = parseCues(vtt);
		expect(cues).toHaveLength(2);
		expect(cues[0].text).toBe('First cue');
		expect(cues[1].text).toBe('Second cue');
	});

	it('strips a leading BOM before sniffing the format', () => {
		const cues = parseCues(`\uFEFF${srt}`);
		expect(cues).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sync/sync.test.ts`
Expected: the three new tests FAIL (each yields 1 cue, not 2).

- [ ] **Step 3: Implement the normalization**

In `src/lib/sync/parse.ts`, replace `parseCues`:

```ts
export function parseCues(raw: string): RawCue[] {
	// Subtitle tools on Windows write \r\n; the SRT regex and VTT splits both
	// need \n\n to separate cues, and a CRLF file contains none — it parsed
	// as one cue holding the whole file. A BOM likewise breaks the WEBVTT
	// sniff. Normalize once, here, so both parsers see a canonical form.
	const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
	if (WEBVTT_HEADER.test(normalized.trimStart())) {
		return parseVTT(normalized);
	}
	return parseSRT(normalized);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sync/sync.test.ts`
Expected: all tests PASS, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/parse.ts src/lib/sync/sync.test.ts
git commit -m "Parse CRLF and BOM subtitle files as real cues"
```

---

### Task 2: Sanitize cloned EPUB content in `cloneForRender`

**Files:**

- Modify: `src/lib/reader/epubRenderer.ts:4-22` (`DROP_ATTRS`, `cloneForRender`)
- Test: `src/lib/reader/epubRenderer.dom.test.ts` (append a describe block)

**Interfaces:**

- Consumes: existing `setup()` helper pattern at epubRenderer.dom.test.ts:28-35, `renderEpub`, `alignEpubToCues`, `makeDoc`, `makeCues` (all present)
- Produces: `cloneForRender` no longer copies `on*` attributes or dangerous elements into the live document. No signature changes.

**Why:** A hostile EPUB's `onclick`/`onerror`/`srcdoc`/`<script>`/`<iframe>` attributes and elements survive `cloneForRender` and compile when the clone is inserted into the live document — arbitrary JS in the app's origin, where the ABS token sits in localStorage.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/reader/epubRenderer.dom.test.ts`:

```ts
describe('cloneForRender sanitization', () => {
	it('strips event handler attributes from cloned content', () => {
		const { container, handle, index } = setup(
			['<p onclick="window.pwned = 1" ONCLICK="window.pwned2 = 1">朝が来た。</p>'],
			[['朝が来た。', 0, 2]]
		);
		// Nothing is mounted until a chapter is anchored.
		handle.ensureVisible(index.sentences[0].id);

		container.querySelectorAll('.reader-block').forEach((p) => {
			// `ONCLICK` exercises the case-insensitive strip: XHTML keeps
			// attribute case, and browsers treat event-handler attributes as
			// case-insensitive, so an uppercase variant would still compile.
			// Assert via `getAttributeNames()` — jsdom's `hasAttribute` cannot
			// find case-preserved names on elements adopted from a parsed XML
			// document.
			expect(p.getAttributeNames()).not.toContain('onclick');
			expect(p.getAttributeNames()).not.toContain('ONCLICK');
		});
	});

	it('drops script, iframe and other executable elements', () => {
		const { container, handle, index } = setup(
			[
				'<p>朝が来た。<script>window.pwned = 1</script><iframe src="https://evil.example"></iframe><form action="https://evil.example"></form></p>'
			],
			[['朝が来た。', 0, 2]]
		);
		handle.ensureVisible(index.sentences[0].id);

		expect(container.querySelector('script')).toBeNull();
		expect(container.querySelector('iframe')).toBeNull();
		expect(container.querySelector('form')).toBeNull();
	});

	it('strips srcdoc and src attributes', () => {
		const { container, handle, index } = setup(
			['<p>朝が来た。<video src="https://evil.example"></video></p>'],
			[['朝が来た。', 0, 2]]
		);
		handle.ensureVisible(index.sentences[0].id);

		container.querySelectorAll('.reader-block [src]').forEach((el) => {
			expect(el.hasAttribute('src')).toBe(false);
		});
	});
```

Note: `alignEpubToCues` normalizes text that includes `<script>`; the sanitizer runs on the _rendered_ clone, so the paragraph still wraps. If `window.pwned` gets set by the script tag during the test's `setup`, the test failing is the point — do not run the existing suite until Step 3.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reader/epubRenderer.dom.test.ts`
Expected: new tests FAIL (attributes still present, or the window property got set).

- [ ] **Step 3: Implement the sanitization**

In `src/lib/reader/epubRenderer.ts`, replace the top-of-file constants and `cloneForRender`:

```ts
/** Attributes stripped from cloned EPUB nodes. */
const DROP_ATTRS = ['style', 'class', 'id', 'width', 'height', 'align'];
/** Attributes that can smuggle code into the document. */
const DROP_CODE_ATTRS = ['srcdoc', 'src', 'srcset', 'formaction', 'data', 'poster'];
/**
 * Elements whose presence in a book is executable or form-submitting. Books
 * are downloaded from the web; an EPUB's own markup must not run in this
 * app's origin, where the ABS token lives.
 */
const DROP_ELEMENTS = new Set([
	'SCRIPT',
	'IFRAME',
	'OBJECT',
	'EMBED',
	'VIDEO',
	'AUDIO',
	'FORM',
	'LINK',
	'STYLE',
	'BASE',
	'META'
]);

/**
 * Clones an EPUB element for rendering, discarding publication styling so the
 * reader's own theme stays authoritative, while keeping semantic markup
 * (emphasis, ruby, headings) that the subtitle path used to throw away.
 *
 * The clone is also sanitized: inline event handlers and executable elements
 * come from the book file, not from this app, and must not compile here.
 */
function cloneForRender(el: Element): HTMLElement {
	const clone = el.cloneNode(true) as HTMLElement;
	const all: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
	for (const node of all) {
		for (const attr of DROP_ATTRS) node.removeAttribute(attr);
		// Snapshot the attributes: removing them while iterating is fine, but
		// `attributes` is live.
		for (const attr of Array.from(node.attributes)) {
			// Case-insensitive: XHTML keeps attribute case (ONCLICK survives
			// the XML parser) and browsers treat event-handler content
			// attributes as ASCII case-insensitive, so a hostile book only
			// needs to uppercase the name to evade a lowercase match.
			const name = attr.name.toLowerCase();
			if (name.startsWith('on') || DROP_CODE_ATTRS.includes(name)) {
				node.removeAttribute(attr.name);
			}
		}
		// Images inside an EPUB reference zip-internal paths that will not
		// resolve; drop them rather than render broken placeholders.
		if (node.tagName === 'IMG' || node.tagName === 'SVG') node.remove();
		if (DROP_ELEMENTS.has(node.tagName)) node.remove();
	}
	return clone;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reader/epubRenderer.dom.test.ts`
Expected: all tests PASS, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/epubRenderer.ts src/lib/reader/epubRenderer.dom.test.ts
git commit -m "Sanitize executable markup out of cloned EPUB content"
```

---

### Task 3: Origin-check the ABS proxy target

**Files:**

- Create: `src/lib/abs/proxy-target.ts`
- Create: `src/lib/abs/proxy-target.test.ts`
- Modify: `src/routes/abs/[...path]/+server.ts:35-44` (`proxy`)

**Interfaces:**

- Consumes: nothing
- Produces: `resolveProxyTarget(origin: string, path: string, search: string): URL | null` — returns the target URL when `path` resolves to the same origin as `origin`, otherwise `null`

**Why:** `GET /abs//evil.example/x` captures `path = "/evil.example/x"`, and `new URL('//evil.example/x', ABS_ORIGIN)` is scheme-relative — it resolves to `http://evil.example/x` and the proxy forwards the user's Bearer token there. The scheme-relative form is valid in `new URL`, so the only reliable guard is comparing the resolved origin.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/abs/proxy-target.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveProxyTarget } from '$lib/abs/proxy-target';

describe('resolveProxyTarget', () => {
	it('resolves a normal API path against the origin', () => {
		// The route consumes one slash, so normal requests arrive WITHOUT a
		// leading slash ("api/items/1"); only the attack (a double slash in
		// the URL) retains one.
		const target = resolveProxyTarget('http://localhost:13378', 'api/items/1', 'token=abc');
		expect(target).not.toBeNull();
		expect(target!.href).toBe('http://localhost:13378/api/items/1?token=abc');
	});

	it('rejects a path that resolves to a foreign origin', () => {
		// /abs//evil.example/x arrives as path "/evil.example/x" — the
		// template then builds a scheme-relative URL, which new URL()
		// happily resolves to the foreign host.
		expect(resolveProxyTarget('http://localhost:13378', '/evil.example/x', '')).toBeNull();
		expect(resolveProxyTarget('http://localhost:13378', '//evil.example/x', '')).toBeNull();
	});

	it('accepts an ordinary same-origin path', () => {
		expect(resolveProxyTarget('http://localhost:13378', 'x', '')).not.toBeNull();
	});

	it('preserves the query string', () => {
		const target = resolveProxyTarget('https://abs.example', 'api/items/2/cover', 'token=xyz');
		expect(target!.search).toBe('?token=xyz');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/abs/proxy-target.test.ts`
Expected: FAIL with "Cannot find module" (file does not exist yet).

- [ ] **Step 3: Implement the resolver**

Create `src/lib/abs/proxy-target.ts`:

```ts
/**
 * Resolves a proxy path against the fixed ABS origin, refusing anything that
 * would escape it.
 *
 * The route param carries a leading slash, so a request for
 * `/abs//evil.example/x` arrives as the path `/evil.example/x`, and the
 * template literal form `/${path}` turns that into a scheme-relative URL that
 * `new URL` resolves to a *foreign* host. An origin comparison after
 * resolution is the only check that catches every spelling.
 */
export function resolveProxyTarget(origin: string, path: string, search: string): URL | null {
	const target = new URL(`/${path}`, origin);
	if (target.origin !== new URL(origin).origin) return null;
	target.search = search;
	return target;
}
```

- [ ] **Step 4: Wire it into the proxy**

In `src/routes/abs/[...path]/+server.ts`:

1. Add the import at the top:

```ts
import { resolveProxyTarget } from '$lib/abs/proxy-target';
```

2. Replace the top of `proxy` (lines 40-43):

```ts
const target = resolveProxyTarget(ABS_ORIGIN, params.path, new URL(request.url).search);
if (!target) {
	return new Response(JSON.stringify({ error: 'Bad proxy path' }), { status: 400 });
}
```

3. Delete the now-unused line `const url = new URL(request.url);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/abs/proxy-target.test.ts && npm run check`
Expected: new tests PASS; `svelte-check` passes (no unused `url` variable).

- [ ] **Step 6: Commit**

```bash
git add src/lib/abs/proxy-target.ts src/lib/abs/proxy-target.test.ts src/routes/abs/[...path]/+server.ts
git commit -m "Refuse ABS proxy paths that resolve off the configured origin"
```

---

### Task 4: Reset player state on source change; fix skipForward and bookmark parsing

**Files:**

- Modify: `src/lib/stores/player.ts:60-67` (`loadBookmarks`), `:128-132` (`skipForward`), `:136-143` (`setSrc`)
- Test: `src/lib/stores/player.test.ts` (replace/extend)

**Interfaces:**

- Consumes: `clampSeek` (already exported), `update` from the store
- Produces: unchanged public API. Behavior: `setSrc` zeroes `currentTime`/`duration`/`playing` synchronously; `skipForward` passes an unknown duration through; `loadBookmarks` returns `{}` for non-object JSON

**Why (three bugs):**

1. `setSrc` leaves the old book's `currentTime` in the store until the new source's first `timeupdate` — many seconds, or forever if the user never presses play. The reader's bookmark interval and onDestroy save then write book A's position as book B's bookmark.
2. `skipForward` clamps against `a.duration || 0` — a not-yet-loaded duration (NaN) reads as 0, rewinding to the start. The exact bug `clampSeek`'s comment documents.
3. `loadBookmarks` parses `'null'` or `'"x"'` successfully, then `bookmarks[itemId]` in `getBookmark` throws a TypeError, crashing the book details page.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/lib/stores/player.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { clampSeek } from '$lib/stores/player';

function makeLocalStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

/** Minimal HTMLAudioElement stand-in. */
class FakeAudio {
	currentTime = 0;
	duration = NaN;
	paused = true;
	playbackRate = 1;
	preservesPitch = true;
	src = '';
	dataset: Record<string, string> = {};
	readyState = 0;
	loadCalls = 0;
	listeners = new Map<string, Set<() => void>>();
	load() {
		this.loadCalls++;
	}
	addEventListener(type: string, fn: () => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(fn);
	}
	removeEventListener(type: string, fn: () => void) {
		this.listeners.get(type)?.delete(fn);
	}
	dispatchEvent(event: Event) {
		for (const fn of this.listeners.get(event.type) ?? []) fn();
		return true;
	}
}

beforeEach(() => {
	vi.stubGlobal('localStorage', makeLocalStorage());
	vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('clampSeek', () => {
	it('passes the target through when it is inside a known duration', () => {
		expect(clampSeek(1200, 1800)).toBe(1200);
	});

	it('clamps to the end once the duration is known', () => {
		expect(clampSeek(9999, 1800)).toBe(1800);
	});

	it('keeps the target when the duration is not known yet', () => {
		expect(clampSeek(1200, NaN)).toBe(1200);
		expect(clampSeek(1200, 0)).toBe(1200);
		expect(clampSeek(1200, Infinity)).toBe(1200);
	});

	it('floors negative and non-finite targets at the start', () => {
		expect(clampSeek(-5, 1800)).toBe(0);
		expect(clampSeek(NaN, 1800)).toBe(0);
	});
});

describe('player store', () => {
	it('resets playback state when the source changes', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.setSrc('book-a.mp3');
		// The store follows the element via timeupdate; simulate book A having
		// actually played to 42s before the source changes. Without the event
		// the store never holds the old position and the test passes pre-fix.
		const a = player.getAudioElement() as unknown as FakeAudio;
		a.currentTime = 42;
		a.duration = 300;
		a.dispatchEvent(new Event('timeupdate'));

		player.setSrc('book-b.mp3');

		const s = get(player);
		// Between setSrc and the new source's first timeupdate the store must
		// not claim book A's position — the bookmark interval would persist it
		// under book B.
		expect(s.currentTime).toBe(0);
		expect(s.duration).toBe(0);
		expect(s.playing).toBe(false);
	});

	it('skipForward does not rewind while the duration is unknown', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		const a = player.getAudioElement() as unknown as FakeAudio;
		a.currentTime = 100;
		a.duration = NaN;
		player.skipForward(10);
		// The regression: `Math.min(a.duration || 0, ...)` turned the unknown
		// duration into a clamp to zero — skipping forward during a slow
		// metadata load rewound the book to the start.
		expect(a.currentTime).toBe(110);
	});

	it('skipForward clamps to the end once the duration is known', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		const a = player.getAudioElement() as unknown as FakeAudio;
		a.currentTime = 25;
		a.duration = 30;
		player.skipForward(10);
		expect(a.currentTime).toBe(30);
	});

	it('treats non-object bookmarks JSON as empty', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		localStorage.setItem('reader-bookmarks', 'null');
		expect(player.getBookmark('book-1')).toBeNull();
		localStorage.setItem('reader-bookmarks', '"a string"');
		expect(player.getBookmark('book-1')).toBeNull();
		localStorage.setItem('reader-bookmarks', '[1,2]');
		expect(player.getBookmark('book-1')).toBeNull();
	});

	it('round-trips a bookmark', async () => {
		vi.resetModules();
		const { player } = await import('$lib/stores/player');

		player.saveBookmark('book-1', 123.5);
		expect(player.getBookmark('book-1')).toBe(123.5);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/stores/player.test.ts`
Expected: the three new behavior tests FAIL (stale currentTime; skipForward sets 0; `getBookmark('book-1')` throws TypeError).

- [ ] **Step 3: Implement the fixes**

In `src/lib/stores/player.ts`:

1. Replace `loadBookmarks`:

```ts
function loadBookmarks(): Record<string, number> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const parsed = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '{}');
		// JSON.parse('null') or JSON.parse('"x"') succeed but are not the
		// object the callers index into; without the shape check,
		// getBookmark throws a TypeError and the details page dies.
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, number>)
			: {};
	} catch {
		return {};
	}
}
```

2. Replace `skipForward`:

```ts
		skipForward(seconds: number = 10) {
			withAudio((a) => {
				a.currentTime = clampSeek(a.currentTime + seconds, a.duration);
			}, undefined);
		},
```

3. Add the state reset at the top of `setSrc`:

```ts
		setSrc(url: string) {
			currentSrc = url;
			// The store keeps the previous book's position until the new
			// source's first timeupdate — many seconds on a slow remote file,
			// or forever if playback is never pressed — and the reader's
			// bookmark saves would write that stale position under the new
			// book. Zero it the moment the source changes.
			update((s) => ({ ...s, currentTime: 0, duration: 0, playing: false }));
			withAudio((a) => {
				a.src = url;
				a.load();
			}, undefined);
			initEvents();
		},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/stores/player.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stores/player.ts src/lib/stores/player.test.ts
git commit -m "Reset player state on source change, fix skipForward and bookmark parsing"
```

---

### Task 5: Guard the connection store against corrupt storage

**Files:**

- Modify: `src/lib/stores/connection.ts:3-16` (`persisted`)
- Create: `src/lib/stores/connection.test.ts`

**Interfaces:**

- Consumes: `writable` from svelte/store
- Produces: unchanged `connection` store API; `persisted` falls back to the default on corrupt or non-object JSON

**Why:** `persisted` calls `JSON.parse` unguarded at module init; corrupt-but-valid JSON under `reader-connection` throws during module evaluation and white-screens the app. Every other persisted store in the app try/catches.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/stores/connection.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';

function makeLocalStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('connection store persistence', () => {
	it('falls back to defaults on corrupt storage', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage({ 'reader-connection': '{oops' }));
		const { connection } = await import('$lib/stores/connection');
		expect(get(connection)).toEqual({ url: '', token: '', connected: false });
	});

	it('falls back to defaults when the stored value is not an object', async () => {
		vi.stubGlobal('localStorage', makeLocalStorage({ 'reader-connection': 'null' }));
		const { connection } = await import('$lib/stores/connection');
		expect(get(connection).token).toBe('');
	});

	it('loads a valid stored credential', async () => {
		vi.stubGlobal(
			'localStorage',
			makeLocalStorage({
				'reader-connection': JSON.stringify({ url: '', token: 'abc', connected: true })
			})
		);
		const { connection } = await import('$lib/stores/connection');
		expect(get(connection).token).toBe('abc');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/stores/connection.test.ts`
Expected: FAIL — module import throws `SyntaxError` on `'{oops'`.

- [ ] **Step 3: Implement the guard**

In `src/lib/stores/connection.ts`, replace `persisted`:

```ts
function persisted<T>(key: string, defaultValue: T): Writable<T> {
	// The store is read at module init, so a corrupt value here throws before
	// any UI can catch it — the app white-screens. Every other persisted
	// store in the app wraps its reads the same way.
	let initial: T = defaultValue;
	if (typeof localStorage !== 'undefined') {
		try {
			const parsed = JSON.parse(localStorage.getItem(key) || '');
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				initial = parsed as T;
			}
		} catch {
			/* corrupt storage falls back to the default */
		}
	}

	const store = writable<T>(initial);

	if (typeof localStorage !== 'undefined') {
		store.subscribe((value) => {
			localStorage.setItem(key, JSON.stringify(value));
		});
	}

	return store;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/stores/connection.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stores/connection.ts src/lib/stores/connection.test.ts
git commit -m "Let the connection store survive corrupt storage"
```

---

### Task 6: Guard the subtitle download in `loadTextSource`

**Files:**

- Modify: `src/lib/epub/source.ts:38-57` (`loadTextSource` signature + subtitle fetch)
- Create: `src/lib/epub/source.dom.test.ts`

**Interfaces:**

- Consumes: `ABSClient`, `ItemSources`, `getFileText` (unchanged)
- Produces: `loadTextSource(client, itemId, sources?, fetchFileText = getFileText)` — the optional last parameter is the test seam; the failure path now returns `{ mode: 'none', ..., notice }` instead of rejecting

**Why:** `getFileText` is the one network call in the function not wrapped in try/catch; a transient failure rejects the whole promise while every sibling path degrades gracefully with a notice.

- [ ] **Step 1: Write the failing test**

Create `src/lib/epub/source.dom.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { loadTextSource } from '$lib/epub/source';
import type { ABSClient } from '$lib/abs/client';

const client = {} as ABSClient;

const sources = {
	subIno: '10',
	subSize: 100,
	epubIno: null,
	epubSize: null
};

describe('loadTextSource', () => {
	it('degrades to no-source with a notice when the subtitle download fails', async () => {
		const fetchFileText = vi.fn().mockRejectedValue(new Error('network down'));
		const source = await loadTextSource(client, 'item-1', sources, fetchFileText);

		expect(source.mode).toBe('none');
		expect(source.notice).toContain('Subtitle');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/epub/source.dom.test.ts`
Expected: FAIL with a rejected promise (`network down`).

- [ ] **Step 3: Implement the guard**

In `src/lib/epub/source.ts`:

1. Change the signature (line 38-42):

```ts
export async function loadTextSource(
	client: ABSClient,
	itemId: string,
	sources?: ItemSources,
	fetchFileText: (
		client: ABSClient,
		itemId: string,
		ino: string
	) => Promise<string> = getFileText
): Promise<TextSource> {
```

2. Replace the unguarded fetch (line 56) with:

```ts
let raw: string;
try {
	raw = await fetchFileText(client, itemId, found.subIno);
} catch (err) {
	return {
		mode: 'none',
		doc: null,
		index: null,
		cues: null,
		fromCache: false,
		notice: `Subtitle could not be downloaded (${
			err instanceof Error ? err.message : 'unknown error'
		}); no transcript.`
	};
}
const cues = parseCues(raw);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/epub/source.dom.test.ts && npm run check`
Expected: test PASSES; `svelte-check` passes (the default parameter's type is compatible — `getFileText` has the same shape).

- [ ] **Step 5: Commit**

```bash
git add src/lib/epub/source.ts src/lib/epub/source.dom.test.ts
git commit -m "Degrade to no-source when the subtitle download fails"
```

---

### Task 7: Re-derive timing invariants in `rebuildIndex`

**Files:**

- Modify: `src/lib/epub/cache.ts:109-134` (`rebuildIndex`)
- Test: `src/lib/epub/cache.test.ts` (append a describe block)

**Interfaces:**

- Consumes: `AlignedIndex`, `AlignedSentence` types
- Produces: unchanged `rebuildIndex(cached: CachedAlignment): AlignedIndex` — but the arrays are now overlap-free and positive-width, matching what `finalize` in `align.ts:382-418` produces, so the doc comment is honest

**Why:** The comment claims "the same ordering and non-overlap guarantees the aligner enforces are re-derived here", but the code only sorts. It is safe today only because `saveAlignment` always stores a `finalize`d index; the claim must either be true or the comment must go. Make it true.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/epub/cache.test.ts` (read the file first and match its existing helper style for building a `CachedAlignment`):

```ts
describe('rebuildIndex invariants', () => {
	it('excludes zero-width timed sentences from the arrays', () => {
		const index = rebuildIndex({
			key: 'k',
			version: 3,
			createdAt: 0,
			blocks: [],
			sentences: [
				{
					id: 0,
					timed: true,
					start: 5,
					end: 5,
					text: 'zero',
					blockId: 0,
					chapterOrder: 0,
					streamStart: 0,
					streamEnd: 0,
					blockOffsetStart: 0,
					blockOffsetEnd: 0
				},
				{
					id: 1,
					timed: true,
					start: 6,
					end: 8,
					text: 'real',
					blockId: 0,
					chapterOrder: 0,
					streamStart: 0,
					streamEnd: 0,
					blockOffsetStart: 0,
					blockOffsetEnd: 0
				}
			],
			stats: { totalSentences: 2, timedSentences: 2, coverage: 1, cueCount: 1, matchedCues: 1 }
		});
		expect(index.timed).toHaveLength(1);
		expect(index.starts[0]).toBe(6);
	});

	it('clamps overlapping ranges forward instead of emitting them', () => {
		const index = rebuildIndex({
			key: 'k',
			version: 3,
			createdAt: 0,
			blocks: [],
			sentences: [
				{
					id: 0,
					timed: true,
					start: 1,
					end: 10,
					text: 'a',
					blockId: 0,
					chapterOrder: 0,
					streamStart: 0,
					streamEnd: 0,
					blockOffsetStart: 0,
					blockOffsetEnd: 0
				},
				{
					id: 1,
					timed: true,
					start: 2,
					end: 4,
					text: 'b',
					blockId: 0,
					chapterOrder: 0,
					streamStart: 0,
					streamEnd: 0,
					blockOffsetStart: 0,
					blockOffsetEnd: 0
				}
			],
			stats: { totalSentences: 2, timedSentences: 2, coverage: 1, cueCount: 1, matchedCues: 1 }
		});
		expect(index.starts[1]).toBeGreaterThanOrEqual(index.ends[0] - 1e-9);
		expect(index.ends[1] - index.starts[1]).toBeLessThan(0.05 + 1e-9);
	});
});
```

(Adjust the `AlignedSentence` literal to whatever fields the current type requires — read `src/lib/types.ts`; include every required field. If `rebuildIndex` is not exported from the module, the test will fail at import; it is exported at cache.ts:114.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/epub/cache.test.ts`
Expected: the new tests FAIL (zero-width sentence present; overlapping ranges un-clamped).

- [ ] **Step 3: Implement the invariants**

In `src/lib/epub/cache.ts`, replace `rebuildIndex`:

```ts
/**
 * Reconstructs the timing arrays from cached sentences, re-deriving the same
 * ordering and non-overlap guarantees `finalize` in align.ts enforces, so a
 * cached index is indistinguishable from a freshly computed one.
 */
export function rebuildIndex(cached: CachedAlignment): AlignedIndex {
	const candidates = cached.sentences
		.filter((s) => s.timed)
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const timed: AlignedSentence[] = [];
	let prevEnd = -Infinity;
	for (const s of candidates) {
		if (s.end <= s.start) continue;
		if (s.start < prevEnd) {
			// Overlaps the previous sentence: clamp forward if that leaves a
			// usable range, otherwise drop it, exactly as finalize does.
			if (s.end - prevEnd < 0.05) continue;
			s.start = prevEnd;
		}
		timed.push(s);
		prevEnd = s.end;
	}

	const starts = new Float64Array(timed.length);
	const ends = new Float64Array(timed.length);
	for (let i = 0; i < timed.length; i++) {
		starts[i] = timed[i].start;
		ends[i] = timed[i].end;
	}

	return {
		blocks: cached.blocks,
		sentences: cached.sentences,
		timed,
		starts,
		ends,
		stats: cached.stats
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/epub/cache.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/epub/cache.ts src/lib/epub/cache.test.ts
git commit -m "Re-derive timing invariants when rebuilding cached alignments"
```

---

### Task 8: Unsubscribe the page-level store subscriptions

**Files:**

- Modify: `src/routes/library/+page.svelte:17-23` + add `onDestroy` import/block
- Modify: `src/routes/book/[itemId]/+page.svelte:27-30` + add `onDestroy` import/block
- Modify: `src/routes/read/[itemId]/+page.svelte:160-173` + teardown in the existing `onDestroy` (line 716)

**Interfaces:**

- Consumes: `connection`, `settings` stores (unchanged)
- Produces: no API changes; subscriptions are torn down on unmount

**Why:** Svelte 5 does not auto-cleanup raw `store.subscribe()` calls (that was legacy `$store` behavior). Every visit to these pages registers a permanent subscriber; the reader is the hot path.

- [ ] **Step 1: Library page**

In `src/routes/library/+page.svelte`:

1. Change the import to `import { onMount, onDestroy } from 'svelte';`
2. Change the subscription block (lines 20-23):

```ts
const unsubConnection = connection.subscribe((s) => {
	connectionUrl = s.url;
	connectionToken = s.token;
});
```

3. Add at the end of the script (after `filteredItems`):

```ts
onDestroy(unsubConnection);
```

- [ ] **Step 2: Book details page**

In `src/routes/book/[itemId]/+page.svelte`:

1. Change the import to `import { onMount, onDestroy } from 'svelte';`
2. Change the subscription block (lines 28-30):

```ts
const unsubConnection = connection.subscribe((s) => {
	connectionToken = s.token;
});
```

3. Add near the bottom of the script:

```ts
onDestroy(unsubConnection);
```

- [ ] **Step 3: Reader page**

In `src/routes/read/[itemId]/+page.svelte`:

1. Change the subscription block (lines 165-173) to capture the unsubscribers:

```ts
const unsubConnection = connection.subscribe((s) => {
	connectionToken = s.token;
	connectionUrl = s.url;
});

const unsubSettings = settings.subscribe((s) => {
	gapThreshold = s.gapThreshold;
	showNonSpeech = s.showNonSpeech;
});
```

2. In the existing `onDestroy` (which starts at line 716), add as its first lines:

```ts
unsubConnection();
unsubSettings();
```

- [ ] **Step 4: Verify**

Run: `npm run check && npx vitest run src/lib/sync/effect-wiring.svelte.test.ts`
Expected: type-check passes; the effect-wiring suite still passes (it pins the reader's controller-wiring shape, which is untouched here).

- [ ] **Step 5: Commit**

```bash
git add src/routes/library/+page.svelte "src/routes/book/[itemId]/+page.svelte" "src/routes/read/[itemId]/+page.svelte"
git commit -m "Unsubscribe page-level store subscriptions on unmount"
```

---

### Task 9: Make the reader's settings sheet keyboard accessible

**Files:**

- Modify: `src/routes/read/[itemId]/+page.svelte`

**Interfaces:**

- Consumes: existing `showSettings` state, the settings button (line ~1551), the sheet markup (lines 2081-2119)
- Produces: the sheet has `aria-modal="true"`, closes on Escape, focuses its close button on open, and returns focus to the settings trigger on close

**Why:** `role="dialog"` without `aria-modal`, no focus management, no Escape handling. Screen-reader and keyboard users cannot leave the dialog predictably.

- [ ] **Step 1: Add state and refs**

In the script, near the other `show*` states (after line 45):

```ts
let settingsCloseBtn = $state<HTMLButtonElement>();
let settingsTriggerEl: HTMLElement | null = null;
```

- [ ] **Step 2: Wire focus into effects**

Add next to the other controller-pushing effects (after the `$effect` at line 417, for example):

```ts
// The sheet is a dialog: focus moves in on open and back out on close.
$effect(() => {
	if (showSettings) {
		settingsCloseBtn?.focus();
	} else if (settingsTriggerEl instanceof HTMLElement) {
		settingsTriggerEl.focus();
	}
});
```

- [ ] **Step 3: Capture the trigger element**

On the settings button (line ~1551), change:

```ts
					<button
						onclick={() => (showSettings = !showSettings)}
```

to:

```ts
					<button
						onclick={() => {
							if (!showSettings) settingsTriggerEl = document.activeElement;
							showSettings = !showSettings;
						}}
```

- [ ] **Step 4: Mark the dialog and handle Escape**

In the sheet markup (lines 2081-2087), change the outer div to:

```ts
		{#if showSettings}
			<div
				class="fixed inset-0 z-50 flex justify-end"
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
				onkeydown={(e) => {
					if (e.key === 'Escape') showSettings = false;
				}}
			>
```

- [ ] **Step 5: Bind the close button**

On the sheet's header close button (line ~2093), add `bind:this={settingsCloseBtn}`:

```ts
						<button
							bind:this={settingsCloseBtn}
							onclick={() => (showSettings = false)}
							class="rounded p-1 text-[var(--muted)] hover:text-[var(--fg)]"
							aria-label="Close"
						>
```

- [ ] **Step 6: Verify**

Run: `npm run check`
Expected: type-check passes.

- [ ] **Step 7: Commit**

```bash
git add "src/routes/read/[itemId]/+page.svelte"
git commit -m "Make the reader settings sheet keyboard accessible"
```

---

### Task 10: Time out AnkiConnect calls

**Files:**

- Modify: `src/lib/anki/connect.ts:31-62` (`invoke`)
- Create: `src/lib/anki/connect.test.ts`

**Interfaces:**

- Consumes: `AnkiError`, `AnkiTarget` (unchanged)
- Produces: `invoke` aborts after 10s; an abort surfaces as `AnkiError` with kind `'unreachable'`, the same message users already get for an unreachable Anki

**Why:** Capture has timeouts on every step that can hang; the Anki calls have none. A firewall that drops SYNs leaves the Mine button spinning with `mining` stuck true until the browser's multi-minute fetch default.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/anki/connect.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ankiVersion, AnkiError } from '$lib/anki/connect';

const TARGET = { url: 'http://localhost:8765' };

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('ankiVersion', () => {
	it('returns the version from a healthy AnkiConnect', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ result: 6, error: null })
			})
		);
		await expect(ankiVersion(TARGET)).resolves.toBe(6);
	});

	it('gives up after the timeout when Anki never answers', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: RequestInit) => {
				// Without a signal the old code never aborts: the promise must
				// stay pending forever, so the test fails by vitest's own
				// timeout pre-fix rather than passing for the wrong reason.
				if (!init.signal) return new Promise(() => {});
				const signal = init.signal as AbortSignal;
				return new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('Aborted')));
				});
			})
		);

		const promise = ankiVersion(TARGET);
		vi.advanceTimersByTime(10_000);
		await expect(promise).rejects.toMatchObject({ kind: 'unreachable' });
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/anki/connect.test.ts`
Expected: the first test PASSES (baseline); the second FAILS (hangs until vitest's own timeout).

- [ ] **Step 3: Implement the timeout**

In `src/lib/anki/connect.ts`, add a constant near `ANKI_VERSION`:

```ts
/** How long to wait for AnkiConnect before declaring it unreachable. */
const REQUEST_TIMEOUT_MS = 10000;
```

Replace the fetch section of `invoke`:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

let res: Response;
try {
	res = await fetch(target.url, {
		method: 'POST',
		// No custom headers: anything beyond a simple request makes the
		// browser preflight, and AnkiConnect answers OPTIONS only for
		// origins already in webCorsOriginList.
		body: JSON.stringify(body),
		signal: controller.signal
	});
} catch {
	// An abort and a refused connection are the same failure to the user:
	// AnkiConnect never answered.
	throw new AnkiError(
		`Could not reach Anki at ${target.url}. Check that Anki is open with AnkiConnect installed, and that this site's address is in AnkiConnect's webCorsOriginList.`,
		'unreachable'
	);
} finally {
	clearTimeout(timer);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/anki/connect.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/anki/connect.ts src/lib/anki/connect.test.ts
git commit -m "Time out AnkiConnect requests instead of hanging the Mine button"
```

---

### Task 11: Cap the length of a mined segment

**Files:**

- Modify: `src/lib/anki/capture.ts` (add `MAX_SEGMENT_SECONDS`, extend `CaptureFailure`, add the check in `captureRange`)
- Test: `src/lib/anki/capture.test.ts` (append a describe block)

**Interfaces:**

- Consumes: `CaptureError` (unchanged constructor)
- Produces: `CaptureFailure` gains `'too-long'`; `captureRange` rejects before touching the audio graph when the range exceeds 5 minutes

**Why:** A misaligned book can produce a "sentence" minutes long; the stall timeout only fires when the playhead _stops_, and a line whose end lands hours ahead records hours — ~345 MB for 30 minutes of 48 kHz Float32, a tab crash for longer.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/anki/capture.test.ts`:

```ts
describe('captureRange length cap', () => {
	it('rejects a segment longer than the cap before touching audio', async () => {
		const { captureRange } = await import('$lib/anki/capture');
		await expect(captureRange('x', 0, 10_000)).rejects.toMatchObject({ reason: 'too-long' });
	});
});
```

Note: `captureRange` must be checked _before_ `audioContext()` is reached, or the node test fails on a missing `AudioContext` instead of the cap. `audioContext()` is called at capture.ts:386, after the empty-range check at :384; insert the cap between them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/anki/capture.test.ts`
Expected: FAIL — the promise resolves/rejects with `AudioContext is not defined` (or hangs) rather than `reason: 'too-long'`.

- [ ] **Step 3: Implement the cap**

In `src/lib/anki/capture.ts`:

1. Add near the other constants (after `STALL_TIMEOUT_MS`, line 30):

```ts
/**
 * Longest segment a mine will record. A sentence is seconds long, so this is
 * generous; its purpose is to stop a misaligned book recording a line whose
 * end landed minutes or hours away — at 48 kHz Float32 a 30-minute capture is
 * ~345 MB, and a longer one crashes the tab.
 */
const MAX_SEGMENT_SECONDS = 300;
```

2. Extend the union (line 74):

```ts
export type CaptureFailure =
	'unavailable' | 'load-failed' | 'stalled' | 'blocked' | 'empty' | 'too-long';
```

3. Insert the check in `captureRange` between the existing empty-range check and `const c = audioContext();`:

```ts
if (to - from > MAX_SEGMENT_SECONDS) {
	throw new CaptureError(
		'too-long',
		`That line is ${Math.round(to - from)}s long — over the ${MAX_SEGMENT_SECONDS}s mining cap. Check the alignment and try a shorter line.`
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/anki/capture.test.ts && npm run check`
Expected: all tests PASS; type-check passes (the union extension is exhaustive where `CaptureFailure` is consumed — check `mine.ts` and the reader page's error rendering compile).

- [ ] **Step 5: Commit**

```bash
git add src/lib/anki/capture.ts src/lib/anki/capture.test.ts
git commit -m "Cap mined segments at five minutes"
```

---

### Task 12: Make the offsets corrupt-storage test real

**Files:**

- Modify: `src/lib/stores/offsets.test.ts:77-80`

**Interfaces:**

- Consumes: `offsets.hydrate()` (already public)
- Produces: no production changes — the test now exercises the corrupt-storage path it claims to cover

**Why:** The test corrupts localStorage but never calls `hydrate()` afterwards; `offsets.get` reads the in-memory `current`, so the test passes even if `load()` threw on the corrupt JSON. It was asserting "a cleared entry returns null".

- [ ] **Step 1: Fix the test**

Replace the `survives corrupt storage` test (lines 77-80):

```ts
it('survives corrupt storage', () => {
	localStorage.setItem('reader-offsets', 'not json');
	offsets.hydrate();
	expect(offsets.get('book-1')).toBeNull();
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/lib/stores/offsets.test.ts`
Expected: PASS — and now for the right reason: `hydrate()` → `load()` → try/catch → `{}`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/stores/offsets.test.ts
git commit -m "Exercise the corrupt-storage path in the offsets store test"
```

---

### Task 13: Remove the dead server-URL field from the connection screen

**Files:**

- Modify: `src/routes/+page.svelte` (form + `handleConnect`)
- Modify: `src/lib/stores/connection.ts` (`connect` signature)
- Modify: `src/routes/library/+page.svelte` (gate)
- Modify: `src/routes/read/[itemId]/+page.svelte` (dead `connectionUrl` assignment)

**Interfaces:**

- Consumes: `connection.connect` call sites (grep: only `src/routes/+page.svelte:58`)
- Produces: `connection.connect(token: string)` — the persisted `url` field stays in the state shape (backwards-compatible storage) but is always `''`

**Why:** Every client request goes through the fixed `/abs` proxy targeting build-time `PUBLIC_ABS_ORIGIN`; the entered URL is never used or validated. It is misleading UI plus persisted state that can only lie.

- [ ] **Step 1: Change the store**

In `src/lib/stores/connection.ts`, replace `connect`:

```ts
		connect(token: string) {
			set({ url: '', token, connected: true });
		},
```

(`url` remains in the state shape so stored blobs from before the removal still load; it is always empty now.)

- [ ] **Step 2: Trim the root page**

In `src/routes/+page.svelte`:

1. Remove `let url = $state('');` (line 8) and `url = stored.url;` (line 27).
2. In `handleConnect`, change line 58 to `connection.connect(token.trim());`.
3. Change the catch fallback (line 64) to `error = 'Connection failed. Check your token.';`.
4. Remove the whole URL field block (the `div` wrapping the `label for="url"` + `input id="url"`, lines 105-120).
5. The subtitle under the form (line 98) can stay: "Connect to your Audiobookshelf server" still describes the screen.

- [ ] **Step 3: Trim the library page gate**

In `src/routes/library/+page.svelte`:

1. Remove `connectionUrl` (declaration at line 17, assignment at line 21).
2. Change the gate (line 26) to `if (!connectionToken) {`.

- [ ] **Step 4: Trim the reader page**

In `src/routes/read/[itemId]/+page.svelte`:

1. Remove `let connectionUrl = '';` (line 161) and the `connectionUrl = s.url;` assignment (line 167).

- [ ] **Step 5: Verify**

Run: `rg -n "connectionUrl" src/routes` (expect no matches except nothing) and `npm run check`
Expected: no references to `connectionUrl` or `connect(url` remain; type-check passes.

- [ ] **Step 6: Commit**

```bash
git add src/routes/+page.svelte src/lib/stores/connection.ts src/routes/library/+page.svelte "src/routes/read/[itemId]/+page.svelte"
git commit -m "Drop the dead server-URL field from the connection screen"
```

---

### Task 14: Guard the reader's async onMount against unmount; report missing audio

**Files:**

- Modify: `src/routes/read/[itemId]/+page.svelte` (onMount ~476-593, onDestroy ~716-756, notice markup ~1622-1639)

**Interfaces:**

- Consumes: existing `player`, `reader`, `contentEl`, `sourceNotice` state
- Produces: a `disposed` flag checked after every await in `onMount`; a `noAudioNotice` state shown when the stream session has no track; `player.setSrc('')` stops a stale book's audio when the new one has none

**Why (two bugs):**

1. Nothing in the async `onMount` checks that the component is still mounted. Navigate away while `getItem`/`getStreamSession`/`loadTextSource` is in flight and the continuation runs after `onDestroy`: `player.setSrc` overwrites the _next_ book's audio, and `reader.setCueIndex` repopulates the store after `reader.reset()`.
2. When `directTrack?.contentUrl` is missing there is no error and no notice: the page renders a play button that does nothing, and a stale previous book's audio keeps playing — whose position then gets recorded under this book's id on destroy.

- [ ] **Step 1: Add the flag and the notice state**

Near the other `let` state (after line 158):

```ts
/** Set when the page is torn down; every await in onMount must bail on it. */
let disposed = false;
/** The stream session exists but has no audio track. */
let noAudioNotice = $state(false);
```

- [ ] **Step 2: Set the flag in onDestroy**

As the first statement of the existing `onDestroy` (line 716):

```ts
	onDestroy(() => {
		disposed = true;
		// Only a page that actually loaded its item may record a position. ...
```

- [ ] **Step 3: Guard every await in onMount**

In `onMount` (lines 476-593), after each of these, add the guard:

1. After `const item = await getItem(client, itemId);`:

```ts
if (disposed) return;
reader.setItem(item);
```

2. After `const session = await getStreamSession(client, itemId);`, insert the guard FIRST — before any `setSrc` — then replace the `audioSrc` block:

```ts
if (disposed) return;
const directTrack = session.libraryItem?.media?.tracks?.[0];
const audioSrc = directTrack?.contentUrl;
if (audioSrc) {
	const src = `/abs${audioSrc}?token=${encodeURIComponent(connectionToken)}`;
	player.setSrc(src);
	const bookmark = restart ? 0 : (player.getBookmark(itemId) ?? 0);
	// Waits for metadata rather than guessing at a delay: 500ms was
	// enough on a local file and nowhere near enough for a long book
	// over a remote connection, where the seek landed before the
	// element knew its duration and was discarded.
	if (bookmark > 0) player.seekWhenReady(bookmark);
} else {
	// No track: stop whatever the previous book left playing on the
	// singleton element, or its position gets bookmarked under this
	// book's id on destroy. setSrc('') also zeroes the store's
	// currentTime, which the destroy guard relies on.
	player.setSrc('');
	noAudioNotice = true;
}
```

(The guard must precede the block: a continuation that resolves after the user has moved on would otherwise write this book's `setSrc` over the next book's audio before the check could stop it.)

3. After `source = await loadTextSource(client, itemId);` (the try/catch at lines 527-532), add inside the try, right after the assignment:

```ts
source = await loadTextSource(client, itemId);
if (disposed) return;
```

4. Inside both `requestAnimationFrame` callbacks (lines 555 and 578), change the guard to:

```ts
if (disposed || !contentEl) return;
```

- [ ] **Step 4: Show the notice**

In the notice markup (lines 1622-1631), extend the condition and add a block:

```svelte
			{#if (sourceNotice || noAudioNotice) && $reader.cueIndex}
				<div
					class="reader-notice rounded border border-[var(--muted)] px-3 py-2 text-sm text-[var(--muted)]"
				>
					{noAudioNotice ? 'No audio track found for this item. You can still read the text.' : sourceNotice}
				</div>
```

(The `{#if !$reader.cueIndex}` "No transcript available" block below already covers the no-audio, no-text case, so the notice stays inside the cueIndex guard.)

- [ ] **Step 5: Verify**

Run: `npm run check && npx vitest run src/lib/sync/effect-wiring.svelte.test.ts`
Expected: type-check passes; the controller-wiring suite still passes (this task touches the same file, so re-run it).

- [ ] **Step 6: Commit**

```bash
git add "src/routes/read/[itemId]/+page.svelte"
git commit -m "Stop unmounted reader pages writing over the next book's audio"
```

---

### Task 15: Absorb a terminated cue into its running sentence

**Files:**

- Modify: `src/lib/sync/merge.ts:37-48`
- Test: `src/lib/sync/sync.test.ts` (replace two pinning tests)

**Interfaces:**

- Consumes: `SENTENCE_END_RE` (unchanged)
- Produces: unchanged `mergeCues` signature. Behavior change: a cue whose final punctuation lands mid-utterance (cue A unpunctuated, cue B punctuated) merges into one sentence instead of leaving the opening as a fragment

**Why:** A cue ending in `.`/`。` always started a new sentence even when it was the _end_ of the current utterance ("長い文章が" + "分かれています。" produced a fragment "長い文章が" as its own sentence). The merge stops on the merged text's own punctuation anyway (line 39), so the `nextCue` check only ever produces fragments.

- [ ] **Step 1: Update the two pinning tests**

In `src/lib/sync/sync.test.ts`:

1. Replace the `does not absorb a terminated cue into a running sentence` test (lines 265-278) with:

```ts
it('absorbs a terminated cue into its running sentence', () => {
	// The final cue carries the 。 for the whole utterance; it used to be
	// split off on its own, leaving the opening as a fragment sentence.
	const cues: RawCue[] = [
		{ index: 0, start: 0, end: 1, text: '長い文章が' },
		{ index: 1, start: 1, end: 2, text: '分かれています。' }
	];
	const sentences = mergeCues(cues)[0].sentences;

	expect(sentences).toHaveLength(1);
	expect(sentences[0].text).toBe('長い文章が 分かれています。');
});
```

2. Replace the `assigns correct cueIds to merged sentences` test (lines 280-287) with:

```ts
it('assigns correct cueIds to merged sentences', () => {
	const cues = makeCues('Hello', 'world', 'today.');
	const paragraphs = mergeCues(cues);
	const sentences = paragraphs[0].sentences;
	expect(sentences).toHaveLength(1);
	expect(sentences[0].cueIds).toEqual([0, 1, 2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sync/sync.test.ts`
Expected: the two updated tests FAIL (current code produces the fragments).

- [ ] **Step 3: Implement the change**

In `src/lib/sync/merge.ts`, update the comment above `SENTENCE_END_RE` and remove the `nextCue` break:

```ts
/**
 * Punctuation that ends a sentence. The merge only ever breaks on the text it
 * has already merged (line 39): a cue that happens to end in punctuation is
 * the end of the *current* utterance, so it is merged in and the break fires
 * against the combined text. Breaking on the *next* cue's punctuation instead
 * leaves a fragment behind — the opening of the sentence becomes its own
 * sentence.
 *
 * Covers the Japanese terminators as well as the Latin ones. Without 。 every
 * line of a Japanese transcript looked unterminated, so consecutive cues were
 * merged until an audio gap broke them up — a whole paragraph would light up
 * as one "sentence", and mining it wrote that whole run into the card.
 *
 * The closing brackets stand alone deliberately: Japanese convention omits the
 * full stop before them, so 「そうか」 ends a sentence with no 。 to match.
 */
const SENTENCE_END_RE = /[.!?\u3002\uFF0E\uFF01\uFF1F\u2026\u00BB"」』]$/;
const DIALOGUE_START_RE = /^[-—]/;
```

And in the inner while loop (lines 37-48), remove the `nextCue` punctuation break and add a break for a run that started with non-speech:

```ts
while (cueIdx + 1 < filtered.length) {
	const nextCue = filtered[cueIdx + 1];
	if (SENTENCE_END_RE.test(mergedText.trimEnd())) break;
	// A run that started with a non-speech cue stays on its own: the
	// point of showNonSpeech is seeing [music] lines separately, and
	// the nextCue guard below keeps speech from absorbing them.
	if (isNonSpeech(mergedText.trim())) break;
	if (isNonSpeech(nextCue.text)) break;
	const gap = nextCue.start - mergedEnd;
	if (gap > gapThreshold) break;
	mergedText += ' ' + nextCue.text;
	mergedEnd = nextCue.end;
	mergedCueIds.push(nextCue.index);
	cueIdx++;
}
```

Note: `shows non-speech when option is set` ([music] + Hello., showNonSpeech) must STILL produce 2 sentences — the new non-speech-start break is what keeps it that way while the fragment case merges.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sync/sync.test.ts`
Expected: all tests PASS, including `splits Japanese sentences on 。`, `splits on fullwidth ！ and ？`, `treats a closing bracket as terminal`, `does not merge sentences ending with punctuation` (these all end their _first_ cue in punctuation, which the line-39 break still splits), and `shows non-speech when option is set` (kept at 2 sentences by the non-speech-start break).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/merge.ts src/lib/sync/sync.test.ts
git commit -m "Merge a terminated cue into its running sentence"
```

---

### Task 16: SettingsPanel smoke test + named micro test gaps

**Files:**

- Create: `src/lib/components/settings-panel.svelte.test.ts`
- Modify: `src/lib/sync/repeat.test.ts` (append one test)
- Modify: `src/lib/sync/ticker.dom.test.ts` (append one test)

**Interfaces:**

- Consumes: `mount`/`flushSync` from `svelte`, `settings` store (module singleton — dynamic import after stubbing localStorage), `SettingsPanel` props `{ showSubtitleOptions }`
- Produces: pinned behavior for (a) the reader's most regressible UI component, (b) repeat units with duplicate end times, (c) the ticker's `seek` method

**Why:** The reader page, SettingsPanel, and routes have zero tests; the effect-wiring convention is already proven in `src/lib/sync/effect-wiring.svelte.test.ts`. The reviewer flagged two micro gaps: `repeat.ts`'s `lastReportedEnd` dedupe (exact equality suppresses a second unit ending at the same time — reachable only with damaged input, untested) and the ticker's `seek()` method (only the element's `seeked` event is exercised).

- [ ] **Step 1: SettingsPanel smoke test**

Create `src/lib/components/settings-panel.svelte.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushSync } from 'svelte';

function makeLocalStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, String(v)),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear()
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', makeLocalStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('SettingsPanel', () => {
	it('hides the subtitle options in EPUB mode and shows them otherwise', async () => {
		const { default: SettingsPanel } = await import('./SettingsPanel.svelte');
		const { mount, flushSync } = await import('svelte');

		// Both mounts pin `only: 'sync'` — #gap-threshold lives in the sync
		// section, and the component defaults to the appearance tab, so without
		// pinning the tab the assertion would pass for the wrong reason.
		const epubHost = document.createElement('div');
		mount(SettingsPanel, { target: epubHost, props: { showSubtitleOptions: false, only: 'sync' } });
		flushSync();
		expect(epubHost.querySelector('#gap-threshold')).toBeNull();

		const subtitleHost = document.createElement('div');
		mount(SettingsPanel, {
			target: subtitleHost,
			props: { showSubtitleOptions: true, only: 'sync' }
		});
		flushSync();
		expect(subtitleHost.querySelector('#gap-threshold')).not.toBeNull();
	});

	it('writes a control change into the settings store', async () => {
		const { default: SettingsPanel } = await import('./SettingsPanel.svelte');
		const { mount, flushSync } = await import('svelte');
		const { settings } = await import('$lib/stores/settings');
		const { get } = await import('svelte/store');

		const host = document.createElement('div');
		mount(SettingsPanel, { target: host, props: { showSubtitleOptions: true, only: 'reading' } });
		flushSync();

		// The reading tab's checkboxes are labelled rows; find "Read along" by
		// its label text rather than assuming checkbox order.
		const row = [...host.querySelectorAll('label')].find((l) =>
			l.textContent?.includes('Read along')
		);
		const readAlong = row?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
		expect(readAlong).not.toBeNull();
		readAlong!.checked = true;
		readAlong!.dispatchEvent(new Event('change'));
		flushSync();

		expect(get(settings).readAlong).toBe(true);
	});
});
```

Note: `only: 'reading'` restricts the panel to the reading tab, which contains the "Read along" checkbox (SettingsPanel.svelte:608-616). If the mount complains about missing globals (e.g. `getComputedStyle`), jsdom provides them; if `document.body` is needed by `seedFrom`, it is only called from user actions, not mount.

- [ ] **Step 2: Run the smoke tests to verify they pass**

Run: `npx vitest run src/lib/components/settings-panel.svelte.test.ts`
Expected: PASS (this is a new-coverage test; the component behavior already exists).

- [ ] **Step 3: Pin the repeat dedupe**

Append to `src/lib/sync/repeat.test.ts` (match its existing fixture style — read the file first; it builds `TimingIndex` objects and drives `audio.currentTime` with fake timers):

```ts
	it('does not re-fire a unit whose end exactly equals the last reported end', () => {
		// Only reachable with damaged input (two units sharing an end time),
		// but the suppression is load-bearing: a re-fire would double-pause.
		...
	});
```

Implement the test by following the file's existing playthrough pattern: build an index whose two units both end at the same time, play through the boundary once, assert `onUnitEnd` fired exactly once, and that advancing past the boundary again does not fire a second time.

- [ ] **Step 4: Pin the ticker's seek method**

Append to `src/lib/sync/ticker.dom.test.ts` (follow its existing setup: a stub audio element with a manually-driven RAF queue and fake timers):

```ts
	it('re-samples immediately on a controller seek', () => {
		// The element's `seeked` event is covered elsewhere; this pins the
		// controller's own seek(), which sets the position AND evaluates in
		// the same call.
		...
	});
```

Implement it by creating a controller over an index whose first sentence is [0, 2) and second [5, 7), calling `controller.seek(5.5)` while paused, and asserting `onActivate` was called with the second sentence's id without any timer advance.

- [ ] **Step 5: Run the suites**

Run: `npx vitest run src/lib/sync/repeat.test.ts src/lib/sync/ticker.dom.test.ts src/lib/components`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/settings-panel.svelte.test.ts src/lib/sync/repeat.test.ts src/lib/sync/ticker.dom.test.ts
git commit -m "Add smoke coverage for SettingsPanel and pin repeat and ticker seek behavior"
```

---

### Task 17: Final verification pass

**Files:** none

- [ ] **Step 1: Run the full suite**

Run: `npm run test && npm run check && npm run lint`
Expected: all tests pass; `svelte-check` clean; prettier clean (run `npm run format` first if lint complains about whitespace in edited files).

- [ ] **Step 2: Manual smoke via the verify skill**

Follow `.claude/skills/verify/SKILL.md` (fake Audiobookshelf + AnkiConnect servers) to observe in the real app: the connection screen (no URL field), a book with a CRLF subtitle, mining a sentence (cap + timeout paths are hard to trigger manually — the unit tests cover them), and the settings sheet's Escape/focus behavior.

- [ ] **Step 3: Report**

Summarize the state of every issue from the review (Critical #1-6, Important list) against the plan's tasks, and note the two deferred items (Web Worker migration, reader-page effect tests beyond Task 16).

---

## Deferred (documented, not implemented)

- **Web Worker migration for the alignment pipeline** — user decision, tracked as a follow-up.
- **Full reader-page effect tests** (beyond Task 16's smoke coverage) — the 2,100-line page needs a component-test harness investment; follow-up.
- Minor items from the review are deliberately out of scope: merge.ts paragraph semantics are unchanged, `quotes.ts` eager join, `repeat.ts` interval while disabled, `touch-action: manipulation`, `pagehide` bookmark save, token-in-log, SW offline fallback, recent.ts trimming, `settings.reset` shared reference, SVG/text traversal asymmetry, seek-slider drag stutter, chromeScrollAnim rAF cancellation, `lang` attribute.

## Self-Review

- **Spec coverage:** Critical 1 (XSS) → Task 2; Critical 2 (SSRF) → Task 3; Critical 3 (onMount race) → Task 14; Critical 4 (setSrc stale) → Task 4; Critical 5 (CRLF) → Task 1; Critical 6 (connection parse + bookmarks shape) → Tasks 4+5. Important: unguarded subtitle fetch → Task 6; rebuildIndex claim → Task 7; main-thread blocking → deferred; subscribe leaks → Task 8; dialog a11y → Task 9; AnkiConnect timeout → Task 10; segment cap → Task 11; reader tests → Task 16; connection URL → Task 13; no-audio notice → Task 14; merge mid-sentence → Task 15; offsets vacuous test → Task 12; test gaps → Task 16. All listed review issues accounted for.
- **Placeholder scan:** every task names exact files, code, and commands; the two tests in Task 16 that require reading the existing fixture file first say so explicitly and point at the pattern to copy.
- **Type consistency:** `loadTextSource`'s new parameter, `resolveProxyTarget`, `CaptureFailure 'too-long'`, and `connection.connect(token)` are each introduced and consumed within the plan with matching signatures.
