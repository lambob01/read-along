import { describe, it, expect } from 'vitest';
import { cutSegment, mediaToFrame, CaptureError, type Segment } from '$lib/anki/capture';

const RATE = 1000;
const CHUNK = 100;

/**
 * Builds a recording the way `captureRange` does: chunks of PCM plus an anchor
 * per chunk tying its first frame to a media timestamp. Samples encode the
 * media time of the frame (divided by 100 to stay in range) so a cut can be
 * checked against the timeline it claims to come from, not just its length.
 */
function record(from: number, seconds: number): Segment {
	const frames = Math.round(seconds * RATE);
	const pcm = new Float32Array(frames);
	const anchors = [];
	for (let i = 0; i < frames; i++) pcm[i] = (from + i / RATE) / 100;
	for (let f = 0; f < frames; f += CHUNK) {
		anchors.push({ frame: f, mediaTime: from + f / RATE });
	}
	return { pcm, sampleRate: RATE, anchors };
}

/** Media timestamp the sample at `i` was captured at. */
const timeAt = (clip: { pcm: Float32Array }, i: number) => clip.pcm[i] * 100;

describe('cutSegment', () => {
	it('trims the overshoot off both ends of a recording', () => {
		// captureRange always overshoots: the seek lands at or before the
		// target and playback is polled at 50ms, so the raw recording is
		// wider than the range that was asked for.
		const segment = record(4.5, 8);

		const clip = cutSegment(segment, 5, 11);

		expect(clip.pcm.length).toBeCloseTo(6 * RATE, -1);
		expect(timeAt(clip, 0)).toBeCloseTo(5, 1);
		expect(timeAt(clip, clip.pcm.length - 1)).toBeCloseTo(11, 1);
	});

	it('returns the range unchanged when the recording matches it exactly', () => {
		const clip = cutSegment(record(5, 3), 5, 8);

		expect(clip.pcm.length).toBeCloseTo(3 * RATE, -1);
		expect(timeAt(clip, 0)).toBeCloseTo(5, 1);
	});

	it('clamps to what was recorded rather than failing', () => {
		// A capture cut short by the file ending still holds the sentence; the
		// missing part is padding, and a slightly short clip beats no card.
		const segment = record(5, 2);

		const clip = cutSegment(segment, 5, 20);

		expect(clip.pcm.length).toBe(segment.pcm.length);
		expect(timeAt(clip, 0)).toBeCloseTo(5, 1);
	});

	it('rejects a recording with no audio in it', () => {
		expect(() =>
			cutSegment({ pcm: new Float32Array(0), sampleRate: RATE, anchors: [] }, 5, 8)
		).toThrow(CaptureError);
	});
});

describe('mediaToFrame', () => {
	it('interpolates within the chunk a timestamp falls in', () => {
		const segment = record(10, 4);

		// 0.5s past the start of a recording that began at 10s.
		expect(mediaToFrame(segment, 10.5)).toBeCloseTo(0.5 * RATE, -1);
		expect(mediaToFrame(segment, 12)).toBeCloseTo(2 * RATE, -1);
	});

	it('reports timestamps outside the recording as absent', () => {
		const segment = record(10, 4);

		expect(mediaToFrame(segment, 9)).toBeNull();
		expect(mediaToFrame(segment, 99)).toBeNull();
	});

	it('refuses to interpolate across a discontinuity', () => {
		// Two recordings spliced together, as would happen if playback jumped.
		const segment = record(10, 1);
		segment.anchors.push({ frame: segment.pcm.length, mediaTime: 80 });

		expect(mediaToFrame(segment, 45)).toBeNull();
	});
});

describe('captureRange length cap', () => {
	it('rejects a segment longer than the cap before touching audio', async () => {
		const { captureRange } = await import('$lib/anki/capture');
		await expect(captureRange('x', 0, 10_000)).rejects.toMatchObject({ reason: 'too-long' });
	});
});
