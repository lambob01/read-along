import { unzipSync, strFromU8 } from 'fflate';

/** Extensions skipped at unzip time; nothing reads images out of the archive. */
const IMAGE_EXTENSIONS = new Set([
	'.jpg',
	'.jpeg',
	'.png',
	'.gif',
	'.webp',
	'.svg',
	'.avif',
	'.bmp',
	'.tif',
	'.tiff'
]);

function isImagePath(path: string): boolean {
	const lower = path.toLowerCase();
	const dot = lower.lastIndexOf('.');
	return dot !== -1 && IMAGE_EXTENSIONS.has(lower.slice(dot));
}

/**
 * A decompressed EPUB archive. Paths are archive-relative and normalized
 * (no leading slash), matching how OPF manifest hrefs resolve.
 */
export class EpubArchive {
	private files: Record<string, Uint8Array>;

	constructor(files: Record<string, Uint8Array>) {
		this.files = files;
	}

	static open(buffer: ArrayBuffer): EpubArchive {
		// Images are the bulk of a typical book and are never decoded — the
		// renderer drops them — so leave them compressed rather than paying to
		// inflate them on every open.
		const files = unzipSync(new Uint8Array(buffer), {
			filter: (file) => !isImagePath(file.name)
		});
		return new EpubArchive(files);
	}

	has(path: string): boolean {
		return normalize(path) in this.files;
	}

	bytes(path: string): Uint8Array | null {
		return this.files[normalize(path)] ?? null;
	}

	/** Decodes an entry as UTF-8 text. Returns null when absent. */
	text(path: string): string | null {
		const raw = this.bytes(path);
		if (!raw) return null;
		return strFromU8(raw);
	}

	paths(): string[] {
		return Object.keys(this.files);
	}
}

function normalize(path: string): string {
	let p = path.replace(/\\/g, '/');
	if (p.startsWith('/')) p = p.slice(1);
	// Collapse ./ and resolve ../ so manifest-relative hrefs match zip entries.
	const parts: string[] = [];
	for (const seg of p.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join('/');
}

/** Resolves an href relative to the directory containing `basePath`. */
export function resolveRelative(basePath: string, href: string): string {
	const cleanHref = href.split('#')[0];
	if (!cleanHref) return normalize(basePath);
	// A leading slash addresses the archive root, not the base's directory.
	if (cleanHref.startsWith('/')) return normalize(cleanHref);
	const baseDir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : '';
	const joined = baseDir ? `${baseDir}/${cleanHref}` : cleanHref;
	return normalize(joined);
}

export { normalize as normalizePath };
