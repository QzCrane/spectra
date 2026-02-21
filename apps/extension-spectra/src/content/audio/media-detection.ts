import { logger } from '../../shared/logger';
import { needsTracking, setupPauseTracking, updatePausedAt } from '../utils/pause-tracker';
import { iterateMedia, hasMediaElements as hasMedia, isAnyMediaPlaying as isPlaying } from '../utils/media-utils';

const log = logger.content;

export function isAnyMediaPlaying(): boolean {
	let hasPlaying = false;
	let hasMedia = false;

	for (const m of iterateMedia()) {
		hasMedia = true;
		if (!m.paused) hasPlaying = true;
		if (needsTracking(m)) setupPauseTracking(m, () => isPlaying());
	}

	updatePausedAt(hasPlaying, hasMedia);
	return hasPlaying;
}

export const hasMediaElements = hasMedia;
