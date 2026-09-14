import { describe, it, expect, afterEach } from 'vitest';
import { focusableWithin, isActivatable, trapTab } from './a11y';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('isActivatable', () => {
	it('recognises elements that handle Space and Enter themselves', () => {
		const button = document.createElement('button');
		const link = document.createElement('a');
		link.setAttribute('href', '#note');
		const summary = document.createElement('summary');
		const custom = document.createElement('div');
		custom.setAttribute('role', 'button');

		expect(isActivatable(button)).toBe(true);
		expect(isActivatable(link)).toBe(true);
		expect(isActivatable(summary)).toBe(true);
		expect(isActivatable(custom)).toBe(true);
	});

	it('leaves plain content alone', () => {
		const div = document.createElement('div');
		const anchorWithoutHref = document.createElement('a');
		const input = document.createElement('input');

		expect(isActivatable(div)).toBe(false);
		expect(isActivatable(anchorWithoutHref)).toBe(false);
		expect(isActivatable(input)).toBe(false);
		expect(isActivatable(null)).toBe(false);
	});
});

describe('trapTab', () => {
	function sheet(): {
		container: HTMLElement;
		first: HTMLButtonElement;
		second: HTMLButtonElement;
		last: HTMLButtonElement;
	} {
		const container = document.createElement('div');
		container.innerHTML = `
			<button id="first">First</button>
			<div>middle</div>
			<button id="second">Second</button>
			<button id="last">Last</button>
			<div tabindex="-1">not focusable</div>
			<button disabled>disabled</button>
		`;
		document.body.appendChild(container);
		return {
			container,
			first: container.querySelector<HTMLButtonElement>('#first')!,
			second: container.querySelector<HTMLButtonElement>('#second')!,
			last: container.querySelector<HTMLButtonElement>('#last')!
		};
	}

	function tab(target: EventTarget, shiftKey = false): KeyboardEvent {
		const event = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey,
			bubbles: true,
			cancelable: true
		});
		target.dispatchEvent(event);
		return event;
	}

	it('collects focusable controls in DOM order and skips inert ones', () => {
		const { container } = sheet();
		const labels = focusableWithin(container).map((el) => el.textContent);
		expect(labels).toEqual(['First', 'Second', 'Last']);
	});

	it('wraps Tab from the last control to the first', () => {
		const { container, first, last } = sheet();
		last.focus();
		const event = tab(last);
		trapTab(event, container);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
	});

	it('wraps Shift+Tab from the first control to the last', () => {
		const { container, first, last } = sheet();
		first.focus();
		const event = tab(first, true);
		trapTab(event, container);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
	});

	it('leaves Tab in the middle of the sheet to the browser', () => {
		const { container, second } = sheet();
		second.focus();
		const event = tab(second);
		trapTab(event, container);
		expect(event.defaultPrevented).toBe(false);
	});

	it('pulls focus in when Tab starts outside the sheet', () => {
		const { container, first } = sheet();
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		document.body.dispatchEvent(event);
		trapTab(event, container);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
	});
});
