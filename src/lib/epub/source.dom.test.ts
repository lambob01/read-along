import { describe, it, expect, vi } from 'vitest';
import { zipSync } from 'fflate';
import { loadTextSource } from '$lib/epub/source';
import type { ABSClient } from '$lib/abs/client';
import type { ItemSources } from '$lib/abs/api';
import type { AlignedIndex } from '$lib/types';

const client = {} as ABSClient;

const sources = {
	subIno: '10',
	subFilename: 'sub.srt',
	subSize: 100,
	epubIno: null,
	epubFilename: null,
	epubSize: null
} as ItemSources;

const sourcesWithEpub = {
	...sources,
	epubIno: '20',
	epubFilename: 'book.epub',
	epubSize: 200
} as ItemSources;

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>別の本</dc:title></metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;

/** Builds a real EPUB archive holding one chapter with `body` markup. */
function makeEpub(body: string): ArrayBuffer {
	const files: Record<string, string> = {
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': CONTAINER,
		'OEBPS/content.opf': OPF,
		'OEBPS/ch1.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`
	};
	const entries: Record<string, Uint8Array> = {};
	for (const [path, content] of Object.entries(files)) {
		entries[path] = new Uint8Array(Array.from(new TextEncoder().encode(content)));
	}
	const zipped = zipSync(entries);
	return zipped.buffer.slice(
		zipped.byteOffset,
		zipped.byteOffset + zipped.byteLength
	) as ArrayBuffer;
}

describe('loadTextSource', () => {
	it('degrades to no-source with a notice when the subtitle download fails', async () => {
		const fetchFileText = vi.fn().mockRejectedValue(new Error('network down'));
		const source = await loadTextSource(client, 'item-1', sources, fetchFileText);

		expect(source.mode).toBe('none');
		expect(source.notice).toContain('Subtitle');
	});

	it('notices an empty subtitle when there is no EPUB', async () => {
		const fetchFileText = vi.fn().mockResolvedValue('not a subtitle at all');
		const source = await loadTextSource(client, 'item-2', sources, fetchFileText);

		expect(source.mode).toBe('subtitle');
		expect(source.cues).toEqual([]);
		expect(source.notice).toBe('Subtitle file contained no cues.');
	});

	it('caches a sub-threshold alignment so a later load does not re-align', async () => {
		const epubClient = {
			getBinary: async () => makeEpub('<p>まったく別の本の本文です。</p>')
		} as unknown as ABSClient;
		const fetchFileText = async () => '1\n00:00:00,000 --> 00:00:02,000\n全然ちがう文章です。\n';

		const saved: AlignedIndex[] = [];
		const save = vi.fn(async (_key: string, index: AlignedIndex) => {
			saved.push(index);
		});

		const first = await loadTextSource(epubClient, 'item-cache', sourcesWithEpub, fetchFileText, {
			load: async () => null,
			save
		});

		expect(first.mode).toBe('subtitle');
		expect(save).toHaveBeenCalledTimes(1);
		expect(saved[0].stats.coverage).toBeLessThan(0.4);

		const saveAgain = vi.fn(async () => {});
		const second = await loadTextSource(epubClient, 'item-cache', sourcesWithEpub, fetchFileText, {
			load: async () => saved[0],
			save: saveAgain
		});

		expect(second.mode).toBe('subtitle');
		expect(second.notice).toContain('matched only');
		expect(saveAgain).not.toHaveBeenCalled();
	});
});
