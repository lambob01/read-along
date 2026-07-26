import { describe, it, expect } from 'vitest';
import { normalizeStream, normalizeText, isSkippable } from '$lib/sync/normalize';
import { splitSentences } from '$lib/sync/align';

describe('normalize', () => {
	it('folds full-width Latin and digits to half-width', () => {
		expect(normalizeText('ＡＢＣ１２３')).toBe('abc123');
	});

	it('folds half-width katakana to full-width', () => {
		expect(normalizeText('ｶﾞｯｷ')).toBe(normalizeText('ガッキ'));
	});

	it('drops Japanese punctuation and whitespace', () => {
		expect(normalizeText('こんにちは、世界。')).toBe('こんにちは世界');
		expect(normalizeText('「はい」')).toBe('はい');
		expect(normalizeText('a b\tc\nd')).toBe('abcd');
		expect(normalizeText('　全角スペース')).toBe('全角スペース');
	});

	it('preserves the chōonpu as content, not punctuation', () => {
		expect(isSkippable('ー')).toBe(false);
		expect(normalizeText('コーヒー')).toBe('コーヒー');
	});

	it('treats dashes as skippable', () => {
		expect(isSkippable('—')).toBe(true);
		expect(isSkippable('-')).toBe(true);
	});

	it('maps each normalized char back to its source offset', () => {
		const src = 'あ、いう';
		const { chars, sourceIndex } = normalizeStream(src);
		expect(chars.join('')).toBe('あいう');
		expect(sourceIndex).toEqual([0, 2, 3]);
		for (let i = 0; i < chars.length; i++) {
			expect(src[sourceIndex[i]]).toBe(chars[i]);
		}
	});

	it('does not split surrogate pairs', () => {
		const { chars } = normalizeStream('𠮷野家');
		expect(chars[0]).toBe('𠮷');
		expect(chars.length).toBe(3);
	});

	it('keeps offsets aligned across multi-byte codepoints', () => {
		const src = '𠮷、野';
		const { chars, sourceIndex } = normalizeStream(src);
		expect(chars.join('')).toBe('𠮷野');
		// '𠮷' occupies two UTF-16 units, so '、' sits at index 2 and '野' at 3.
		expect(sourceIndex).toEqual([0, 3]);
	});
});

describe('splitSentences', () => {
	it('splits on Japanese sentence-final punctuation', () => {
		const text = '一つ目。二つ目。三つ目。';
		const spans = splitSentences(text);
		expect(spans.length).toBe(3);
		expect(text.slice(spans[0].start, spans[0].end)).toBe('一つ目。');
		expect(text.slice(spans[2].start, spans[2].end)).toBe('三つ目。');
	});

	it('keeps a closing quote with its sentence', () => {
		const text = '「行こう。」と言った。';
		const spans = splitSentences(text);
		expect(text.slice(spans[0].start, spans[0].end)).toBe('「行こう。」');
	});

	it('handles Latin punctuation', () => {
		const text = 'First one. Second one! Third?';
		const spans = splitSentences(text);
		expect(spans.length).toBe(3);
	});

	it('returns the whole block when there is no terminator', () => {
		const spans = splitSentences('見出しテキスト');
		expect(spans).toEqual([{ start: 0, end: 7 }]);
	});

	it('produces spans that tile the input without gaps', () => {
		const text = 'あ。い。う';
		const spans = splitSentences(text);
		expect(spans[0].start).toBe(0);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].start).toBe(spans[i - 1].end);
		}
		expect(spans[spans.length - 1].end).toBe(text.length);
	});
});
