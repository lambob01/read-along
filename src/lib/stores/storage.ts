/**
 * Writes to localStorage without letting a refused write reach the caller.
 *
 * `setItem` throws when the origin's storage is full or blocked (Safari's
 * private mode historically threw on every write), and the call sites include
 * a bookmark interval and `onDestroy` — a throw there is an unhandled page
 * error, not a failed write the caller could act on. The in-memory store keeps
 * the value either way, so swallowing is the whole contract.
 */
export function safeSetItem(key: string, value: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, value);
	} catch {
		/* best-effort persistence; the visible state does not depend on it */
	}
}
