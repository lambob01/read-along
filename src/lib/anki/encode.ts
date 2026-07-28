/**
 * Turns captured PCM into a file Anki can store.
 *
 * MP3 rather than WAV because these clips end up in a synced Anki collection:
 * a 5-second line is ~40 KB as 64 kbps mono MP3 against ~480 KB as 48 kHz
 * 16-bit WAV, and a mining habit produces thousands of them.
 */

/** Sample rates LAME accepts. Anything else is written as WAV instead. */
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

const MP3_KBPS = 64;

/** LAME consumes MPEG granules; feeding it whole multiples avoids ragged tails. */
const MP3_BLOCK = 1152;

export interface EncodedAudio {
	bytes: Uint8Array;
	/** File extension without the dot, for naming the Anki media file. */
	ext: 'mp3' | 'wav';
	mime: string;
}

function toInt16(pcm: Float32Array): Int16Array {
	const out = new Int16Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) {
		const v = pcm[i];
		out[i] = v < -1 ? -32768 : v > 1 ? 32767 : Math.round(v * 32767);
	}
	return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
	const samples = toInt16(pcm);
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);

	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	ascii(0, 'RIFF');
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels: mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, 'data');
	view.setUint32(40, samples.length * 2, true);

	for (let i = 0; i < samples.length; i++) {
		view.setInt16(44 + i * 2, samples[i], true);
	}
	return bytes;
}

/**
 * Encodes to MP3, falling back to WAV when the capture ran at a sample rate
 * LAME cannot express or the encoder throws. A larger card beats no card.
 */
export async function encodeClip(pcm: Float32Array, sampleRate: number): Promise<EncodedAudio> {
	if (MP3_RATES.includes(sampleRate)) {
		try {
			const { Mp3Encoder } = await import('@breezystack/lamejs');
			const encoder = new Mp3Encoder(1, sampleRate, MP3_KBPS);
			const samples = toInt16(pcm);
			const chunks: Uint8Array[] = [];
			for (let i = 0; i < samples.length; i += MP3_BLOCK) {
				const block = samples.subarray(i, Math.min(i + MP3_BLOCK, samples.length));
				const encoded = encoder.encodeBuffer(block);
				if (encoded.length > 0) chunks.push(encoded);
			}
			const tail = encoder.flush();
			if (tail.length > 0) chunks.push(tail);
			const bytes = concat(chunks);
			if (bytes.length > 0) {
				return { bytes, ext: 'mp3', mime: 'audio/mpeg' };
			}
		} catch {
			/* fall through to WAV */
		}
	}
	return { bytes: encodeWav(pcm, sampleRate), ext: 'wav', mime: 'audio/wav' };
}

/** AnkiConnect takes media as base64, so the bytes never touch the filesystem. */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	// Chunked because String.fromCharCode(...arr) blows the argument limit on
	// anything longer than a second or two of audio.
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
