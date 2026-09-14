type Fetcher = (input: RequestInfo | URL, init: RequestInit) => Promise<Response>;

/**
 * Fetches with a deadline on the response headers only.
 *
 * `AbortSignal.timeout` cannot express that: the signal stays armed for the
 * life of the exchange, so a body still streaming when the deadline fires is
 * aborted mid-transfer. A controller we own can drop the deadline as soon as
 * `fetch` resolves — the response arrives with its headers — leaving the body
 * stream free to finish however slowly the upstream sends it.
 */
export async function fetchWithDeadline(
	fetchFn: Fetcher,
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(deadline);
	}
}
