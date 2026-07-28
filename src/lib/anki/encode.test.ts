import { describe, it, expect } from 'vitest';
import { encodeWav, encodeClip, toBase64 } from '$lib/anki/encode';

function readAscii(bytes: Uint8Array, at: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + length));
}

describe('encodeWav', () => {
	it('writes a mono 16-bit PCM header matching the payload', () => {
		const pcm = new Float32Array(8).fill(0.5);
		const wav = encodeWav(pcm, 48000);
		const view = new DataView(wav.buffer);

		expect(readAscii(wav, 0, 4)).toBe('RIFF');
		expect(readAscii(wav, 8, 4)).toBe('WAVE');
		expect(readAscii(wav, 36, 4)).toBe('data');
		expect(view.getUint32(4, true)).toBe(wav.length - 8);
		expect(view.getUint16(22, true)).toBe(1); // channels
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint16(34, true)).toBe(16); // bit depth
		expect(view.getUint32(40, true)).toBe(pcm.length * 2);
		expect(wav.length).toBe(44 + pcm.length * 2);
	});

	it('clamps samples that overshoot instead of wrapping them', () => {
		const wav = encodeWav(Float32Array.from([2, -2]), 44100);
		const view = new DataView(wav.buffer);

		expect(view.getInt16(44, true)).toBe(32767);
		expect(view.getInt16(46, true)).toBe(-32768);
	});
});

describe('encodeClip', () => {
	it('produces an mp3 at a rate LAME supports', async () => {
		const pcm = new Float32Array(48000);
		for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 20) * 0.4;

		const out = await encodeClip(pcm, 48000);

		expect(out.ext).toBe('mp3');
		expect(out.mime).toBe('audio/mpeg');
		// MPEG audio frames start with the 11-bit sync word.
		expect(out.bytes[0]).toBe(0xff);
		expect(out.bytes[1] & 0xe0).toBe(0xe0);
		// A second of speech should land far below the WAV it replaces.
		expect(out.bytes.length).toBeLessThan(pcm.length * 2);
	});

	it('falls back to WAV at a rate mp3 cannot express', async () => {
		const out = await encodeClip(new Float32Array(100), 37000);

		expect(out.ext).toBe('wav');
		expect(readAscii(out.bytes, 0, 4)).toBe('RIFF');
	});
});

describe('toBase64', () => {
	it('round-trips bytes', () => {
		const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
		expect(toBase64(bytes)).toBe('AAF/gP8=');
	});

	it('handles payloads past the argument limit of fromCharCode', () => {
		const bytes = new Uint8Array(200_000).fill(65);
		const encoded = toBase64(bytes);
		expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
	});
});
