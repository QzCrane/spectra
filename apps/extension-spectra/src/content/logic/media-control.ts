// goal: provides direct DOM control for playback, picture-in-picture, and playback rate
// role: operations target the "primary" video element (largest visible)

import { createLogger } from '../../shared/logger';
import { simulateMouseHover } from '../utils/focus-helper';

const log = createLogger('MediaControl');

// eff: single pass O(N) zero-alloc
function getPrimaryVideo(): HTMLVideoElement | null {
	const v = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxA = 0;

	for (let i = 0, l = v.length; i < l; i++) {
		const el = v[i];
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		const a = rect.width * rect.height;
		if (a > maxA) { maxA = a; best = el; }
	}
	// eff: Safe fallback
	return best || (v.length > 0 ? v[0]! : null);
}

// eff: live collections iteration
export function setSpeed(s: number, pitch?: boolean): { speed: number; preservePitch: boolean } {
	const clamped = Math.max(0.1, Math.min(16, s));
	const p = pitch ?? true;

	const vs = document.getElementsByTagName('video');
	const as = document.getElementsByTagName('audio');

	const apply = (m: HTMLMediaElement) => {
		if (Math.abs(m.playbackRate - clamped) > 0.005) {
			m.playbackRate = clamped;
		}
		if ('preservesPitch' in m) (m as any).preservesPitch = p;
	};

	for (let i = 0; i < vs.length; i++) { const m = vs[i]; if (m) apply(m); }
	for (let i = 0; i < as.length; i++) { const m = as[i]; if (m) apply(m); }

	log.info(`Speed ${clamped}x, pitch=${p}`);
	return { speed: clamped, preservePitch: p };
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
		pipActive: !!document.pictureInPictureElement,
		preservePitch: p,
	};
}

export function seekVideo(d: number): number {
	const v = getPrimaryVideo();
	if (!v) { log.warn('No video'); return 0; }
	const t = Math.max(0, Math.min(v.duration || 0, v.currentTime + d));
	v.currentTime = t;
	log.info(`Seek ${t.toFixed(2)}s`);
	return t;
}
