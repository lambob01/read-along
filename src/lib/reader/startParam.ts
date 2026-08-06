/**
 * Parses the reader's `?at=` query parameter: the seconds to seek to on load,
 * or null when the parameter is absent or unusable.
 *
 * Number('') is 0, so an empty value must be rejected explicitly — a malformed
 * link seeking to the start of the book would be a surprise. Negative and
 * non-finite values fall back to the bookmark flow rather than seeking.
 */
export function parseStartParam(value: string | null): number | null {
	if (value === null || value.trim() === '') return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
