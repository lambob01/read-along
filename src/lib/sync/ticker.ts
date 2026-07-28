import type { TimingIndex } from '$lib/types';

export interface SyncController {
	start(): void;
	stop(): void;
	seek(time: number): void;
	/**
	 * Shifts which sentence is lit for a given audio position. Positive values
	 * make the text lead the audio, negative make it trail. Applies on the next
	 * evaluation, which is forced immediately so the change is visible while
	 * paused.
	 */
	setOffset(seconds: number): void;
	/** Detaches the audio listeners. The audio element outlives this page. */
	destroy(): void;
}

export function createSyncController(
	audio: HTMLAudioElement,
	index: TimingIndex,
	onActivate: (sentenceId: number | null) => void,
	initialOffset = 0
): SyncController {
	let cursor = 0;
	let rafId: number | null = null;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let usingRAF = false;
	const frameDeltas: number[] = [];
	let lastFrameTime = 0;
	let offset = initialOffset;

	let activeId: number | null = null;

	function setActive(id: number | null) {
		if (id !== activeId) {
			activeId = id;
			onActivate(id);
		}
	}

	function findSentence(time: number): number | null {
		const { starts, ends, sentences } = index;
		const len = sentences.length;
		if (len === 0) return null;

		if (time >= starts[cursor] && time < ends[cursor]) {
			return sentences[cursor]?.id ?? null;
		}

		if (cursor + 1 < len && time >= starts[cursor + 1] && time < ends[cursor + 1]) {
			cursor = cursor + 1;
			return sentences[cursor].id;
		}

		if (cursor + 2 < len && time >= starts[cursor + 2] && time < ends[cursor + 2]) {
			cursor = cursor + 2;
			return sentences[cursor].id;
		}

		for (let i = -3; i <= 3; i++) {
			const idx = cursor + i;
			if (idx >= 0 && idx < len) {
				if (time >= starts[idx] && time < ends[idx]) {
					cursor = idx;
					return sentences[cursor].id;
				}
			}
		}

		let lo = 0;
		let hi = len - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (time < starts[mid]) {
				hi = mid - 1;
			} else if (time >= ends[mid]) {
				lo = mid + 1;
			} else {
				cursor = mid;
				return sentences[cursor].id;
			}
		}

		return null;
	}

	/** One synchronous sample. Safe to call outside the loop (paused, seeked). */
	function evaluate() {
		if (!audio) return;
		setActive(findSentence(audio.currentTime + offset));
	}

	/**
	 * The driven loop body. Only this re-arms RAF, so `evaluate` stays safe to
	 * call from event handlers without starting a second chain.
	 */
	function loop() {
		evaluate();

		if (!audio.paused) {
			const now = performance.now();
			if (lastFrameTime > 0) {
				const delta = now - lastFrameTime;
				frameDeltas.push(delta);
				if (frameDeltas.length > 3) frameDeltas.shift();

				if (frameDeltas.length === 3 && frameDeltas.every((d) => d > 150)) {
					switchToInterval();
					return;
				}
			}
			lastFrameTime = now;
		}

		// Interval mode drives `loop` from its own timer; re-arming here too
		// would leave both running.
		if (usingRAF) {
			rafId = requestAnimationFrame(loop);
		}
	}

	/**
	 * The frame-delta heuristic in `loop` can only fire while frames are still
	 * arriving, so it catches a throttled tab but not a suspended one. On mobile
	 * a locked screen stops RAF outright while audio keeps playing, and without
	 * this the last sentence stays lit until the user returns.
	 */
	function handleVisibility() {
		if (typeof document === 'undefined') return;
		if (document.hidden) {
			switchToInterval();
		} else {
			evaluate();
			if (!audio.paused) switchToRAF();
		}
	}

	/**
	 * A driver of last resort. `timeupdate` keeps firing (roughly 4Hz) when the
	 * page is backgrounded and both RAF and timers are throttled, so the
	 * highlight still advances rather than freezing mid-sentence.
	 */
	function handleTimeUpdate() {
		evaluate();
	}

	function clearTimers() {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}
	}

	function switchToInterval() {
		if (!usingRAF) return;
		usingRAF = false;
		clearTimers();
		intervalId = setInterval(loop, 100);
	}

	function switchToRAF() {
		if (usingRAF && rafId !== null) return;
		usingRAF = true;
		clearTimers();
		frameDeltas.length = 0;
		lastFrameTime = 0;
		rafId = requestAnimationFrame(loop);
	}

	function handlePlay() {
		switchToRAF();
	}

	/**
	 * Stopping on pause keeps a backgrounded phone from spinning the loop, but
	 * the final sample still has to run: the pause may land in a gap, and the
	 * sentence lit before it would otherwise stay lit indefinitely.
	 */
	function handleStop() {
		usingRAF = false;
		clearTimers();
		evaluate();
	}

	function handleSeeked() {
		cursor = 0;
		evaluate();
	}

	audio.addEventListener('play', handlePlay);
	audio.addEventListener('pause', handleStop);
	audio.addEventListener('ended', handleStop);
	audio.addEventListener('seeked', handleSeeked);
	audio.addEventListener('timeupdate', handleTimeUpdate);
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', handleVisibility);
	}

	return {
		start() {
			evaluate();
			if (audio.paused) return;
			switchToRAF();
		},
		stop() {
			usingRAF = false;
			clearTimers();
		},
		seek(time: number) {
			cursor = 0;
			audio.currentTime = time;
			evaluate();
		},
		setOffset(seconds: number) {
			offset = seconds;
			cursor = 0;
			evaluate();
		},
		destroy() {
			usingRAF = false;
			clearTimers();
			audio.removeEventListener('play', handlePlay);
			audio.removeEventListener('pause', handleStop);
			audio.removeEventListener('ended', handleStop);
			audio.removeEventListener('seeked', handleSeeked);
			audio.removeEventListener('timeupdate', handleTimeUpdate);
			if (typeof document !== 'undefined') {
				document.removeEventListener('visibilitychange', handleVisibility);
			}
		}
	};
}
