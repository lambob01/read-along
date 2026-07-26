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

export class ABSClient {
	private baseUrl: string;
	private token: string;

	constructor(baseUrl: string, token: string) {
		this.baseUrl = baseUrl;
		this.token = token;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`
		};

		const init: RequestInit = { method, headers };

		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}

		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			throw new ABSError('Network error', 0, err);
		}

		if (response.status === 401) {
			throw new ABSError('Unauthorized — check your API token', 401, null);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => null);
			throw new ABSError(
				`Request failed: ${response.status}`,
				response.status,
				text
			);
		}

		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('application/json')) {
			return response.json() as Promise<T>;
		}
		return response.text() as unknown as T;
	}

	get<T>(path: string): Promise<T> {
		return this.request<T>('GET', path);
	}

	post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>('POST', path, body);
	}
}
