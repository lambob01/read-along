import { describe, it, expect, vi } from 'vitest';
import { loadTextSource } from '$lib/epub/source';
import type { ABSClient } from '$lib/abs/client';
import type { ItemSources } from '$lib/abs/api';

const client = {} as ABSClient;

const sources = {
	subIno: '10',
	subSize: 100,
	epubIno: null,
	epubSize: null
} as ItemSources;

describe('loadTextSource', () => {
	it('degrades to no-source with a notice when the subtitle download fails', async () => {
		const fetchFileText = vi.fn().mockRejectedValue(new Error('network down'));
		const source = await loadTextSource(client, 'item-1', sources, fetchFileText);

		expect(source.mode).toBe('none');
		expect(source.notice).toContain('Subtitle');
	});
});
