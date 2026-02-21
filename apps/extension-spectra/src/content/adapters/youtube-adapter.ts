// goal: YouTube playback speed & volume UI sync via cross-world messaging
// role: content script side of the bridge to MAIN world injector
// note: YouTube API only accessible in MAIN world

import { createLogger } from '../../shared/logger';

const log = createLogger('YTAdapter');

// inv: last values to prevent loop
type ValueCache = { value: number; ts: number };
let lastSpeed: ValueCache | null = null;
let lastVol: ValueCache | null = null;
let lastMuted: { value: boolean; ts: number } | null = null;

// eff: check YouTube domain - cache hostname check
const hostname = location.hostname;
const isYT = hostname.includes('youtube.com') || hostname.includes('youtu.be');

export const isYouTube = (): boolean => isYT;

// eff: send speed to injector (MAIN world has YouTube API access)
export function setYouTubeSpeed(rate: number): void {
	const now = Date.now();
	if (lastSpeed && Math.abs(lastSpeed.value - rate) < 0.005 && now - lastSpeed.ts < 100) return;
	lastSpeed = { value: rate, ts: now };
	window.postMessage({ type: 'SPECTRA_YT_SPEED', speed: rate }, '*');
}

// eff: send volume/mute to injector
// note: volume is 0-100 for YouTube API
export function setYouTubeVolume(volume: number, muted: boolean): void {
	const now = Date.now();
	const volSkip = lastVol && Math.abs(lastVol.value - volume) < 1 && now - lastVol.ts < 100;
	const muteSkip = lastMuted && lastMuted.value === muted && now - lastMuted.ts < 100;

	if (volSkip && muteSkip) return;

	if (!volSkip) lastVol = { value: volume, ts: now };
	if (!muteSkip) lastMuted = { value: muted, ts: now };

	window.postMessage({ type: 'SPECTRA_YT_VOLUME', volume, muted }, '*');
}

// eff: listen for injector responses
export function initYouTubeAdapter(): void {
	window.addEventListener('message', (e) => {
		if (!e.data) return;
		if (e.data.type === 'SPECTRA_YT_SPEED_OK') {
			log.debug(`YT speed synced: ${e.data.speed}x`);
		}
		if (e.data.type === 'SPECTRA_YT_VOLUME_OK') {
			log.debug(`YT volume synced: ${e.data.volume}% muted=${e.data.muted}`);
		}
		if (e.data.type === 'SPECTRA_YT_FAIL') {
			log.warn('YT sync failed:', e.data.error);
			if (e.data.feature === 'speed') lastSpeed = null;
			if (e.data.feature === 'volume') { lastVol = null; lastMuted = null; }
		}
	});
}

// eff: clear cache on navigation
export function clearYouTubeCache(): void {
	lastSpeed = null;
	lastVol = null;
	lastMuted = null;
}
