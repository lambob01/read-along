import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHighlighter, ACTIVE_CLASS } from '$lib/reader/highlight';

function span(text: string): HTMLElement {
	const el = document.createElement('span');
	el.className = 'reader-sentence';
	el.textContent = text;
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	document.body.replaceChildren();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('class-based highlighter', () => {
	function make() {
		return createHighlighter({ preferClassFallback: true });
	}

	it('lights the active spans', () => {
		const h = make();
		const a = span('one');
		const b = span('two');

		h.activateMany([a, b]);

		expect(a.classList.contains(ACTIVE_CLASS)).toBe(true);
		expect(b.classList.contains(ACTIVE_CLASS)).toBe(true);
	});

	// The reported bug: the finished line must go dark when the next one lights.
	it('clears the previous sentence when the next activates', () => {
		const h = make();
		const first = span('first');
		const second = span('second');

		h.activateMany([first]);
		h.activateMany([second]);

		expect(first.classList.contains(ACTIVE_CLASS)).toBe(false);
		expect(second.classList.contains(ACTIVE_CLASS)).toBe(true);
	});

	it('clears everything on reset', () => {
		const h = make();
		const a = span('one');

		h.activateMany([a]);
		h.reset();

		expect(document.querySelectorAll(`.${ACTIVE_CLASS}`).length).toBe(0);
	});

	it('leaves nothing lit when the sentence has no spans', () => {
		const h = make();
		const a = span('one');

		h.activateMany([a]);
		h.activateMany([]);

		expect(document.querySelectorAll(`.${ACTIVE_CLASS}`).length).toBe(0);
	});

	/*
		Chapter windowing can remount a chapter between activations, so the spans
		this handle remembers are not necessarily the ones still in the document.
		A sweep is the only way to guarantee nothing stays lit.
	*/
	it('clears spans it no longer holds references to', () => {
		const h = make();
		const orphan = span('stale');
		orphan.classList.add(ACTIVE_CLASS);

		h.activateMany([span('fresh')]);

		expect(orphan.classList.contains(ACTIVE_CLASS)).toBe(false);
		expect(document.querySelectorAll(`.${ACTIVE_CLASS}`).length).toBe(1);
	});

	it('scopes the sweep to the given root', () => {
		const outside = span('outside');
		outside.classList.add(ACTIVE_CLASS);

		const root = document.createElement('div');
		document.body.appendChild(root);
		const inside = document.createElement('span');
		inside.classList.add(ACTIVE_CLASS);
		root.appendChild(inside);

		const h = createHighlighter({ preferClassFallback: true, getRoot: () => root });
		h.reset();

		expect(inside.classList.contains(ACTIVE_CLASS)).toBe(false);
		expect(outside.classList.contains(ACTIVE_CLASS)).toBe(true);
	});
});

describe('engine selection', () => {
	it('avoids the Highlight API on WebKit, where clearing does not repaint', () => {
		vi.stubGlobal('navigator', { vendor: 'Apple Computer, Inc.' });
		vi.stubGlobal('CSS', { highlights: new Map() });

		const h = createHighlighter();
		const el = span('one');
		h.activateMany([el]);

		// The class path is in use, so the span itself carries the state.
		expect(el.classList.contains(ACTIVE_CLASS)).toBe(true);
	});

	it('uses the Highlight API elsewhere', () => {
		const highlights = new Map();
		vi.stubGlobal('navigator', { vendor: 'Google Inc.' });
		vi.stubGlobal('CSS', { highlights });
		// jsdom implements neither Highlight nor the registry.
		vi.stubGlobal(
			'Highlight',
			class {
				ranges: Range[];
				constructor(...ranges: Range[]) {
					this.ranges = ranges;
				}
			}
		);

		const h = createHighlighter();
		const el = span('one');
		h.activateMany([el]);

		expect(highlights.has('active-sentence')).toBe(true);
		expect(el.classList.contains(ACTIVE_CLASS)).toBe(false);
	});

	it('falls back to classes when the Highlight API is absent', () => {
		vi.stubGlobal('navigator', { vendor: 'Google Inc.' });
		vi.stubGlobal('CSS', {});

		const h = createHighlighter();
		const el = span('one');
		h.activateMany([el]);

		expect(el.classList.contains(ACTIVE_CLASS)).toBe(true);
	});
});
