/**
 * SPECTRA Content Script - Video Transform
 * Responsibility: Video rotation, mirroring, screenshot
 */

import { createLogger } from '../shared/logger';
import { simulateMouseHover } from './focus-helper';

const log = createLogger('VideoTransform');

// eff: WeakMap for O(1) state access
const transformState = new WeakMap<HTMLVideoElement, { rotation: number; mirrored: boolean }>();
const cropState = new WeakMap<HTMLVideoElement, boolean>();

function getState(video: HTMLVideoElement) {
	let state = transformState.get(video);
	if (!state) {
		transformState.set(video, state = { rotation: 0, mirrored: false });
	}
	return state;
}

// eff: O(N) Single-pass scan, Zero-Allocation (no Array.from/filter/sort)
function getPrimaryVideo(): HTMLVideoElement | null {
	const videos = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxArea = 0;

	for (let i = 0, len = videos.length; i < len; i++) {
		const v = videos[i];
		if (!v) continue;
		const rect = v.getBoundingClientRect();
		const area = rect.width * rect.height;
		if (area > maxArea) {
			maxArea = area;
			best = v;
		}
	}
	return best || videos[0] || null;
}

function applyTransform(video: HTMLVideoElement): void {
	const { rotation, mirrored } = getState(video);
	let css = '';
	if (rotation) css += `rotate(${rotation}deg) `;
	if (mirrored) css += 'scaleX(-1)';
	video.style.transform = css || 'none';
	log.info(`Transform: r=${rotation} m=${mirrored}`);
}

export function rotateVideo(): number {
	const video = getPrimaryVideo();
	if (!video) return 0;
	const state = getState(video);
	state.rotation = (state.rotation + 90) % 360;
	applyTransform(video);
	return state.rotation;
}

export function toggleMirror(): boolean {
	const video = getPrimaryVideo();
	if (!video) return false;
	const state = getState(video);
	state.mirrored = !state.mirrored;
	applyTransform(video);
	return state.mirrored;
}

export function takeScreenshot(): string | null {
	const video = getPrimaryVideo();
	if (!video) return null;

	try {
		const canvas = document.createElement('canvas');
		const { videoWidth: w, videoHeight: h } = video;
		canvas.width = w; canvas.height = h;

		const ctx = canvas.getContext('2d');
		if (!ctx) return null;

		const { rotation, mirrored } = getState(video);
		ctx.save();
		ctx.translate(w / 2, h / 2);
		if (rotation) ctx.rotate((rotation * Math.PI) / 180);
		if (mirrored) ctx.scale(-1, 1);
		ctx.drawImage(video, -w / 2, -h / 2);
		ctx.restore();

		const dataUrl = canvas.toDataURL('image/png');

		const link = document.createElement('a');
		link.href = dataUrl;
		link.download = `screenshot_${Date.now()}.png`;
		link.click();

		log.info(`Screenshot: ${w}x${h}`);
		return dataUrl;
	} catch (e) {
		log.error('Screenshot failed:', e);
		return null;
	}
}

export async function toggleFullscreen(): Promise<boolean> {
	const video = getPrimaryVideo();
	if (!video) return false;

	try {
		if (document.fullscreenElement === video) {
			await document.exitFullscreen();
			setTimeout(() => simulateMouseHover(video), 200);
			return false;
		}
		await video.requestFullscreen();
		setTimeout(() => simulateMouseHover(video), 200);
		return true;
	} catch (e) {
		log.error('Fullscreen failed:', e);
		return false;
	}
}

export function toggleCrop(): boolean {
	const video = getPrimaryVideo();
	if (!video) return false;

	const isCropped = !(cropState.get(video) ?? false);
	video.style.objectFit = isCropped ? 'cover' : 'contain';
	cropState.set(video, isCropped);
	log.info(`Crop: ${isCropped}`);
	return isCropped;
}
