/**
 * On-demand capture of an arbitrary time range of the book's audio.
 *
 * Clipping the range out of the source file directly is not an option: the
 * books are M4B (AAC in an MP4 container), so a byte range fetched around a
 * sentence carries no container header and will not decode. Nor can the range
 * be taken from what the user happened to have played — anything not recently
 * heard, or heard before a seek, simply is not there.
 *
 * So the range is re-played to obtain it. A throwaway audio element seeks to
 * the sentence and plays it through a muted Web Audio tap while an
 * AudioWorklet collects the PCM. This works for any timestamp in the book
 * whether or not it has ever been listened to, for any format the browser can
 * play, and it leaves the reader's own audio element untouched.
 *
 * The cost is that a capture takes as long as the sentence does. That is the
 * price of never failing, which is the property that matters here.
 */

/** Frames per message from the worklet — ~85ms at 48kHz. */
const CHUNK_FRAMES = 4096;

/**
 * Largest media-time gap two adjacent anchors may span before the pair is
 * treated as a discontinuity rather than continuous playback.
 */
const MAX_ANCHOR_SPAN = 1;

/** Grace beyond the segment's own length before a capture is abandoned. */
const STALL_TIMEOUT_MS = 15000;

/** Seeking deep into a long remote file needs more room than a local one. */
const SEEK_TIMEOUT_MS = 30000;

/** Cap on the setup steps that can hang instead of rejecting. */
const RESUME_TIMEOUT_MS = 5000;

/**
 * Rejects if `promise` has not settled in time.
 *
 * Several Web Audio calls signal refusal by never settling rather than by
 * throwing, which surfaces as a button stuck at 0% with nothing logged.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new CaptureError('blocked', message)), ms)
		)
	]);
}

/**
 * Ties a position in the recording to the media timestamp of the audio stored
 * there. Sampled per chunk rather than computed, because the relationship
 * between the two clocks depends on decode and output buffering.
 */
interface Anchor {
	frame: number;
	mediaTime: number;
}

export interface Segment {
	pcm: Float32Array;
	sampleRate: number;
	anchors: Anchor[];
}

export interface Clip {
	pcm: Float32Array;
	sampleRate: number;
}

export type CaptureFailure = 'unavailable' | 'load-failed' | 'stalled' | 'blocked' | 'empty';

/** Where a capture got to, so a stall reports the step that hung. */
type Stage = 'loading' | 'seeking' | 'starting' | 'recording';

/**
 * Snapshot of everything that explains a stuck capture. Logged on failure
 * because the interesting state is gone by the time anyone can inspect it.
 */
function diagnose(el: HTMLAudioElement, c: AudioContext, stage: Stage) {
	return {
		stage,
		context: c.state,
		readyState: el.readyState,
		networkState: el.networkState,
		currentTime: el.currentTime,
		duration: el.duration,
		paused: el.paused,
		buffered: el.buffered.length > 0 ? `${el.buffered.start(0)}-${el.buffered.end(0)}` : 'none',
		error: el.error ? `${el.error.code}: ${el.error.message}` : null
	};
}

export class CaptureError extends Error {
	constructor(
		public readonly reason: CaptureFailure,
		message: string
	) {
		super(message);
		this.name = 'CaptureError';
	}
}

const WORKLET_SOURCE = `
class ReadAlongCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buf = new Float32Array(${CHUNK_FRAMES});
		this.n = 0;
	}

	process(inputs) {
		const input = inputs[0];
		if (!input || input.length === 0) return true;
		const left = input[0];
		if (!left) return true;
		const right = input.length > 1 ? input[1] : null;

		for (let i = 0; i < left.length; i++) {
			this.buf[this.n++] = right ? (left[i] + right[i]) * 0.5 : left[i];
			if (this.n === ${CHUNK_FRAMES}) {
				const out = this.buf.slice(0);
				this.port.postMessage(out, [out.buffer]);
				this.n = 0;
			}
		}
		return true;
	}
}
registerProcessor('readalong-capture', ReadAlongCapture);
`;

let ctx: AudioContext | null = null;
let workletReady: Promise<boolean> | null = null;

function audioContext(): AudioContext {
	if (ctx) return ctx;
	const Ctor: typeof AudioContext | undefined =
		typeof AudioContext !== 'undefined'
			? AudioContext
			: (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) throw new CaptureError('unavailable', 'Web Audio is not available in this browser');
	ctx = new Ctor();
	return ctx;
}

/**
 * Call from a user gesture. Browsers start an AudioContext suspended, and a
 * suspended context yields no frames at all — the capture would time out.
 */
export async function primeCapture(): Promise<void> {
	try {
		const c = audioContext();
		if (c.state === 'suspended') await c.resume();
	} catch {
		/* the capture itself will report the failure */
	}
}

/**
 * The worklet is loaded from a blob so no extra asset has to survive the
 * static build and the service worker's cache list.
 */
async function ensureWorklet(c: AudioContext): Promise<boolean> {
	if (!c.audioWorklet) return false;
	if (!workletReady) {
		workletReady = (async () => {
			const url = URL.createObjectURL(
				new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
			);
			try {
				await c.audioWorklet.addModule(url);
				return true;
			} catch {
				return false;
			} finally {
				URL.revokeObjectURL(url);
			}
		})();
	}
	return workletReady;
}

function createCaptureNode(
	c: AudioContext,
	useWorklet: boolean,
	onChunk: (samples: Float32Array) => void
): AudioNode {
	if (useWorklet) {
		const node = new AudioWorkletNode(c, 'readalong-capture', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1]
		});
		node.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
		return node;
	}

	// Deprecated, but the only tap available on engines without AudioWorklet.
	const node = c.createScriptProcessor(CHUNK_FRAMES, 2, 1);
	node.onaudioprocess = (e) => {
		const left = e.inputBuffer.getChannelData(0);
		const right = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : null;
		const mono = new Float32Array(left.length);
		for (let i = 0; i < left.length; i++) {
			mono[i] = right ? (left[i] + right[i]) * 0.5 : left[i];
		}
		onChunk(mono);
	};
	return node;
}

function once(
	el: HTMLMediaElement,
	event: string,
	timeoutMs: number,
	label: string
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new CaptureError('stalled', `${label} — see console for details`));
		}, timeoutMs);
		const onOk = () => {
			cleanup();
			resolve();
		};
		const onErr = () => {
			cleanup();
			reject(new CaptureError('load-failed', 'The audio file could not be loaded for capture'));
		};
		function cleanup() {
			clearTimeout(timer);
			el.removeEventListener(event, onOk);
			el.removeEventListener('error', onErr);
		}
		el.addEventListener(event, onOk);
		el.addEventListener('error', onErr);
	});
}

export interface CaptureOptions {
	/** Seconds of audio kept before the sentence starts. */
	padStart?: number;
	/** Seconds of audio kept after the sentence ends. */
	padEnd?: number;
	/** Reports elapsed capture progress, 0..1, for a determinate spinner. */
	onProgress?: (fraction: number) => void;
	/**
	 * Distinguishes the one-off load from the recording, which need different
	 * UI: the first has no meaningful percentage and can take a while.
	 */
	onPhase?: (phase: 'preparing' | 'recording') => void;
}

/**
 * The capture element and its audio graph, kept alive between mines.
 *
 * Rebuilding this per capture is what made mining unusable on a real
 * audiobook. A five-hour M4B carries a sample table covering hundreds of
 * thousands of AAC frames, so `loadedmetadata` means downloading several
 * megabytes of index before a single second of audio can be sought — a cost
 * worth paying once per book, never once per card.
 *
 * `createMediaElementSource` can only ever be called once for an element, so
 * the graph has to be as long-lived as the element. `sink` is rebound per
 * capture instead of reconnecting nodes.
 */
interface Rig {
	el: HTMLAudioElement;
	src: string;
	sink: ((samples: Float32Array) => void) | null;
	dispose: () => void;
}

let rigPromise: Promise<Rig> | null = null;
let currentRig: Rig | null = null;

/** Metadata for a long book is a large download; only ever paid once. */
const PREPARE_TIMEOUT_MS = 120000;

async function getRig(c: AudioContext, src: string, useWorklet: boolean): Promise<Rig> {
	if (currentRig && currentRig.src === src) return currentRig;
	if (currentRig) {
		currentRig.dispose();
		currentRig = null;
		rigPromise = null;
	}
	if (rigPromise) return rigPromise;

	rigPromise = (async () => {
		const el = new Audio();
		// Not 'auto': the point of this element is to seek, and letting it
		// greedily buffer a multi-hour book from byte zero competes with the
		// reader's own streaming for both bandwidth and connections.
		el.preload = 'metadata';
		el.src = src;
		// Rate 1 with pitch preserved: the captured samples are the book's own
		// audio, not a resampled approximation of it.
		el.playbackRate = 1;
		el.preservesPitch = true;

		const source = c.createMediaElementSource(el);
		// A muted path to the destination: the tap must be reachable from the
		// destination to be scheduled, but must not be audible over the
		// reader's own playback.
		const silent = c.createGain();
		silent.gain.value = 0;

		const rig: Rig = {
			el,
			src,
			sink: null,
			dispose: () => {
				try {
					el.pause();
					source.disconnect();
					node.disconnect();
					silent.disconnect();
				} catch {
					/* already torn down */
				}
				el.removeAttribute('src');
				el.load();
			}
		};

		const node = createCaptureNode(c, useWorklet, (samples) => rig.sink?.(samples));
		source.connect(node);
		node.connect(silent);
		silent.connect(c.destination);

		if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
			const started = Date.now();
			await once(
				el,
				'loadedmetadata',
				PREPARE_TIMEOUT_MS,
				'The audio file did not load for capture'
			);
			console.info('[readalong] capture element ready', {
				ms: Date.now() - started,
				duration: el.duration
			});
		}

		currentRig = rig;
		return rig;
	})();

	try {
		return await rigPromise;
	} catch (err) {
		rigPromise = null;
		throw err;
	}
}

/** Drops the capture element, e.g. when leaving a book. */
export function releaseCapture() {
	currentRig?.dispose();
	currentRig = null;
	rigPromise = null;
}

/**
 * Records [start, end] of `src` by playing it inaudibly.
 *
 * Deliberately independent of the reader's own player: it owns its own element
 * so the user's playback position, rate and buffering are untouched, and so
 * nothing has to be permanently rewired into a Web Audio graph.
 */
export async function captureRange(
	src: string,
	start: number,
	end: number,
	opts: CaptureOptions = {}
): Promise<Clip> {
	const from = Math.max(0, start - (opts.padStart ?? 0));
	const to = end + (opts.padEnd ?? 0);
	if (!(to > from)) throw new CaptureError('empty', 'That line has no duration to capture');

	const c = audioContext();
	console.info('[readalong] capture starting', { from, to, context: c.state, src });

	// Both of these can hang rather than reject. A blocked AudioContext.resume()
	// in particular stays pending forever instead of throwing, which is exactly
	// the silent stall this guards against.
	if (c.state === 'suspended') {
		await withTimeout(
			c.resume(),
			RESUME_TIMEOUT_MS,
			'The browser would not start audio for the capture — press play in the reader once, then mine again'
		);
	}
	const useWorklet = await withTimeout(
		ensureWorklet(c),
		RESUME_TIMEOUT_MS,
		'The audio capture module did not load'
	).catch(() => false);

	const chunks: Float32Array[] = [];
	const anchors: Anchor[] = [];
	let total = 0;
	let latency = 0;

	let stage: Stage = 'loading';
	let rig: Rig;
	try {
		opts.onPhase?.('preparing');
		rig = await getRig(c, src, useWorklet);
	} catch (err) {
		console.error('[readalong] capture failed', { stage, context: c.state, error: String(err) });
		throw err;
	}
	const el = rig.el;

	rig.sink = (samples) => {
		if (el.paused) return;
		chunks.push(samples);
		anchors.push({
			frame: total,
			// The element's clock has already moved past the chunk in hand by
			// the chunk itself plus whatever the output stage buffers.
			mediaTime: el.currentTime - (samples.length / c.sampleRate + latency)
		});
		total += samples.length;
	};

	const teardown = () => {
		rig.sink = null;
		try {
			el.pause();
		} catch {
			/* already stopped */
		}
	};

	try {
		opts.onPhase?.('recording');
		stage = 'seeking';
		el.currentTime = from;
		// Likewise: a seek inside already-buffered audio can complete before
		// the listener is attached.
		if (Math.abs(el.currentTime - from) > 0.01 || el.seeking) {
			await once(el, 'seeked', SEEK_TIMEOUT_MS, 'Seeking to that line timed out');
		}

		stage = 'starting';
		latency = c.outputLatency || c.baseLatency || 0;
		// play() rejects when autoplay is blocked, but it can stay pending
		// indefinitely when the media never gets enough data — without this
		// race, that hangs the button at 0% with nothing to report.
		await Promise.race([
			el.play(),
			new Promise((_, reject) =>
				setTimeout(
					() =>
						reject(
							new CaptureError('stalled', 'Playback for the capture never started — see console')
						),
					STALL_TIMEOUT_MS
				)
			)
		]);

		stage = 'recording';
		const span = to - from;
		// A capture is only as slow as the sentence, so the budget tracks
		// progress rather than total time: it resets whenever the playhead
		// actually moves, and only fires when it stops moving.
		let lastSeen = el.currentTime;
		let lastMoved = Date.now();
		while (el.currentTime < to && !el.ended) {
			if (el.currentTime > lastSeen + 0.01) {
				lastSeen = el.currentTime;
				lastMoved = Date.now();
			} else if (Date.now() - lastMoved > STALL_TIMEOUT_MS) {
				throw new CaptureError('stalled', 'Capture stalled part-way through — see console');
			}
			opts.onProgress?.(Math.min(1, Math.max(0, (el.currentTime - from) / span)));
			await new Promise((r) => setTimeout(r, 50));
		}
		opts.onProgress?.(1);
	} catch (err) {
		// The element is torn down in `finally`, so capture the state first.
		console.error('[readalong] capture failed', diagnose(el, c, stage));
		if (err instanceof CaptureError) throw err;
		const name = err instanceof Error ? err.name : '';
		if (name === 'NotAllowedError') {
			throw new CaptureError(
				'blocked',
				'The browser blocked the capture playback — press play in the reader once, then mine again'
			);
		}
		throw new CaptureError(
			'load-failed',
			err instanceof Error ? err.message : 'The audio could not be captured'
		);
	} finally {
		teardown();
	}

	console.info('[readalong] capture finished', {
		frames: total,
		seconds: (total / c.sampleRate).toFixed(2),
		worklet: useWorklet
	});

	if (total === 0) {
		throw new CaptureError(
			'empty',
			useWorklet
				? 'No audio reached the capture — the browser may have muted the hidden playback'
				: 'No audio was captured for that line'
		);
	}

	const pcm = new Float32Array(total);
	let at = 0;
	for (const chunk of chunks) {
		pcm.set(chunk, at);
		at += chunk.length;
	}

	return cutSegment({ pcm, sampleRate: c.sampleRate, anchors }, from, to);
}

/**
 * Locates a media timestamp within a recording.
 *
 * Scanning newest-first is deliberate: if the same timestamp was somehow
 * recorded twice, the later copy is the one the caller means. A bracketing
 * pair spanning more than `MAX_ANCHOR_SPAN` of media time covers a
 * discontinuity, where interpolation would be meaningless.
 */
export function mediaToFrame(segment: Segment, mediaTime: number): number | null {
	const a = segment.anchors;
	for (let i = a.length - 1; i > 0; i--) {
		const hi = a[i];
		const lo = a[i - 1];
		if (lo.mediaTime > mediaTime || hi.mediaTime < mediaTime) continue;
		const span = hi.mediaTime - lo.mediaTime;
		const frames = hi.frame - lo.frame;
		if (span <= 0 || span > MAX_ANCHOR_SPAN || frames <= 0) continue;
		return Math.round(lo.frame + ((mediaTime - lo.mediaTime) / span) * frames);
	}
	return null;
}

/**
 * Trims a recording down to exactly [start, end].
 *
 * The recording always overshoots at both ends — playback is started slightly
 * before the range and polled at 50ms, and the seek lands on a frame boundary
 * at or before the target — so the anchors are what make the cut exact rather
 * than approximate. Ends that fall outside the anchors are clamped instead of
 * failing: the audio either side is padding, and a clip a few milliseconds
 * short beats no card.
 */
export function cutSegment(segment: Segment, start: number, end: number): Clip {
	const first = mediaToFrame(segment, start) ?? 0;
	const last = mediaToFrame(segment, end) ?? segment.pcm.length;
	const from = Math.max(0, Math.min(first, segment.pcm.length));
	const to = Math.max(from, Math.min(last, segment.pcm.length));

	if (to - from === 0) {
		throw new CaptureError('empty', 'No audio was captured for that line');
	}
	return { pcm: segment.pcm.subarray(from, to), sampleRate: segment.sampleRate };
}
