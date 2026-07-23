// goal: Popup/Options smooth scroll with boundary bubbling (based on Halo sidepanel-init)
// inv: when child element reaches scroll boundary, scroll propagates to parent

type EasingFn = (t: number) => number;

// ===== Scroll Engine (queue-based) =====
interface ScrollCommand {
	x: number;
	y: number;
	lastX: number;
	lastY: number;
	start: number;
}

interface EngineState {
	que: ScrollCommand[];
	pending: number | null;
	target: Element | null;
	direction: { x: number; y: number };
	animationTime: number;
	easing: EasingFn;
}

const engine: EngineState = {
	que: [], pending: null, target: null, direction: { x: 0, y: 0 },
	animationTime: 300, easing: (t) => 1 - (1 - t) ** 4
};

function directionCheck(x: number, y: number): void {
	const dx = x > 0 ? 1 : -1;
	const dy = y > 0 ? 1 : -1;
	if (engine.direction.x !== dx || engine.direction.y !== dy) {
		engine.direction.x = dx; engine.direction.y = dy;
		engine.que.length = 0; // eff: clear without alloc
		if (engine.pending) { cancelAnimationFrame(engine.pending); engine.pending = null; }
	}
}

function scrollStep(): void {
	const tgt = engine.target as HTMLElement;
	if (!tgt) return;

	const now = Date.now();
	let sy = 0;
	let active = 0;

	for (let i = 0; i < engine.que.length; i++) {
		const item = engine.que[i];
		if (!item) continue;

		const elap = now - item.start;
		const fin = elap >= engine.animationTime;
		const pos = engine.easing(fin ? 1 : elap / engine.animationTime);
		const y = ((item.y * pos - item.lastY) | 0);

		sy += y;
		item.lastY += y;

		if (!fin) {
			// eff: compact array in-place
			if (i !== active) engine.que[active] = item;
			active++;
		}
	}
	engine.que.length = active; // eff: trim

	if (sy) tgt.scrollTop += sy;

	if (engine.que.length) engine.pending = requestAnimationFrame(scrollStep);
	else engine.pending = null;
}

function scrollTo(target: Element, deltaY: number): void {
	directionCheck(0, deltaY);
	engine.target = target;
	engine.que.push({
		x: 0,
		y: deltaY,
		lastX: 0,
		lastY: deltaY < 0 ? 0.99 : -0.99,
		start: Date.now(),
	});
	if (!engine.pending) {
		engine.pending = requestAnimationFrame(scrollStep);
	}
}

// ===== Scroll Target with Boundary Bubbling =====
function findScrollable(el: HTMLElement | null): HTMLElement {
	while (el && el !== document.body) {
		const s = getComputedStyle(el);
		if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
			return el;
		}
		el = el.parentElement;
	}
	return document.documentElement;
}

// ===== Wheel Handler with Boundary Bubbling =====
const CONFIG = {
	stepSize: 150, // more responsive than 300
	accelerationMax: 2.5,
	accelerationDelta: 50,
};

let lastTime = 0;
let accel = 1;

function handleWheel(e: WheelEvent): void {
	let target = findScrollable(e.target as HTMLElement);
	const isScrollingDown = e.deltaY > 0;
	const isScrollingUp = e.deltaY < 0;

	// Boundary bubbling: find a scrollable parent that isn't at boundary
	while (target && target !== document.documentElement) {
		const max = target.scrollHeight - target.clientHeight;
		if (max <= 0) {
			target = findScrollable(target.parentElement);
			continue;
		}

		const atTop = target.scrollTop <= 0;
		const atBottom = target.scrollTop >= max - 1;

		if ((atTop && isScrollingUp) || (atBottom && isScrollingDown)) {
			target = findScrollable(target.parentElement);
			continue;
		}

		break;
	}

	// Final boundary check
	const max = target.scrollHeight - target.clientHeight;
	if (max <= 0) return;

	const atTop = target.scrollTop <= 0;
	const atBottom = target.scrollTop >= max - 1;
	if ((atTop && isScrollingUp) || (atBottom && isScrollingDown)) {
		return; // let browser handle
	}

	e.preventDefault();

	// Acceleration
	const now = Date.now();
	if (now - lastTime < CONFIG.accelerationDelta) {
		accel = Math.min(accel + 0.4, CONFIG.accelerationMax);
	} else {
		accel = 1;
	}
	lastTime = now;

	const deltaY = (e.deltaY > 0 ? 1 : -1) * CONFIG.stepSize * accel;
	scrollTo(target, deltaY);
}

// ===== Export =====
export function enableSmoothScroll(root: Document | HTMLElement = document): void {
	root.addEventListener('wheel', handleWheel as EventListener, { passive: false });
}

export function disableSmoothScroll(root: Document | HTMLElement = document): void {
	root.removeEventListener('wheel', handleWheel as EventListener);
	if (engine.pending) {
		cancelAnimationFrame(engine.pending);
		engine.pending = null;
	}
	engine.que = [];
}
