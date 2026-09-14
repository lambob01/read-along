/**
 * A back control that cannot leave the app. `history.back()` is correct when
 * the reader navigated in, but a deep link straight into a settings page has
 * no entry behind it and would drop them out of the reader entirely. The
 * collaborators are arguments so this decision is testable without a browser.
 */
export function goBackOrHome(
	navigate: (url: string, options: { replaceState: boolean }) => void,
	history: Pick<History, 'length' | 'back'>
): void {
	if (history.length > 1) history.back();
	else navigate('/', { replaceState: true });
}
