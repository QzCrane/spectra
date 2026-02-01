import { logger } from '../../shared/logger';
import { needsTracking, setupPauseTracking, updatePausedAt } from '../utils/pause-tracker';

const log = logger.content;

// eff: Check both collections without allocation
function checkPause(els: HTMLCollectionOf<HTMLMediaElement>): boolean {
	for (let i = 0, l = els.length; i < l; i++) {
		const el = els[i];
		if (el && !el.paused) return true;
	}
	return false;
}

function processCollection(els: HTMLCollectionOf<HTMLMediaElement>): boolean {
	let hasPlaying = false;
	for (let i = 0, l = els.length; i < l; i++) {
		const m = els[i];
		if (!m) continue;
		if (!m.paused) hasPlaying = true;
		if (needsTracking(m)) setupPauseTracking(m, isAnyMediaPlayingRaw);
	}
	return hasPlaying;
}

export function isAnyMediaPlaying(): boolean {
	const videos = document.getElementsByTagName('video');
	const audio = document.getElementsByTagName('audio');

	const vPlaying = processCollection(videos as unknown as HTMLCollectionOf<HTMLMediaElement>);
	const aPlaying = processCollection(audio as unknown as HTMLCollectionOf<HTMLMediaElement>);
	const playing = vPlaying || aPlaying;

	updatePausedAt(playing, (videos.length + audio.length) > 0);
	return playing;
}

function isAnyMediaPlayingRaw(): boolean {
	if (checkPause(document.getElementsByTagName('video') as unknown as HTMLCollectionOf<HTMLMediaElement>)) return true;
	if (checkPause(document.getElementsByTagName('audio') as unknown as HTMLCollectionOf<HTMLMediaElement>)) return true;
	return false;
}

export function hasMediaElements(): boolean {
	return document.getElementsByTagName('video').length > 0 || document.getElementsByTagName('audio').length > 0;
}
