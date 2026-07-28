import { describe, it, expect } from 'vitest';
import {
	toBookDetails,
	formatDuration,
	formatSize,
	descriptionToParagraphs
} from '$lib/abs/metadata';

describe('toBookDetails', () => {
	it('falls back to placeholders on an empty payload', () => {
		const d = toBookDetails({});
		expect(d.title).toBe('Untitled');
		expect(d.authorName).toBe('Unknown author');
		expect(d.genres).toEqual([]);
		expect(d.hasEpub).toBe(false);
		expect(d.hasSubtitle).toBe(false);
	});

	it('reads series from the array form', () => {
		const d = toBookDetails({
			media: { metadata: { series: [{ name: 'Wheel of Time' }] } }
		});
		expect(d.seriesName).toBe('Wheel of Time');
	});

	it('reads series from the flattened form', () => {
		const d = toBookDetails({ media: { metadata: { seriesName: 'Discworld' } } });
		expect(d.seriesName).toBe('Discworld');
	});

	it('detects epub and subtitle attachments across file lists', () => {
		const d = toBookDetails({
			media: {
				audioFiles: [{ metadata: { filename: 'book.m4b' } }],
				libraryFiles: [{ metadata: { filename: 'Book.EPUB' } }]
			},
			libraryFiles: [{ metadata: { filename: 'book.srt' } }]
		});
		expect(d.hasEpub).toBe(true);
		expect(d.hasSubtitle).toBe(true);
	});

	it('ignores blank strings when choosing a fallback', () => {
		const d = toBookDetails({
			media: { metadata: { title: '   ', authorName: '', authors: [{ name: 'Le Guin' }] } }
		});
		expect(d.title).toBe('Untitled');
		expect(d.authorName).toBe('Le Guin');
	});

	it('counts chapters and reads duration', () => {
		const d = toBookDetails({
			media: { duration: 3600, chapters: [{}, {}, {}] }
		});
		expect(d.duration).toBe(3600);
		expect(d.chapterCount).toBe(3);
	});

	it('drops non-string genres', () => {
		const d = toBookDetails({ media: { metadata: { genres: ['Sci-Fi', null, 7] } } });
		expect(d.genres).toEqual(['Sci-Fi']);
	});
});

describe('formatDuration', () => {
	it('formats hours and minutes', () => {
		expect(formatDuration(3600)).toBe('1 hr');
		expect(formatDuration(5400)).toBe('1 hr 30 min');
		expect(formatDuration(600)).toBe('10 min');
	});

	it('reports unknown for missing duration', () => {
		expect(formatDuration(0)).toBe('Unknown');
		expect(formatDuration(-5)).toBe('Unknown');
	});
});

describe('formatSize', () => {
	it('scales to a readable unit', () => {
		expect(formatSize(512)).toBe('512 B');
		expect(formatSize(1024 * 1024 * 350)).toBe('350 MB');
		expect(formatSize(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
	});

	it('returns null when unknown', () => {
		expect(formatSize(null)).toBeNull();
		expect(formatSize(0)).toBeNull();
	});
});

describe('descriptionToParagraphs', () => {
	it('splits on paragraph tags and strips markup', () => {
		const out = descriptionToParagraphs('<p>First para.</p><p>Second <i>para</i>.</p>');
		expect(out).toEqual(['First para.', 'Second para.']);
	});

	it('collapses whitespace within a paragraph', () => {
		expect(descriptionToParagraphs('a   b\n c')).toEqual(['a b c']);
	});

	it('returns empty for missing description', () => {
		expect(descriptionToParagraphs(null)).toEqual([]);
		expect(descriptionToParagraphs('')).toEqual([]);
	});
});
