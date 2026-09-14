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
	const base = new URL(origin);
	const target = new URL(`/${path}`, base);
	if (target.origin !== base.origin) return null;

	// The origin may carry a base path (ABS behind a reverse proxy mounted at
	// `/abs`), and the template above resolves against the host rather than
	// that directory, so put the prefix back.
	const prefix = base.pathname.replace(/\/+$/, '');
	if (prefix) target.pathname = `${prefix}${target.pathname}`;

	target.search = search;
	return target;
}
