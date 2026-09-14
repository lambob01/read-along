import { describe, it, expect } from 'vitest';
import { resolveProxyTarget } from '$lib/abs/proxy-target';

describe('resolveProxyTarget', () => {
	it('resolves a normal API path against the origin', () => {
		// The route consumes one slash, so normal requests arrive WITHOUT a
		// leading slash ("api/items/1"); only the attack (a double slash in
		// the URL) retains one.
		const target = resolveProxyTarget('http://localhost:13378', 'api/items/1', 'token=abc');
		expect(target).not.toBeNull();
		expect(target!.href).toBe('http://localhost:13378/api/items/1?token=abc');
	});

	it('rejects a path that resolves to a foreign origin', () => {
		// /abs//evil.example/x arrives as path "/evil.example/x" — the
		// template then builds a scheme-relative URL, which new URL()
		// happily resolves to the foreign host.
		expect(resolveProxyTarget('http://localhost:13378', '/evil.example/x', '')).toBeNull();
		expect(resolveProxyTarget('http://localhost:13378', '//evil.example/x', '')).toBeNull();
	});

	it('accepts an ordinary same-origin path', () => {
		expect(resolveProxyTarget('http://localhost:13378', 'x', '')).not.toBeNull();
	});

	it('preserves the query string', () => {
		const target = resolveProxyTarget('https://abs.example', 'api/items/2/cover', 'token=xyz');
		expect(target!.search).toBe('?token=xyz');
	});

	it('preserves a base path on the origin', () => {
		// ABS_ORIGIN may point at a subpath, e.g. behind a reverse proxy that
		// mounts it at /abs. The resolved API path must keep that prefix.
		// (The route param has no leading slash — see the first test.)
		expect(resolveProxyTarget('https://host/abs', 'api/x', '')!.href).toBe(
			'https://host/abs/api/x'
		);
		expect(resolveProxyTarget('https://host/abs/', 'api/x', '')!.href).toBe(
			'https://host/abs/api/x'
		);
		expect(resolveProxyTarget('https://host/a/b', 'api/x', 'q=1')!.href).toBe(
			'https://host/a/b/api/x?q=1'
		);
	});

	it('rejects a foreign origin even when the base has a path', () => {
		expect(resolveProxyTarget('https://host/abs', '/evil.example/x', '')).toBeNull();
	});
});
