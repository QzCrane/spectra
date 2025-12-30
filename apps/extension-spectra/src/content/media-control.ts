// goal: provides direct DOM control for playback, picture-in-picture, and playback rate orchestration
// rule: operations always target the "primary" video element, defined as the largest visible video on the page

import { createLogger } from '../shared/logger';
import { simulateMouseHover } from './focus-helper';

const log = createLogger('MediaControl');

// role: logic for identifying the primary video element based on viewport area
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

function getAllMedia(): HTMLMediaElement[] {
	return [
		...Array.from(document.querySelectorAll('video')),
		...Array.from(document.querySelectorAll('audio')),
	];
}

export function togglePlay(): boolean {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	if (video.paused) {
		video.play().catch(e => log.error('Play failed:', e));
		return true;
	} else {
		video.pause();
		return false;
	}
}

// eff: toggles Picture-in-Picture mode and attempts to restore focus to the video element afterwards
export async function togglePip(): Promise<boolean> {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	try {
		let result: boolean;
		if (document.pictureInPictureElement === video) {
			await document.exitPictureInPicture();
			result = false;
		} else {
			if (document.pictureInPictureElement) {
				await document.exitPictureInPicture();
			}
			await video.requestPictureInPicture();
			result = true;
		}
		// note: delay focus restoration to allow for PiP transition animations to complete
		setTimeout(() => simulateMouseHover(video), 200);
		return result;
	} catch (e) {
		log.error('PiP toggle failed:', e);
		return false;
	}
}

// eff: applies playback rate to all media elements on the page
// rule: speed is clamped between 0.1x and 16.0x (browser limitation)
export function setSpeed(speed: number, preservePitch?: boolean): { speed: number; preservePitch: boolean } {
	const clampedSpeed = Math.max(0.1, Math.min(16, speed));
	const medias = getAllMedia();
	const shouldPreservePitch = preservePitch ?? true;

	medias.forEach(m => {
		m.playbackRate = clampedSpeed;
		// note: HTMLMediaElement.preservesPitch is a standard for maintaining audio pitch during speed shifts
		if ('preservesPitch' in m) {
			(m as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch = shouldPreservePitch;
		}
	});

	log.info(`Speed set to ${clampedSpeed}x, preservePitch=${shouldPreservePitch}`);
	return { speed: clampedSpeed, preservePitch: shouldPreservePitch };
}

export function adjustSpeed(delta: number): { speed: number; preservePitch: boolean } {
	const video = getPrimaryVideo();
	const currentSpeed = video?.playbackRate ?? 1;
	return setSpeed(currentSpeed + delta);
}

export function getMediaState(): { playing: boolean; speed: number; pipActive: boolean; preservePitch: boolean } {
	const video = getPrimaryVideo();
	const preservePitch = video && 'preservesPitch' in video
		? (video as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch
		: true;
	return {
		playing: video ? !video.paused : false,
		speed: video?.playbackRate ?? 1,
		pipActive: !!document.pictureInPictureElement,
		preservePitch,
	};
}

export function seekVideo(delta: number): number {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return 0;
	}

	const newTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
	video.currentTime = newTime;
	log.info(`Seek to ${newTime.toFixed(2)}s (delta: ${delta}s)`);
	return newTime;
}
