import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	CaptureError,
	captureRange,
	cutSegment,
	getRig,
	mediaToFrame,
	redactUrl,
	releaseCapture,
	PREPARE_TIMEOUT_MS,
	type Segment
} from '$lib/anki/capture';

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
		await expect(captureRange('x', 0, 10_000)).rejects.toMatchObject({ reason: 'too-long' });
	});
});

class FakeNode {
	disconnects = 0;
	connect(_target?: unknown) {
		return this;
	}
	disconnect() {
		this.disconnects++;
	}
}

class FakeGain extends FakeNode {
	gain = { value: 0 };
}

class FakeProcessor extends FakeNode {
	onaudioprocess: ((event: unknown) => void) | null = null;
}

/** The stand-in graph `getRig` builds, so disconnects can be observed. */
class FakeContext {
	state = 'running';
	sampleRate = 48000;
	destination = new FakeNode();
	sources: FakeNode[] = [];
	gains: FakeGain[] = [];
	processors: FakeProcessor[] = [];
	resume = async () => {};
	createMediaElementSource() {
		const node = new FakeNode();
		this.sources.push(node);
		return node;
	}
	createGain() {
		const gain = new FakeGain();
		this.gains.push(gain);
		return gain;
	}
	createScriptProcessor() {
		const processor = new FakeProcessor();
		this.processors.push(processor);
		return processor;
	}
}

class FakeAudio {
	static instances: FakeAudio[] = [];
	src = '';
	readyState = 0;
	duration = NaN;
	preload = '';
	playbackRate = 1;
	preservesPitch = true;
	paused = true;
	loads = 0;
	private listeners = new Map<string, Set<() => void>>();

	constructor() {
		FakeAudio.instances.push(this);
	}

	pause() {
		this.paused = true;
	}

	load() {
		this.loads++;
	}

	removeAttribute(name: string) {
		if (name === 'src') this.src = '';
	}

	addEventListener(type: string, fn: () => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)?.add(fn);
	}

	removeEventListener(type: string, fn: () => void) {
		this.listeners.get(type)?.delete(fn);
	}

	dispatch(type: string) {
		for (const fn of this.listeners.get(type) ?? []) fn();
	}
}

const asContext = (c: FakeContext) => c as unknown as AudioContext;

beforeEach(() => {
	FakeAudio.instances = [];
	vi.stubGlobal('Audio', FakeAudio);
	// `getRig` gates on the media constant, which node does not define.
	vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1 });
});

afterEach(() => {
	releaseCapture();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('getRig', () => {
	it('disposes the element and graph when metadata never arrives', async () => {
		vi.useFakeTimers();
		const c = new FakeContext();

		const pending = getRig(asContext(c), '/abs/audio?token=SECRET', false);
		const el = FakeAudio.instances[0];
		const failed = expect(pending).rejects.toMatchObject({ reason: 'stalled' });

		await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
		await failed;

		expect(el.src).toBe('');
		expect(el.loads).toBe(1);
		expect(c.sources[0].disconnects).toBeGreaterThan(0);
		expect(c.processors[0].disconnects).toBeGreaterThan(0);
		expect(c.gains[0].disconnects).toBeGreaterThan(0);
	});

	it('builds a fresh rig when a different source is requested mid-load', async () => {
		vi.useFakeTimers();
		const c = new FakeContext();

		const first = getRig(asContext(c), 'book-a.mp3', false);
		const firstEl = FakeAudio.instances[0];
		const second = getRig(asContext(c), 'book-b.mp3', false);
		const secondEl = FakeAudio.instances[1];

		expect(secondEl).not.toBe(firstEl);
		expect(secondEl.src).toBe('book-b.mp3');
		// The abandoned book's element must not stay connected to the graph.
		expect(firstEl.src).toBe('');
		expect(c.sources[0].disconnects).toBeGreaterThan(0);

		secondEl.readyState = 1;
		secondEl.dispatch('loadedmetadata');
		await expect(second).resolves.toMatchObject({ src: 'book-b.mp3' });

		const failed = expect(first).rejects.toMatchObject({ reason: 'stalled' });
		await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
		await failed;
	});

	it('reuses the element already prepared for the same source', async () => {
		const c = new FakeContext();
		const first = getRig(asContext(c), 'book-a.mp3', false);
		const el = FakeAudio.instances[0];
		el.readyState = 1;
		el.dispatch('loadedmetadata');
		const rig = await first;

		await expect(getRig(asContext(c), 'book-a.mp3', false)).resolves.toBe(rig);
		expect(FakeAudio.instances).toHaveLength(1);
	});
});

describe('redactUrl', () => {
	it('drops the query so a logged source cannot leak the ABS token', () => {
		expect(redactUrl('/abs/audio/abc?token=SECRET')).toBe('/abs/audio/abc');
	});

	it('leaves a URL without a query alone', () => {
		expect(redactUrl('/abs/audio/abc')).toBe('/abs/audio/abc');
	});
});

describe('captureRange logging', () => {
	it('does not log the access token in the source URL', async () => {
		vi.useFakeTimers();
		const c = new FakeContext();
		c.state = 'suspended';
		c.resume = () => Promise.reject(new Error('blocked'));
		vi.stubGlobal(
			'AudioContext',
			class {
				constructor() {
					return c;
				}
			} as unknown as typeof AudioContext
		);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});

		await expect(captureRange('/abs/audio?token=SECRET', 0, 1)).rejects.toThrow();

		const logged = JSON.stringify(info.mock.calls);
		expect(logged).toContain('capture starting');
		expect(logged).not.toContain('SECRET');
	});
});
