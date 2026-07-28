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

export async function mineSentence(req: MineRequest, s: SettingsState): Promise<MineResult> {
	const problem = validateAnkiSettings(s);
	if (problem) throw new AnkiError(problem);

	const target = ankiTarget(s);
	const audioField = s.ankiAudioField.trim();
	const sentenceField = s.ankiSentenceField.trim();
	const tags = parseTags(s.ankiTags);

	// Capture first: it is the slowest step and the one most likely to fail,
	// and failing before anything reaches Anki leaves nothing half-done.
	const clip = await captureRange(req.audioSrc, req.start, req.end, {
		padStart: s.ankiPadStart,
		padEnd: s.ankiPadEnd,
		onProgress: req.onProgress,
		onPhase: req.onPhase
	});
	const encoded = await encodeClip(clip.pcm, clip.sampleRate);
	const requested = mediaFilename(req.itemId, req.start, encoded.ext);
	const filename = await storeMediaFile(target, requested, toBase64(encoded.bytes));

	const sound = `[sound:${filename}]`;

	if (s.ankiMode === 'create') {
		const noteId = await addNote(target, {
			deckName: s.ankiDeck.trim(),
			modelName: s.ankiModel.trim(),
			fields: { [sentenceField]: req.text, [audioField]: sound },
			tags
		});
		return {
			action: 'created',
			noteId,
			filename,
			byteLength: encoded.bytes.length
		};
	}

	const noteId = await findNewestNote(target, s.ankiLastCardQuery.trim());
	if (noteId === null) {
		throw new AnkiError(
			`No Anki note matched "${s.ankiLastCardQuery.trim()}". Make the card first, then mine the audio.`
		);
	}

	// The newest note is whatever the user last made, which may not use the
	// note type they configured. Saying so beats AnkiConnect's bare field error.
	const [info] = await notesInfo(target, [noteId]);
	if (info && !(audioField in info.fields)) {
		throw new AnkiError(
			`The last card (note type "${info.modelName}") has no field named "${audioField}".`
		);
	}

	const fields: Record<string, string> = { [audioField]: sound };
	if (s.ankiUpdateSentence && sentenceField) fields[sentenceField] = req.text;
	await updateNoteFields(target, noteId, fields);

	if (tags.length > 0) {
		// Non-fatal: the audio is already attached, and a tag failure should not
		// read as a mining failure.
		try {
			await addTags(target, [noteId], tags.join(' '));
		} catch {
			/* ignore */
		}
	}

	return {
		action: 'updated',
		noteId,
		filename,
		byteLength: encoded.bytes.length
	};
}
