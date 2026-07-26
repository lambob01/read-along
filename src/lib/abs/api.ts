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

export async function getTranscript(
	client: ABSClient,
	itemId: string
): Promise<string> {
	const item = await getItem(client, itemId);

	const allFiles = [
		...(item.media?.audioFiles || []),
		...(item.media?.libraryFiles || []),
		...(item.media?.tracks || []),
		...(item.libraryFiles || [])
	];

	const subFile = allFiles.find((f: any) => {
		const name = (f.metadata?.filename || '').toLowerCase();
		return name.endsWith('.srt') || name.endsWith('.vtt');
	});

	if (subFile) {
		return client.get<string>(
			`/api/items/${itemId}/file/${subFile.ino}`
		);
	}

	throw new TranscriptNotFoundError(itemId);
}
