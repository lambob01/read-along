import { describe, it, expect } from 'vitest';
import { createLatestRequests } from './latest';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('createLatestRequests', () => {
	it('applies only the last requested load when responses land out of order', async () => {
		const latest = createLatestRequests();
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		const applied: string[][] = [];
		const errors: unknown[] = [];

		const firstRun = latest.run(
			() => first.promise,
			(value) => applied.push(value),
			(err) => errors.push(err)
		);
		const secondRun = latest.run(
			() => second.promise,
			(value) => applied.push(value),
			(err) => errors.push(err)
		);

		// The later click answers first, then the earlier one straggles in.
		second.resolve(['second']);
		await secondRun;
		first.resolve(['first']);
		await firstRun;

		expect(applied).toEqual([['second']]);
		expect(errors).toEqual([]);
	});

	it('drops an error belonging to a superseded request', async () => {
		const latest = createLatestRequests();
		const stale = deferred<string[]>();
		const current = deferred<string[]>();
		const errors: unknown[] = [];
		const applied: string[][] = [];

		const staleRun = latest.run(
			() => stale.promise,
			(value) => applied.push(value),
			(err) => errors.push(err)
		);
		const currentRun = latest.run(
			() => current.promise,
			(value) => applied.push(value),
			(err) => errors.push(err)
		);

		stale.reject(new Error('library no longer selected'));
		await staleRun;
		current.resolve(['current']);
		await currentRun;

		expect(errors).toEqual([]);
		expect(applied).toEqual([['current']]);
	});

	it('reports the error of the newest request', async () => {
		const latest = createLatestRequests();
		const boom = new Error('boom');
		const errors: unknown[] = [];

		await latest.run(
			() => Promise.reject(boom),
			() => {},
			(err) => errors.push(err)
		);

		expect(errors).toEqual([boom]);
	});

	it('drops everything in flight after cancel', async () => {
		const latest = createLatestRequests();
		const request = deferred<string[]>();
		const applied: string[][] = [];
		const errors: unknown[] = [];

		const run = latest.run(
			() => request.promise,
			(value) => applied.push(value),
			(err) => errors.push(err)
		);
		latest.cancel();
		request.resolve(['late']);
		await run;

		expect(applied).toEqual([]);
		expect(errors).toEqual([]);
	});
});
