/**
 * Minimal AnkiConnect client.
 *
 * The request goes straight from the browser to Anki on the user's own
 * machine; there is no server in this app to relay it. That means AnkiConnect
 * has to list this page's origin in `webCorsOriginList`, which is the single
 * most common reason mining fails, so a network-level failure is reported as
 * that rather than as a generic fetch error.
 */

export const DEFAULT_ANKI_URL = 'http://localhost:8765';

const ANKI_VERSION = 6;

export class AnkiError extends Error {
	constructor(
		message: string,
		public readonly kind: 'unreachable' | 'api' = 'api'
	) {
		super(message);
		this.name = 'AnkiError';
	}
}

export interface AnkiTarget {
	url: string;
	/** Optional; only set when the user has configured `apiKey` in AnkiConnect. */
	key?: string;
}

async function invoke<T>(
	target: AnkiTarget,
	action: string,
	params: Record<string, unknown> = {}
): Promise<T> {
	const body: Record<string, unknown> = { action, version: ANKI_VERSION, params };
	if (target.key) body.key = target.key;

	let res: Response;
	try {
		res = await fetch(target.url, {
			method: 'POST',
			// No custom headers: anything beyond a simple request makes the
			// browser preflight, and AnkiConnect answers OPTIONS only for
			// origins already in webCorsOriginList.
			body: JSON.stringify(body)
		});
	} catch {
		throw new AnkiError(
			`Could not reach Anki at ${target.url}. Check that Anki is open with AnkiConnect installed, and that this site's address is in AnkiConnect's webCorsOriginList.`,
			'unreachable'
		);
	}

	if (!res.ok) {
		throw new AnkiError(`AnkiConnect returned HTTP ${res.status}`);
	}

	const payload = (await res.json()) as { result: T; error: string | null };
	if (payload.error) throw new AnkiError(payload.error);
	return payload.result;
}

export function ankiVersion(target: AnkiTarget): Promise<number> {
	return invoke<number>(target, 'version');
}

export function deckNames(target: AnkiTarget): Promise<string[]> {
	return invoke<string[]>(target, 'deckNames');
}

export function modelNames(target: AnkiTarget): Promise<string[]> {
	return invoke<string[]>(target, 'modelNames');
}

export function modelFieldNames(target: AnkiTarget, modelName: string): Promise<string[]> {
	return invoke<string[]>(target, 'modelFieldNames', { modelName });
}

export function findNotes(target: AnkiTarget, query: string): Promise<number[]> {
	return invoke<number[]>(target, 'findNotes', { query });
}

export interface NoteInfo {
	noteId: number;
	modelName: string;
	fields: Record<string, { value: string; order: number }>;
	tags: string[];
}

export function notesInfo(target: AnkiTarget, notes: number[]): Promise<NoteInfo[]> {
	return invoke<NoteInfo[]>(target, 'notesInfo', { notes });
}

/**
 * Uploads media and returns the stored filename.
 *
 * Anki may rename on collision, so the field must be written with the returned
 * name rather than the requested one.
 */
export function storeMediaFile(
	target: AnkiTarget,
	filename: string,
	base64: string
): Promise<string> {
	return invoke<string>(target, 'storeMediaFile', { filename, data: base64 });
}

export function updateNoteFields(
	target: AnkiTarget,
	noteId: number,
	fields: Record<string, string>
): Promise<null> {
	return invoke<null>(target, 'updateNoteFields', { note: { id: noteId, fields } });
}

export function addTags(target: AnkiTarget, notes: number[], tags: string): Promise<null> {
	return invoke<null>(target, 'addTags', { notes, tags });
}

export interface AddNoteSpec {
	deckName: string;
	modelName: string;
	fields: Record<string, string>;
	tags: string[];
}

export function addNote(target: AnkiTarget, spec: AddNoteSpec): Promise<number> {
	return invoke<number>(target, 'addNote', {
		note: {
			deckName: spec.deckName,
			modelName: spec.modelName,
			fields: spec.fields,
			tags: spec.tags,
			options: { allowDuplicate: true }
		}
	});
}

/**
 * Newest note matching `query`.
 *
 * Anki note ids are creation timestamps in milliseconds, so the largest id is
 * the most recently created note — no extra lookup needed to sort them.
 */
export function newestNoteId(ids: number[]): number | null {
	if (ids.length === 0) return null;
	let max = ids[0];
	for (const id of ids) if (id > max) max = id;
	return max;
}

export async function findNewestNote(target: AnkiTarget, query: string): Promise<number | null> {
	return newestNoteId(await findNotes(target, query));
}
