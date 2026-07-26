import type { TimingIndex } from '$lib/types';

export interface SyncController {
	start(): void;
	stop(): void;
	seek(time: number): void;
}

export function createSyncController(
	audio: HTMLAudioElement,
	index: TimingIndex,
	onActivate: (sentenceId: number | null) => void
): SyncController {
	let cursor = 0;
	let rafId: number | null = null;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let usingRAF = false;
	const frameDeltas: number[] = [];
	let lastFrameTime = 0;

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

	function tick() {
		if (!audio) return;
		const time = audio.currentTime;
		const id = findSentence(time);
		setActive(id);

		if (!audio.paused) {
			const now = performance.now();
			if (lastFrameTime > 0) {
				const delta = now - lastFrameTime;
				frameDeltas.push(delta);
				if (frameDeltas.length > 3) frameDeltas.shift();

				if (
					frameDeltas.length === 3 &&
					frameDeltas.every((d) => d > 150)
				) {
					switchToInterval();
					return;
				}
			}
			lastFrameTime = now;
		}

		rafId = requestAnimationFrame(tick);
	}

	function switchToInterval() {
		if (!usingRAF) return;
		usingRAF = false;
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		intervalId = setInterval(tick, 100);
	}

	function switchToRAF() {
		if (usingRAF) return;
		usingRAF = true;
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}
		frameDeltas.length = 0;
		lastFrameTime = 0;
		rafId = requestAnimationFrame(tick);
	}

	audio.addEventListener('play', switchToRAF);

	return {
		start() {
			if (audio.paused) return;
			switchToRAF();
		},
		stop() {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (intervalId !== null) {
				clearInterval(intervalId);
				intervalId = null;
			}
		},
		seek(time: number) {
			cursor = 0;
			audio.currentTime = time;
			const id = findSentence(time);
			setActive(id);
		}
	};
}
