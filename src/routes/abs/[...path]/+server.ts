import { PUBLIC_ABS_ORIGIN } from '$env/static/public';
import { resolveProxyTarget } from '$lib/abs/proxy-target';
import { env } from '$env/dynamic/private';
import { ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import type { RequestHandler } from './$types';

const ABS_ORIGIN = PUBLIC_ABS_ORIGIN || 'http://localhost:13378';

/**
 * The dev server fetches the origin itself, so its connection needs the same
 * VPN as the browser. `ABS_HTTP_PROXY` names a local proxy (e.g. Clash Verge's
 * mixed port) to route that traffic through; unset, it connects directly.
 */
const ABS_PROXY = env.ABS_HTTP_PROXY || '';
const dispatcher: Dispatcher | undefined = ABS_PROXY ? new ProxyAgent(ABS_PROXY) : undefined;

function fetchWithProxy(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
	// Node's global fetch is undici's, so a `dispatcher` in init routes it
	// through the proxy even though the type doesn't know the option.
	return dispatcher
		? globalThis.fetch(input, { ...init, dispatcher } as RequestInit)
		: globalThis.fetch(input, init);
}

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
	const target = resolveProxyTarget(ABS_ORIGIN, params.path, new URL(request.url).search);
	if (!target) {
		return new Response(JSON.stringify({ error: 'Bad proxy path' }), { status: 400 });
	}

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
		const res = await fetchWithProxy(target.toString(), init);

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
