import type { AlignedIndex, EpubBlock, AlignedSentence, AlignmentStats } from '$lib/types';

const DB_NAME = 'read-along-align';
const DB_VERSION = 1;
const STORE = 'alignments';

/**
 * Serializable form of an AlignedIndex. DOM nodes and typed arrays are omitted;
 * blocks carry `nodePath` so elements can be re-resolved against a freshly
 * parsed EPUB, and the timing arrays are rebuilt from the sentence list.
 */
interface CachedAlignment {
	key: string;
	version: number;
	createdAt: number;
	blocks: EpubBlock[];
	sentences: AlignedSentence[];
	stats: AlignmentStats;
}

/** Bumped when the alignment algorithm changes, invalidating stored results. */
const ALGORITHM_VERSION = 1;

/**
 * Cache key incorporating both source file sizes: replacing either the EPUB or
 * the subtitle must invalidate a stored alignment.
 */
export function alignmentKey(
	itemId: string,
	epubSize: number | null,
	subSize: number | null
): string {
	return `${itemId}:${epubSize ?? 0}:${subSize ?? 0}`;
}

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);

	return new Promise((resolve) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE, { keyPath: 'key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		// Caching is an optimisation; a failure must not break reading.
		req.onerror = () => resolve(null);
	});
}

export async function loadAlignment(key: string): Promise<AlignedIndex | null> {
	const db = await openDb();
	if (!db) return null;

	const cached = await new Promise<CachedAlignment | null>((resolve) => {
		try {
			const tx = db.transaction(STORE, 'readonly');
			const req = tx.objectStore(STORE).get(key);
			req.onsuccess = () => resolve((req.result as CachedAlignment) ?? null);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});

	db.close();
	if (!cached || cached.version !== ALGORITHM_VERSION) return null;

	return rebuildIndex(cached);
}

export async function saveAlignment(key: string, index: AlignedIndex): Promise<void> {
	const db = await openDb();
	if (!db) return;

	const record: CachedAlignment = {
		key,
		version: ALGORITHM_VERSION,
		createdAt: Date.now(),
		blocks: index.blocks,
		sentences: index.sentences,
		stats: index.stats
	};

	await new Promise<void>((resolve) => {
		try {
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(record);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resolve();
		}
	});

	db.close();
}

/**
 * Reconstructs the timing arrays from cached sentences. The same ordering and
 * non-overlap guarantees the aligner enforces are re-derived here, so a cached
 * index is indistinguishable from a freshly computed one.
 */
export function rebuildIndex(cached: CachedAlignment): AlignedIndex {
	const timed = cached.sentences
		.filter((s) => s.timed)
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const starts = new Float64Array(timed.length);
	const ends = new Float64Array(timed.length);
	for (let i = 0; i < timed.length; i++) {
		starts[i] = timed[i].start;
		ends[i] = timed[i].end;
	}

	return {
		blocks: cached.blocks,
		sentences: cached.sentences,
		timed,
		starts,
		ends,
		stats: cached.stats
	};
}
