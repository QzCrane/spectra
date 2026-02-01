// goal: Set A/B points and manage loop playback
import { createLogger } from '../../shared/logger';

const log = createLogger('ABLoop');

interface ABState { a: number | null; b: number | null; loop: boolean; cleanup: (() => void) | null; }
const s: ABState = { a: null, b: null, loop: false, cleanup: null };

function getPrimary(): HTMLVideoElement | null {
	const v = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxA = 0;
	// eff: Safe live collection iteration
	for (let i = 0, l = v.length; i < l; i++) {
		const el = v[i];
		if (!el) continue;
		const r = el.getBoundingClientRect();
		const a = r.width * r.height;
		if (a > maxA) { maxA = a; best = el; }
	}
	// eff: Safe return
	return best || (v.length > 0 ? v[0]! : null);
}

function handleTime(this: HTMLVideoElement) {
	if (!s.loop || s.a === null || s.b === null) return;
	if (this.currentTime >= s.b) { this.currentTime = s.a; log.info(`Loop A (${s.a.toFixed(2)}s)`); }
}

function start(v: HTMLVideoElement) {
	if (s.cleanup) return;
	v.addEventListener('timeupdate', handleTime);
	s.cleanup = () => v.removeEventListener('timeupdate', handleTime);
	log.info('Loop start');
}

function stop() {
	if (s.cleanup) { s.cleanup(); s.cleanup = null; }
	s.loop = false;
	log.info('Loop stop');
}

export function setPointA(): number | null {
	const v = getPrimary();
	if (!v) return null;
	s.a = v.currentTime; s.b = null;
	stop();
	log.info(`Set A: ${s.a.toFixed(2)}s`);
	return s.a;
}

export function setPointB(): { pointB: number | null; looping: boolean } {
	const v = getPrimary();
	if (!v || s.a === null) return { pointB: null, looping: false };
	if (v.currentTime <= s.a) { log.warn('B <= A'); return { pointB: null, looping: false }; }

	s.b = v.currentTime; s.loop = true;
	start(v);
	log.info(`Set B: ${s.b.toFixed(2)}s`);
	return { pointB: s.b, looping: true };
}

export function clearABLoop(): boolean {
	stop();
	s.a = null; s.b = null;
	log.info('Cleared');
	return true;
}

export function getABState(): { pointA: number | null; pointB: number | null; looping: boolean } {
	return { pointA: s.a, pointB: s.b, looping: s.loop };
}
