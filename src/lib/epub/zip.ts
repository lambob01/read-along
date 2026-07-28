import { unzipSync, strFromU8 } from 'fflate';

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
		const files = unzipSync(new Uint8Array(buffer));
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
	const baseDir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : '';
	const joined = baseDir ? `${baseDir}/${cleanHref}` : cleanHref;
	return normalize(joined);
}

export { normalize as normalizePath };
