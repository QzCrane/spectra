// goal: implements a Mac-like inertial smooth scrolling engine using requestAnimationFrame and ease-out-quart
// note: this helps eliminate UI stutter and provides a more premium interaction feel

const CONFIG = {
	sensitivity: 0.6,
	duration: 600,
	// group: easing function (ease-out-quart)
	easing: (t: number) => 1 - Math.pow(1 - t, 4),
};

interface ScrollState {
	container: HTMLElement | null;
	animationId: number | null;
	targetY: number;
	startY: number;
	startTime: number;
}

const state: ScrollState = {
	container: null,
	animationId: null,
	targetY: 0,
	startY: 0,
	startTime: 0,
};

// eff: executes the frame-by-frame scroll position update until the target is reached or animation is cancelled
function animateScroll(timestamp: number): void {
	if (!state.container) return;

	if (!state.startTime) {
		state.startTime = timestamp;
	}

	const elapsed = timestamp - state.startTime;
	const progress = Math.min(elapsed / CONFIG.duration, 1);
	const easedProgress = CONFIG.easing(progress);

	const currentY = state.startY + (state.targetY - state.startY) * easedProgress;
	state.container.scrollTop = currentY;

	if (progress < 1) {
		state.animationId = requestAnimationFrame(animateScroll);
	} else {
		state.animationId = null;
	}
}

// eff: calculates the final scroll destination and initiates the animation loop
function scrollTo(container: HTMLElement, targetY: number): void {
	if (state.animationId !== null) {
		cancelAnimationFrame(state.animationId);
	}

	const maxScroll = container.scrollHeight - container.clientHeight;
	const clampedTarget = Math.max(0, Math.min(targetY, maxScroll));

	state.container = container;
	state.startY = container.scrollTop;
	state.targetY = clampedTarget;
	state.startTime = 0;

	state.animationId = requestAnimationFrame(animateScroll);
}

// eff: intercepts native wheel events to apply custom smooth scrolling logic
function handleWheel(event: WheelEvent): void {
	const container = findScrollableParent(event.target as HTMLElement);
	if (!container) return;

	// rule: prevent native scrolling to allow the smooth engine to take full control
	event.preventDefault();

	const delta = event.deltaY * CONFIG.sensitivity;

	const currentTarget =
		state.container === container && state.animationId !== null
			? state.targetY
			: container.scrollTop;

	scrollTo(container, currentTarget + delta);
}

// post: returns the nearest scrollable parent element or documentElement if none found
function findScrollableParent(element: HTMLElement | null): HTMLElement | null {
	while (element && element !== document.body) {
		const style = getComputedStyle(element);
		const overflowY = style.overflowY;

		if (
			(overflowY === 'auto' || overflowY === 'scroll') &&
			element.scrollHeight > element.clientHeight
		) {
			return element;
		}

		element = element.parentElement;
	}

	const html = document.documentElement;
	if (html.scrollHeight > html.clientHeight) {
		return html;
	}

	return null;
}

// eff: attaches wheel listeners to the specified root to enable inertial scrolling
export function enableSmoothScroll(root: Document | HTMLElement = document): void {
	root.addEventListener('wheel', handleWheel as EventListener, { passive: false });
	console.log('[SPECTRA] Smooth scroll enabled');
}

// eff: detaches listeners and halts any ongoing scroll animations
export function disableSmoothScroll(root: Document | HTMLElement = document): void {
	root.removeEventListener('wheel', handleWheel as EventListener);
	if (state.animationId !== null) {
		cancelAnimationFrame(state.animationId);
		state.animationId = null;
	}
	console.log('[SPECTRA] Smooth scroll disabled');
}
