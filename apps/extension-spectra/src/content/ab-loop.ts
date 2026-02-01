/**
 * // goal: Set A/B points and manage loop playback
 * // eff: Monitors video time with minimal overhead
 */

import { createLogger } from '../shared/logger';

const log = createLogger('ABLoop');

// eff: Direct state access (faster than object lookup)
let pgA: number | null = null;
let pgB: number | null = null;
let isLooping = false;
let cleanup: (() => void) | null = null;

// eff: O(N) Zero-Alloc
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

const checkLoop = function (this: HTMLVideoElement) {
	if (isLooping && pgA !== null && pgB !== null && this.currentTime >= pgB) {
		this.currentTime = pgA;
		log.info(`Loop: jumped to ${pgA.toFixed(2)}s`);
	}
};

function enableLoop(video: HTMLVideoElement): void {
	if (cleanup) return;
	video.addEventListener('timeupdate', checkLoop);
	cleanup = () => {
		video.removeEventListener('timeupdate', checkLoop);
		cleanup = null;
	};
	log.info('AB loop active');
}

function disableLoop(): void {
	if (cleanup) cleanup();
	isLooping = false;
	log.info('AB loop stopped');
}

export function setPointA(): number | null {
	const video = getPrimaryVideo();
	if (!video) return null;

	pgA = video.currentTime;
	pgB = null;
	disableLoop();

	log.info(`Set A: ${pgA.toFixed(2)}s`);
	return pgA;
}

export function setPointB(): { pointB: number | null; looping: boolean } {
	const video = getPrimaryVideo();
	if (!video || pgA === null) return { pointB: null, looping: false };

	if (video.currentTime <= pgA) {
		log.warn('B must be > A');
		return { pointB: null, looping: false };
	}

	pgB = video.currentTime;
	isLooping = true;
	enableLoop(video);

	log.info(`Set B: ${pgB.toFixed(2)}s`);
	return { pointB: pgB, looping: true };
}

export function clearABLoop(): boolean {
	disableLoop();
	pgA = null;
	pgB = null;
	return true;
}

export function getABState() {
	return { pointA: pgA, pointB: pgB, looping: isLooping };
}
