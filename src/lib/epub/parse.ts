import type { EpubDoc, EpubChapter } from '$lib/types';
import { EpubArchive, resolveRelative } from './zip';

const CONTAINER_PATH = 'META-INF/container.xml';

function parseXML(source: string, mime: DOMParserSupportedType): Document {
	const doc = new DOMParser().parseFromString(source, mime);
	if (doc.querySelector('parsererror')) {
		// XHTML parsing is strict; fall back to the lenient HTML parser.
		return new DOMParser().parseFromString(source, 'text/html');
	}
	return doc;
}

/** Reads META-INF/container.xml to find the OPF package document. */
function findOpfPath(archive: EpubArchive): string {
	const containerXml = archive.text(CONTAINER_PATH);
	if (containerXml) {
		const doc = parseXML(containerXml, 'application/xml');
		const rootfile = doc.querySelector('rootfile');
		const path = rootfile?.getAttribute('full-path');
		if (path) return path;
	}
	// Malformed EPUBs sometimes omit the container; probe for any .opf.
	const guess = archive.paths().find((p) => p.toLowerCase().endsWith('.opf'));
	if (guess) return guess;
	throw new Error('Not a valid EPUB: no OPF package document found');
}

/**
 * Reads a metadata value from the OPF, handling the `dc:` prefix that CSS
 * selectors do not match. Falls back to scanning children by local name.
 */
function metaValue(opf: Document, localName: string): string | null {
	const meta = opf.querySelector('metadata');
	if (!meta) return null;
	for (const el of meta.querySelectorAll('*')) {
		if (el.localName === localName && el.namespaceURI === 'http://purl.org/dc/elements/1.1/') {
			const v = el.textContent?.trim();
			if (v) return v;
		}
	}
	// EPUB 2 sometimes uses bare elements without a dc: prefix
	const bare = meta.querySelector(localName);
	return bare?.textContent?.trim() ?? null;
}

/**
 * Maps spine item hrefs to human-readable titles using the EPUB3 nav document
 * or the EPUB2 NCX. Titles are cosmetic; failure is non-fatal.
 */
function buildTitleMap(
	archive: EpubArchive,
	opfPath: string,
	navHref: string | null,
	ncxHref: string | null
): Map<string, string> {
	const titles = new Map<string, string>();

	if (navHref) {
		const navPath = resolveRelative(opfPath, navHref);
		const navSrc = archive.text(navPath);
		if (navSrc) {
			const navDoc = parseXML(navSrc, 'application/xhtml+xml');
			for (const a of navDoc.querySelectorAll('nav a[href]')) {
				const href = a.getAttribute('href');
				const label = a.textContent?.trim();
				if (!href || !label) continue;
				titles.set(resolveRelative(navPath, href), label);
			}
		}
	}

	if (ncxHref) {
		const ncxPath = resolveRelative(opfPath, ncxHref);
		const ncxSrc = archive.text(ncxPath);
		if (ncxSrc) {
			const ncxDoc = parseXML(ncxSrc, 'application/xml');
			for (const point of ncxDoc.querySelectorAll('navPoint')) {
				const href = point.querySelector('content')?.getAttribute('src');
				const label = point.querySelector('navLabel text')?.textContent?.trim();
				if (!href || !label) continue;
				const key = resolveRelative(ncxPath, href);
				if (!titles.has(key)) titles.set(key, label);
			}
		}
	}

	return titles;
}

/**
 * Parses an EPUB into ordered chapters with live DOM bodies.
 *
 * Only semantic markup is retained — the publication's own stylesheets are
 * deliberately ignored so the reader's theme system stays authoritative.
 */
export function parseEpub(buffer: ArrayBuffer): EpubDoc {
	const archive = EpubArchive.open(buffer);
	const opfPath = findOpfPath(archive);
	const opfSrc = archive.text(opfPath);
	if (!opfSrc) throw new Error(`EPUB OPF unreadable at ${opfPath}`);

	const opf = parseXML(opfSrc, 'application/xml');

	// manifest id -> { href, properties }
	const manifest = new Map<string, { href: string; props: string }>();
	for (const item of opf.querySelectorAll('manifest > item')) {
		const id = item.getAttribute('id');
		const href = item.getAttribute('href');
		if (!id || !href) continue;
		manifest.set(id, {
			href,
			props: item.getAttribute('properties') || ''
		});
	}

	let navHref: string | null = null;
	for (const [, entry] of manifest) {
		if (entry.props.split(/\s+/).includes('nav')) {
			navHref = entry.href;
			break;
		}
	}

	const spineEl = opf.querySelector('spine');
	const ncxId = spineEl?.getAttribute('toc');
	const ncxHref = ncxId ? (manifest.get(ncxId)?.href ?? null) : null;

	const titles = buildTitleMap(archive, opfPath, navHref, ncxHref);

	const chapters: EpubChapter[] = [];
	let order = 0;

	for (const itemref of opf.querySelectorAll('spine > itemref')) {
		const idref = itemref.getAttribute('idref');
		if (!idref) continue;
		const entry = manifest.get(idref);
		if (!entry) continue;

		// The nav document is navigation, not prose; skip it.
		if (entry.props.split(/\s+/).includes('nav')) continue;

		const chapterPath = resolveRelative(opfPath, entry.href);
		const src = archive.text(chapterPath);
		if (!src) continue;

		const chapterDoc = parseXML(src, 'application/xhtml+xml');
		const body = chapterDoc.body ?? chapterDoc.querySelector('body');
		if (!body) continue;

		stripNonProse(body);

		chapters.push({
			id: idref,
			order: order++,
			href: chapterPath,
			title: titles.get(chapterPath) ?? null,
			body: body as HTMLElement
		});
	}

	if (chapters.length === 0) {
		throw new Error('EPUB contains no readable spine documents');
	}

	return {
		title: metaValue(opf, 'title'),
		author: metaValue(opf, 'creator'),
		language: metaValue(opf, 'language'),
		chapters
	};
}

/** Removes elements that carry no reading content. */
function stripNonProse(root: Element): void {
	for (const el of root.querySelectorAll('script, style, link, meta')) {
		el.remove();
	}
}
