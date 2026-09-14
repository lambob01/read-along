/**
 * Ties audio capture, the encoder and AnkiConnect together.
 *
 * Kept free of Svelte so the validation and payload shaping can be tested
 * without a DOM or a running audio graph.
 */

import type { SettingsState } from '$lib/stores/settings';
import { captureRange } from './capture';
import { encodeClip, toBase64 } from './encode';
import {
	AnkiError,
	addNote,
	addTags,
	findNewestNote,
	notesInfo,
	storeMediaFile,
	updateNoteFields,
	type AnkiTarget
} from './connect';

export interface MineRequest {
	itemId: string;
	/** URL of the book's audio, re-played inaudibly to capture the clip. */
	audioSrc: string;
	/** The sentence as it appears in the text. */
	text: string;
	/** Media timestamps of the sentence, before padding. */
	start: number;
	end: number;
	/** Capture progress, 0..1, for the button's spinner. */
	onProgress?: (fraction: number) => void;
	/** Which step the capture is on; the first load has no percentage. */
	onPhase?: (phase: 'preparing' | 'recording') => void;
}

export interface MineResult {
	action: 'updated' | 'created';
	noteId: number;
	filename: string;
	byteLength: number;
}

export function ankiTarget(s: SettingsState): AnkiTarget {
	return { url: s.ankiUrl.trim() || 'http://localhost:8765', key: s.ankiKey.trim() || undefined };
}

/**
 * The impure edges of a mine, injectable so the orchestration can be tested
 * without audio hardware or a running Anki.
 */
export interface MineDeps {
	capture: typeof captureRange;
	encode: typeof encodeClip;
	anki: {
		findNewestNote: typeof findNewestNote;
		notesInfo: typeof notesInfo;
		storeMediaFile: typeof storeMediaFile;
		updateNoteFields: typeof updateNoteFields;
		addNote: typeof addNote;
		addTags: typeof addTags;
	};
}

const defaultDeps: MineDeps = {
	capture: captureRange,
	encode: encodeClip,
	anki: { findNewestNote, notesInfo, storeMediaFile, updateNoteFields, addNote, addTags }
};

export function parseTags(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * Returns the reason mining cannot run with these settings, or null.
 *
 * Checked before any audio is captured so a misconfiguration reports the
 * missing field instead of failing at the AnkiConnect call with a message
 * about an unknown field name.
 */
export function validateAnkiSettings(s: SettingsState): string | null {
	if (!s.ankiEnabled) return 'Anki mining is turned off in settings.';
	if (!s.ankiAudioField.trim()) return 'Choose which Anki field the audio goes in.';
	if (s.ankiMode === 'create') {
		if (!s.ankiDeck.trim()) return 'Choose a deck for new cards.';
		if (!s.ankiModel.trim()) return 'Choose a note type for new cards.';
		if (!s.ankiSentenceField.trim()) return 'Choose which field the sentence text goes in.';
	}
	if (s.ankiMode === 'update-last') {
		if (!s.ankiLastCardQuery.trim()) return 'Set a search for finding the last card.';
		if (s.ankiUpdateSentence && !s.ankiSentenceField.trim()) {
			return 'Choose which field the sentence text goes in.';
		}
	}
	return null;
}

/** Anki stores media on disk, so the name has to survive every filesystem. */
export function mediaFilename(itemId: string, start: number, ext: string): string {
	const safeId = itemId.replace(/[^a-zA-Z0-9._-]/g, '') || 'book';
	return `readalong_${safeId}_${Math.round(start * 1000)}.${ext}`;
}

/** Everything a mine will send to AnkiConnect, shaped but not sent. */
export type MinePayload =
	| {
			action: 'created';
			deckName: string;
			modelName: string;
			fields: Record<string, string>;
			tags: string[];
	  }
	| {
			action: 'updated';
			noteId: number;
			fields: Record<string, string>;
			tags: string[];
	  };

/**
 * Shapes the fields and tags a mine will use.
 *
 * Pure so the field rules can be pinned by tests, and so the update path can
 * build what it is about to write before anything is uploaded. `noteId` is the
 * resolved target note in update mode; the create path ignores it.
 */
export function buildMinePayload(
	s: SettingsState,
	text: string,
	filename: string,
	noteId: number | null
): MinePayload {
	const sound = `[sound:${filename}]`;
	const audioField = s.ankiAudioField.trim();
	const sentenceField = s.ankiSentenceField.trim();
	const tags = parseTags(s.ankiTags);

	if (s.ankiMode === 'create') {
		return {
			action: 'created',
			deckName: s.ankiDeck.trim(),
			modelName: s.ankiModel.trim(),
			fields: { [sentenceField]: text, [audioField]: sound },
			tags
		};
	}

	if (noteId === null) {
		// Callers resolve the note before building; this guards the invariant.
		throw new AnkiError('No Anki note to update.');
	}

	const fields: Record<string, string> = { [audioField]: sound };
	if (s.ankiUpdateSentence && sentenceField) fields[sentenceField] = text;
	return { action: 'updated', noteId, fields, tags };
}

export async function mineSentence(
	req: MineRequest,
	s: SettingsState,
	deps: MineDeps = defaultDeps
): Promise<MineResult> {
	const problem = validateAnkiSettings(s);
	if (problem) throw new AnkiError(problem);

	const target = ankiTarget(s);
	const audioField = s.ankiAudioField.trim();

	// The target note is resolved before any audio is captured or uploaded: a
	// missing note or field would otherwise orphan the media file that had
	// already been stored, after the user waited out the slowest step.
	let noteId: number | null = null;
	if (s.ankiMode === 'update-last') {
		noteId = await deps.anki.findNewestNote(target, s.ankiLastCardQuery.trim());
		if (noteId === null) {
			throw new AnkiError(
				`No Anki note matched "${s.ankiLastCardQuery.trim()}". Make the card first, then mine the audio.`
			);
		}

		// The newest note is whatever the user last made, which may not use the
		// note type they configured. Saying so beats AnkiConnect's bare field error.
		const [info] = await deps.anki.notesInfo(target, [noteId]);
		// The note can be deleted between the search and this lookup, and a
		// reply with no usable fields cannot be updated either. Both have to
		// stop here: having passed the "does it have the audio field" check
		// vacuously, the mine would capture the clip and upload the media
		// against a note that can never receive it.
		const fields = info?.fields;
		if (!fields || typeof fields !== 'object') {
			throw new AnkiError(
				`The last card (note ${noteId}) could not be read; it may have been deleted. Make the card again, then mine the audio.`
			);
		}
		if (!(audioField in fields)) {
			throw new AnkiError(
				`The last card (note type "${info.modelName}") has no field named "${audioField}".`
			);
		}
	}

	const clip = await deps.capture(req.audioSrc, req.start, req.end, {
		padStart: s.ankiPadStart,
		padEnd: s.ankiPadEnd,
		onProgress: req.onProgress,
		onPhase: req.onPhase
	});
	const encoded = await deps.encode(clip.pcm, clip.sampleRate);
	const requested = mediaFilename(req.itemId, req.start, encoded.ext);
	const filename = await deps.anki.storeMediaFile(target, requested, toBase64(encoded.bytes));

	const payload = buildMinePayload(s, req.text, filename, noteId);

	if (payload.action === 'created') {
		const created = await deps.anki.addNote(target, {
			deckName: payload.deckName,
			modelName: payload.modelName,
			fields: payload.fields,
			tags: payload.tags
		});
		return { action: 'created', noteId: created, filename, byteLength: encoded.bytes.length };
	}

	await deps.anki.updateNoteFields(target, payload.noteId, payload.fields);

	if (payload.tags.length > 0) {
		// Non-fatal: the audio is already attached, and a tag failure should not
		// read as a mining failure.
		try {
			await deps.anki.addTags(target, [payload.noteId], payload.tags.join(' '));
		} catch {
			/* ignore */
		}
	}

	return {
		action: 'updated',
		noteId: payload.noteId,
		filename,
		byteLength: encoded.bytes.length
	};
}
