import { PUBLIC_ABS_ORIGIN } from '$env/static/public';
import type { RequestHandler } from './$types';

const ABS_ORIGIN = PUBLIC_ABS_ORIGIN || 'http://localhost:13378';

function filterHeaders(headers: Headers): Headers {
	const filtered = new Headers();
	headers.forEach((value, key) => {
		const name = key.toLowerCase();
		if (name === 'host' || name === 'origin' || name === 'referer') return;
		filtered.set(key, value);
	});
	return filtered;
}

async function proxy(
	request: Request,
	params: { path: string },
	method: string
): Promise<Response> {
	const path = params.path;
	const target = new URL(`/${path}`, ABS_ORIGIN);
	const url = new URL(request.url);
	target.search = url.search;

	const init: RequestInit = {
		method,
		headers: filterHeaders(request.headers),
		redirect: 'manual'
	};

	if (method !== 'GET' && method !== 'HEAD' && request.body) {
		init.body = request.body;
		(init as any).duplex = 'half';
	}

	try {
		const res = await fetch(target.toString(), init);

		const resHeaders = new Headers();
		res.headers.forEach((value, key) => {
			const name = key.toLowerCase();
			if (name === 'transfer-encoding' || name === 'content-encoding') return;
			resHeaders.set(key, value);
		});

		return new Response(res.body, {
			status: res.status,
			headers: resHeaders
		});
	} catch (e) {
		console.error(`Proxy error fetching ${target}:`, e);
		return new Response(JSON.stringify({ error: 'Proxy error', target: target.toString() }), {
			status: 502
		});
	}
}

export const GET: RequestHandler = async ({ request, params }) => proxy(request, params, 'GET');
export const POST: RequestHandler = async ({ request, params }) => proxy(request, params, 'POST');
export const PUT: RequestHandler = async ({ request, params }) => proxy(request, params, 'PUT');
export const DELETE: RequestHandler = async ({ request, params }) =>
	proxy(request, params, 'DELETE');
export const PATCH: RequestHandler = async ({ request, params }) => proxy(request, params, 'PATCH');
