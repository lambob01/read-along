/**
 * Shaping helpers for the `?expanded=1` item payload.
 *
 * Audiobookshelf returns a loose, version-dependent structure, so every field
 * is treated as optional and normalized here rather than at each call site.
 */

export interface BookDetails {
	title: string;
	subtitle: string | null;
	authorName: string;
	narratorName: string | null;
	seriesName: string | null;
	publishedYear: string | null;
	publisher: string | null;
	genres: string[];
	description: string | null;
	language: string | null;
	isbn: string | null;
	duration: number;
	chapterCount: number;
	sizeBytes: number | null;
	explicit: boolean;
	/** Whether the item carries an EPUB, which enables aligned reading mode. */
	hasEpub: boolean;
	/** Whether a subtitle track exists, without which nothing can be synced. */
	hasSubtitle: boolean;
}

function firstString(...values: unknown[]): string | null {
	for (const v of values) {
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return null;
}

function collectFiles(item: any): any[] {
	return [
		...(item?.media?.audioFiles || []),
		...(item?.media?.libraryFiles || []),
		...(item?.media?.tracks || []),
		...(item?.libraryFiles || [])
	];
}

export function toBookDetails(item: any): BookDetails {
	const meta = item?.media?.metadata ?? {};
	const files = collectFiles(item);
	const nameOf = (f: any) => (f?.metadata?.filename || '').toLowerCase();

	const genres: string[] = Array.isArray(meta.genres)
		? meta.genres.filter((g: unknown) => typeof g === 'string')
		: [];

	// Series arrives either as an array of objects or as a flattened name.
	const seriesName = Array.isArray(meta.series)
		? firstString(meta.series[0]?.name, meta.series[0]?.displayName)
		: firstString(meta.seriesName, meta.series?.name);

	return {
		title: firstString(meta.title) ?? 'Untitled',
		subtitle: firstString(meta.subtitle),
		authorName: firstString(meta.authorName, meta.authors?.[0]?.name) ?? 'Unknown author',
		narratorName: firstString(meta.narratorName, meta.narrators?.[0]),
		seriesName,
		publishedYear: firstString(meta.publishedYear, meta.publishedDate),
		publisher: firstString(meta.publisher),
		genres,
		description: firstString(meta.description),
		language: firstString(meta.language),
		isbn: firstString(meta.isbn, meta.asin),
		duration: Number(item?.media?.duration ?? 0) || 0,
		chapterCount: Array.isArray(item?.media?.chapters) ? item.media.chapters.length : 0,
		sizeBytes: Number(item?.size ?? item?.media?.size ?? 0) || null,
		explicit: Boolean(meta.explicit),
		hasEpub: files.some((f) => nameOf(f).endsWith('.epub')),
		hasSubtitle: files.some((f) => {
			const n = nameOf(f);
			return n.endsWith('.srt') || n.endsWith('.vtt');
		})
	};
}

export function formatDuration(seconds: number): string {
	if (!seconds || seconds < 0) return 'Unknown';
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	if (h === 0) return `${m} min`;
	return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function formatSize(bytes: number | null): string | null {
	if (!bytes || bytes <= 0) return null;
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Strips the HTML Audiobookshelf allows in descriptions down to plain text. */
export function descriptionToParagraphs(description: string | null): string[] {
	if (!description) return [];
	return description
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<[^>]+>/g, '')
		.split(/\n{2,}/)
		.map((p) => p.replace(/\s+/g, ' ').trim())
		.filter(Boolean);
}
