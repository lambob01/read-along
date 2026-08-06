/**
 * Resolves a proxy path against the fixed ABS origin, refusing anything that
 * would escape it.
 *
 * The route param carries a leading slash, so a request for
 * `/abs//evil.example/x` arrives as the path `/evil.example/x`, and the
 * template literal form `/${path}` turns that into a scheme-relative URL that
 * `new URL` resolves to a *foreign* host. An origin comparison after
 * resolution is the only check that catches every spelling.
 */
export function resolveProxyTarget(origin: string, path: string, search: string): URL | null {
	const target = new URL(`/${path}`, origin);
	if (target.origin !== new URL(origin).origin) return null;
	target.search = search;
	return target;
}
