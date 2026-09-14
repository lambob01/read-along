import { PUBLIC_ABS_ORIGIN } from '$env/static/public';
import { resolveProxyTarget } from '$lib/abs/proxy-target';
import { fetchWithDeadline } from '$lib/abs/proxy-fetch';
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

/**
 * Cap on waiting for response headers from a hung upstream. The deadline is
 * lifted once they arrive, so a slow EPUB transfer is not cut short.
 */
const UPSTREAM_TIMEOUT_MS = 120_000;

const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'upgrade',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer'
]);

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
		if (HOP_BY_HOP.has(name)) return;
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
		return new Response(JSON.stringify({ error: 'Bad proxy path' }), {
			status: 400,
			headers: { 'content-type': 'application/json' }
		});
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
		const res = await fetchWithDeadline(
			fetchWithProxy,
			target.toString(),
			init,
			UPSTREAM_TIMEOUT_MS
		);

		const resHeaders = new Headers();
		// undici has already decoded the body, so an upstream encoding marker
		// describes bytes we are no longer sending — and its content-length is
		// the compressed length, which no longer matches the decoded body.
		const encoded = res.headers.has('content-encoding');
		res.headers.forEach((value, key) => {
			const name = key.toLowerCase();
			if (name === 'transfer-encoding') return;
			if (encoded && (name === 'content-encoding' || name === 'content-length')) return;
			resHeaders.set(key, value);
		});

		return new Response(res.body, {
			status: res.status,
			headers: resHeaders
		});
	} catch (e) {
		// The query string can carry an API token, so log and echo only the
		// origin and path.
		console.error(`Proxy error fetching ${target.origin}${target.pathname}:`, e);
		return new Response(JSON.stringify({ error: 'Proxy error' }), {
			status: 502,
			headers: { 'content-type': 'application/json' }
		});
	}
}

export const GET: RequestHandler = async ({ request, params }) => proxy(request, params, 'GET');
export const POST: RequestHandler = async ({ request, params }) => proxy(request, params, 'POST');
export const PUT: RequestHandler = async ({ request, params }) => proxy(request, params, 'PUT');
export const DELETE: RequestHandler = async ({ request, params }) =>
	proxy(request, params, 'DELETE');
export const PATCH: RequestHandler = async ({ request, params }) => proxy(request, params, 'PATCH');
