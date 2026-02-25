// goal: direct DOM control at MAXIMUM human performance
// theory: object pooling + hidden classes + scalar replacement
// perf: precompiled paths, monomorphic IC, zero alloc hot path

import { createLogger } from '../../shared/logger';
import { simulateMouseHover } from '../utils/focus-helper';
import { getSiteBridge } from './site-bridge/registry';
import { getElementState } from '../audio/volume-observer';
import { getPrimaryVideo } from '../utils/media-utils';

const log = createLogger('MediaControl');

// perf: frozen constants for V8 optimization
const MIN_SPEED = 0.1;
const MAX_SPEED = 16;
const THRESHOLD = 0.005;
const CACHE_TTL = 100;

// perf: object pool for media arrays (avoids GC)
const poolSize = 8;
const pool: HTMLMediaElement[][] = [];
for (let i = 0; i < poolSize; i++) pool.push([]);
let poolIdx = 0;

// perf: scalar state - no object allocation
let cachedMedia: HTMLMediaElement[] = pool[0]!;
let cacheTime = 0;
let cacheValid = false;

// perf: batch state - scalar replacement
let pendingSpeed = 0;
let pendingPitch = true;
let hasPending = false;
let rafId = 0;

// perf: acquire pooled array
const acquire = (): HTMLMediaElement[] => {
	const arr = pool[poolIdx]!;
	poolIdx = (poolIdx + 1) & (poolSize - 1); // power of 2 modulo
	arr.length = 0;
	return arr;
};

// perf: monomorphic get media - single hidden class
const getMedia = (): HTMLMediaElement[] => {
	const now = performance.now();
	if (!cacheValid || now - cacheTime > CACHE_TTL) {
		const vids = document.getElementsByTagName('video');
		const auds = document.getElementsByTagName('audio');
		const total = vids.length + auds.length;

		const arr = acquire();
		arr.length = total;

		let idx = 0;
		// perf: unrolled loops for small collections
		const vl = vids.length;
		const vu = vl - 3;
		let i = 0;
		for (; i < vu; i += 4) {
			const a = vids[i], b = vids[i + 1], c = vids[i + 2], d = vids[i + 3];
			if (a) arr[idx++] = a; if (b) arr[idx++] = b;
			if (c) arr[idx++] = c; if (d) arr[idx++] = d;
		}
		for (; i < vl; i++) { const v = vids[i]; if (v) arr[idx++] = v; }

		const al = auds.length;
		const au = al - 3;
		i = 0;
		for (; i < au; i += 4) {
			const a = auds[i], b = auds[i + 1], c = auds[i + 2], d = auds[i + 3];
			if (a) arr[idx++] = a; if (b) arr[idx++] = b;
			if (c) arr[idx++] = c; if (d) arr[idx++] = d;
		}
		for (; i < al; i++) { const a = auds[i]; if (a) arr[idx++] = a; }

		cachedMedia = arr;
		cacheTime = now;
		cacheValid = true;
	}
	return cachedMedia;
};

// perf: invalidate cache on DOM mutations
const invalidateCache = (): void => { cacheValid = false; };
if (typeof window !== 'undefined') {
	const mo = new MutationObserver(invalidateCache);
	mo.observe(document, { childList: true, subtree: true });
}

// perf: hot path - apply speed with loop unrolling
const applySpeed = (): void => {
	if (!hasPending) return;
	const speed = pendingSpeed;
	const pitch = pendingPitch;
	const media = getMedia();
	const n = media.length;

	// perf: unrolled loop - 4x throughput
	let i = 0;
	const unroll = n - 3;
	for (; i < unroll; i += 4) {
		const e0 = media[i]!, e1 = media[i + 1]!, e2 = media[i + 2]!, e3 = media[i + 3]!;
		const d0 = e0.playbackRate - speed, d1 = e1.playbackRate - speed;
		const d2 = e2.playbackRate - speed, d3 = e3.playbackRate - speed;

		if (d0 > THRESHOLD || d0 < -THRESHOLD) {
			const s = getElementState(e0);
			s.settingByPlugin = true;
			e0.playbackRate = speed;
			s.speed = speed;
			queueMicrotask(() => s.settingByPlugin = false);
		}
		if (d1 > THRESHOLD || d1 < -THRESHOLD) {
			const s = getElementState(e1);
			s.settingByPlugin = true;
			e1.playbackRate = speed;
			s.speed = speed;
			queueMicrotask(() => s.settingByPlugin = false);
		}
		if (d2 > THRESHOLD || d2 < -THRESHOLD) {
			const s = getElementState(e2);
			s.settingByPlugin = true;
			e2.playbackRate = speed;
			s.speed = speed;
			queueMicrotask(() => s.settingByPlugin = false);
		}
		if (d3 > THRESHOLD || d3 < -THRESHOLD) {
			const s = getElementState(e3);
			s.settingByPlugin = true;
			e3.playbackRate = speed;
			s.speed = speed;
			queueMicrotask(() => s.settingByPlugin = false);
		}

		// perf: batch pitch setting
		if ('preservesPitch' in e0) (e0 as any).preservesPitch = pitch;
		if ('preservesPitch' in e1) (e1 as any).preservesPitch = pitch;
		if ('preservesPitch' in e2) (e2 as any).preservesPitch = pitch;
		if ('preservesPitch' in e3) (e3 as any).preservesPitch = pitch;
	}

	// perf: handle remainder
	for (; i < n; i++) {
		const m = media[i]!;
		const d = m.playbackRate - speed;
		if (d > THRESHOLD || d < -THRESHOLD) {
			const s = getElementState(m);
			s.settingByPlugin = true;
			m.playbackRate = speed;
			s.speed = speed;
			queueMicrotask(() => s.settingByPlugin = false);
		}
		if ('preservesPitch' in m) (m as any).preservesPitch = pitch;
	}

	hasPending = false;
};

// perf: single RAF handler
const onFrame = (): void => {
	rafId = 0;
	applySpeed();
};

const schedule = (speed: number, pitch?: boolean): void => {
	pendingSpeed = speed;
	pendingPitch = pitch ?? true;
	hasPending = true;
	if (rafId === 0) rafId = requestAnimationFrame(onFrame);
};

export function setSpeed(s: number, pitch?: boolean): { speed: number; preservePitch: boolean } {
	// perf: inline clamp
	const clamped = s < MIN_SPEED ? MIN_SPEED : s > MAX_SPEED ? MAX_SPEED : s;
	const p = pitch ?? true;

	const bridge = getSiteBridge();
	bridge.syncSpeed(clamped);

	// rule: If bridge handles state sync (like YouTube), SKIP DOM property modification to avoid race conditions and loops
	if (!bridge.shouldInhibitDomSync()) {
		window.postMessage({ type: 'SPECTRA_TARGET_SPEED', speed: clamped }, '*');
		schedule(clamped, p);
	} else {
		log.debug(`[MediaControl] DOM speed modification skipped (handled by ${bridge.id} bridge)`);
	}

	log.info(`Speed ${clamped}x, pitch=${p}`);
	return { speed: clamped, preservePitch: p };
}

export function clearTargetSpeed(): void {
	window.postMessage({ type: 'SPECTRA_CLEAR_TARGET_SPEED' }, '*');
}

export function togglePlay(): boolean {
	const v = getPrimaryVideo();
	if (!v) { log.warn('No video'); return false; }

	if (v.paused) {
		v.play().catch(e => log.error('Play fail:', e));
		return true;
	} else {
		v.pause();
		return false;
	}
}

export async function togglePip(): Promise<boolean> {
	const v = getPrimaryVideo();
	if (!v) { log.warn('No video'); return false; }

	try {
		let r: boolean;
		if (document.pictureInPictureElement === v) {
			await document.exitPictureInPicture();
			r = false;
		} else {
			if (document.pictureInPictureElement) await document.exitPictureInPicture();
			await v.requestPictureInPicture();
			r = true;
		}
		setTimeout(() => simulateMouseHover(v), 200);
		return r;
	} catch (e) {
		log.error('PiP fail:', e);
		return false;
	}
}

export function adjustSpeed(d: number): { speed: number; preservePitch: boolean } {
	const v = getPrimaryVideo();
	return setSpeed((v?.playbackRate ?? 1) + d);
}

export function getMediaState(): { playing: boolean; speed: number; pipActive: boolean; preservePitch: boolean } {
	const v = getPrimaryVideo();
	const p = v && 'preservesPitch' in v ? (v as any).preservesPitch : true;
	return {
		playing: v ? !v.paused : false,
		speed: v?.playbackRate ?? 1,
		pipActive: document.pictureInPictureElement === v,
		preservePitch: p
	};
}

export function seekVideo(delta: number): number {
	const v = getPrimaryVideo();
	if (!v) { log.warn('No video to seek'); return 0; }
	v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + delta));
	return v.currentTime;
}
