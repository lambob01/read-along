import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { EpubArchive, resolveRelative } from '$lib/epub/zip';

function u8(text: string): Uint8Array {
	return new Uint8Array(Array.from(new TextEncoder().encode(text)));
}

function buildZip(files: Record<string, string>): ArrayBuffer {
	const entries: Record<string, Uint8Array> = {};
	for (const [path, content] of Object.entries(files)) {
		entries[path] = u8(content);
	}
	const zipped = zipSync(entries);
	return zipped.buffer.slice(
		zipped.byteOffset,
		zipped.byteOffset + zipped.byteLength
	) as ArrayBuffer;
}

describe('resolveRelative', () => {
	it('treats a leading slash as archive-root absolute', () => {
		expect(resolveRelative('OEBPS/content.opf', '/OEBPS/ch1.xhtml')).toBe('OEBPS/ch1.xhtml');
	});

	it('strips fragments before resolving an absolute href', () => {
		expect(resolveRelative('OEBPS/content.opf', '/OEBPS/ch1.xhtml#top')).toBe('OEBPS/ch1.xhtml');
	});
});

describe('EpubArchive image filtering', () => {
	it('omits image entries from the archive', () => {
		const archive = EpubArchive.open(
			buildZip({
				mimetype: 'application/epub+zip',
				'OEBPS/ch1.xhtml': '<p>本文。</p>',
				'OEBPS/images/cover.png': 'not really a png',
				'OEBPS/images/figure.JPEG': 'not really a jpeg'
			})
		);

		expect(archive.paths()).not.toContain('OEBPS/images/cover.png');
		expect(archive.has('OEBPS/images/figure.JPEG')).toBe(false);
		expect(archive.text('OEBPS/ch1.xhtml')).toContain('本文。');
	});
});
