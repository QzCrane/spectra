// goal: unified debounce/throttle utilities with cleanup support

export interface DebouncedFn<T extends (...args: any[]) => any> {
	(...args: Parameters<T>): void;
	cancel: () => void;
	flush: () => void;
}

export interface ThrottledFn<T extends (...args: any[]) => any> {
	(...args: Parameters<T>): void;
	cancel: () => void;
}

// eff: debounce with cancel/flush support
export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	wait: number
): DebouncedFn<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: Parameters<T> | null = null;

	const debounced = (...args: Parameters<T>) => {
		lastArgs = args;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			if (lastArgs) fn(...lastArgs);
		}, wait);
	};

	debounced.cancel = () => {
		if (timer) { clearTimeout(timer); timer = null; }
		lastArgs = null;
	};

	debounced.flush = () => {
		if (timer) { clearTimeout(timer); timer = null; }
		if (lastArgs) { fn(...lastArgs); lastArgs = null; }
	};

	return debounced;
}

// eff: throttle with cancel support
export function throttle<T extends (...args: any[]) => any>(
	fn: T,
	wait: number
): ThrottledFn<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: Parameters<T> | null = null;

	const throttled = (...args: Parameters<T>) => {
		lastArgs = args;
		if (!timer) {
			timer = setTimeout(() => {
				timer = null;
				if (lastArgs) fn(...lastArgs);
			}, wait);
		}
	};

	throttled.cancel = () => {
		if (timer) { clearTimeout(timer); timer = null; }
		lastArgs = null;
	};

	return throttled;
}

// eff: cleanup manager for multiple disposables
export type CleanupFn = () => void;

export function createCleanupManager(): {
	add: (fn: CleanupFn) => void;
	remove: (fn: CleanupFn) => void;
	dispose: () => void;
} {
	const fns = new Set<CleanupFn>();

	return {
		add: (fn) => fns.add(fn),
		remove: (fn) => fns.delete(fn),
		dispose: () => {
			fns.forEach(fn => fn());
			fns.clear();
		}
	};
}

// eff: event listener with auto-cleanup
export function createEventListener(
	target: EventTarget,
	event: string,
	handler: EventListenerOrEventListenerObject,
	options?: boolean | AddEventListenerOptions
): CleanupFn {
	target.addEventListener(event, handler, options);
	return () => target.removeEventListener(event, handler, options);
}
