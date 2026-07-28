import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { parseEpub } from '$lib/epub/parse';
import { EpubArchive, resolveRelative } from '$lib/epub/zip';

/**
 * Encodes to a realm-local Uint8Array.
 *
 * fflate's `strToU8` returns an array from the Node realm, which fails the
 * `instanceof Uint8Array` check inside `zipSync` under jsdom — fflate then
 * treats the array as a nested directory. Browsers have a single realm, so this
 * only affects the test harness.
 */
function u8(text: string): Uint8Array {
	return new Uint8Array(Array.from(new TextEncoder().encode(text)));
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function opf(opts: { nav?: boolean; ncx?: boolean } = {}): string {
	return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>テスト本</dc:title>
    <dc:creator>著者名</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    ${opts.nav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
    ${opts.ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ''}
  </manifest>
  <spine${opts.ncx ? ' toc="ncx"' : ''}>
    ${opts.nav ? '<itemref idref="nav"/>' : ''}
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
}

function chapter(body: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head>
<body>${body}</body></html>`;
}

const NAV = chapter(
	`<nav epub:type="toc"><ol>
     <li><a href="ch1.xhtml">第一章</a></li>
     <li><a href="text/ch2.xhtml">第二章</a></li>
   </ol></nav>`
);

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>序章</text></navLabel><content src="ch1.xhtml"/></navPoint>
  </navMap>
</ncx>`;

function buildEpub(files: Record<string, string>): ArrayBuffer {
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

function standardEpub(opts: { nav?: boolean; ncx?: boolean } = {}) {
	const files: Record<string, string> = {
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': CONTAINER,
		'OEBPS/content.opf': opf(opts),
		'OEBPS/ch1.xhtml': chapter('<h1>見出し</h1><p>第一章の本文。</p>'),
		'OEBPS/text/ch2.xhtml': chapter('<p>第二章の本文。</p>')
	};
	if (opts.nav) files['OEBPS/nav.xhtml'] = NAV;
	if (opts.ncx) files['OEBPS/toc.ncx'] = NCX;
	return buildEpub(files);
}

describe('EpubArchive', () => {
	it('reads entries from a real zip', () => {
		const archive = EpubArchive.open(standardEpub());
		expect(archive.has('META-INF/container.xml')).toBe(true);
		expect(archive.text('mimetype')).toBe('application/epub+zip');
	});

	it('normalizes leading slashes', () => {
		const archive = EpubArchive.open(standardEpub());
		expect(archive.has('/OEBPS/content.opf')).toBe(true);
	});

	it('returns null for missing entries', () => {
		const archive = EpubArchive.open(standardEpub());
		expect(archive.bytes('nope.xhtml')).toBeNull();
		expect(archive.text('nope.xhtml')).toBeNull();
	});
});

describe('resolveRelative', () => {
	it('resolves against the containing directory', () => {
		expect(resolveRelative('OEBPS/content.opf', 'ch1.xhtml')).toBe('OEBPS/ch1.xhtml');
	});

	it('resolves nested hrefs', () => {
		expect(resolveRelative('OEBPS/content.opf', 'text/ch2.xhtml')).toBe('OEBPS/text/ch2.xhtml');
	});

	it('walks up with ..', () => {
		expect(resolveRelative('OEBPS/text/ch2.xhtml', '../images/a.png')).toBe('OEBPS/images/a.png');
	});

	it('strips fragments', () => {
		expect(resolveRelative('OEBPS/content.opf', 'ch1.xhtml#frag')).toBe('OEBPS/ch1.xhtml');
	});
});

describe('parseEpub', () => {
	it('extracts metadata', () => {
		const doc = parseEpub(standardEpub());
		expect(doc.title).toBe('テスト本');
		expect(doc.author).toBe('著者名');
		expect(doc.language).toBe('ja');
	});

	it('returns chapters in spine order', () => {
		const doc = parseEpub(standardEpub());
		expect(doc.chapters.length).toBe(2);
		expect(doc.chapters[0].order).toBe(0);
		expect(doc.chapters[0].body.textContent).toContain('第一章の本文。');
		expect(doc.chapters[1].body.textContent).toContain('第二章の本文。');
	});

	it('resolves chapters in subdirectories', () => {
		const doc = parseEpub(standardEpub());
		expect(doc.chapters[1].href).toBe('OEBPS/text/ch2.xhtml');
	});

	it('titles chapters from the EPUB3 nav document', () => {
		const doc = parseEpub(standardEpub({ nav: true }));
		expect(doc.chapters[0].title).toBe('第一章');
		expect(doc.chapters[1].title).toBe('第二章');
	});

	it('excludes the nav document from the reading order', () => {
		const doc = parseEpub(standardEpub({ nav: true }));
		// The spine lists nav first, but it is navigation, not prose.
		expect(doc.chapters.length).toBe(2);
		expect(doc.chapters[0].body.textContent).toContain('第一章の本文。');
	});

	it('falls back to the NCX for titles', () => {
		const doc = parseEpub(standardEpub({ ncx: true }));
		expect(doc.chapters[0].title).toBe('序章');
	});

	it('strips scripts and stylesheets', () => {
		const buf = buildEpub({
			'META-INF/container.xml': CONTAINER,
			'OEBPS/content.opf': opf(),
			'OEBPS/ch1.xhtml': chapter(
				'<style>p{color:red}</style><script>alert(1)</script><p>本文。</p>'
			),
			'OEBPS/text/ch2.xhtml': chapter('<p>二章。</p>')
		});
		const doc = parseEpub(buf);
		expect(doc.chapters[0].body.querySelector('script')).toBeNull();
		expect(doc.chapters[0].body.querySelector('style')).toBeNull();
	});

	it('recovers when container.xml is missing by probing for the OPF', () => {
		const buf = buildEpub({
			'OEBPS/content.opf': opf(),
			'OEBPS/ch1.xhtml': chapter('<p>本文。</p>'),
			'OEBPS/text/ch2.xhtml': chapter('<p>二章。</p>')
		});
		const doc = parseEpub(buf);
		expect(doc.chapters.length).toBe(2);
	});

	it('throws when there is no OPF at all', () => {
		const buf = buildEpub({ 'random.txt': 'not an epub' });
		expect(() => parseEpub(buf)).toThrow(/no OPF/i);
	});

	it('throws when the spine has no readable documents', () => {
		const buf = buildEpub({
			'META-INF/container.xml': CONTAINER,
			'OEBPS/content.opf': opf()
			// chapter files deliberately absent
		});
		expect(() => parseEpub(buf)).toThrow(/no readable spine/i);
	});
});
