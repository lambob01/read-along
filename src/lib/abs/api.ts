import { ABSClient, TranscriptNotFoundError } from './client';
import type { ABSLibrary, ABSItem, ABSSession } from '$lib/types';

export { ABSError, TranscriptNotFoundError } from './client';

export async function login(
	client: ABSClient,
	username: string,
	password: string
): Promise<{ token: string }> {
	return client.post<{ token: string }>('/api/login', {
		username,
		password
	});
}

export async function getLibraries(
	client: ABSClient
): Promise<ABSLibrary[]> {
	const data = await client.get<{ libraries: ABSLibrary[] }>(
		'/api/libraries'
	);
	return data.libraries || [];
}

export async function getLibraryItems(
	client: ABSClient,
	libraryId: string
): Promise<ABSItem[]> {
	const data = await client.get<{ results: ABSItem[] }>(
		`/api/libraries/${libraryId}/items?sort=media.metadata.title`
	);
	return data.results || [];
}

export async function getItem(
	client: ABSClient,
	itemId: string
): Promise<any> {
	return client.get<any>(`/api/items/${itemId}?expanded=1`);
}

export async function getStreamSession(
	client: ABSClient,
	itemId: string
): Promise<any> {
	return client.post<any>(
		`/api/items/${itemId}/play?forceDirectPlay=1`,
		{ deviceInfo: { client: 'ReadAlongReader' } }
	);
}

function collectFiles(item: any): any[] {
	return [
		...(item.media?.audioFiles || []),
		...(item.media?.libraryFiles || []),
		...(item.media?.tracks || []),
		...(item.libraryFiles || [])
	];
}

export interface ItemSources {
	/** ino of the subtitle file (.srt/.vtt) — the timing source. */
	subIno: string | null;
	subFilename: string | null;
	/** ino of the EPUB — the text/structure source. */
	epubIno: string | null;
	epubFilename: string | null;
	epubSize: number | null;
	subSize: number | null;
}

/**
 * Locates the timing source (subtitle) and the text source (EPUB) for an item.
 *
 * The reader needs both for aligned mode: EPUB supplies text and structure,
 * the subtitle supplies timestamps. Either may be absent; callers decide the
 * fallback. Sizes are returned so the alignment cache can be invalidated when
 * a file is replaced.
 */
export async function getItemSources(
	client: ABSClient,
	itemId: string
): Promise<ItemSources> {
	const item = await getItem(client, itemId);
	const allFiles = collectFiles(item);

	const nameOf = (f: any) => (f.metadata?.filename || '').toLowerCase();

	const subFile = allFiles.find((f: any) => {
		const name = nameOf(f);
		return name.endsWith('.srt') || name.endsWith('.vtt');
	});

	const epubFile = allFiles.find((f: any) => nameOf(f).endsWith('.epub'));

	return {
		subIno: subFile?.ino ?? null,
		subFilename: subFile?.metadata?.filename ?? null,
		subSize: subFile?.metadata?.size ?? null,
		epubIno: epubFile?.ino ?? null,
		epubFilename: epubFile?.metadata?.filename ?? null,
		epubSize: epubFile?.metadata?.size ?? null
	};
}

export async function getFileText(
	client: ABSClient,
	itemId: string,
	ino: string
): Promise<string> {
	return client.get<string>(`/api/items/${itemId}/file/${ino}`);
}

export async function getFileBinary(
	client: ABSClient,
	itemId: string,
	ino: string
): Promise<ArrayBuffer> {
	return client.getBinary(`/api/items/${itemId}/file/${ino}`);
}

export async function getTranscript(
	client: ABSClient,
	itemId: string
): Promise<string> {
	const { subIno } = await getItemSources(client, itemId);

	if (subIno) {
		return getFileText(client, itemId, subIno);
	}

	throw new TranscriptNotFoundError(itemId);
}
