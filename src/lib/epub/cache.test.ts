import { describe, it, expect } from 'vitest';
import { alignmentKey, rebuildIndex } from '$lib/epub/cache';
import type { AlignedSentence } from '$lib/types';

function sentence(
	id: number,
	start: number,
	end: number,
	timed = true
): AlignedSentence {
	return {
		id,
		start,
		end,
		text: `文${id}`,
		timed,
		blockId: 0,
		chapterOrder: 0,
		streamStart: id * 10,
		streamEnd: id * 10 + 10,
		blockOffsetStart: 0,
		blockOffsetEnd: 3
	};
}

describe('alignmentKey', () => {
	it('changes when the epub is replaced', () => {
		expect(alignmentKey('item1', 100, 50)).not.toBe(alignmentKey('item1', 101, 50));
	});

	it('changes when the subtitle is replaced', () => {
		expect(alignmentKey('item1', 100, 50)).not.toBe(alignmentKey('item1', 100, 51));
	});

	it('distinguishes items', () => {
		expect(alignmentKey('item1', 100, 50)).not.toBe(alignmentKey('item2', 100, 50));
	});

	it('tolerates missing sizes', () => {
		expect(alignmentKey('item1', null, null)).toBe('item1:0:0');
	});
});

describe('rebuildIndex', () => {
	const base = {
		key: 'k',
		version: 1,
		createdAt: 0,
		blocks: [],
		stats: {
			coverage: 1,
			totalSentences: 3,
			timedSentences: 3,
			cueCount: 3,
			matchedCues: 3
		}
	};

	it('rebuilds timing arrays parallel to the timed list', () => {
		const sentences = [sentence(0, 0, 1), sentence(1, 1, 2), sentence(2, 2, 3)];
		const index = rebuildIndex({ ...base, sentences });

		expect(index.starts.length).toBe(3);
		expect(Array.from(index.starts)).toEqual([0, 1, 2]);
		expect(Array.from(index.ends)).toEqual([1, 2, 3]);
		for (let i = 0; i < index.timed.length; i++) {
			expect(index.starts[i]).toBe(index.timed[i].start);
		}
	});

	it('excludes untimed sentences from the arrays but keeps them readable', () => {
		const sentences = [sentence(0, 0, 0, false), sentence(1, 1, 2)];
		const index = rebuildIndex({ ...base, sentences });

		expect(index.sentences.length).toBe(2);
		expect(index.timed.length).toBe(1);
		expect(index.starts.length).toBe(1);
		expect(index.timed[0].id).toBe(1);
	});

	it('sorts by start so a cached record yields a monotonic index', () => {
		// Persisted order is not guaranteed to be time order.
		const sentences = [sentence(0, 5, 6), sentence(1, 1, 2), sentence(2, 3, 4)];
		const index = rebuildIndex({ ...base, sentences });

		expect(Array.from(index.starts)).toEqual([1, 3, 5]);
		for (let i = 1; i < index.starts.length; i++) {
			expect(index.starts[i]).toBeGreaterThanOrEqual(index.ends[i - 1]);
		}
	});

	it('round-trips the stats it was given', () => {
		const index = rebuildIndex({ ...base, sentences: [sentence(0, 0, 1)] });
		expect(index.stats.coverage).toBe(1);
		expect(index.stats.cueCount).toBe(3);
	});

	it('handles an empty sentence list', () => {
		const index = rebuildIndex({ ...base, sentences: [] });
		expect(index.starts.length).toBe(0);
		expect(index.timed.length).toBe(0);
	});
});
