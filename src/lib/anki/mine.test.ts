import { describe, it, expect } from 'vitest';
import { validateAnkiSettings, mediaFilename, parseTags, ankiTarget } from '$lib/anki/mine';
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
