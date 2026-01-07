import { logger } from '../../shared/logger';
import { needsTracking, setupPauseTracking, updatePausedAt } from '../utils/pause-tracker';

const log = logger.content;

export function isAnyMediaPlaying(): boolean {
	const els = document.querySelectorAll('video, audio');
	let hasPlaying = false;
	for (const el of els) {
		const m = el as HTMLMediaElement;
		if (!m.paused) hasPlaying = true;
		if (needsTracking(m)) setupPauseTracking(m, isAnyMediaPlayingRaw);
	}
	updatePausedAt(hasPlaying, els.length > 0);
	return hasPlaying;
}

function isAnyMediaPlayingRaw(): boolean {
	for (const el of document.querySelectorAll('video, audio')) {
		if (!(el as HTMLMediaElement).paused) return true;
	}
	return false;
}

export function hasMediaElements(): boolean {
	return document.querySelectorAll('video, audio').length > 0;
}
