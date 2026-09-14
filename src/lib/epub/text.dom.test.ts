import { describe, it, expect } from 'vitest';
import { collectBlocks, blockPlainText, resolvePath } from '$lib/epub/text';

describe('collectBlocks mixed content', () => {
	it('keeps text either side of an inline element', () => {
		document.body.innerHTML = '<div>前置き <em>強調</em> 後ろ</div>';
		const blocks = collectBlocks(document.body);
		expect(blocks.map((b) => blockPlainText(b.el))).toEqual(['前置き 強調 後ろ']);
	});

	it('keeps direct text in a table cell', () => {
		document.body.innerHTML = '<table><tr><td>セル <b>強調</b></td></tr></table>';
		const blocks = collectBlocks(document.body);
		expect(blocks.map((b) => blockPlainText(b.el))).toEqual(['セル 強調']);
	});

	it('keeps text after a nested block by emitting the container once', () => {
		document.body.innerHTML = '<div>lead<p>para</p>tail</div>';
		const blocks = collectBlocks(document.body);
		expect(blocks.map((b) => blockPlainText(b.el))).toEqual(['leadparatail']);
	});

	it('still recurses when a container has only whitespace direct text', () => {
		document.body.innerHTML = '<div>\n  <p>a</p>\n  <p>b</p>\n</div>';
		const blocks = collectBlocks(document.body);
		expect(blocks.map((b) => blockPlainText(b.el))).toEqual(['a', 'b']);
	});

	it('does not emit a nested block twice when the container wins', () => {
		document.body.innerHTML = '<div>lead<p>para</p></div>';
		const blocks = collectBlocks(document.body);
		expect(blocks.map((b) => blockPlainText(b.el))).toEqual(['leadpara']);
	});

	it('emits paths that resolve back to the emitted element', () => {
		document.body.innerHTML = '<section><div>前置き <em>強調</em> 後ろ</div></section>';
		const blocks = collectBlocks(document.body);
		expect(blocks.length).toBe(1);
		for (const b of blocks) {
			expect(resolvePath(document.body, b.path)).toBe(b.el);
		}
	});
});
