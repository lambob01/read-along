import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABSClient } from '$lib/abs/client';

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

describe('ABSClient timeout', () => {
	let hanging: Server;
	let hangingUrl: string;

	beforeAll(async () => {
		// Accepts the connection and never answers, so only the client's own
		// timeout can end the request.
		hanging = createServer(() => {});
		hangingUrl = await listen(hanging);
	});

	afterAll(() => close(hanging));

	it('rejects an unanswered request with a timeout error', { timeout: 2000 }, async () => {
		const client = new ABSClient(hangingUrl, 'token', 50);

		await expect(client.get('/api/items')).rejects.toMatchObject({
			name: 'ABSError',
			message: 'Request timed out',
			status: 0
		});
	});

	it('rejects an unanswered binary request with a timeout error', { timeout: 2000 }, async () => {
		const client = new ABSClient(hangingUrl, 'token', 50);

		await expect(client.getBinary('/api/items/1/file/2')).rejects.toMatchObject({
			name: 'ABSError',
			message: 'Request timed out',
			status: 0
		});
	});
});

describe('ABSClient error mapping', () => {
	let unauthorized: Server;
	let unauthorizedUrl: string;

	beforeAll(async () => {
		unauthorized = createServer((_req, res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'Unauthorized' }));
		});
		unauthorizedUrl = await listen(unauthorized);
	});

	afterAll(() => close(unauthorized));

	it('maps 401 to the unauthorized message', async () => {
		const client = new ABSClient(unauthorizedUrl, 'bad-token');

		await expect(client.get('/api/items')).rejects.toMatchObject({
			name: 'ABSError',
			message: 'Unauthorized — check your API token',
			status: 401
		});
	});
});
