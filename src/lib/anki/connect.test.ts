import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnkiError, ankiVersion, REQUEST_TIMEOUT_MS } from '$lib/anki/connect';

const TARGET = { url: 'http://localhost:8765' };

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('ankiVersion', () => {
	it('returns the version from a healthy AnkiConnect', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ result: 6, error: null })
			})
		);
		await expect(ankiVersion(TARGET)).resolves.toBe(6);
	});

	it('gives up after the timeout when Anki never answers', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: RequestInit) => {
				// Without a signal the old code never aborts: the promise must
				// stay pending forever, so the test fails by vitest's own
				// timeout pre-fix rather than passing for the wrong reason.
				if (!init.signal) return new Promise(() => {});
				const signal = init.signal as AbortSignal;
				return new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('Aborted')));
				});
			})
		);

		const promise = ankiVersion(TARGET);
		vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
		await expect(promise).rejects.toMatchObject({ kind: 'unreachable' });
	});

	it('names an unreadable response body instead of leaking a SyntaxError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => {
					throw new SyntaxError('Unexpected token < in JSON at position 0');
				}
			})
		);

		const err = await ankiVersion(TARGET).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(AnkiError);
		expect((err as Error).message).toMatch(/JSON/);
	});

	it('rejects a JSON body that carries no result', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

		const err = await ankiVersion(TARGET).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(AnkiError);
		expect((err as Error).message).toMatch(/no result/i);
	});
});
