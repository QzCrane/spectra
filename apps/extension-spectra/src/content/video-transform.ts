/**
 * SPECTRA Content Script - Video Transform
 *
 * Responsibility: Video rotation, mirroring, screenshot
 * Uses CSS transform for visual changes without modifying the source.
 */

import { createLogger } from '../shared/logger';
import { simulateMouseHover } from './focus-helper';

const log = createLogger('VideoTransform');

// ============================================
// State Management
// ============================================

/** Current transform state (per video) */
const transformState = new WeakMap<HTMLVideoElement, { rotation: number; mirrored: boolean }>();

function getState(video: HTMLVideoElement): { rotation: number; mirrored: boolean } {
	let state = transformState.get(video);
	if (!state) {
		state = { rotation: 0, mirrored: false };
		transformState.set(video, state);
	}
	return state;
}

function getPrimaryVideo(): HTMLVideoElement | null {
	const videos = Array.from(document.querySelectorAll('video'));
	if (!videos.length) return null;

	const visible = videos.filter(v => {
		const rect = v.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	});

	if (!visible.length) return videos[0] ?? null;

	visible.sort((a, b) => {
		const aRect = a.getBoundingClientRect();
		const bRect = b.getBoundingClientRect();
		return (bRect.width * bRect.height) - (aRect.width * aRect.height);
	});

	return visible[0] ?? null;
}

// ============================================
// Transform Operations
// ============================================

/** Apply CSS transform */
function applyTransform(video: HTMLVideoElement): void {
	const state = getState(video);
	const transforms: string[] = [];

	if (state.rotation !== 0) {
		transforms.push(`rotate(${state.rotation}deg)`);
	}
	if (state.mirrored) {
		transforms.push('scaleX(-1)');
	}

	video.style.transform = transforms.join(' ') || 'none';
	log.info(`Transform applied: rotation=${state.rotation}, mirrored=${state.mirrored}`);
}

/** Rotate Video (+90°) */
export function rotateVideo(): number {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return 0;
	}

	const state = getState(video);
	state.rotation = (state.rotation + 90) % 360;
	applyTransform(video);
	return state.rotation;
}

/** Toggle Mirror */
export function toggleMirror(): boolean {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	const state = getState(video);
	state.mirrored = !state.mirrored;
	applyTransform(video);
	return state.mirrored;
}

/** Screenshot */
export function takeScreenshot(): string | null {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return null;
	}

	try {
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;

		const ctx = canvas.getContext('2d');
		if (!ctx) return null;

		// Apply transforms to canvas
		const state = getState(video);
		ctx.save();

		// Center
		ctx.translate(canvas.width / 2, canvas.height / 2);

		// Rotate
		if (state.rotation !== 0) {
			ctx.rotate((state.rotation * Math.PI) / 180);
		}

		// Mirror
		if (state.mirrored) {
			ctx.scale(-1, 1);
		}

		// Draw
		ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
		ctx.restore();

		const dataUrl = canvas.toDataURL('image/png');
		log.info(`Screenshot taken: ${canvas.width}x${canvas.height}`);

		// Trigger Download
		const link = document.createElement('a');
		link.href = dataUrl;
		link.download = `screenshot_${Date.now()}.png`;
		link.click();

		return dataUrl;
	} catch (e) {
		log.error('Screenshot failed:', e);
		return null;
	}
}

/** Toggle Fullscreen */
export async function toggleFullscreen(): Promise<boolean> {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	try {
		let result: boolean;
		if (document.fullscreenElement === video) {
			await document.exitFullscreen();
			result = false;
		} else {
			await video.requestFullscreen();
			result = true;
		}
		// Delay focus restore
		setTimeout(() => simulateMouseHover(video), 200);
		return result;
	} catch (e) {
		log.error('Fullscreen toggle failed:', e);
		return false;
	}
}

const cropState = new WeakMap<HTMLVideoElement, boolean>();

/** Toggle Crop (object-fit: cover) */
export function toggleCrop(): boolean {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	const isCropped = cropState.get(video) ?? false;
	const newCropped = !isCropped;

	// cover = fill, contain = fit
	video.style.objectFit = newCropped ? 'cover' : 'contain';
	cropState.set(video, newCropped);

	log.info(`Crop mode: ${newCropped ? 'cover' : 'contain'}`);
	return newCropped;
}
