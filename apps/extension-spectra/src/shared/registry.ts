// goal: providing a unified interface for sub-millisecond precision cleanup of side effects
// note: essential for zero-refresh hot-swap to prevent "zombie" listeners and resource leaks

export type Disposable = (() => void) | { dispose: () => void };

/**
 * Pinnacle Disposable Registry
 * Handles atomic cleanup of observers, timers, and event listeners
 */
export class Registry {
	private stack: Array<() => void> = [];

	/**
	 * Track a side effect for eventual cleanup
	 * @param item - A cleanup function or an object with a dispose method
	 */
	track<T extends Disposable>(item: T): T {
		if (typeof item === 'function') {
			this.stack.push(item);
		} else {
			this.stack.push(() => item.dispose());
		}
		return item;
	}

	/**
	 * Atomic cleanup of all registered side effects
	 * Resets the registry to an empty state
	 */
	dispose(): void {
		while (this.stack.length > 0) {
			const cleanup = this.stack.pop();
			try {
				cleanup?.();
			} catch {
				// note: silent fail-fast to ensure all cleanups are attempted
			}
		}
	}

	/**
	 * Wrapper for standard DOM event listeners
	 */
	addEventListener(
		target: EventTarget,
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	): void {
		target.addEventListener(type, listener, options);
		this.stack.push(() => target.removeEventListener(type, listener, options));
	}

}
