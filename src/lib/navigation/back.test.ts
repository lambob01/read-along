import { describe, it, expect, vi } from 'vitest';
import { goBackOrHome } from './back';

describe('goBackOrHome', () => {
	it('goes back through history when the app was navigated into', () => {
		const back = vi.fn();
		const navigate = vi.fn();

		goBackOrHome(navigate, { length: 3, back });

		expect(back).toHaveBeenCalledOnce();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('falls back to the library when a deep link has no history behind it', () => {
		const back = vi.fn();
		const navigate = vi.fn();

		goBackOrHome(navigate, { length: 1, back });

		expect(back).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith('/', { replaceState: true });
	});
});
