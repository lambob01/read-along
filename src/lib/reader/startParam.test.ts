import { describe, it, expect } from 'vitest';
import { parseStartParam } from './startParam';

describe('parseStartParam', () => {
	it('parses a whole-number target', () => {
		expect(parseStartParam('612')).toBe(612);
	});

	it('parses a fractional target', () => {
		expect(parseStartParam('612.5')).toBe(612.5);
	});

	it('treats a missing parameter as no jump', () => {
		expect(parseStartParam(null)).toBeNull();
	});

	it('treats an empty parameter as no jump', () => {
		// /read/x?at= yields '', and Number('') is 0 — seeking to the start
		// would be a surprise for a malformed link.
		expect(parseStartParam('')).toBeNull();
	});

	it('treats non-numeric input as no jump', () => {
		expect(parseStartParam('abc')).toBeNull();
		expect(parseStartParam('1,000')).toBeNull();
	});

	it('treats negative values as no jump', () => {
		expect(parseStartParam('-5')).toBeNull();
	});

	it('treats non-finite values as no jump', () => {
		expect(parseStartParam('Infinity')).toBeNull();
		expect(parseStartParam('NaN')).toBeNull();
	});
});
