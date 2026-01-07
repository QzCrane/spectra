/**
 * // goal: Set A/B points and manage loop playback
 * // eff: Monitors video time and seeks back to A when B is reached
 */

import { createLogger } from '../../shared/logger';

const log = createLogger('ABLoop');

// ============================================
// State
// ============================================

interface ABState {
	pointA: number | null;
	pointB: number | null;
	looping: boolean;
	listener: (() => void) | null;
}

const abState: ABState = {
	pointA: null,
	pointB: null,
	looping: false,
	listener: null
};

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
// Loop Logic
// ============================================

/**
 * // eff: Adds timeupdate listener to video
 */
function startLoop(video: HTMLVideoElement): void {
	if (abState.listener) return;

	const handler = () => {
		if (!abState.looping || abState.pointA === null || abState.pointB === null) return;
		if (video.currentTime >= abState.pointB) {
			video.currentTime = abState.pointA;
			log.info(`Loop: jumped back to A (${abState.pointA.toFixed(2)}s)`);
		}
	};

	video.addEventListener('timeupdate', handler);
	abState.listener = () => video.removeEventListener('timeupdate', handler);
	log.info('AB loop started');
}

/**
 * // eff: Removes timeupdate listener
 */
function stopLoop(): void {
	if (abState.listener) {
		abState.listener();
		abState.listener = null;
	}
	abState.looping = false;
	log.info('AB loop stopped');
}

// ============================================
// Public API
// ============================================

/**
 * // goal: Mark start point (A)
 * // eff: Clears existing loop, saves currentTime as A
 */
export function setPointA(): number | null {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return null;
	}

	abState.pointA = video.currentTime;
	abState.pointB = null; // Reset Point B
	stopLoop();
	log.info(`Set point A: ${abState.pointA.toFixed(2)}s`);
	return abState.pointA;
}

/**
 * // goal: Mark end point (B) and start looping
 * // pre: Point A must be set and < current time
 */
export function setPointB(): { pointB: number | null; looping: boolean } {
	const video = getPrimaryVideo();
	if (!video || abState.pointA === null) {
		log.warn('No video or point A not set');
		return { pointB: null, looping: false };
	}

	if (video.currentTime <= abState.pointA) {
		log.warn('Point B must be after point A');
		return { pointB: null, looping: false };
	}

	abState.pointB = video.currentTime;
	abState.looping = true;
	startLoop(video);
	log.info(`Set point B: ${abState.pointB.toFixed(2)}s, looping enabled`);
	return { pointB: abState.pointB, looping: true };
}

/**
 * // goal: Reset AB state
 */
export function clearABLoop(): boolean {
	stopLoop();
	abState.pointA = null;
	abState.pointB = null;
	log.info('AB loop cleared');
	return true;
}

export function getABState(): { pointA: number | null; pointB: number | null; looping: boolean } {
	return {
		pointA: abState.pointA,
		pointB: abState.pointB,
		looping: abState.looping
	};
}
