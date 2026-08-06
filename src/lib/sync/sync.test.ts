import { describe, it, expect } from 'vitest';
import { sanitizeText, isNonSpeech } from '$lib/sync/sanitize';
import { parseSRT, parseVTT, parseCues } from '$lib/sync/parse';
import { mergeCues } from '$lib/sync/merge';
import { buildIndex } from '$lib/sync/index';
import type { RawCue } from '$lib/types';

describe('sanitize', () => {
	it('strips HTML tags', () => {
		expect(sanitizeText('<i>hello</i> world')).toBe('hello world');
		expect(sanitizeText('<b>bold</b> text')).toBe('bold text');
	});

	it('strips bracket blocks', () => {
		expect(sanitizeText('hello world')).toBe('hello world');
	});

	it('strips word timing tags', () => {
		expect(sanitizeText('<00:00:01.500>hello <00:00:02.000>world')).toBe('hello world');
	});

	it('normalizes whitespace', () => {
		expect(sanitizeText('hello   \n  world')).toBe('hello world');
	});

	it('trims', () => {
		expect(sanitizeText('  hello  ')).toBe('hello');
	});

	it('detects non-speech', () => {
		expect(isNonSpeech('[music]')).toBe(true);
		expect(isNonSpeech('[applause]')).toBe(true);
		expect(isNonSpeech('♪')).toBe(true);
		expect(isNonSpeech('Hello world')).toBe(false);
		expect(isNonSpeech('')).toBe(true);
	});
});

describe('parseSRT', () => {
	it('parses basic SRT cues', () => {
		const srt = `1
00:00:01,000 --> 00:00:02,500
Hello world

2
00:00:03,000 --> 00:00:05,000
How are you?`;

		const cues = parseSRT(srt);
		expect(cues).toHaveLength(2);
		expect(cues[0]).toEqual({ index: 1, start: 1, end: 2.5, text: 'Hello world' });
		expect(cues[1]).toEqual({ index: 2, start: 3, end: 5, text: 'How are you?' });
	});

	it('handles MM:SS,mmm timestamps', () => {
		const srt = `1
00:30,500 --> 01:00,000
Short format`;

		const cues = parseSRT(srt);
		expect(cues).toHaveLength(1);
		expect(cues[0].start).toBe(30.5);
		expect(cues[0].end).toBe(60);
	});

	it('skips malformed cues', () => {
		const srt = `1
invalid --> 00:00:02,000
bad cue

2
00:00:03,000 --> 00:00:05,000
good cue`;

		const cues = parseSRT(srt);
		expect(cues).toHaveLength(1);
		expect(cues[0].text).toBe('good cue');
	});

	it('handles multiline text', () => {
		const srt = `1
00:00:01,000 --> 00:00:03,000
Line one
Line two`;

		const cues = parseSRT(srt);
		expect(cues[0].text).toBe('Line one Line two');
	});

	it('strips HTML from SRT text', () => {
		const srt = `1
00:00:01,000 --> 00:00:03,000
<i>italic</i> text`;

		const cues = parseSRT(srt);
		expect(cues[0].text).toBe('italic text');
	});
});

describe('parseVTT', () => {
	it('parses basic VTT cues', () => {
		const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.500
Hello world

2
00:00:03.000 --> 00:00:05.000
How are you?`;

		const cues = parseVTT(vtt);
		expect(cues).toHaveLength(2);
		expect(cues[0].start).toBe(1);
		expect(cues[0].end).toBe(2.5);
		expect(cues[0].text).toBe('Hello world');
	});

	it('handles VTT without cue numbers', () => {
		const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.500
First cue

00:00:03.000 --> 00:00:05.000
Second cue`;

		const cues = parseVTT(vtt);
		expect(cues).toHaveLength(2);
	});

	it('strips word timing tags in VTT', () => {
		const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<00:00:01.500>hello <00:00:02.000>world`;

		const cues = parseVTT(vtt);
		expect(cues[0].text).toBe('hello world');
	});
});

describe('parseCues dispatcher', () => {
	it('auto-detects VTT format', () => {
		const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello`;
		const cues = parseCues(vtt);
		expect(cues).toHaveLength(1);
	});

	it('auto-detects SRT format', () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\nHello`;
		const cues = parseCues(srt);
		expect(cues).toHaveLength(1);
	});
});

describe('mergeCues', () => {
	const makeCues = (...texts: string[]): RawCue[] =>
		texts.map((text, i) => ({
			index: i,
			start: i * 2,
			end: i * 2 + 1.5,
			text
		}));

	it('merges consecutive cues that do not end in punctuation', () => {
		const cues = makeCues('Hello', 'world', 'today is');
		const paragraphs = mergeCues(cues);
		expect(paragraphs[0].sentences).toHaveLength(1);
		expect(paragraphs[0].sentences[0].text).toBe('Hello world today is');
	});

	it('does not merge sentences ending with punctuation', () => {
		const cues = makeCues('Hello world.', 'How are you?');
		const paragraphs = mergeCues(cues);
		expect(paragraphs[0].sentences).toHaveLength(2);
	});

	it('breaks paragraph on gap exceeding threshold', () => {
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 2, text: 'First para.' },
			{ index: 1, start: 5, end: 7, text: 'Second para.' }
		];
		const paragraphs = mergeCues(cues, { gapThreshold: 1.0 });
		expect(paragraphs).toHaveLength(2);
	});

	it('breaks paragraph on dialogue dash', () => {
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 2, text: 'She said hello.' },
			{ index: 1, start: 2.5, end: 4, text: '-I disagree.' }
		];
		const paragraphs = mergeCues(cues, { gapThreshold: 3 });
		expect(paragraphs).toHaveLength(2);
	});

	it('filters non-speech cues by default', () => {
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 1, text: '[music]' },
			{ index: 1, start: 1, end: 3, text: 'Hello.' }
		];
		const paragraphs = mergeCues(cues);
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0].sentences[0].text).toBe('Hello.');
	});

	it('shows non-speech when option is set', () => {
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 1, text: '[music]' },
			{ index: 1, start: 1, end: 3, text: 'Hello.' }
		];
		const paragraphs = mergeCues(cues, { showNonSpeech: true });
		expect(paragraphs[0].sentences).toHaveLength(2);
	});

	it('splits Japanese sentences on 。', () => {
		// Back-to-back cues with no audio gap: only the punctuation can
		// separate them. Before 。 was recognised these merged into one
		// "sentence" that highlighted — and mined — as a single block.
		const cues: RawCue[] = [
			{ index: 0, start: 5, end: 8, text: 'これは五秒から八秒までの文です。' },
			{ index: 1, start: 8, end: 11, text: 'つぎは八秒から十一秒までの文。' }
		];
		const sentences = mergeCues(cues)[0].sentences;

		expect(sentences).toHaveLength(2);
		expect(sentences[0].text).toBe('これは五秒から八秒までの文です。');
		expect(sentences[1].text).toBe('つぎは八秒から十一秒までの文。');
	});

	it('splits on fullwidth ！ and ？', () => {
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 1, text: 'まさか！' },
			{ index: 1, start: 1, end: 2, text: 'どうして？' },
			{ index: 2, start: 2, end: 3, text: 'わからない。' }
		];

		expect(mergeCues(cues)[0].sentences).toHaveLength(3);
	});

	it('treats a closing bracket as terminal, since 。 is dropped before it', () => {
		// 「そうか」 is correct Japanese; there is no 。 to match, so the
		// bracket has to end the sentence on its own.
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 1, text: '「そうか」' },
			{ index: 1, start: 1, end: 2, text: '彼は頷いた。' }
		];

		expect(mergeCues(cues)[0].sentences).toHaveLength(2);
	});

	it('still merges unterminated Japanese cues into one sentence', () => {
		// Cues that end without punctuation are continuations, in any script.
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 1, text: '長い文章が' },
			{ index: 1, start: 1, end: 2, text: '二つに分かれて' },
			{ index: 2, start: 2, end: 3, text: 'いる' }
		];
		const sentences = mergeCues(cues)[0].sentences;

		expect(sentences).toHaveLength(1);
		expect(sentences[0].text).toBe('長い文章が 二つに分かれて いる');
	});

	it('absorbs a terminated cue into its running sentence', () => {
		// The final cue carries the 。 for the whole utterance; it used to be
		// split off on its own, leaving the opening as a fragment sentence.
		const cues: RawCue[] = [
			{ index: 0, start: 0, end: 1, text: '長い文章が' },
			{ index: 1, start: 1, end: 2, text: '分かれています。' }
		];
		const sentences = mergeCues(cues)[0].sentences;

		expect(sentences).toHaveLength(1);
		expect(sentences[0].text).toBe('長い文章が 分かれています。');
	});

	it('assigns correct cueIds to merged sentences', () => {
		const cues = makeCues('Hello', 'world', 'today.');
		const paragraphs = mergeCues(cues);
		const sentences = paragraphs[0].sentences;
		expect(sentences).toHaveLength(1);
		expect(sentences[0].cueIds).toEqual([0, 1, 2]);
	});
});

describe('buildIndex', () => {
	it('produces sorted parallel arrays', () => {
		const paragraphs = [
			{
				id: 0,
				sentences: [{ id: 1, start: 5, end: 7, text: 'B.', cueIds: [1] }]
			},
			{
				id: 1,
				sentences: [{ id: 0, start: 1, end: 3, text: 'A.', cueIds: [0] }]
			}
		];

		const index = buildIndex(paragraphs);
		expect(index.sentences).toHaveLength(2);
		expect(index.starts[0]).toBe(1);
		expect(index.ends[0]).toBe(3);
		expect(index.starts[1]).toBe(5);
		expect(index.ends[1]).toBe(7);
		expect(index.sentences[0].text).toBe('A.');
		expect(index.sentences[1].text).toBe('B.');
	});
});

describe('parseCues line endings', () => {
	const srt = `1\r\n00:00:01,000 --> 00:00:02,500\r\nHello world\r\n\r\n2\r\n00:00:03,000 --> 00:00:05,000\r\nHow are you?`;

	it('parses CRLF SRT files as multiple cues', () => {
		const cues = parseCues(srt);
		expect(cues).toHaveLength(2);
		expect(cues[0].text).toBe('Hello world');
		expect(cues[1].text).toBe('How are you?');
	});

	it('parses CRLF VTT files as multiple cues', () => {
		const vtt = `WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.500\r\nFirst cue\r\n\r\n00:00:03.000 --> 00:00:05.000\r\nSecond cue`;
		const cues = parseCues(vtt);
		expect(cues).toHaveLength(2);
		expect(cues[0].text).toBe('First cue');
		expect(cues[1].text).toBe('Second cue');
	});

	it('strips a leading BOM before sniffing the format', () => {
		const cues = parseCues(`\uFEFF${srt}`);
		expect(cues).toHaveLength(2);
	});
});
