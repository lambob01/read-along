import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchWithDeadline } from '$lib/abs/proxy-fetch';

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				resolve(`http://127.0.0.1:${address.port}`);
			}
		});
	});
}

function close(server: Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('fetchWithDeadline', () => {
	let slowBody: Server;
	let slowBodyUrl: string;
	let hanging: Server;
	let hangingUrl: string;

	beforeAll(async () => {
		// Sends headers immediately, then keeps writing for three times the
		// header deadline below.
		slowBody = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.write('first ');
			setTimeout(() => res.write('second '), 150);
			setTimeout(() => res.end('third'), 300);
		});
		slowBodyUrl = await listen(slowBody);

		// Accepts the connection and never answers.
		hanging = createServer(() => {});
		hangingUrl = await listen(hanging);
	});

	afterAll(async () => {
		await close(slowBody);
		await close(hanging);
	});

	it('delivers a body that outlives the header deadline', { timeout: 5000 }, async () => {
		const res = await fetchWithDeadline(fetch, slowBodyUrl, {}, 100);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('first second third');
	});

	it('still aborts when the headers never arrive', { timeout: 2000 }, async () => {
		await expect(fetchWithDeadline(fetch, hangingUrl, {}, 50)).rejects.toBeInstanceOf(DOMException);
	});
});
