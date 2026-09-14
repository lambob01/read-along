export class ABSError extends Error {
	constructor(
		message: string,
		public status: number,
		public body: unknown
	) {
		super(message);
		this.name = 'ABSError';
	}
}

export class TranscriptNotFoundError extends Error {
	constructor(itemId: string) {
		super(`No transcript file found for item ${itemId}`);
		this.name = 'TranscriptNotFoundError';
	}
}

/** Aborts from `AbortSignal.timeout` reject as a DOMException with this name. */
function isTimeout(err: unknown): boolean {
	return (
		typeof err === 'object' && err !== null && (err as { name?: string }).name === 'TimeoutError'
	);
}

export class ABSClient {
	private baseUrl: string;
	private token: string;
	private timeoutMs: number;

	constructor(baseUrl: string, token: string, timeoutMs = 30_000) {
		this.baseUrl = baseUrl;
		this.token = token;
		this.timeoutMs = timeoutMs;
	}

	/**
	 * `AbortSignal.timeout` covers the whole exchange, so an abort can also
	 * surface while the body is being read — map it wherever it lands rather
	 * than letting a raw DOMException escape.
	 */
	private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
		try {
			return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
		} catch (err) {
			throw isTimeout(err)
				? new ABSError('Request timed out', 0, err)
				: new ABSError('Network error', 0, err);
		}
	}

	private mapBodyError(err: unknown): never {
		if (isTimeout(err)) throw new ABSError('Request timed out', 0, err);
		throw err;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`
		};

		const init: RequestInit = { method, headers };

		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}

		const response = await this.fetchWithTimeout(url, init);

		if (response.status === 401) {
			throw new ABSError('Unauthorized — check your API token', 401, null);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => null);
			throw new ABSError(`Request failed: ${response.status}`, response.status, text);
		}

		try {
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('application/json')) {
				return (await response.json()) as T;
			}
			return (await response.text()) as unknown as T;
		} catch (err) {
			this.mapBodyError(err);
		}
	}

	get<T>(path: string): Promise<T> {
		return this.request<T>('GET', path);
	}

	/**
	 * Fetches a path as raw bytes. Required for binary payloads such as EPUB
	 * (a zip archive) — `request()` funnels non-JSON responses through
	 * `response.text()`, which would corrupt them via UTF-8 decoding.
	 */
	async getBinary(path: string): Promise<ArrayBuffer> {
		const url = `${this.baseUrl}${path}`;

		const response = await this.fetchWithTimeout(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${this.token}` }
		});

		if (response.status === 401) {
			throw new ABSError('Unauthorized — check your API token', 401, null);
		}

		if (!response.ok) {
			throw new ABSError(`Request failed: ${response.status}`, response.status, null);
		}

		try {
			return await response.arrayBuffer();
		} catch (err) {
			this.mapBodyError(err);
		}
	}

	post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>('POST', path, body);
	}
}
