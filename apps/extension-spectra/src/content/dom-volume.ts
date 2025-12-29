/**
 * // goal: Sync DOM media volume with plugin state
 * // rule: Native site volume change takes precedence unless locked
 */

import { logger } from '../shared/logger';

const log = logger.content;
const monitoredElements = new WeakSet<HTMLMediaElement>();
let targetVolume = 1, targetMuted = false;
let syncEnabled = true, settingByPlugin = false;
let onNativeVolumeChange: ((volume: number, muted: boolean) => void) | null = null;


export function setNativeVolumeCallback(cb: (volume: number, muted: boolean) => void): void {
	onNativeVolumeChange = cb;
}

/**
 * // eff: Apply volume to all media elements
 */
export function setDomVolume(volume: number, muted: boolean): void {
	targetVolume = volume;
	targetMuted = muted;
	const els = document.querySelectorAll('video, audio');
	let applied = 0;
	settingByPlugin = true;

	els.forEach((el) => {
		const m = el as HTMLMediaElement;
		if (Math.abs(m.volume - volume) > 0.01) {
			try { m.volume = volume; applied++; } catch { /* ignore */ }
		}
		if (m.muted !== muted) {
			try { m.muted = muted; } catch { /* ignore */ }
		}
		if (!monitoredElements.has(m)) {
			setupVolumeMonitor(m);
			monitoredElements.add(m);
		}
	});

	// why: debounce requires simple timeout here
	setTimeout(() => { settingByPlugin = false; }, 100);
	if (applied > 0) log.debug(`[DOM] Volume Applied: ${(volume * 100).toFixed(0)}% -> ${applied}/${els.length}`);
}

/**
 * // goal: Detect native volume changes
 */
function setupVolumeMonitor(media: HTMLMediaElement): void {
	media.addEventListener('volumechange', () => {
		if (settingByPlugin) return;
		const newVol = media.volume, newMuted = media.muted;
		const volDiff = Math.abs(newVol - targetVolume), muteDiff = newMuted !== targetMuted;

		// rule: Advanced Mode only syncs mute toggle
		if (!syncEnabled) {
			if (muteDiff) {
				targetMuted = newMuted;
				log.debug(`[DOM] Advanced Mode Mute Toggle: ${newMuted}`);
				// Always send -1 to indicate no volume change, preventing accidental set to 0
				onNativeVolumeChange?.(-1, newMuted);
			}
			return;
		}

		// rule: NATIVE_LITE full sync
		if (volDiff > 0.01 || muteDiff) {
			targetVolume = newVol;
			targetMuted = newMuted;
			log.debug(`[DOM] Native Volume: ${(newVol * 100).toFixed(0)}% (Muted: ${newMuted})`);
			onNativeVolumeChange?.(newVol, newMuted);
		}
	});
}

export function hasMediaElements(): boolean {
	return document.querySelectorAll('video, audio').length > 0;
}


export { getPausedAt } from './pause-tracker';
import { updatePausedAt, needsTracking, setupPauseTracking } from './pause-tracker';


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

/**
 * // goal: Release control to user (Advanced Mode)
 */
export function releaseVolumeLock(): void {
	syncEnabled = false;
	settingByPlugin = true;  // eff: Block volumechange callback
	targetVolume = 1;
	targetMuted = false;
	document.querySelectorAll('video, audio').forEach((el) => {
		try { (el as HTMLMediaElement).volume = 1; (el as HTMLMediaElement).muted = false; } catch { }
	});
	setTimeout(() => { settingByPlugin = false; }, 100);
}

/**
 * // goal: Restore control (Native Lite)
 */
export function enableVolumeLock(volume: number, muted: boolean): void {
	syncEnabled = true;
	setDomVolume(volume, muted);
}
