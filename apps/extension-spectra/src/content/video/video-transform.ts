// goal: Video rotation, mirroring, screenshot
// role: uses CSS transform for visual changes without modifying source

import { createLogger } from '../../shared/logger';
import { simulateMouseHover } from '../utils/focus-helper';

const log = createLogger('VideoTransform');

// eff: WeakMaps for per-element state
const tfState = new WeakMap<HTMLVideoElement, { r: number; m: boolean }>();
const cpState = new WeakMap<HTMLVideoElement, boolean>();

function getState(v: HTMLVideoElement): { r: number; m: boolean } {
	let s = tfState.get(v);
	if (!s) { s = { r: 0, m: false }; tfState.set(v, s); }
	return s;
}

// eff: duplicative logic with media-control, but keep isolated for now
function getPrimary(): HTMLVideoElement | null {
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
	return best || (v.length > 0 ? v[0]! : null);
}

function apply(v: HTMLVideoElement) {
	const s = getState(v);
	const t: string[] = [];
	if (s.r !== 0) t.push(`rotate(${s.r}deg)`);
	if (s.m) t.push('scaleX(-1)');
	v.style.transform = t.join(' ') || 'none';
	log.info(`Transform: r=${s.r}, m=${s.m}`);
}

export function rotateVideo(): number {
	const v = getPrimary();
	if (!v) return 0;
	const s = getState(v);
	s.r = (s.r + 90) % 360;
	apply(v);
	return s.r;
}

export function toggleMirror(): boolean {
	const v = getPrimary();
	if (!v) return false;
	const s = getState(v);
	s.m = !s.m;
	apply(v);
	return s.m;
}

export function takeScreenshot(): string | null {
	const v = getPrimary();
	if (!v) return null;

	try {
		const cvs = document.createElement('canvas');
		cvs.width = v.videoWidth;
		cvs.height = v.videoHeight;
		const ctx = cvs.getContext('2d');
		if (!ctx) return null;

		const s = getState(v);
		ctx.save();
		ctx.translate(cvs.width / 2, cvs.height / 2);
		if (s.r !== 0) ctx.rotate((s.r * Math.PI) / 180);
		if (s.m) ctx.scale(-1, 1);
		ctx.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2);
		ctx.restore();

		const data = cvs.toDataURL('image/png');
		const a = document.createElement('a');
		a.href = data;
		a.download = `screenshot_${Date.now()}.png`;
		a.click();
		return data;
	} catch (e) {
		log.error('Screenshot fail:', e);
		return null;
	}
}

export async function toggleFullscreen(): Promise<boolean> {
	const v = getPrimary();
	if (!v) return false;

	try {
		let r: boolean;
		if (document.fullscreenElement === v) {
			await document.exitFullscreen();
			r = false;
		} else {
			await v.requestFullscreen();
			r = true;
		}
		setTimeout(() => simulateMouseHover(v), 200);
		return r;
	} catch (e) {
		log.error('FS fail:', e);
		return false;
	}
}

export function toggleCrop(): boolean {
	const v = getPrimary();
	if (!v) return false;
	const c = !(cpState.get(v) ?? false);
	v.style.objectFit = c ? 'cover' : 'contain';
	cpState.set(v, c);
	log.info(`Crop: ${c ? 'cover' : 'contain'}`);
	return c;
}
