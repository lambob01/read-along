/**
 * Serialises async loads that write to one piece of state, so that only the
 * most recently requested one may apply its result — or report its error.
 *
 * Library switching sends overlapping requests: the first click's response can
 * land after the second's, and applying it would leave the shelf showing a
 * library the reader has already left. A stale failure is worse than useless,
 * because it reports "Failed to load" for a library no longer on screen.
 */
export interface LatestRequests {
	/**
	 * Starts `load` and routes the outcome through the callbacks only while it
	 * is still the newest request. Callbacks for superseded runs never fire.
	 */
	run<T>(
		load: () => Promise<T>,
		apply: (value: T) => void,
		onError: (err: unknown) => void
	): Promise<void>;
	/** Drops whatever is in flight, e.g. when the page is torn down. */
	cancel(): void;
}

export function createLatestRequests(): LatestRequests {
	let sequence = 0;

	return {
		async run(load, apply, onError) {
			const id = ++sequence;
			try {
				const value = await load();
				if (id !== sequence) return;
				apply(value);
			} catch (err) {
				if (id !== sequence) return;
				onError(err);
			}
		},
		cancel() {
			sequence++;
		}
	};
}
