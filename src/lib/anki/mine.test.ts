import { describe, it, expect, vi } from 'vitest';
import {
	ankiTarget,
	buildMinePayload,
	mediaFilename,
	mineSentence,
	parseTags,
	validateAnkiSettings,
	type MineDeps,
	type MineRequest
} from '$lib/anki/mine';
import { newestNoteId } from '$lib/anki/connect';
import { defaultSettings, type SettingsState } from '$lib/stores/settings';

function withAnki(overrides: Partial<SettingsState>): SettingsState {
	return { ...defaultSettings, ankiEnabled: true, ...overrides };
}

describe('validateAnkiSettings', () => {
	it('rejects mining while the feature is off', () => {
		expect(validateAnkiSettings(defaultSettings)).toMatch(/turned off/);
	});

	it('requires an audio field in both modes', () => {
		expect(validateAnkiSettings(withAnki({ ankiMode: 'update-last' }))).toMatch(/audio goes in/);
		expect(validateAnkiSettings(withAnki({ ankiMode: 'create' }))).toMatch(/audio goes in/);
	});

	it('accepts the default update-last setup once a field is chosen', () => {
		expect(validateAnkiSettings(withAnki({ ankiAudioField: 'SentenceAudio' }))).toBeNull();
	});

	it('only demands a sentence field in update mode when it will be written', () => {
		const base = withAnki({ ankiAudioField: 'SentenceAudio' });
		expect(validateAnkiSettings({ ...base, ankiUpdateSentence: true })).toMatch(/sentence text/);
		expect(
			validateAnkiSettings({ ...base, ankiUpdateSentence: true, ankiSentenceField: 'Sentence' })
		).toBeNull();
	});

	it('demands deck, note type and sentence field before creating cards', () => {
		let s = withAnki({ ankiMode: 'create', ankiAudioField: 'Audio' });
		expect(validateAnkiSettings(s)).toMatch(/deck/i);
		s = { ...s, ankiDeck: 'Mining' };
		expect(validateAnkiSettings(s)).toMatch(/note type/i);
		s = { ...s, ankiModel: 'Basic' };
		expect(validateAnkiSettings(s)).toMatch(/sentence text/);
		s = { ...s, ankiSentenceField: 'Front' };
		expect(validateAnkiSettings(s)).toBeNull();
	});

	it('rejects a blank last-card search, which would match the whole collection', () => {
		expect(
			validateAnkiSettings(withAnki({ ankiAudioField: 'Audio', ankiLastCardQuery: '  ' }))
		).toMatch(/search/i);
	});
});

describe('mediaFilename', () => {
	it('encodes the position so two lines from one book do not collide', () => {
		expect(mediaFilename('abc123', 12.3456, 'mp3')).toBe('readalong_abc123_12346.mp3');
	});

	it('strips characters that would not survive Anki media storage', () => {
		expect(mediaFilename('../../etc/passwd', 1, 'mp3')).toBe('readalong_....etcpasswd_1000.mp3');
	});

	it('falls back to a name when the id has nothing usable left', () => {
		expect(mediaFilename('///', 0, 'wav')).toBe('readalong_book_0.wav');
	});
});

describe('parseTags', () => {
	it('splits on spaces and commas and drops the gaps', () => {
		expect(parseTags(' read-along,  jp1k   mined ')).toEqual(['read-along', 'jp1k', 'mined']);
	});

	it('returns nothing for a blank setting', () => {
		expect(parseTags('   ')).toEqual([]);
	});
});

describe('ankiTarget', () => {
	it('omits the key entirely when none is configured', () => {
		expect(ankiTarget(withAnki({}))).toEqual({
			url: 'http://localhost:8765',
			key: undefined
		});
	});

	it('trims a configured key and url', () => {
		expect(ankiTarget(withAnki({ ankiUrl: ' http://pc:8765 ', ankiKey: ' secret ' }))).toEqual({
			url: 'http://pc:8765',
			key: 'secret'
		});
	});
});

describe('newestNoteId', () => {
	it('picks the largest id, since note ids are creation timestamps', () => {
		expect(newestNoteId([1700000000000, 1700000009999, 1699999999999])).toBe(1700000009999);
	});

	it('reports no match rather than throwing', () => {
		expect(newestNoteId([])).toBeNull();
	});
});

const UPDATE_SETTINGS = withAnki({ ankiAudioField: 'SentenceAudio' });

const REQUEST: MineRequest = {
	itemId: 'item-1',
	audioSrc: '/abs/audio?token=x',
	text: 'こんにちは。',
	start: 12.5,
	end: 15
};

/** Records every impure step so the orchestration can be checked in order. */
function makeDeps(): MineDeps {
	return {
		capture: vi.fn(async () => ({ pcm: new Float32Array(4), sampleRate: 48000 })),
		encode: vi.fn(async () => ({
			bytes: new Uint8Array([1, 2, 3]),
			ext: 'mp3' as const,
			mime: 'audio/mpeg'
		})),
		anki: {
			findNewestNote: vi.fn(async () => 1700000000000),
			notesInfo: vi.fn(async () => [
				{
					noteId: 1700000000000,
					modelName: 'Basic',
					fields: { SentenceAudio: { value: '', order: 0 } },
					tags: []
				}
			]),
			storeMediaFile: vi.fn(async (_target, filename) => filename),
			updateNoteFields: vi.fn(async () => null),
			addNote: vi.fn(async () => 42),
			addTags: vi.fn(async () => null)
		}
	};
}

describe('buildMinePayload', () => {
	it('shapes a new note with the sound, deck, model, fields and tags', () => {
		const payload = buildMinePayload(
			withAnki({
				ankiMode: 'create',
				ankiDeck: ' Mining ',
				ankiModel: ' Basic ',
				ankiSentenceField: 'Front',
				ankiAudioField: 'Audio',
				ankiTags: 'jp1k, mined'
			}),
			'こんにちは。',
			'readalong_item-1_12500.mp3',
			null
		);

		expect(payload).toEqual({
			action: 'created',
			deckName: 'Mining',
			modelName: 'Basic',
			fields: { Front: 'こんにちは。', Audio: '[sound:readalong_item-1_12500.mp3]' },
			tags: ['jp1k', 'mined']
		});
	});

	it('writes the sentence field on an update only when that option is on', () => {
		const base = withAnki({ ankiAudioField: 'SentenceAudio', ankiSentenceField: 'Sentence' });
		const off = buildMinePayload(base, 'text', 'readalong_x_1.mp3', 42);

		expect(off).toEqual({
			action: 'updated',
			noteId: 42,
			fields: { SentenceAudio: '[sound:readalong_x_1.mp3]' },
			tags: ['read-along']
		});

		const on = buildMinePayload(
			{ ...base, ankiUpdateSentence: true },
			'text',
			'readalong_x_1.mp3',
			42
		);
		expect(on.fields.Sentence).toBe('text');
	});
});

describe('mineSentence', () => {
	it('does not capture or upload when the last-card search matches nothing', async () => {
		const deps = makeDeps();
		deps.anki.findNewestNote = vi.fn(async () => null);

		await expect(mineSentence(REQUEST, UPDATE_SETTINGS, deps)).rejects.toThrow(
			/No Anki note matched/
		);

		expect(deps.anki.storeMediaFile).not.toHaveBeenCalled();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it('does not capture or upload when the target note lacks the audio field', async () => {
		const deps = makeDeps();
		deps.anki.notesInfo = vi.fn(async () => [
			{ noteId: 1, modelName: 'Basic', fields: { Front: { value: '', order: 0 } }, tags: [] }
		]);

		await expect(mineSentence(REQUEST, UPDATE_SETTINGS, deps)).rejects.toThrow(
			/no field named "SentenceAudio"/
		);

		expect(deps.anki.storeMediaFile).not.toHaveBeenCalled();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it('uploads the clip and writes the built payload onto the last note', async () => {
		const deps = makeDeps();

		const result = await mineSentence(REQUEST, UPDATE_SETTINGS, deps);

		expect(deps.anki.updateNoteFields).toHaveBeenCalledWith(expect.anything(), 1700000000000, {
			SentenceAudio: '[sound:readalong_item-1_12500.mp3]'
		});
		expect(deps.anki.addTags).toHaveBeenCalledWith(
			expect.anything(),
			[1700000000000],
			'read-along'
		);
		expect(result).toEqual({
			action: 'updated',
			noteId: 1700000000000,
			filename: 'readalong_item-1_12500.mp3',
			byteLength: 3
		});
	});

	it('creates a note from the built payload in create mode', async () => {
		const deps = makeDeps();
		const settings = withAnki({
			ankiMode: 'create',
			ankiDeck: 'Mining',
			ankiModel: 'Basic',
			ankiSentenceField: 'Front',
			ankiAudioField: 'Audio',
			ankiTags: ''
		});

		const result = await mineSentence(REQUEST, settings, deps);

		expect(deps.anki.findNewestNote).not.toHaveBeenCalled();
		expect(deps.anki.addNote).toHaveBeenCalledWith(expect.anything(), {
			deckName: 'Mining',
			modelName: 'Basic',
			fields: { Front: 'こんにちは。', Audio: '[sound:readalong_item-1_12500.mp3]' },
			tags: []
		});
		expect(result.action).toBe('created');
	});
});
